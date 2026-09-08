import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AudioLines, Gauge, Info, Pause, Play, Repeat, RotateCcw, SkipBack, SkipForward,
  Volume2, VolumeX,
} from "lucide-react";
import type { ViewerProps } from "../../types/handlers";
import { readBytes, formatBytes } from "../../utils/file";
import { api } from "../../services/tauri";
import { channelLayout, readAudioMeta, statedBitrate, type AudioMeta } from "../../utils/audioMeta";
import {
  analyseLoudness, buildPeaks, formatDb, formatLufs, formatTime, midSide, monoSum,
  peakOfChannel, toDecibels, type LoudnessReport,
} from "../../utils/loudness";

const AUDIO_LIMIT = 48 * 1024 * 1024;
const ZOOMS = [1, 2, 5] as const;
const VIEWS = [
  { id: "stereo", label: "Stereo L/R" },
  { id: "midside", label: "Mid/Side" },
  { id: "mono", label: "Mono Sum" },
] as const;
type View = (typeof VIEWS)[number]["id"];

export default function AudioViewer({ file, onStatusChange }: ViewerProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [meta, setMeta] = useState<AudioMeta | null>(null);
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [report, setReport] = useState<LoudnessReport | null>(null);
  const [analysing, setAnalysing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("stereo");
  const [zoom, setZoom] = useState<number>(1);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const [inspector, setInspector] = useState(true);
  const [spectrum, setSpectrum] = useState<Uint8Array | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const spectrumRef = useRef<HTMLCanvasElement>(null);
  const graphRef = useRef<{ context: AudioContext; analyser: AnalyserNode } | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let disposed = false;
    if (file.size > AUDIO_LIMIT) { setError("Audio is too large for the bounded in-app player."); return; }
    void readBytes(file.path, AUDIO_LIMIT).then(async (bytes) => {
      if (disposed) return;
      setMeta(readAudioMeta(bytes));
      objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.mimeType ?? "audio/*" }));
      setUrl(objectUrl);
      try {
        const context = new AudioContext();
        const decoded = await context.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
        void context.close();
        if (disposed) return;
        setBuffer(decoded);
        const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
        setReport(analyseLoudness(channels, decoded.sampleRate));
      } catch {
        if (!disposed) setError("This codec cannot be decoded for analysis. Playback may still work.");
      } finally {
        if (!disposed) setAnalysing(false);
      }
    }).catch((reason) => { setError(String(reason)); setAnalysing(false); });
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file.path, file.size, file.mimeType]);

  /** The analyser is only wired once playback starts, so nothing runs while idle. */
  const ensureGraph = useCallback(() => {
    const element = audioRef.current;
    if (!element || graphRef.current) return;
    const context = new AudioContext();
    const source = context.createMediaElementSource(element);
    const analyser = context.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);
    analyser.connect(context.destination);
    graphRef.current = { context, analyser };
  }, []);

  useEffect(() => () => { void graphRef.current?.context.close(); graphRef.current = null; }, []);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const data = new Uint8Array(2048);
    const tick = () => {
      const graph = graphRef.current;
      if (graph) {
        graph.analyser.getByteFrequencyData(data);
        setSpectrum(data.slice());
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const channels = useMemo(() => {
    if (!buffer) return [];
    const raw = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
    const lane = (label: string, data: Float32Array) => ({ label, data, peak: peakOfChannel(data) });
    if (view === "mono" || raw.length === 1) return [lane("Mono", monoSum(raw))];
    if (view === "midside") {
      const { mid, side } = midSide(raw[0], raw[1]);
      return [lane("Mid", mid), lane("Side", side)];
    }
    return raw.slice(0, 2).map((data, index) => lane(index === 0 ? "Channel 1" : "Channel 2", data));
  }, [buffer, view]);

  // Draw the waveform whenever the source, view or zoom changes.
  useEffect(() => {
    const canvas = waveRef.current;
    if (!canvas || channels.length === 0) return;
    const width = canvas.clientWidth * devicePixelRatio;
    const laneHeight = 110 * devicePixelRatio;
    canvas.width = width;
    canvas.height = laneHeight * channels.length;
    const context = canvas.getContext("2d");
    if (!context) return;
    const columns = Math.max(1, Math.floor(width / zoom));
    context.clearRect(0, 0, canvas.width, canvas.height);
    channels.forEach((channel, index) => {
      const peaks = buildPeaks(channel.data, columns);
      const middle = laneHeight * index + laneHeight / 2;
      context.strokeStyle = index === 0 ? "#4f8cff" : "#42d392";
      context.globalAlpha = 0.55;
      context.beginPath();
      for (let column = 0; column < columns; column += 1) {
        const x = (column / columns) * width;
        context.moveTo(x, middle - peaks.max[column] * (laneHeight / 2 - 8));
        context.lineTo(x, middle - peaks.min[column] * (laneHeight / 2 - 8));
      }
      context.stroke();
      context.globalAlpha = 1;
      context.beginPath();
      for (let column = 0; column < columns; column += 1) {
        const x = (column / columns) * width;
        context.moveTo(x, middle - peaks.rms[column] * (laneHeight / 2 - 8));
        context.lineTo(x, middle + peaks.rms[column] * (laneHeight / 2 - 8));
      }
      context.stroke();
      context.strokeStyle = "rgba(255,255,255,.16)";
      context.globalAlpha = 1;
      context.beginPath();
      context.moveTo(0, middle);
      context.lineTo(width, middle);
      context.stroke();
    });
  }, [channels, zoom]);

  // Draw the live spectrum on a logarithmic frequency axis.
  useEffect(() => {
    const canvas = spectrumRef.current;
    if (!canvas || !spectrum || !buffer) return;
    const width = canvas.clientWidth * devicePixelRatio;
    const height = 90 * devicePixelRatio;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    const nyquist = buffer.sampleRate / 2;
    const minimum = Math.log10(20);
    const span = Math.log10(Math.min(20000, nyquist)) - minimum;
    context.beginPath();
    context.moveTo(0, height);
    for (let x = 0; x < width; x += 1) {
      const frequency = Math.pow(10, minimum + (x / width) * span);
      const bin = Math.min(spectrum.length - 1, Math.round((frequency / nyquist) * spectrum.length));
      context.lineTo(x, height - (spectrum[bin] / 255) * height);
    }
    context.lineTo(width, height);
    context.closePath();
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "rgba(241,183,75,.85)");
    gradient.addColorStop(1, "rgba(241,183,75,.08)");
    context.fillStyle = gradient;
    context.fill();
  }, [spectrum, buffer]);

  useEffect(() => {
    if (!buffer) return;
    onStatusChange(`${formatTime(buffer.duration)} · ${buffer.sampleRate.toLocaleString()} Hz · ${channelLayout(buffer.numberOfChannels)}`);
  }, [buffer, onStatusChange]);

  const duration = buffer?.duration ?? audioRef.current?.duration ?? 0;
  const seek = (seconds: number) => {
    const element = audioRef.current;
    if (element) element.currentTime = Math.max(0, Math.min(duration, seconds));
  };
  const toggle = () => {
    const element = audioRef.current;
    if (!element) return;
    ensureGraph();
    void graphRef.current?.context.resume();
    if (element.paused) void element.play(); else element.pause();
  };

  const sampleRate = meta?.sampleRate ?? buffer?.sampleRate ?? null;
  const contextRate = graphRef.current?.context.sampleRate ?? null;

  if (error && !url) {
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
    <div className="viewer media-viewer stream-inspector audio-studio">
      <div className="viewer-toolbar media-bar">
        <span className="json-file"><AudioLines size={13} /> {file.name}</span>
        {meta?.lossless !== null && meta?.lossless !== undefined && (
          <span className={`json-valid ${meta.lossless ? "ok" : ""}`}>{meta.lossless ? "LOSSLESS" : "LOSSY"}</span>
        )}
        <span className="audio-summary">
          {[meta?.container, meta?.bitDepth ? `${meta.bitDepth}-bit` : null,
            sampleRate ? `${(sampleRate / 1000).toFixed(1)} kHz` : null,
            channelLayout(meta?.channels ?? buffer?.numberOfChannels ?? null)].filter(Boolean).join(" · ")}
        </span>
        <span className="spacer" />
        <button className={`icon-action labelled ${inspector ? "selected" : ""}`} aria-pressed={inspector} onClick={() => setInspector((value) => !value)}><Info size={13} /> Inspector</button>
      </div>

      <div className="viewer-toolbar json-subbar">
        <span className="segmented">
          {VIEWS.map((option) => (
            <button key={option.id} className={view === option.id ? "selected" : ""} aria-pressed={view === option.id} disabled={!buffer} onClick={() => setView(option.id)}>{option.label}</button>
          ))}
        </span>
        <button className={`icon-action ${loop ? "selected" : ""}`} aria-label="Loop" aria-pressed={loop} onClick={() => setLoop((value) => !value)}><Repeat size={13} /> Loop</button>
        <span className="toolbar-divider" />
        <span className="json-stat">Zoom:</span>
        {ZOOMS.map((level) => (
          <button key={level} className={zoom === level ? "selected" : ""} onClick={() => setZoom(level)}>{level}×</button>
        ))}
        <span className="spacer" />
        {report && <span className="json-stat">Peak: <b>{formatDb(report.samplePeak)} dBFS</b></span>}
      </div>

      <div className="media-body">
        <div className="audio-main">
          <div className="audio-strip">
            <span><Activity size={11} /> {analysing ? "ANALYSING" : "DECODED"}</span>
            <span>Playhead: {formatTime(time)}</span>
            <span className="spacer" />
            <span>Length: {formatTime(duration)}</span>
          </div>

          <div className="audio-lanes">
            {channels.map((channel, index) => (
              <span key={channel.label} className="audio-lane-label" style={{ top: index * 110 + 8 }}>
                {channel.label} · Peak {formatDb(toDecibels(channel.peak))} dBFS
              </span>
            ))}
            <canvas ref={waveRef} className="audio-wave" style={{ height: Math.max(110, channels.length * 110) }}
              onClick={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                seek(((event.clientX - bounds.left) / bounds.width) * duration);
              }} />
            {duration > 0 && <span className="audio-playhead" style={{ left: `${(time / duration) * 100}%` }} />}
            {!buffer && !analysing && <div className="center muted">Waveform unavailable for this codec.</div>}
          </div>

          <div className="audio-spectrum">
            <div className="audio-strip"><span><AudioLines size={11} /> Spectrum · 4096-pt FFT</span><span className="spacer" /><span>20 Hz – {Math.round(Math.min(20000, (buffer?.sampleRate ?? 48000) / 2) / 1000)} kHz</span></div>
            <canvas ref={spectrumRef} style={{ height: 90 }} />
            {!playing && <span className="audio-spectrum-hint muted small">Press play to read the live spectrum</span>}
          </div>
        </div>

        {inspector && (
          <aside className="media-inspector" aria-label="Audio inspector">
            <div className="json-details-head"><strong><Gauge size={13} /> Loudness &amp; Dynamics</strong><em className="json-type">EBU R128</em></div>
            {report ? (
              <dl className="image-facts">
                <Row label="Integrated" value={`${formatLufs(report.integrated)} LUFS`} />
                <Row label="Short-term max" value={`${formatLufs(report.shortTermMax)} LUFS`} />
                <Row label="Momentary max" value={`${formatLufs(report.momentaryMax)} LUFS`} />
                <Row label="Loudness range" value={`${report.range.toFixed(1)} LU`} />
                <Row label="Sample peak" value={`${formatDb(report.samplePeak)} dBFS`} />
                <Row label="True peak (4× est.)" value={`${formatDb(report.truePeak)} dBTP`} />
                {report.correlation !== null && (
                  <Row label="Stereo correlation" value={`${formatDb(report.correlation)} ${report.correlation > 0.5 ? "(in phase)" : report.correlation < 0 ? "(out of phase)" : "(wide)"}`} />
                )}
              </dl>
            ) : (
              <p className="muted small">{analysing ? "Measuring loudness…" : "Loudness needs a decodable stream."}</p>
            )}

            <section>
              <h3>Codec &amp; stream</h3>
              <dl className="image-facts">
                {meta?.container && <Row label="Container" value={meta.container} />}
                {meta?.codec && <Row label="Codec" value={meta.codec} />}
                {sampleRate && <Row label="Sample rate" value={`${sampleRate.toLocaleString()} Hz`} />}
                {meta?.bitDepth && <Row label="Bit depth" value={`${meta.bitDepth}-bit`} />}
                {channelLayout(meta?.channels ?? buffer?.numberOfChannels ?? null) && (
                  <Row label="Channels" value={channelLayout(meta?.channels ?? buffer?.numberOfChannels ?? null)!} />
                )}
                {duration > 0 && <Row label="Duration" value={formatTime(duration)} />}
                <Row label="File size" value={formatBytes(file.size)} />
                {statedBitrate(meta ?? ({} as AudioMeta)) && <Row label="Bitrate" value={`${statedBitrate(meta!)!.toLocaleString()} kbps`} />}
                {meta?.encoder && <Row label="Encoder" value={meta.encoder} />}
              </dl>
            </section>

            {meta && meta.tags.length > 0 && (
              <section>
                <h3>Tags</h3>
                <dl className="image-facts">
                  {meta.tags.map((tag) => <Row key={tag.label} label={tag.label} value={tag.value} />)}
                </dl>
              </section>
            )}

            <section>
              <h3>Output</h3>
              <dl className="image-facts">
                {contextRate && <Row label="Device rate" value={`${contextRate.toLocaleString()} Hz`} />}
                {contextRate && sampleRate && (
                  <Row label="Resampling" value={contextRate === sampleRate ? "None" : `${(sampleRate / 1000).toFixed(1)} → ${(contextRate / 1000).toFixed(1)} kHz`} />
                )}
                {!contextRate && <Row label="Device rate" value="Known once playing" />}
              </dl>
            </section>
          </aside>
        )}
      </div>

      <div className="media-transport">
        <button className="icon-action" aria-label={playing ? "Pause" : "Play"} onClick={toggle}>{playing ? <Pause size={15} /> : <Play size={15} />}</button>
        <button className="icon-action" aria-label="Back 10 seconds" onClick={() => seek(time - 10)}><SkipBack size={14} /></button>
        <button className="icon-action" aria-label="Forward 10 seconds" onClick={() => seek(time + 10)}><SkipForward size={14} /></button>
        <button className="icon-action" aria-label="Restart" onClick={() => seek(0)}><RotateCcw size={14} /></button>
        <span className="media-time">{formatTime(time)} / {formatTime(duration)}</span>
        <input className="media-scrub" type="range" aria-label="Seek" min={0} max={Math.max(1, duration)} step={0.01} value={time} onChange={(event) => seek(Number(event.target.value))} />
        <label className="media-rate"><Gauge size={13} />
          <select aria-label="Playback speed" value={rate} onChange={(event) => {
            const value = Number(event.target.value);
            setRate(value);
            if (audioRef.current) audioRef.current.playbackRate = value;
          }}>
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => <option key={value} value={value}>{value}×</option>)}
          </select>
        </label>
        <button className="icon-action" aria-label={muted ? "Unmute" : "Mute"} onClick={() => {
          const next = !muted;
          setMuted(next);
          if (audioRef.current) audioRef.current.muted = next;
        }}>{muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>
        <input className="media-volume" type="range" aria-label="Volume" min={0} max={1} step={0.01} value={volume} onChange={(event) => {
          const value = Number(event.target.value);
          setVolume(value);
          if (audioRef.current) audioRef.current.volume = value;
        }} />
      </div>

      {error && <div className="validation-error">{error}</div>}

      <audio
        ref={audioRef}
        src={url ?? undefined}
        loop={loop}
        hidden
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onError={() => setError("This codec is not supported by the system WebView.")}
      />

      <div className="json-status">
        {meta?.container && <span>{meta.container}</span>}
        {meta?.bitDepth && sampleRate && <span>{meta.bitDepth}-bit {(sampleRate / 1000).toFixed(1)} kHz</span>}
        {report && <span className={report.truePeak > -0.1 ? "bad" : "ok"}>True peak {formatDb(report.truePeak)} dBTP</span>}
        <span className="spacer" />
        <span>Web Audio decode · analysis in-process</span>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd title={value}>{value}</dd></div>;
}
