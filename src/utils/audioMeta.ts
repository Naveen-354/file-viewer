export interface AudioTag {
  label: string;
  value: string;
}

export interface AudioMeta {
  container: string | null;
  codec: string | null;
  lossless: boolean | null;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  totalSamples: number | null;
  bitrateKbps: number | null;
  encoder: string | null;
  tags: AudioTag[];
}

const EMPTY: AudioMeta = {
  container: null, codec: null, lossless: null, sampleRate: null, bitDepth: null,
  channels: null, totalSamples: null, bitrateKbps: null, encoder: null, tags: [],
};

/** Vorbis/ID3 keys worth surfacing, in the order a studio panel lists them. */
const TAG_LABELS: Record<string, string> = {
  TITLE: "Title", ARTIST: "Artist", ALBUM: "Album", ALBUMARTIST: "Album artist",
  DATE: "Date", GENRE: "Genre", ISRC: "ISRC", ENGINEER: "Engineer", PRODUCER: "Producer",
  TRACKNUMBER: "Track", COMMENT: "Comment", DESCRIPTION: "Description", COPYRIGHT: "Copyright",
  TIT2: "Title", TPE1: "Artist", TALB: "Album", TPE2: "Album artist", TDRC: "Date",
  TYER: "Date", TCON: "Genre", TSRC: "ISRC", TRCK: "Track", TSSE: "Encoder", COMM: "Comment",
};

const ORDER = ["Title", "Artist", "Album", "Album artist", "Date", "Genre", "Track", "ISRC", "Engineer", "Producer"];

export function readAudioMeta(bytes: Uint8Array): AudioMeta {
  if (ascii(bytes, 0, 4) === "fLaC") return readFlac(bytes);
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return readWav(bytes);
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return readMp3(bytes);
  if (ascii(bytes, 0, 4) === "OggS") return { ...EMPTY, container: "Ogg", codec: "Vorbis / Opus", lossless: false };
  return { ...EMPTY };
}

function readFlac(bytes: Uint8Array): AudioMeta {
  const meta: AudioMeta = { ...EMPTY, container: "FLAC", codec: "Free Lossless Audio Codec", lossless: true, tags: [] };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 4;
  while (offset + 4 <= bytes.length) {
    const header = bytes[offset];
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    const start = offset + 4;
    if (start + length > bytes.length) break;

    if (type === 0 && length >= 34) {
      // 20 bits sample rate, 3 bits channels-1, 5 bits depth-1, 36 bits samples.
      const packed = view.getUint32(start + 10);
      meta.sampleRate = packed >>> 12;
      meta.channels = ((packed >>> 9) & 0x07) + 1;
      meta.bitDepth = ((packed >>> 4) & 0x1f) + 1;
      const high = packed & 0x0f;
      meta.totalSamples = high * 2 ** 32 + view.getUint32(start + 14);
    } else if (type === 4) {
      readVorbisComment(bytes, start, start + length, meta);
    }
    if (last) break;
    offset = start + length;
  }
  return meta;
}

function readVorbisComment(bytes: Uint8Array, start: number, end: number, meta: AudioMeta): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = start;
  if (cursor + 4 > end) return;
  const vendorLength = view.getUint32(cursor, true);
  cursor += 4;
  if (cursor + vendorLength > end) return;
  meta.encoder = utf8(bytes, cursor, vendorLength) || null;
  cursor += vendorLength;
  if (cursor + 4 > end) return;
  const count = view.getUint32(cursor, true);
  cursor += 4;
  for (let index = 0; index < count && index < 64 && cursor + 4 <= end; index += 1) {
    const length = view.getUint32(cursor, true);
    cursor += 4;
    if (cursor + length > end) break;
    const entry = utf8(bytes, cursor, length);
    cursor += length;
    const split = entry.indexOf("=");
    if (split <= 0) continue;
    push(meta, entry.slice(0, split).toUpperCase(), entry.slice(split + 1));
  }
}

function readWav(bytes: Uint8Array): AudioMeta {
  const meta: AudioMeta = { ...EMPTY, container: "WAV (RIFF)", tags: [] };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (size > bytes.length - start) break;

    if (id === "fmt " && size >= 16) {
      const format = view.getUint16(start, true);
      meta.channels = view.getUint16(start + 2, true);
      meta.sampleRate = view.getUint32(start + 4, true);
      meta.bitDepth = view.getUint16(start + 14, true);
      meta.codec = format === 1 ? "Linear PCM" : format === 3 ? "IEEE float PCM" : format === 0xfffe ? "Extensible PCM" : `Format ${format}`;
      meta.lossless = format === 1 || format === 3 || format === 0xfffe;
    } else if (id === "LIST" && ascii(bytes, start, 4) === "INFO") {
      let cursor = start + 4;
      while (cursor + 8 <= start + size) {
        const tag = ascii(bytes, cursor, 4);
        const tagSize = view.getUint32(cursor + 4, true);
        const value = stripNulls(utf8(bytes, cursor + 8, tagSize)).trim();
        const label = { INAM: "Title", IART: "Artist", IPRD: "Album", ICRD: "Date", IGNR: "Genre", ISFT: "Encoder", ICMT: "Comment" }[tag];
        if (label && value) {
          if (label === "Encoder") meta.encoder = value;
          else meta.tags.push({ label, value });
        }
        cursor += 8 + tagSize + (tagSize % 2);
      }
    }
    offset = start + size + (size % 2);
  }
  return meta;
}

const MP3_RATES = [44100, 48000, 32000];
const MP3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

function readMp3(bytes: Uint8Array): AudioMeta {
  const meta: AudioMeta = { ...EMPTY, container: "MP3", codec: "MPEG Layer III", lossless: false, tags: [] };
  let offset = 0;
  if (ascii(bytes, 0, 3) === "ID3") {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    readId3(bytes, 10, Math.min(bytes.length, 10 + size), meta);
    offset = 10 + size;
  }
  for (let index = offset; index + 3 < bytes.length && index < offset + 200000; index += 1) {
    if (bytes[index] !== 0xff || (bytes[index + 1] & 0xe0) !== 0xe0) continue;
    const version = (bytes[index + 1] >> 3) & 0x03;
    const bitrateIndex = (bytes[index + 2] >> 4) & 0x0f;
    const rateIndex = (bytes[index + 2] >> 2) & 0x03;
    const mode = (bytes[index + 3] >> 6) & 0x03;
    if (rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) continue;
    const base = MP3_RATES[rateIndex];
    meta.sampleRate = version === 3 ? base : version === 2 ? base / 2 : base / 4;
    meta.bitrateKbps = MP3_BITRATES[bitrateIndex];
    meta.channels = mode === 3 ? 1 : 2;
    break;
  }
  return meta;
}

function readId3(bytes: Uint8Array, start: number, end: number, meta: AudioMeta): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = start;
  while (cursor + 10 <= end) {
    const id = ascii(bytes, cursor, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = view.getUint32(cursor + 4);
    const body = cursor + 10;
    if (size <= 0 || body + size > end) break;
    const encoding = bytes[body];
    const raw = encoding === 1 || encoding === 2
      ? utf16(bytes, body + 1, size - 1)
      : utf8(bytes, body + 1, size - 1);
    const value = stripNulls(raw).trim();
    if (value) {
      if (id === "TSSE") meta.encoder = value;
      else push(meta, id, value);
    }
    cursor = body + size;
  }
}

function push(meta: AudioMeta, key: string, value: string): void {
  const label = TAG_LABELS[key];
  const text = value.trim();
  if (!label || !text || meta.tags.some((tag) => tag.label === label)) return;
  meta.tags.push({ label, value: text.slice(0, 120) });
  meta.tags.sort((left, right) => rank(left.label) - rank(right.label));
}

function rank(label: string): number {
  const index = ORDER.indexOf(label);
  return index === -1 ? ORDER.length : index;
}

/** Both WAV INFO and ID3 pad text with NULs; filtering avoids a control regex. */
function stripNulls(value: string): string {
  return [...value].filter((character) => character !== "\u0000").join("");
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  if (start < 0 || length <= 0 || start + length > bytes.length) return "";
  let text = "";
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(bytes[start + index]);
  return text;
}

function utf8(bytes: Uint8Array, start: number, length: number): string {
  if (start < 0 || length <= 0 || start + length > bytes.length) return "";
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(start, start + length));
}

function utf16(bytes: Uint8Array, start: number, length: number): string {
  if (start < 0 || length <= 0 || start + length > bytes.length) return "";
  return new TextDecoder("utf-16", { fatal: false }).decode(bytes.subarray(start, start + length));
}

/** Bits per second implied by the stream itself, when the header states it. */
export function statedBitrate(meta: AudioMeta): number | null {
  if (meta.bitrateKbps) return meta.bitrateKbps;
  if (meta.sampleRate && meta.bitDepth && meta.channels && meta.lossless !== false) {
    return Math.round((meta.sampleRate * meta.bitDepth * meta.channels) / 1000);
  }
  return null;
}

export function channelLayout(channels: number | null): string | null {
  if (!channels) return null;
  const names: Record<number, string> = {
    1: "1.0 Mono", 2: "2.0 Stereo", 3: "2.1", 4: "4.0 Quad", 6: "5.1 Surround", 8: "7.1 Surround",
  };
  return names[channels] ?? `${channels} channels`;
}
