import { describe, expect, it } from "vitest";
import {
  analyseLoudness, buildPeaks, correlationOf, formatDb, formatLufs, formatTime, kWeight,
  loudnessRange, midSide, monoSum, peakOfChannel, samplePeakOf, toDecibels, truePeakOf,
} from "./loudness";

const RATE = 48000;

function sine(seconds: number, frequency: number, amplitude: number, rate = RATE): Float32Array {
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / rate);
  }
  return samples;
}

describe("K-weighting", () => {
  it("leaves 1 kHz close to unity, where the curve crosses 0 dB", () => {
    const input = sine(1, 1000, 0.5);
    const output = kWeight(input, RATE);
    const settled = output.subarray(RATE / 2);
    const gain = Math.max(...settled) / 0.5;
    expect(gain).toBeGreaterThan(0.9);
    expect(gain).toBeLessThan(1.15);
  });

  it("attenuates sub-bass, which is what the high pass is for", () => {
    const output = kWeight(sine(1, 20, 0.5), RATE);
    const settled = output.subarray(RATE / 2);
    expect(Math.max(...settled)).toBeLessThan(0.25);
  });

  it("lifts high frequencies, which is what the shelf is for", () => {
    const output = kWeight(sine(1, 8000, 0.5), RATE);
    const settled = output.subarray(RATE / 2);
    expect(Math.max(...settled)).toBeGreaterThan(0.55);
  });
});

describe("integrated loudness", () => {
  it("rises by about 6 LU when amplitude doubles", () => {
    const quiet = analyseLoudness([sine(4, 1000, 0.1), sine(4, 1000, 0.1)], RATE).integrated;
    const loud = analyseLoudness([sine(4, 1000, 0.2), sine(4, 1000, 0.2)], RATE).integrated;
    expect(loud - quiet).toBeCloseTo(6.02, 1);
  });

  it("puts a stereo 1 kHz tone in the expected LUFS range", () => {
    const report = analyseLoudness([sine(4, 1000, 0.5), sine(4, 1000, 0.5)], RATE);
    // A full-scale stereo sine sits near 0 LUFS; half amplitude is about 6 LU below.
    expect(report.integrated).toBeGreaterThan(-8);
    expect(report.integrated).toBeLessThan(-3);
  });

  it("reports negative infinity for silence rather than a misleading number", () => {
    const silence = new Float32Array(RATE * 4);
    const report = analyseLoudness([silence, silence], RATE);
    expect(report.integrated).toBe(Number.NEGATIVE_INFINITY);
    expect(formatLufs(report.integrated)).toBe("−∞");
  });

  it("gates out a quiet passage so it does not drag the reading down", () => {
    const loud = sine(4, 1000, 0.5);
    const withSilence = new Float32Array(RATE * 8);
    withSilence.set(loud, 0);
    const gated = analyseLoudness([withSilence, withSilence], RATE).integrated;
    const alone = analyseLoudness([loud, loud], RATE).integrated;
    expect(Math.abs(gated - alone)).toBeLessThan(1.5);
  });

  it("counts both channels, so stereo is louder than one channel of silence", () => {
    const tone = sine(4, 1000, 0.3);
    const silence = new Float32Array(tone.length);
    const stereo = analyseLoudness([tone, tone], RATE).integrated;
    const single = analyseLoudness([tone, silence], RATE).integrated;
    expect(stereo - single).toBeCloseTo(3.01, 1);
  });
});

describe("peaks", () => {
  it("handles a channel far longer than the argument limit", () => {
    // Spreading this into Math.max(...) throws "Maximum call stack size exceeded".
    const long = new Float32Array(500_000);
    long[400_000] = -0.9;
    expect(() => Math.max(...(long as unknown as number[]))).toThrow(RangeError);
    expect(peakOfChannel(long)).toBeCloseTo(0.9);
    expect(samplePeakOf([long, long])).toBeCloseTo(0.9);
  });

  it("returns zero for an empty channel", () => {
    expect(peakOfChannel(new Float32Array(0))).toBe(0);
  });

  it("measures the sample peak exactly", () => {
    expect(samplePeakOf([Float32Array.from([0.1, -0.8, 0.4])])).toBeCloseTo(0.8);
    expect(toDecibels(0.5)).toBeCloseTo(-6.02, 1);
    expect(toDecibels(0)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("finds inter-sample peaks the sample peak misses", () => {
    // A sine sampled either side of its crest under-reads at sample resolution.
    const tone = sine(0.05, 11025, 1);
    expect(truePeakOf([tone])).toBeGreaterThanOrEqual(samplePeakOf([tone]) - 1e-6);
  });

  it("never reports a true peak below the sample peak", () => {
    const noise = Float32Array.from({ length: 500 }, (_, index) => Math.sin(index) * 0.7);
    expect(truePeakOf([noise])).toBeGreaterThanOrEqual(samplePeakOf([noise]) - 1e-6);
  });
});

describe("stereo relationship", () => {
  it("reports +1 for identical channels and -1 for inverted ones", () => {
    const tone = sine(0.2, 440, 0.5);
    const inverted = Float32Array.from(tone, (value) => -value);
    expect(correlationOf(tone, tone)).toBeCloseTo(1, 5);
    expect(correlationOf(tone, inverted)).toBeCloseTo(-1, 5);
  });

  it("reports about zero for unrelated channels", () => {
    const left = sine(0.5, 440, 0.5);
    const right = sine(0.5, 997, 0.5);
    expect(Math.abs(correlationOf(left, right))).toBeLessThan(0.2);
  });

  it("reports zero for silence instead of dividing by nothing", () => {
    const silence = new Float32Array(100);
    expect(correlationOf(silence, silence)).toBe(0);
  });
});

describe("channel maths", () => {
  it("splits mid and side so that mid+side and mid-side rebuild the pair", () => {
    const left = Float32Array.from([1, 0.5, -0.25]);
    const right = Float32Array.from([0.5, -0.5, 0.25]);
    const { mid, side } = midSide(left, right);
    for (let index = 0; index < left.length; index += 1) {
      expect(mid[index] + side[index]).toBeCloseTo(left[index], 6);
      expect(mid[index] - side[index]).toBeCloseTo(right[index], 6);
    }
  });

  it("averages channels for the mono sum", () => {
    const summed = monoSum([Float32Array.from([1, 0]), Float32Array.from([0, 1])]);
    expect([...summed]).toEqual([0.5, 0.5]);
  });
});

describe("waveform peaks", () => {
  it("reduces a channel to the requested number of columns", () => {
    const tone = sine(1, 100, 0.8);
    const peaks = buildPeaks(tone, 64);
    expect(peaks.min).toHaveLength(64);
    expect(Math.min(...peaks.min)).toBeLessThan(-0.7);
    expect(Math.max(...peaks.max)).toBeGreaterThan(0.7);
    expect(Math.max(...peaks.rms)).toBeLessThan(0.8);
  });

  it("handles a channel shorter than the column count", () => {
    const peaks = buildPeaks(Float32Array.from([0.5, -0.5]), 8);
    expect(peaks.max).toHaveLength(8);
    expect(Number.isFinite(peaks.rms[0])).toBe(true);
  });
});

describe("loudness range and formatting", () => {
  it("is zero for a constant level and positive when the level varies", () => {
    expect(loudnessRange([-20, -20, -20, -20])).toBe(0);
    expect(loudnessRange([-30, -25, -20, -15, -10])).toBeGreaterThan(0);
  });

  it("formats decibels with a sign and timecodes with milliseconds", () => {
    expect(formatDb(-0.4)).toBe("-0.40");
    expect(formatDb(0.85)).toBe("+0.85");
    expect(formatTime(84.812)).toBe("01:24.812");
    expect(formatTime(0)).toBe("00:00.000");
  });
});
