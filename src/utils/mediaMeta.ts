export interface MediaMeta {
  container: string | null;
  durationSeconds: number | null;
  video: {
    codec: string | null;
    profile: string | null;
    width: number | null;
    height: number | null;
  } | null;
  audio: {
    codec: string | null;
    sampleRate: number | null;
    channels: number | null;
  } | null;
}

const EMPTY: MediaMeta = { container: null, durationSeconds: null, video: null, audio: null };

const CODECS: Record<string, string> = {
  avc1: "H.264 / AVC", avc3: "H.264 / AVC", hev1: "H.265 / HEVC", hvc1: "H.265 / HEVC",
  av01: "AV1", vp08: "VP8", vp09: "VP9", mp4v: "MPEG-4 Visual",
  mp4a: "AAC", "ac-3": "AC-3", "ec-3": "E-AC-3", alac: "ALAC", Opus: "Opus", opus: "Opus",
  fLaC: "FLAC", twos: "PCM", sowt: "PCM",
};

const AVC_PROFILES: Record<number, string> = {
  66: "Baseline", 77: "Main", 88: "Extended", 100: "High", 110: "High 10",
  122: "High 4:2:2", 244: "High 4:4:4",
};

const AAC_OBJECT_TYPES: Record<number, string> = {
  1: "AAC Main", 2: "AAC LC", 3: "AAC SSR", 4: "AAC LTP", 5: "HE-AAC", 29: "HE-AAC v2",
};

const WEBM_CODECS: Record<string, string> = {
  "V_VP8": "VP8", "V_VP9": "VP9", "V_AV1": "AV1", "V_MPEG4/ISO/AVC": "H.264 / AVC",
  "A_OPUS": "Opus", "A_VORBIS": "Vorbis", "A_AAC": "AAC", "A_FLAC": "FLAC",
};

/**
 * Reads track details straight out of the container. The WebView exposes almost
 * nothing about the streams it decodes, so anything shown has to come from here
 * or be left out.
 */
export function readMediaMeta(bytes: Uint8Array): MediaMeta {
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") return readMp4(bytes);
  if (bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return readWebm(bytes);
  }
  return { ...EMPTY };
}

interface Box { type: string; start: number; end: number }

function boxes(bytes: Uint8Array, from: number, to: number): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: Box[] = [];
  let offset = from;
  while (offset + 8 <= to) {
    let size = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, 4);
    let start = offset + 8;
    if (size === 1) {
      if (offset + 16 > to) break;
      size = Number(view.getBigUint64(offset + 8));
      start = offset + 16;
    } else if (size === 0) {
      size = to - offset;
    }
    const end = Math.min(to, offset + size);
    if (size < 8 || end <= start) break;
    found.push({ type, start, end });
    offset = offset + size;
  }
  return found;
}

function find(bytes: Uint8Array, list: Box[], path: string[]): Box | null {
  let current = list;
  let match: Box | null = null;
  for (const name of path) {
    match = current.find((box) => box.type === name) ?? null;
    if (!match) return null;
    current = boxes(bytes, match.start, match.end);
  }
  return match;
}

function readMp4(bytes: Uint8Array): MediaMeta {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const meta: MediaMeta = { ...EMPTY, container: `MP4 (${ascii(bytes, 8, 4).trim()})` };
  const top = boxes(bytes, 0, bytes.length);
  const moov = top.find((box) => box.type === "moov");
  if (!moov) return meta;
  const inMoov = boxes(bytes, moov.start, moov.end);

  const mvhd = inMoov.find((box) => box.type === "mvhd");
  if (mvhd) {
    const version = bytes[mvhd.start];
    const base = mvhd.start + 4;
    const needed = version === 1 ? 28 : 16;
    if (base + needed <= mvhd.end) {
      const timescale = version === 1 ? view.getUint32(base + 16) : view.getUint32(base + 8);
      const duration = version === 1 ? Number(view.getBigUint64(base + 20)) : view.getUint32(base + 12);
      if (timescale > 0) meta.durationSeconds = duration / timescale;
    }
  }

  for (const trak of inMoov.filter((box) => box.type === "trak")) {
    const inTrak = boxes(bytes, trak.start, trak.end);
    const hdlr = find(bytes, inTrak, ["mdia", "hdlr"]);
    if (!hdlr) continue;
    const kind = ascii(bytes, hdlr.start + 8, 4);
    const stsd = find(bytes, inTrak, ["mdia", "minf", "stbl", "stsd"]);
    if (!stsd) continue;
    const entries = boxes(bytes, stsd.start + 8, stsd.end);
    const entry = entries[0];
    if (!entry) continue;

    if (kind === "vide" && !meta.video && entry.start + 28 <= entry.end) {
      const width = view.getUint16(entry.start + 24);
      const height = view.getUint16(entry.start + 26);
      const inner = entry.start + 78 <= entry.end ? boxes(bytes, entry.start + 78, entry.end) : [];
      const avcC = inner.find((box) => box.type === "avcC");
      const hvcC = inner.find((box) => box.type === "hvcC");
      let profile: string | null = null;
      if (avcC && avcC.end - avcC.start >= 4) {
        const name = AVC_PROFILES[bytes[avcC.start + 1]] ?? `Profile ${bytes[avcC.start + 1]}`;
        profile = `${name} @ L${(bytes[avcC.start + 3] / 10).toFixed(1)}`;
      } else if (hvcC && hvcC.end - hvcC.start >= 13) {
        const tier = (bytes[hvcC.start + 1] & 0x20) === 0 ? "Main" : "High";
        profile = `${tier} tier @ L${(bytes[hvcC.start + 12] / 30).toFixed(1)}`;
      }
      meta.video = { codec: CODECS[entry.type] ?? entry.type, profile, width, height };
    }

    if (kind === "soun" && !meta.audio && entry.start + 28 <= entry.end) {
      const channels = view.getUint16(entry.start + 16);
      const sampleRate = view.getUint16(entry.start + 24);
      let codec = CODECS[entry.type] ?? entry.type;
      const esds = boxes(bytes, entry.start + 28, entry.end).find((item) => item.type === "esds");
      if (esds) {
        const objectType = readAacObjectType(bytes, esds.start, esds.end);
        if (objectType && AAC_OBJECT_TYPES[objectType]) codec = AAC_OBJECT_TYPES[objectType];
      }
      meta.audio = { codec, sampleRate: sampleRate || null, channels: channels || null };
    }
  }
  return meta;
}

/** Finds the DecoderSpecificInfo descriptor and reads its 5-bit object type. */
function readAacObjectType(bytes: Uint8Array, start: number, end: number): number | null {
  for (let offset = start; offset < end - 2; offset += 1) {
    if (bytes[offset] !== 0x05) continue;
    let cursor = offset + 1;
    let length = 0;
    for (let index = 0; index < 4 && cursor < end; index += 1) {
      const byte = bytes[cursor];
      cursor += 1;
      length = (length << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    if (length >= 2 && cursor < end) return bytes[cursor] >> 3;
  }
  return null;
}

/** A minimal EBML walk: enough for the codec ids and track geometry. */
function readWebm(bytes: Uint8Array): MediaMeta {
  const meta: MediaMeta = { ...EMPTY, container: "WebM / Matroska" };
  const limit = Math.min(bytes.length, 4 * 1024 * 1024);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const video: NonNullable<MediaMeta["video"]> = { codec: null, profile: null, width: null, height: null };
  const audio: NonNullable<MediaMeta["audio"]> = { codec: null, sampleRate: null, channels: null };
  let offset = 0;

  while (offset < limit) {
    const id = readVint(bytes, offset, limit, true);
    if (!id) break;
    const size = readVint(bytes, id.next, limit, false);
    if (!size) break;
    const start = size.next;
    const end = Math.min(limit, start + size.value);
    const master = [0x18538067, 0x1654ae6b, 0xae, 0xe0, 0xe1].includes(id.value);

    if (id.value === 0x86) {
      const codecId = stripNulls(ascii(bytes, start, end - start));
      const name = WEBM_CODECS[codecId] ?? codecId;
      if (codecId.startsWith("V_")) video.codec = name;
      else if (codecId.startsWith("A_")) audio.codec = name;
    } else if (id.value === 0xb0) {
      video.width = readUint(bytes, start, end);
    } else if (id.value === 0xba) {
      video.height = readUint(bytes, start, end);
    } else if (id.value === 0x9f) {
      audio.channels = readUint(bytes, start, end);
    } else if (id.value === 0xb5) {
      const width = end - start;
      const rate = width === 4 ? view.getFloat32(start) : width === 8 ? view.getFloat64(start) : null;
      if (rate) audio.sampleRate = Math.round(rate);
    }

    // Descend into master elements, skip over the rest, and never stand still.
    const nextOffset = master ? start : end;
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }

  meta.video = video.codec || video.width ? video : null;
  meta.audio = audio.codec || audio.channels ? audio : null;
  return meta;
}

/** Matroska pads strings with NULs; a character filter avoids a control regex. */
function stripNulls(value: string): string {
  return [...value].filter((character) => character !== " ").join("");
}

function readVint(bytes: Uint8Array, offset: number, limit: number, keepMarker: boolean): { value: number; next: number } | null {
  if (offset >= limit) return null;
  const first = bytes[offset];
  if (first === 0) return null;
  let length = 1;
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length += 1;
  if (length > 8 || offset + length > limit) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  for (let index = 1; index < length; index += 1) value = value * 256 + bytes[offset + index];
  return { value, next: offset + length };
}

function readUint(bytes: Uint8Array, start: number, end: number): number | null {
  if (end <= start || end - start > 8) return null;
  let value = 0;
  for (let index = start; index < end; index += 1) value = value * 256 + bytes[index];
  return value;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  if (start < 0 || length <= 0 || start + length > bytes.length) return "";
  let text = "";
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(bytes[start + index]);
  return text;
}

/** Average bitrate over the whole file; the only bitrate a player can honestly state. */
export function averageBitrate(sizeBytes: number, durationSeconds: number | null): string | null {
  if (!durationSeconds || durationSeconds <= 0 || sizeBytes <= 0) return null;
  const bits = (sizeBytes * 8) / durationSeconds;
  if (bits >= 1_000_000) return `${(bits / 1_000_000).toFixed(1)} Mbps avg`;
  return `${Math.round(bits / 1000)} kbps avg`;
}

export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--:--";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "Unknown duration";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}
