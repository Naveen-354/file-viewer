import { useCallback, useEffect, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Activity, Camera, Film, Gauge, Info, Maximize, Pause, Play, Repeat, RotateCcw,
  SkipBack, SkipForward, Volume2, VolumeX,
} from "lucide-react";
import type { ViewerProps } from "../../types/handlers";
import { readBytes, formatBytes } from "../../utils/file";
import { api } from "../../services/tauri";
import {
  averageBitrate, formatDuration, formatTimecode, readMediaMeta, type MediaMeta,
} from "../../utils/mediaMeta";
import AudioViewer from "./AudioViewer";

const MEDIA_LIMIT = 48 * 1024 * 1024;
const FITS = [
  { id: "contain", label: "Native" },
  { id: "cover", label: "Fill" },
  { id: "fill", label: "Stretch" },
] as const;
type Fit = (typeof FITS)[number]["id"];

interface Quality { total: number; dropped: number }

export default function MediaViewer(props: ViewerProps) {
  const { file, onStatusChange } = props;
  const [url, setUrl] = useState<string | null>(null);
  const [meta, setMeta] = useState<MediaMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const [fit, setFit] = useState<Fit>("contain");
  const [inspector, setInspector] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [fps, setFps] = useState<number | null>(null);
  const [frames, setFrames] = useState(0);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [captured, setCaptured] = useState<string | null>(null);
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const frameTimes = useRef<number[]>([]);

  const isVideo = file.mimeType?.startsWith("video/") || ["mp4", "webm", "mov", "mkv"].includes(file.extension ?? "");

  useEffect(() => {
    let objectUrl: string | null = null;
    let disposed = false;
    if (file.size > MEDIA_LIMIT) { setError("Media is too large for the bounded in-app player."); return; }
    void readBytes(file.path, MEDIA_LIMIT).then((bytes) => {
      if (disposed) return;
      setMeta(readMediaMeta(bytes));
      objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.mimeType ?? "application/octet-stream" }));
      setUrl(objectUrl);
    }).catch((reason) => setError(String(reason)));
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file.path, file.size, file.mimeType]);

  /**
   * Frame callbacks are the only place the WebView reports real playback facts,
   * so the frame counter and measured rate come from here rather than a guess.
   */
  useEffect(() => {
    const element = mediaRef.current;
    if (!element || !isVideo || !url) return;
    let handle = 0;
    let cancelled = false;
    const withCallback = element as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: (now: number) => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    if (!withCallback.requestVideoFrameCallback) return;
    const onFrame = (now: number) => {
      if (cancelled) return;
      const times = frameTimes.current;
      times.push(now);
      if (times.length > 30) times.shift();
      if (times.length > 5) {
        const span = times[times.length - 1] - times[0];
        if (span > 0) setFps(((times.length - 1) / span) * 1000);
      }
      setFrames((value) => value + 1);
      const stats = element.getVideoPlaybackQuality?.();
      if (stats) setQuality({ total: stats.totalVideoFrames, dropped: stats.droppedVideoFrames });
      handle = withCallback.requestVideoFrameCallback!(onFrame);
    };
    handle = withCallback.requestVideoFrameCallback(onFrame);
    return () => { cancelled = true; withCallback.cancelVideoFrameCallback?.(handle); };
  }, [url, isVideo]);

  const onTimeUpdate = useCallback(() => {
    const element = mediaRef.current;
    if (!element) return;
    setTime(element.currentTime);
    const ranges = element.buffered;
    setBuffered(ranges.length ? ranges.end(ranges.length - 1) : 0);
  }, []);

  const toggle = () => {
    const element = mediaRef.current;
    if (!element) return;
    if (element.paused) void element.play(); else element.pause();
  };

  const seek = (seconds: number) => {
    const element = mediaRef.current;
    if (element) element.currentTime = Math.max(0, Math.min(element.duration || 0, seconds));
  };

  const capture = async () => {
    const element = mediaRef.current;
    if (!element || !element.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = element.videoWidth;
    canvas.height = element.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(element, 0, 0);
    const destination = await saveDialog({
      defaultPath: `${file.name.replace(/\.[^.]+$/, "")}-${Math.round(element.currentTime)}s.png`,
      filters: [{ name: "PNG", extensions: ["png"] }],
    });
    if (!destination) return;
    try {
      const dataUrl = canvas.toDataURL("image/png");
      await api.saveImageFrame(destination, dataUrl.replace(/^data:.*?;base64,/, ""));
      setCaptured(destination);
      window.setTimeout(() => setCaptured(null), 4000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    if (!duration) return;
    onStatusChange(`${formatDuration(duration)}${fps ? ` · ${fps.toFixed(1)} fps` : ""}`);
  }, [duration, fps, onStatusChange]);

  const bufferAhead = Math.max(0, buffered - time);
  const bufferPercent = duration ? Math.min(100, Math.round((buffered / duration) * 100)) : 0;

  if (!isVideo) return <AudioViewer {...props} />;

  if (error) {
    return (
      <div className="viewer media-viewer">
        <div className="media-fallback">
          <p>{error}</p>
          <button className="primary" onClick={() => void api.openSystem(file.path)}>Open with system application</button>
        </div>
      </div>
    );
  }

  return (
    <div className="viewer media-viewer stream-inspector">
      <div className="viewer-toolbar media-bar">
        <span className="json-file"><Film size={13} /> {file.name}</span>
        <span className="segmented">
          {FITS.map((option) => (
            <button key={option.id} className={fit === option.id ? "selected" : ""} aria-pressed={fit === option.id} onClick={() => setFit(option.id)}>{option.label}</button>
          ))}
        </span>
        <span className="toolbar-divider" />
        <label className="media-rate"><Gauge size={13} />
          <select aria-label="Playback speed" value={rate} onChange={(event) => {
            const value = Number(event.target.value);
            setRate(value);
            if (mediaRef.current) mediaRef.current.playbackRate = value;
          }}>
            {[0.25, 0.5, 1, 1.25, 1.5, 2, 4].map((value) => <option key={value} value={value}>{value}×</option>)}
          </select>
        </label>
        <button className={`icon-action ${loop ? "selected" : ""}`} aria-label="Loop" aria-pressed={loop} title="Loop playback" onClick={() => setLoop((value) => !value)}><Repeat size={14} /></button>
        <span className="spacer" />
        {isVideo && <button className="icon-action labelled" title="Save the current frame as a PNG" onClick={() => void capture()}><Camera size={13} /> Capture PNG</button>}
        <button className={`icon-action labelled ${inspector ? "selected" : ""}`} aria-label="Stream inspector" aria-pressed={inspector} onClick={() => setInspector((value) => !value)}><Info size={13} /> Inspector</button>
      </div>

      {captured && <div className="validation-error media-captured">Frame saved to {captured}</div>}

      <div className="media-body">
        <div className="media-stage">
          {isVideo && (
            <div className="media-hud">
              <span className={playing ? "live" : ""}><Activity size={11} /> {playing ? "PLAYING" : "PAUSED"}</span>
              {fps !== null && <span>{fps.toFixed(3)} FPS measured</span>}
              <span className="spacer" />
              <span>BUFFER: {bufferAhead.toFixed(1)}s ({bufferPercent}%)</span>
            </div>
          )}
          {url && (
            isVideo
              ? <video
                  ref={mediaRef}
                  src={url}
                  playsInline
                  loop={loop}
                  style={{ objectFit: fit }}
                  onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onTimeUpdate={onTimeUpdate}
                  onProgress={onTimeUpdate}
                  onClick={toggle}
                  onError={() => setError("This codec is not supported by the system WebView.")}
                />
              : <audio
                  ref={mediaRef as unknown as React.RefObject<HTMLAudioElement>}
                  src={url}
                  controls
                  loop={loop}
                  onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
                  onTimeUpdate={onTimeUpdate}
                  onError={() => setError("This codec is not supported by the system WebView.")}
                />
          )}
          {isVideo && (
            <div className="media-hud bottom">
              <span>FRAME: {frames.toLocaleString()}</span>
              <span className="spacer" />
              <span>PTS: {formatTimecode(time)}</span>
            </div>
          )}
        </div>

        {inspector && (
          <aside className="media-inspector" aria-label="Stream inspector">
            <div className="json-details-head"><strong><Activity size={13} /> Stream Inspector</strong><em className="json-type">{meta?.container?.split(" ")[0] ?? "MEDIA"}</em></div>

            {meta?.video && (
              <section>
                <h3>Video stream</h3>
                <dl className="image-facts">
                  {meta.video.codec && <Row label="Codec" value={meta.video.codec} />}
                  {meta.video.profile && <Row label="Profile / level" value={meta.video.profile} />}
                  {meta.video.width && <Row label="Dimensions" value={`${meta.video.width} × ${meta.video.height} px`} />}
                  {fps !== null && <Row label="Frame rate" value={`${fps.toFixed(2)} fps measured`} />}
                </dl>
              </section>
            )}

            {meta?.audio && (
              <section>
                <h3>Audio stream</h3>
                <dl className="image-facts">
                  {meta.audio.codec && <Row label="Codec" value={meta.audio.codec} />}
                  {meta.audio.sampleRate && <Row label="Sample rate" value={`${meta.audio.sampleRate.toLocaleString()} Hz`} />}
                  {meta.audio.channels && <Row label="Channels" value={String(meta.audio.channels)} />}
                </dl>
              </section>
            )}

            <section>
              <h3>Container</h3>
              <dl className="image-facts">
                {meta?.container && <Row label="Format" value={meta.container} />}
                {duration > 0 && <Row label="Duration" value={formatTimecode(duration)} />}
                <Row label="File size" value={formatBytes(file.size)} />
                {averageBitrate(file.size, meta?.durationSeconds ?? duration) && (
                  <Row label="Bitrate" value={averageBitrate(file.size, meta?.durationSeconds ?? duration)!} />
                )}
              </dl>
            </section>

            {quality && (
              <section>
                <h3>Playback quality</h3>
                <dl className="image-facts">
                  <Row label="Frames decoded" value={quality.total.toLocaleString()} />
                  <Row label="Frames dropped" value={`${quality.dropped.toLocaleString()} (${quality.total ? ((quality.dropped / quality.total) * 100).toFixed(2) : "0.00"}%)`} />
                  <Row label="Buffered ahead" value={`${bufferAhead.toFixed(1)} s`} />
                </dl>
              </section>
            )}

            {!meta?.video && !meta?.audio && (
              <p className="muted small">This container's track details could not be read. Playback still uses the system decoder.</p>
            )}
          </aside>
        )}
      </div>

      <div className="media-transport">
        <button className="icon-action" aria-label={playing ? "Pause" : "Play"} onClick={toggle}>{playing ? <Pause size={15} /> : <Play size={15} />}</button>
        <button className="icon-action" aria-label="Back 10 seconds" title="Back 10s" onClick={() => seek(time - 10)}><SkipBack size={14} /></button>
        <button className="icon-action" aria-label="Forward 10 seconds" title="Forward 10s" onClick={() => seek(time + 10)}><SkipForward size={14} /></button>
        <button className="icon-action" aria-label="Restart" title="Restart" onClick={() => seek(0)}><RotateCcw size={14} /></button>
        <span className="media-time">{formatTimecode(time)} / {formatTimecode(duration)}</span>
        <input
          className="media-scrub"
          type="range"
          aria-label="Seek"
          min={0}
          max={Math.max(1, duration)}
          step={0.05}
          value={time}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <button className="icon-action" aria-label={muted ? "Unmute" : "Mute"} onClick={() => {
          const next = !muted;
          setMuted(next);
          if (mediaRef.current) mediaRef.current.muted = next;
        }}>{muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>
        <input
          className="media-volume"
          type="range"
          aria-label="Volume"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(event) => {
            const value = Number(event.target.value);
            setVolume(value);
            if (mediaRef.current) { mediaRef.current.volume = value; mediaRef.current.muted = value === 0; }
          }}
        />
        {isVideo && <button className="icon-action" aria-label="Fullscreen" onClick={() => void mediaRef.current?.requestFullscreen?.()}><Maximize size={14} /></button>}
      </div>

      <div className="json-status">
        {meta?.container && <span>{meta.container}</span>}
        {meta?.video?.codec && <span>{meta.video.codec}{meta.audio?.codec ? ` / ${meta.audio.codec}` : ""}</span>}
        <span>System WebView decoder</span>
        <span className="spacer" />
        {quality && <span className={quality.dropped > 0 ? "bad" : "ok"}>{quality.dropped} dropped</span>}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd title={value}>{value}</dd></div>;
}
