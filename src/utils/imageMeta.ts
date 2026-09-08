export interface MetaField {
  label: string;
  value: string;
}

export interface ImageMeta {
  /** Container format, from the file's own signature rather than its name. */
  format: string | null;
  width: number | null;
  height: number | null;
  bitDepth: string | null;
  colorType: string | null;
  compression: string | null;
  interlace: string | null;
  colorSpace: string | null;
  /** Everything else worth showing, in the order it was found. */
  extra: MetaField[];
}

const EMPTY: ImageMeta = {
  format: null, width: null, height: null, bitDepth: null, colorType: null,
  compression: null, interlace: null, colorSpace: null, extra: [],
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const PNG_COLOR_TYPES: Record<number, { label: string; channels: number }> = {
  0: { label: "Greyscale", channels: 1 },
  2: { label: "Truecolour (RGB)", channels: 3 },
  3: { label: "Indexed", channels: 1 },
  4: { label: "Greyscale + alpha", channels: 2 },
  6: { label: "Truecolour + alpha (RGBA)", channels: 4 },
};

/**
 * Reads what the file itself states. Anything absent stays null so the panel can
 * omit the row rather than display a plausible guess.
 */
export function readImageMeta(bytes: Uint8Array): ImageMeta {
  if (startsWith(bytes, PNG_SIGNATURE)) return readPng(bytes);
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return readJpeg(bytes);
  if (startsWith(bytes, [0x47, 0x49, 0x46])) return { ...EMPTY, format: "GIF", compression: "LZW" };
  if (startsWith(bytes, [0x42, 0x4d])) return { ...EMPTY, format: "BMP", compression: "None / RLE" };
  if (bytes.length > 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return { ...EMPTY, format: "WebP", compression: ascii(bytes, 12, 4) === "VP8L" ? "Lossless (VP8L)" : "VP8" };
  }
  return { ...EMPTY };
}

function readPng(bytes: Uint8Array): ImageMeta {
  const meta: ImageMeta = { ...EMPTY, format: "PNG", compression: "Deflate / PNG", extra: [] };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, 4);
    const start = offset + 8;
    if (length > bytes.length - start) break;

    if (type === "IHDR" && length >= 13) {
      meta.width = view.getUint32(start);
      meta.height = view.getUint32(start + 4);
      const depth = bytes[start + 8];
      const colorType = bytes[start + 9];
      const info = PNG_COLOR_TYPES[colorType];
      meta.colorType = info?.label ?? `Type ${colorType}`;
      meta.bitDepth = info ? `${depth * info.channels}-bit (${depth}bpc)` : `${depth}-bit`;
      meta.interlace = bytes[start + 12] === 1 ? "Adam7" : "Non-interlaced";
    } else if (type === "sRGB" && length >= 1) {
      const intents = ["Perceptual", "Relative colorimetric", "Saturation", "Absolute colorimetric"];
      meta.colorSpace = "sRGB";
      meta.extra.push({ label: "Rendering intent", value: intents[bytes[start]] ?? String(bytes[start]) });
    } else if (type === "gAMA" && length >= 4) {
      meta.extra.push({ label: "Gamma", value: (100000 / view.getUint32(start)).toFixed(2) });
    } else if (type === "cHRM" && length >= 32) {
      const x = view.getUint32(start) / 100000;
      const y = view.getUint32(start + 4) / 100000;
      meta.extra.push({ label: "White point", value: `${x.toFixed(4)}, ${y.toFixed(4)}` });
    } else if (type === "iCCP") {
      const name = readZeroTerminated(bytes, start, Math.min(start + length, bytes.length));
      meta.colorSpace = name || "Embedded ICC profile";
      meta.extra.push({ label: "ICC profile", value: name || "Embedded" });
    } else if (type === "pHYs" && length >= 9) {
      if (bytes[start + 8] === 1) {
        const dpi = Math.round(view.getUint32(start) * 0.0254);
        meta.extra.push({ label: "Resolution", value: `${dpi} DPI` });
      }
    } else if (type === "tEXt" || type === "iTXt") {
      const keyword = readZeroTerminated(bytes, start, Math.min(start + length, bytes.length));
      const valueStart = start + keyword.length + 1;
      const raw = ascii(bytes, valueStart, Math.max(0, length - keyword.length - 1)).replace(/\0/g, " ").trim();
      if (keyword && raw && meta.extra.length < 12) meta.extra.push({ label: keyword, value: raw.slice(0, 80) });
    } else if (type === "IDAT" || type === "IEND") {
      break;
    }
    offset = start + length + 4;
  }
  return meta;
}

const EXIF_TAGS: Record<number, string> = {
  0x010f: "Camera make",
  0x0110: "Camera model",
  0x0112: "Orientation",
  0x0131: "Software",
  0x0132: "Modified",
};

function readJpeg(bytes: Uint8Array): ImageMeta {
  const meta: ImageMeta = { ...EMPTY, format: "JPEG", compression: "Baseline DCT", extra: [] };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = view.getUint16(offset + 2);
    const start = offset + 4;
    if (length < 2 || start + length - 2 > bytes.length) break;

    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const precision = bytes[start];
      meta.height = view.getUint16(start + 1);
      meta.width = view.getUint16(start + 3);
      const components = bytes[start + 5];
      meta.bitDepth = `${precision * components}-bit (${precision}bpc)`;
      meta.colorType = components === 1 ? "Greyscale" : components === 4 ? "CMYK" : "YCbCr";
      if (marker === 0xc2) meta.compression = "Progressive DCT";
    } else if (marker === 0xe0 && ascii(bytes, start, 4) === "JFIF") {
      if (bytes[start + 7] === 1) meta.extra.push({ label: "Resolution", value: `${view.getUint16(start + 8)} DPI` });
    } else if (marker === 0xe1 && ascii(bytes, start, 4) === "Exif") {
      for (const field of readExif(bytes, start + 6, length - 8)) meta.extra.push(field);
    } else if (marker === 0xe2 && ascii(bytes, start, 11) === "ICC_PROFILE") {
      meta.colorSpace = "Embedded ICC profile";
    } else if (marker === 0xda) {
      break;
    }
    offset = start + length - 2;
  }
  return meta;
}

/** Reads only the top-level IFD0 string and short tags worth showing. */
function readExif(bytes: Uint8Array, start: number, length: number): MetaField[] {
  const fields: MetaField[] = [];
  if (start + 8 > bytes.length || length <= 0) return fields;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = ascii(bytes, start, 2) === "II";
  const read16 = (at: number) => view.getUint16(at, little);
  const read32 = (at: number) => view.getUint32(at, little);
  if (read16(start + 2) !== 0x002a) return fields;

  const directory = start + read32(start + 4);
  if (directory + 2 > bytes.length) return fields;
  const count = read16(directory);
  for (let index = 0; index < count && index < 40; index += 1) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > bytes.length) break;
    const tag = read16(entry);
    const label = EXIF_TAGS[tag];
    if (!label) continue;
    const type = read16(entry + 2);
    const size = read32(entry + 4);
    if (type === 2) {
      const valueOffset = size > 4 ? start + read32(entry + 8) : entry + 8;
      const text = ascii(bytes, valueOffset, Math.max(0, size - 1)).replace(/\0/g, "").trim();
      if (text) fields.push({ label, value: text.slice(0, 60) });
    } else if (type === 3) {
      fields.push({ label, value: String(read16(entry + 8)) });
    }
  }
  return fields;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  if (start < 0 || length <= 0 || start + length > bytes.length) return "";
  let text = "";
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(bytes[start + index]);
  return text;
}

function readZeroTerminated(bytes: Uint8Array, start: number, limit: number): string {
  let text = "";
  for (let index = start; index < limit && index < bytes.length; index += 1) {
    if (bytes[index] === 0) break;
    text += String.fromCharCode(bytes[index]);
  }
  return text;
}

/** `3840x2160` becomes `16:9`. */
export function aspectRatio(width: number, height: number): string {
  if (!width || !height) return "—";
  const divisor = greatestCommonDivisor(width, height);
  const w = width / divisor;
  const h = height / divisor;
  if (w > 40 || h > 40) return (width / height).toFixed(2) + ":1";
  return `${w}:${h}`;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

export interface Histogram {
  red: number[];
  green: number[];
  blue: number[];
  buckets: number;
}

/** Buckets the RGB channels of decoded pixel data for the histogram strip. */
export function histogramOf(data: Uint8ClampedArray, buckets = 24): Histogram {
  const red = new Array<number>(buckets).fill(0);
  const green = new Array<number>(buckets).fill(0);
  const blue = new Array<number>(buckets).fill(0);
  const scale = buckets / 256;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    red[Math.min(buckets - 1, Math.floor(data[index] * scale))] += 1;
    green[Math.min(buckets - 1, Math.floor(data[index + 1] * scale))] += 1;
    blue[Math.min(buckets - 1, Math.floor(data[index + 2] * scale))] += 1;
  }
  return { red, green, blue, buckets };
}

export function toHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
