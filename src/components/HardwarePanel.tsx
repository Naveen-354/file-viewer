import { useCallback, useEffect, useState } from "react";
import { Activity, Cpu, Gauge, Monitor, Music, Video } from "lucide-react";
import {
  readAudio, readCodecs, readDisplay, readGraphics, readRuntime, sampleFrames,
  type AudioInfo, type CodecSupport, type FrameSummary,
} from "../utils/hardware";

const FRAME_COUNT = 60;

export function HardwarePanel({ matches }: { matches: (...text: string[]) => boolean }) {
  const graphics = readGraphics();
  const display = readDisplay();
  const [runtime, setRuntime] = useState(() => readRuntime());
  const [audio, setAudio] = useState<AudioInfo | null | "pending">("pending");
  const [codecs, setCodecs] = useState<CodecSupport[] | null | "pending">("pending");
  const [frames, setFrames] = useState<FrameSummary | null>(null);
  const [measuring, setMeasuring] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readAudio().then((value) => { if (!cancelled) setAudio(value); });
    void readCodecs().then((value) => { if (!cancelled) setCodecs(value); });
    return () => { cancelled = true; };
  }, []);

  const measure = useCallback(async () => {
    setMeasuring(true);
    setFrames(await sampleFrames(FRAME_COUNT));
    setRuntime(readRuntime());
    setMeasuring(false);
  }, []);

  return (
    <>
      {matches("gpu", "graphics", "adapter", "backend", "webgl", "render", "compositor") && (
        <section className="settings-card">
          <header><Cpu size={14} /><div><strong>Graphics adapter</strong><small>Reported by the WebView's own graphics stack.</small></div></header>
          <dl className="engine-facts wide">
            <Fact label="Adapter" value={graphics.gpu} />
            <Fact label="Backend" value={graphics.backend} />
            <Fact label="Driver vendor" value={graphics.vendor} />
            <Fact label="Graphics API" value={graphics.api} />
            <Fact label="Max texture" value={graphics.maxTextureSize ? `${graphics.maxTextureSize} px` : null} />
            <Fact label="WebGPU" value={graphics.webgpu ? "Available" : "Not exposed"} />
          </dl>
          {!graphics.renderer && (
            <p className="engine-note">This WebView does not expose the adapter, so nothing above could be read.</p>
          )}
          <p className="engine-note">
            OneOpen does not pick a graphics backend, cap a texture budget or manage a shader
            cache. The WebView chooses the backend shown here, and everything on this page is
            read from it — there is nothing to configure.
          </p>
        </section>
      )}

      {matches("display", "screen", "hdr", "resolution", "refresh", "monitor", "scaling") && (
        <section className="settings-card">
          <header><Monitor size={14} /><div><strong>Display</strong><small>The screen this window is on, as the system describes it.</small></div></header>
          <dl className="engine-facts">
            <Fact label="Resolution" value={display.width && display.height ? `${display.width} × ${display.height}` : null} />
            <Fact label="Scale factor" value={display.pixelRatio ? `${display.pixelRatio}×` : null} />
            <Fact label="Colour depth" value={display.colorDepth ? `${display.colorDepth}-bit` : null} />
            <Fact label="High dynamic range" value={display.hdr === null ? null : display.hdr ? "Reported" : "Not reported"} />
            <Fact label="Reduced motion" value={display.reducedMotion === null ? null : display.reducedMotion ? "Requested" : "Not requested"} />
            <Fact label="Refresh rate" value={frames ? `${frames.hz.toFixed(1)} Hz measured` : "Measure to find out"} />
          </dl>
        </section>
      )}

      {matches("frame", "latency", "timing", "compositor", "performance", "fps") && (
        <section className="settings-card">
          <header><Activity size={14} /><div><strong>Frame timing</strong><small>Measured from this window's own animation frames, over {FRAME_COUNT} frames.</small></div></header>

          <div className="setting-row">
            <span><strong>Sample the compositor</strong><small>Nothing is measured until you ask. The window must be visible — a minimised window stops receiving frames.</small></span>
            <button className="icon-action labelled" disabled={measuring} onClick={() => void measure()}>
              <Gauge size={12} /> {measuring ? "Measuring…" : "Measure"}
            </button>
          </div>

          {frames && (
            <>
              <dl className="engine-facts">
                <Fact label="Frames sampled" value={String(frames.frames)} />
                <Fact label="Median" value={`${frames.medianMs.toFixed(2)} ms`} />
                <Fact label="Average" value={`${frames.averageMs.toFixed(2)} ms`} />
                <Fact label="Longest" value={`${frames.peakMs.toFixed(2)} ms`} />
              </dl>
              <Sparkline intervals={frames.intervals} />
              {frames.frames < FRAME_COUNT && (
                <p className="engine-note">
                  Only {frames.frames} frames arrived before the sampler gave up. That happens when
                  the window is hidden or minimised, so this sample is not representative.
                </p>
              )}
            </>
          )}
        </section>
      )}

      {matches("video", "codec", "decode", "hardware", "h264", "hevc", "av1", "vp9") && (
        <section className="settings-card">
          <header><Video size={14} /><div><strong>Video decoding</strong><small>What the WebView says it can decode, asked with a preference for hardware.</small></div></header>
          {codecs === "pending" && <p className="muted">Asking the decoder…</p>}
          {codecs === null && (
            <p className="engine-note">
              This WebView has no WebCodecs API, so the question cannot be asked. The media viewer
              still plays whatever the built-in player supports; OneOpen has no bundled codecs and
              cannot switch a decoder to hardware.
            </p>
          )}
          {Array.isArray(codecs) && (
            <div className="engine-table-wrap">
              <table className="engine-table">
                <thead><tr><th>Codec</th><th>Profile string</th><th>Decodes</th><th>Hardware</th></tr></thead>
                <tbody>
                  {codecs.map((codec) => (
                    <tr key={codec.codec}>
                      <td>{codec.label}</td>
                      <td className="engine-module">{codec.codec}</td>
                      <td><span className={`engine-runtime ${codec.supported ? "core" : "webview"}`}>{codec.supported ? "Yes" : "No"}</span></td>
                      <td>{codec.hardware === null ? "—" : codec.hardware ? "Accepted" : "Software"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {matches("audio", "latency", "sample rate", "output", "sound") && (
        <section className="settings-card">
          <header><Music size={14} /><div><strong>Audio output</strong><small>Read from an audio context opened briefly and closed again.</small></div></header>
          {audio === "pending" && <p className="muted">Reading the audio stack…</p>}
          {audio === null && <p className="engine-note">This runtime has no Web Audio API, so nothing could be read.</p>}
          {audio && audio !== "pending" && (
            <dl className="engine-facts">
              <Fact label="Sample rate" value={`${audio.sampleRate.toLocaleString()} Hz`} />
              <Fact label="Base latency" value={audio.baseLatencyMs === null ? null : `${audio.baseLatencyMs.toFixed(2)} ms`} />
              <Fact label="Output latency" value={audio.outputLatencyMs === null ? null : `${audio.outputLatencyMs.toFixed(2)} ms`} />
            </dl>
          )}
          <p className="engine-note">
            These are the figures the system audio stack reports. OneOpen does not open an
            exclusive-mode or ASIO device and has no mixer of its own.
          </p>
        </section>
      )}

      {matches("cpu", "memory", "cores", "heap", "ram", "processor") && (
        <section className="settings-card">
          <header><Gauge size={14} /><div><strong>Processor and memory</strong><small>What the runtime discloses. It deliberately reports these coarsely.</small></div></header>
          <dl className="engine-facts">
            <Fact label="Logical cores" value={runtime.cores ? String(runtime.cores) : null} />
            <Fact
              label="Device memory"
              value={runtime.deviceMemoryGb ? `${runtime.deviceMemoryGb} GB or more` : "Not exposed"}
              hint="Rounded down to a power of two and capped at 8 GB by the browser, so it is a floor, not the real figure."
            />
            <Fact label="JS heap in use" value={runtime.jsHeapMb === null ? null : `${runtime.jsHeapMb.toLocaleString()} MB`} />
            <Fact label="JS heap ceiling" value={runtime.jsHeapLimitMb === null ? null : `${runtime.jsHeapLimitMb.toLocaleString()} MB`} />
          </dl>
          <p className="engine-note">
            The heap figures cover this window's JavaScript only. They are not the process's total
            memory, and OneOpen does not measure GPU memory — nothing in the WebView reports it.
          </p>
        </section>
      )}
    </>
  );
}

/** A row is dropped when the runtime declines to report the value. */
function Fact({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  if (!value) return null;
  return <div><dt title={hint}>{label}</dt><dd title={hint ?? value}>{value}</dd></div>;
}

/** Draws the sampled frame intervals, with a line marking the median. */
function Sparkline({ intervals }: { intervals: number[] }) {
  if (intervals.length < 2) return null;
  const width = 100;
  const height = 28;
  const peak = Math.max(...intervals, 1);
  const points = intervals
    .map((value, index) => {
      const x = (index / (intervals.length - 1)) * width;
      const y = height - (value / peak) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <div className="frame-spark">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Frame interval history">
        <polyline points={points} />
      </svg>
      <span>peak {peak.toFixed(1)} ms</span>
    </div>
  );
}
