/**
 * What the WebView will tell us about the machine it is running on.
 *
 * Every value here is read from a browser API at the moment it is asked for.
 * Nothing is inferred, and anything the runtime declines to expose comes back
 * as null so the panel can say "not exposed" rather than invent a number.
 */

export interface GraphicsInfo {
  api: string | null;
  vendor: string | null;
  renderer: string | null;
  /** The GPU name pulled out of the ANGLE string, when it is shaped that way. */
  gpu: string | null;
  /** The graphics backend ANGLE reports translating to, e.g. D3D11 or Vulkan. */
  backend: string | null;
  maxTextureSize: number | null;
  webgpu: boolean;
}

/**
 * Chromium reports the renderer as
 * `ANGLE (Intel, Intel(R) UHD Graphics (0x00009B41) Direct3D11 vs_5_0 ps_5_0, D3D11)`.
 * The adapter name is the middle field and the backend is the last one.
 */
export function parseAngle(renderer: string | null): { gpu: string | null; backend: string | null } {
  if (!renderer) return { gpu: null, backend: null };
  const match = /^ANGLE\s*\((.*)\)\s*$/.exec(renderer.trim());
  if (!match) return { gpu: renderer.trim() || null, backend: null };
  const parts = splitTopLevel(match[1]);
  if (parts.length < 2) return { gpu: match[1].trim() || null, backend: null };
  const backend = parts[parts.length - 1].trim() || null;
  const middle = parts.slice(1, -1).join(", ").trim();
  const adapter = (middle || parts[0]).replace(/\s+(vs_\d+_\d+|ps_\d+_\d+)/g, "").trim();
  return { gpu: adapter || null, backend };
}

/** Splits on commas that are not inside parentheses, so `(0x00009B41)` survives. */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) { parts.push(current); current = ""; continue; }
    current += char;
  }
  parts.push(current);
  return parts;
}

export function readGraphics(): GraphicsInfo {
  const empty: GraphicsInfo = {
    api: null, vendor: null, renderer: null, gpu: null, backend: null,
    maxTextureSize: null, webgpu: typeof navigator !== "undefined" && "gpu" in navigator,
  };
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return empty;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null;
    const { gpu, backend } = parseAngle(renderer);
    return {
      ...empty,
      api: String(gl.getParameter(gl.VERSION)),
      vendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : null,
      renderer,
      gpu,
      backend,
      maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || null,
    };
  } catch {
    return empty;
  }
}

export interface DisplayInfo {
  width: number | null;
  height: number | null;
  colorDepth: number | null;
  pixelRatio: number | null;
  hdr: boolean | null;
  reducedMotion: boolean | null;
}

export function readDisplay(): DisplayInfo {
  const media = (query: string): boolean | null => {
    try {
      return typeof matchMedia === "function" ? matchMedia(query).matches : null;
    } catch {
      return null;
    }
  };
  const screenOf = typeof screen !== "undefined" ? screen : null;
  return {
    width: screenOf?.width ?? null,
    height: screenOf?.height ?? null,
    colorDepth: screenOf?.colorDepth ?? null,
    pixelRatio: typeof devicePixelRatio === "number" ? devicePixelRatio : null,
    hdr: media("(dynamic-range: high)"),
    reducedMotion: media("(prefers-reduced-motion: reduce)"),
  };
}

export interface RuntimeInfo {
  cores: number | null;
  /** Chromium rounds this to a power of two and caps it at 8, so it is a floor. */
  deviceMemoryGb: number | null;
  jsHeapMb: number | null;
  jsHeapLimitMb: number | null;
}

interface HeapMemory { usedJSHeapSize: number; jsHeapSizeLimit: number }

export function readRuntime(): RuntimeInfo {
  const memory = (performance as Performance & { memory?: HeapMemory }).memory;
  return {
    cores: navigator.hardwareConcurrency ?? null,
    deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    jsHeapMb: memory ? Math.round(memory.usedJSHeapSize / 1048576) : null,
    jsHeapLimitMb: memory ? Math.round(memory.jsHeapSizeLimit / 1048576) : null,
  };
}

export interface AudioInfo {
  sampleRate: number;
  baseLatencyMs: number | null;
  outputLatencyMs: number | null;
}

/**
 * Opens a context only long enough to read its latency, then closes it. The
 * numbers are what the audio stack reports, not a target we set.
 */
export async function readAudio(): Promise<AudioInfo | null> {
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctor) return null;
  let context: AudioContext | null = null;
  try {
    context = new Ctor();
    const withOutput = context as AudioContext & { outputLatency?: number };
    return {
      sampleRate: context.sampleRate,
      baseLatencyMs: typeof context.baseLatency === "number" ? context.baseLatency * 1000 : null,
      outputLatencyMs: typeof withOutput.outputLatency === "number" ? withOutput.outputLatency * 1000 : null,
    };
  } catch {
    return null;
  } finally {
    try { await context?.close(); } catch { /* already closed */ }
  }
}

export interface CodecSupport { label: string; codec: string; supported: boolean; hardware: boolean | null }

const CODECS = [
  { label: "H.264 High", codec: "avc1.640028" },
  { label: "HEVC Main10", codec: "hev1.2.4.L120.B0" },
  { label: "VP9 Profile 0", codec: "vp09.00.10.08" },
  { label: "AV1 Main", codec: "av01.0.04M.08" },
];

interface DecoderConfig { codec: string; hardwareAcceleration?: string; codedWidth?: number; codedHeight?: number }
interface DecoderSupport { supported?: boolean; config?: DecoderConfig }
interface DecoderCtor { isConfigSupported(config: DecoderConfig): Promise<DecoderSupport> }

/**
 * Asks WebCodecs which video codecs decode here, preferring hardware. Returns
 * null when the runtime has no WebCodecs at all, so the panel can say the
 * question could not be asked rather than reporting "unsupported".
 */
export async function readCodecs(): Promise<CodecSupport[] | null> {
  const Decoder = (globalThis as { VideoDecoder?: DecoderCtor }).VideoDecoder;
  if (!Decoder || typeof Decoder.isConfigSupported !== "function") return null;
  const results: CodecSupport[] = [];
  for (const entry of CODECS) {
    try {
      const hardware = await Decoder.isConfigSupported({
        codec: entry.codec, hardwareAcceleration: "prefer-hardware", codedWidth: 1920, codedHeight: 1080,
      });
      if (hardware.supported) {
        results.push({ ...entry, supported: true, hardware: hardware.config?.hardwareAcceleration === "prefer-hardware" });
        continue;
      }
      const any = await Decoder.isConfigSupported({ codec: entry.codec, codedWidth: 1920, codedHeight: 1080 });
      results.push({ ...entry, supported: Boolean(any.supported), hardware: any.supported ? false : null });
    } catch {
      results.push({ ...entry, supported: false, hardware: null });
    }
  }
  return results;
}

export interface FrameSummary {
  frames: number;
  medianMs: number;
  averageMs: number;
  peakMs: number;
  hz: number;
  intervals: number[];
}

/** Turns raw frame timestamps into the numbers the panel shows. */
export function summariseFrames(timestamps: number[]): FrameSummary | null {
  if (timestamps.length < 2) return null;
  const intervals: number[] = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    intervals.push(timestamps[index] - timestamps[index - 1]);
  }
  const sorted = [...intervals].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  let total = 0;
  let peak = 0;
  for (const value of intervals) {
    total += value;
    if (value > peak) peak = value;
  }
  return {
    frames: intervals.length,
    medianMs: median,
    averageMs: total / intervals.length,
    peakMs: peak,
    hz: median > 0 ? 1000 / median : 0,
    intervals,
  };
}

/**
 * Samples animation-frame timing.
 *
 * The window manager stops delivering frames to a hidden or minimised window,
 * so this gives up after `timeoutMs` and reports what it collected instead of
 * waiting for callbacks that will never arrive.
 */
export function sampleFrames(count = 60, timeoutMs = 4000): Promise<FrameSummary | null> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") { resolve(null); return; }
    const timestamps: number[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      resolve(summariseFrames(timestamps));
    };
    const timer = window.setTimeout(finish, timeoutMs);
    const step = (timestamp: number) => {
      if (done) return;
      timestamps.push(timestamp);
      if (timestamps.length > count) finish();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
