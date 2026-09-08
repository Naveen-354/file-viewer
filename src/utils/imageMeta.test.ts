import { describe, expect, it } from "vitest";
import { aspectRatio, histogramOf, readImageMeta, toHex } from "./imageMeta";

function chunk(type: string, data: number[]): number[] {
  const length = [(data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255];
  return [...length, ...[...type].map((character) => character.charCodeAt(0)), ...data, 0, 0, 0, 0];
}

function be32(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function png(options: { width: number; height: number; depth: number; colorType: number; interlace?: number; tail?: number[] }): Uint8Array {
  const ihdr = [
    ...be32(options.width), ...be32(options.height),
    options.depth, options.colorType, 0, 0, options.interlace ?? 0,
  ];
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", ihdr),
    ...(options.tail ?? []),
    ...chunk("IEND", []),
  ]);
}

const text = (value: string) => [...value].map((character) => character.charCodeAt(0));

describe("PNG metadata", () => {
  it("reads dimensions, depth, colour type and interlacing from IHDR", () => {
    const meta = readImageMeta(png({ width: 3840, height: 2160, depth: 8, colorType: 6 }));
    expect(meta.format).toBe("PNG");
    expect(meta.width).toBe(3840);
    expect(meta.height).toBe(2160);
    expect(meta.bitDepth).toBe("32-bit (8bpc)");
    expect(meta.colorType).toBe("Truecolour + alpha (RGBA)");
    expect(meta.interlace).toBe("Non-interlaced");
    expect(meta.compression).toBe("Deflate / PNG");
  });

  it("distinguishes the other colour types and Adam7", () => {
    expect(readImageMeta(png({ width: 1, height: 1, depth: 8, colorType: 2 })).bitDepth).toBe("24-bit (8bpc)");
    expect(readImageMeta(png({ width: 1, height: 1, depth: 16, colorType: 0 })).bitDepth).toBe("16-bit (16bpc)");
    expect(readImageMeta(png({ width: 1, height: 1, depth: 8, colorType: 3 })).colorType).toBe("Indexed");
    expect(readImageMeta(png({ width: 1, height: 1, depth: 8, colorType: 6, interlace: 1 })).interlace).toBe("Adam7");
  });

  it("reads colour-space chunks when the file carries them", () => {
    const meta = readImageMeta(png({
      width: 2, height: 2, depth: 8, colorType: 6,
      tail: [...chunk("sRGB", [0]), ...chunk("gAMA", be32(45455))],
    }));
    expect(meta.colorSpace).toBe("sRGB");
    expect(meta.extra).toContainEqual({ label: "Rendering intent", value: "Perceptual" });
    expect(meta.extra).toContainEqual({ label: "Gamma", value: "2.20" });
  });

  it("names an embedded ICC profile", () => {
    const meta = readImageMeta(png({
      width: 2, height: 2, depth: 8, colorType: 6,
      tail: chunk("iCCP", [...text("Display P3"), 0, 0, 0x78, 0x9c]),
    }));
    expect(meta.colorSpace).toBe("Display P3");
  });

  it("surfaces text chunks such as the writing software", () => {
    const meta = readImageMeta(png({
      width: 2, height: 2, depth: 8, colorType: 6,
      tail: chunk("tEXt", [...text("Software"), 0, ...text("Affinity Metal 2.4")]),
    }));
    expect(meta.extra).toContainEqual({ label: "Software", value: "Affinity Metal 2.4" });
  });

  it("stops at the pixel data instead of scanning the whole file", () => {
    const meta = readImageMeta(png({
      width: 2, height: 2, depth: 8, colorType: 6,
      tail: [...chunk("IDAT", [1, 2, 3]), ...chunk("tEXt", [...text("Late"), 0, ...text("ignored")])],
    }));
    expect(meta.extra.some((field) => field.label === "Late")).toBe(false);
  });
});

describe("JPEG metadata", () => {
  function jpeg(extra: number[] = []): Uint8Array {
    const sof = [0xff, 0xc0, 0x00, 0x11, 8, 0x04, 0x38, 0x07, 0x80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    return Uint8Array.from([0xff, 0xd8, ...extra, ...sof, 0xff, 0xda, 0x00, 0x02]);
  }

  it("reads dimensions and precision from the frame header", () => {
    const meta = readImageMeta(jpeg());
    expect(meta.format).toBe("JPEG");
    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(1080);
    expect(meta.bitDepth).toBe("24-bit (8bpc)");
    expect(meta.colorType).toBe("YCbCr");
  });

  it("reads the Software tag out of an Exif segment", () => {
    const value = "OneOpen Studio\0";
    const ifd = [
      1, 0,
      0x31, 0x01, 2, 0, ...[value.length, 0, 0, 0], ...[26, 0, 0, 0],
      0, 0, 0, 0,
    ];
    const tiff = [0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, ...ifd, ...text(value)];
    const segment = [...text("Exif"), 0, 0, ...tiff];
    const length = segment.length + 2;
    const meta = readImageMeta(jpeg([0xff, 0xe1, (length >> 8) & 255, length & 255, ...segment]));
    expect(meta.extra).toContainEqual({ label: "Software", value: "OneOpen Studio" });
  });

  it("marks progressive frames", () => {
    const bytes = jpeg();
    bytes[bytes.indexOf(0xc0, 2)] = 0xc2;
    expect(readImageMeta(bytes).compression).toBe("Progressive DCT");
  });
});

describe("other containers and safety", () => {
  it("recognises GIF, BMP and WebP without claiming details it cannot read", () => {
    expect(readImageMeta(Uint8Array.from(text("GIF89a"))).format).toBe("GIF");
    expect(readImageMeta(Uint8Array.from(text("BM__"))).format).toBe("BMP");
    const webp = Uint8Array.from([...text("RIFF"), 0, 0, 0, 0, ...text("WEBPVP8L")]);
    expect(readImageMeta(webp).compression).toBe("Lossless (VP8L)");
  });

  it("returns empty metadata rather than guessing for unknown or truncated data", () => {
    expect(readImageMeta(Uint8Array.from([1, 2, 3])).format).toBeNull();
    const truncated = png({ width: 4, height: 4, depth: 8, colorType: 6 }).slice(0, 20);
    expect(() => readImageMeta(truncated)).not.toThrow();
  });

  it("survives a chunk claiming an impossible length", () => {
    const bytes = png({ width: 4, height: 4, depth: 8, colorType: 6 });
    bytes[8] = 0xff;
    expect(() => readImageMeta(bytes)).not.toThrow();
  });
});

describe("derived values", () => {
  it("reduces aspect ratios", () => {
    expect(aspectRatio(3840, 2160)).toBe("16:9");
    expect(aspectRatio(1024, 1024)).toBe("1:1");
    expect(aspectRatio(1920, 1200)).toBe("8:5");
    expect(aspectRatio(1013, 379)).toBe("2.67:1");
    expect(aspectRatio(0, 10)).toBe("—");
  });

  it("buckets pixels per channel and skips fully transparent ones", () => {
    const pixels = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 9, 9, 9, 0]);
    const histogram = histogramOf(pixels, 4);
    expect(histogram.red[3]).toBe(1);
    expect(histogram.green[3]).toBe(1);
    expect(histogram.red.reduce((sum, value) => sum + value, 0)).toBe(2);
  });

  it("formats hex the way a colour picker shows it", () => {
    expect(toHex(110, 159, 255)).toBe("#6E9FFF");
    expect(toHex(0, 0, 0)).toBe("#000000");
  });
});
