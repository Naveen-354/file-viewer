import { describe, expect, it } from "vitest";
import { channelLayout, readAudioMeta, statedBitrate } from "./audioMeta";

const text = (value: string) => [...value].map((character) => character.charCodeAt(0));
const le32 = (value: number) => [value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >>> 24) & 255];
const le16 = (value: number) => [value & 255, (value >> 8) & 255];
const be32 = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];

function flacBlock(type: number, payload: number[], last = false): number[] {
  return [(last ? 0x80 : 0) | type, (payload.length >> 16) & 255, (payload.length >> 8) & 255, payload.length & 255, ...payload];
}

/** STREAMINFO packs rate, channels, depth and sample count into 8 bytes. */
function streamInfo(rate: number, channels: number, depth: number, samples: number): number[] {
  const packed = (rate << 12) | ((channels - 1) << 9) | ((depth - 1) << 4) | Math.floor(samples / 2 ** 32);
  return [
    ...le16(4096), ...le16(4096), 0, 0, 0, 0, 0, 0,
    ...be32(packed >>> 0), ...be32(samples >>> 0),
    ...new Array(16).fill(0),
  ];
}

function vorbisComment(vendor: string, entries: string[]): number[] {
  const payload = [...le32(vendor.length), ...text(vendor), ...le32(entries.length)];
  for (const entry of entries) payload.push(...le32(entry.length), ...text(entry));
  return payload;
}

describe("FLAC", () => {
  it("reads the stream description from STREAMINFO", () => {
    const bytes = Uint8Array.from([...text("fLaC"), ...flacBlock(0, streamInfo(96000, 2, 24, 24816000), true)]);
    const meta = readAudioMeta(bytes);
    expect(meta.container).toBe("FLAC");
    expect(meta.lossless).toBe(true);
    expect(meta.sampleRate).toBe(96000);
    expect(meta.channels).toBe(2);
    expect(meta.bitDepth).toBe(24);
    expect(meta.totalSamples).toBe(24816000);
  });

  it("reads the vendor string and studio tags", () => {
    const bytes = Uint8Array.from([
      ...text("fLaC"),
      ...flacBlock(0, streamInfo(48000, 2, 16, 480000)),
      ...flacBlock(4, vorbisComment("reference libFLAC 1.4.3 20230623", [
        "TITLE=Acoustic Session Master_Take4",
        "ARTIST=Studio Ensemble",
        "ISRC=US-S1Z-25-00418",
        "ENGINEER=A. Sterling",
      ]), true),
    ]);
    const meta = readAudioMeta(bytes);
    expect(meta.encoder).toContain("libFLAC 1.4.3");
    expect(meta.tags).toEqual([
      { label: "Title", value: "Acoustic Session Master_Take4" },
      { label: "Artist", value: "Studio Ensemble" },
      { label: "ISRC", value: "US-S1Z-25-00418" },
      { label: "Engineer", value: "A. Sterling" },
    ]);
  });

  it("ignores unknown tag keys instead of listing raw noise", () => {
    const bytes = Uint8Array.from([
      ...text("fLaC"),
      ...flacBlock(4, vorbisComment("v", ["WEIRDKEY=x", "TITLE=Kept"]), true),
    ]);
    expect(readAudioMeta(bytes).tags).toEqual([{ label: "Title", value: "Kept" }]);
  });

  it("survives a block claiming more bytes than the file holds", () => {
    const bytes = Uint8Array.from([...text("fLaC"), 0x04, 0xff, 0xff, 0xff, 1, 2, 3]);
    expect(() => readAudioMeta(bytes)).not.toThrow();
  });
});

describe("WAV", () => {
  function wav(chunks: number[]): Uint8Array {
    return Uint8Array.from([...text("RIFF"), ...le32(chunks.length + 4), ...text("WAVE"), ...chunks]);
  }
  const chunk = (id: string, payload: number[]) => [...text(id), ...le32(payload.length), ...payload];

  it("reads the format chunk", () => {
    const fmt = chunk("fmt ", [...le16(1), ...le16(2), ...le32(48000), ...le32(192000), ...le16(4), ...le16(24)]);
    const meta = readAudioMeta(wav(fmt));
    expect(meta.container).toBe("WAV (RIFF)");
    expect(meta.codec).toBe("Linear PCM");
    expect(meta.lossless).toBe(true);
    expect(meta.sampleRate).toBe(48000);
    expect(meta.bitDepth).toBe(24);
  });

  it("reads LIST INFO tags", () => {
    const fmt = chunk("fmt ", [...le16(1), ...le16(2), ...le32(44100), ...le32(0), ...le16(4), ...le16(16)]);
    const info = chunk("LIST", [...text("INFO"), ...chunk("INAM", text("Session One\0")), ...chunk("IART", text("Ensemble\0"))]);
    const meta = readAudioMeta(wav([...fmt, ...info]));
    expect(meta.tags).toEqual([
      { label: "Title", value: "Session One" },
      { label: "Artist", value: "Ensemble" },
    ]);
  });

  it("names float and extensible formats", () => {
    const float = chunk("fmt ", [...le16(3), ...le16(2), ...le32(96000), ...le32(0), ...le16(8), ...le16(32)]);
    expect(readAudioMeta(wav(float)).codec).toBe("IEEE float PCM");
  });
});

describe("MP3", () => {
  it("reads ID3v2 text frames and the frame header", () => {
    const frame = (id: string, value: string) => [...text(id), ...be32(value.length + 1), 0, 0, 0, ...text(value)];
    const frames = [...frame("TIT2", "Reference Mix"), ...frame("TPE1", "Studio Ensemble"), ...frame("TSSE", "LAME 3.100")];
    const size = frames.length;
    const header = [...text("ID3"), 3, 0, 0,
      (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f];
    // 0xFF FB: MPEG-1 Layer III; 0xB2: 192 kbps at 44.1 kHz; 0x40: joint stereo.
    const audio = [0xff, 0xfb, 0xb2, 0x40];
    const meta = readAudioMeta(Uint8Array.from([...header, ...frames, ...audio]));
    expect(meta.container).toBe("MP3");
    expect(meta.lossless).toBe(false);
    expect(meta.sampleRate).toBe(44100);
    expect(meta.bitrateKbps).toBe(192);
    expect(meta.encoder).toBe("LAME 3.100");
    expect(meta.tags).toEqual([
      { label: "Title", value: "Reference Mix" },
      { label: "Artist", value: "Studio Ensemble" },
    ]);
  });
});

describe("derived values", () => {
  it("computes the PCM bitrate when the header does not state one", () => {
    const meta = readAudioMeta(Uint8Array.from([...text("fLaC"), ...flacBlock(0, streamInfo(96000, 2, 24, 100), true)]));
    expect(statedBitrate(meta)).toBe(4608);
  });

  it("prefers a stated bitrate over a computed one", () => {
    expect(statedBitrate({ bitrateKbps: 192, sampleRate: 44100, bitDepth: 16, channels: 2, lossless: false } as never)).toBe(192);
  });

  it("names channel layouts", () => {
    expect(channelLayout(1)).toBe("1.0 Mono");
    expect(channelLayout(2)).toBe("2.0 Stereo");
    expect(channelLayout(6)).toBe("5.1 Surround");
    expect(channelLayout(5)).toBe("5 channels");
    expect(channelLayout(null)).toBeNull();
  });

  it("returns nothing for a container it does not know", () => {
    expect(readAudioMeta(Uint8Array.from([1, 2, 3, 4])).container).toBeNull();
  });
});
