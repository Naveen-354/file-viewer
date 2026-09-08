import { describe, expect, it } from "vitest";
import { averageBitrate, formatTimecode, readMediaMeta } from "./mediaMeta";

const text = (value: string) => [...value].map((character) => character.charCodeAt(0));
const be32 = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const be16 = (value: number) => [(value >> 8) & 255, value & 255];

function box(type: string, payload: number[]): number[] {
  return [...be32(payload.length + 8), ...text(type), ...payload];
}

/** version+flags, timescale and duration as an mvhd version 0 payload. */
function mvhd(timescale: number, duration: number): number[] {
  return box("mvhd", [0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(timescale), ...be32(duration)]);
}

function videoTrak(format: string, width: number, height: number, config: number[]): number[] {
  const entry = box(format, [
    ...new Array(24).fill(0), ...be16(width), ...be16(height),
    ...new Array(78 - 28).fill(0),
    ...config,
  ]);
  const stsd = box("stsd", [0, 0, 0, 0, ...be32(1), ...entry]);
  const hdlr = box("hdlr", [0, 0, 0, 0, ...be32(0), ...text("vide")]);
  const mdia = box("mdia", [...hdlr, ...box("minf", box("stbl", stsd))]);
  return box("trak", mdia);
}

function audioTrak(format: string, channels: number, rate: number, extra: number[] = []): number[] {
  const entry = box(format, [
    ...new Array(16).fill(0), ...be16(channels), ...be16(16), ...new Array(4).fill(0),
    ...be16(rate), ...be16(0),
    ...extra,
  ]);
  const stsd = box("stsd", [0, 0, 0, 0, ...be32(1), ...entry]);
  const hdlr = box("hdlr", [0, 0, 0, 0, ...be32(0), ...text("soun")]);
  const mdia = box("mdia", [...hdlr, ...box("minf", box("stbl", stsd))]);
  return box("trak", mdia);
}

function mp4(traks: number[][], options: { timescale?: number; duration?: number; brand?: string } = {}): Uint8Array {
  const ftyp = box("ftyp", [...text(options.brand ?? "isom"), ...be32(512)]);
  const moov = box("moov", [...mvhd(options.timescale ?? 1000, options.duration ?? 258000), ...traks.flat()]);
  return Uint8Array.from([...ftyp, ...moov]);
}

describe("MP4 containers", () => {
  it("reads the brand and duration", () => {
    const meta = readMediaMeta(mp4([], { brand: "mp42", timescale: 1000, duration: 258000 }));
    expect(meta.container).toBe("MP4 (mp42)");
    expect(meta.durationSeconds).toBeCloseTo(258);
  });

  it("reads H.264 codec, profile, level and geometry", () => {
    const avcC = box("avcC", [1, 100, 0, 51, 0xff]);
    const meta = readMediaMeta(mp4([videoTrak("avc1", 1920, 1080, avcC)]));
    expect(meta.video).toEqual({ codec: "H.264 / AVC", profile: "High @ L5.1", width: 1920, height: 1080 });
  });

  it("names the other video codecs it finds", () => {
    const meta = readMediaMeta(mp4([videoTrak("av01", 3840, 2160, [])]));
    expect(meta.video?.codec).toBe("AV1");
    expect(meta.video?.profile).toBeNull();
    expect(meta.video?.width).toBe(3840);
  });

  it("reads audio channels, sample rate and the AAC object type", () => {
    const esds = box("esds", [0, 0, 0, 0, 0x05, 0x02, 0x11, 0x90]);
    const meta = readMediaMeta(mp4([audioTrak("mp4a", 6, 48000, esds)]));
    expect(meta.audio).toEqual({ codec: "AAC LC", sampleRate: 48000, channels: 6 });
  });

  it("falls back to the sample format when there is no decoder config", () => {
    const meta = readMediaMeta(mp4([audioTrak("ac-3", 6, 48000)]));
    expect(meta.audio?.codec).toBe("AC-3");
  });

  it("reads both tracks from one file", () => {
    const meta = readMediaMeta(mp4([
      videoTrak("avc1", 1280, 720, box("avcC", [1, 77, 0, 31, 0xff])),
      audioTrak("mp4a", 2, 44100),
    ]));
    expect(meta.video?.profile).toBe("Main @ L3.1");
    expect(meta.audio?.channels).toBe(2);
  });

  it("returns nothing rather than guessing when the moov box is absent", () => {
    const meta = readMediaMeta(Uint8Array.from(box("ftyp", text("isom"))));
    expect(meta.container).toBe("MP4 (isom)");
    expect(meta.video).toBeNull();
    expect(meta.audio).toBeNull();
  });

  it("survives truncated and self-referential boxes", () => {
    const bytes = mp4([videoTrak("avc1", 640, 480, box("avcC", [1, 66, 0, 30, 0]))]);
    expect(() => readMediaMeta(bytes.slice(0, 40))).not.toThrow();
    const zeroed = Uint8Array.from(bytes);
    zeroed[0] = 0; zeroed[1] = 0; zeroed[2] = 0; zeroed[3] = 4;
    expect(() => readMediaMeta(zeroed)).not.toThrow();
  });
});

describe("WebM containers", () => {
  it("identifies the container and its codecs", () => {
    const codec = (value: string) => [0x86, 0x80 | value.length, ...text(value)];
    const trackEntry = (payload: number[]) => [0xae, 0x80 | payload.length, ...payload];
    const tracks = (payload: number[]) => [0x16, 0x54, 0xae, 0x6b, 0x80 | payload.length, ...payload];
    const bytes = Uint8Array.from([
      0x1a, 0x45, 0xdf, 0xa3, 0x84, 1, 1, 1, 1,
      ...tracks([...trackEntry(codec("V_VP9")), ...trackEntry(codec("A_OPUS"))]),
    ]);
    const meta = readMediaMeta(bytes);
    expect(meta.container).toBe("WebM / Matroska");
    expect(meta.video?.codec).toBe("VP9");
    expect(meta.audio?.codec).toBe("Opus");
  });
});

describe("derived values", () => {
  it("states bitrate as an average, because that is all a file can prove", () => {
    expect(averageBitrate(3_576_832, 10)).toBe("2.9 Mbps avg");
    expect(averageBitrate(120_000, 10)).toBe("96 kbps avg");
    expect(averageBitrate(1000, 0)).toBeNull();
    expect(averageBitrate(0, 10)).toBeNull();
  });

  it("formats timecodes with hours", () => {
    expect(formatTimecode(258)).toBe("00:04:18");
    expect(formatTimecode(3661)).toBe("01:01:01");
    expect(formatTimecode(Number.NaN)).toBe("--:--:--");
  });

  it("ignores anything that is not a known container", () => {
    expect(readMediaMeta(Uint8Array.from([1, 2, 3, 4])).container).toBeNull();
  });
});
