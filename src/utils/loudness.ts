/**
 * ITU-R BS.1770 / EBU R128 loudness measurement.
 *
 * The numbers a mastering engineer expects (LUFS, true peak, loudness range)
 * are only meaningful if they follow the standard, so the K-weighting filter,
 * the 400 ms gating blocks and the two-stage gate are implemented here rather
 * than approximated.
 */

export interface Biquad {
  b0: number; b1: number; b2: number; a1: number; a2: number;
}

/** Stage 1 of K-weighting: a high shelf, specified at 1681.97 Hz / +4 dB. */
export function highShelf(sampleRate: number): Biquad {
  const f0 = 1681.974450955533;
  const gain = 3.999843853973347;
  const q = 0.7071752369554196;
  const k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = Math.pow(10, gain / 20);
  const vb = Math.pow(vh, 0.499666774155);
  const denominator = 1 + k / q + k * k;
  return {
    b0: (vh + (vb * k) / q + k * k) / denominator,
    b1: (2 * (k * k - vh)) / denominator,
    b2: (vh - (vb * k) / q + k * k) / denominator,
    a1: (2 * (k * k - 1)) / denominator,
    a2: (1 - k / q + k * k) / denominator,
  };
}

/** Stage 2 of K-weighting: a high pass at 38.14 Hz. */
export function highPass(sampleRate: number): Biquad {
  const f0 = 38.13547087602444;
  const q = 0.5003270373238773;
  const k = Math.tan((Math.PI * f0) / sampleRate);
  const denominator = 1 + k / q + k * k;
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / denominator,
    a2: (1 - k / q + k * k) / denominator,
  };
}

export function applyBiquad(input: Float32Array, filter: Biquad): Float32Array {
  const output = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let index = 0; index < input.length; index += 1) {
    const x0 = input[index];
    const y0 = filter.b0 * x0 + filter.b1 * x1 + filter.b2 * x2 - filter.a1 * y1 - filter.a2 * y2;
    output[index] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return output;
}

export function kWeight(channel: Float32Array, sampleRate: number): Float32Array {
  return applyBiquad(applyBiquad(channel, highShelf(sampleRate)), highPass(sampleRate));
}

const ABSOLUTE_GATE = -70;
const OFFSET = -0.691;

function blockLoudness(sums: number[], weights: number[]): number {
  let total = 0;
  for (let index = 0; index < sums.length; index += 1) total += weights[index] * sums[index];
  return total > 0 ? OFFSET + 10 * Math.log10(total) : Number.NEGATIVE_INFINITY;
}

interface Blocks {
  loudness: number[];
  power: number[][];
  weights: number[];
}

/** Mean square per channel over overlapping windows of `windowSeconds`. */
function gatingBlocks(channels: Float32Array[], sampleRate: number, windowSeconds: number, overlap = 0.75): Blocks {
  const weights = channels.map((_, index) => (index >= 3 ? 1.41 : 1));
  const size = Math.max(1, Math.round(sampleRate * windowSeconds));
  const step = Math.max(1, Math.round(size * (1 - overlap)));
  const weighted = channels.map((channel) => kWeight(channel, sampleRate));
  const length = channels[0]?.length ?? 0;
  const loudness: number[] = [];
  const power: number[][] = [];

  for (let start = 0; start + size <= length; start += step) {
    const sums = weighted.map((channel) => {
      let total = 0;
      for (let index = start; index < start + size; index += 1) total += channel[index] * channel[index];
      return total / size;
    });
    power.push(sums);
    loudness.push(blockLoudness(sums, weights));
  }
  return { loudness, power, weights };
}

/** The two-stage gate: drop below -70 LUFS, then below the relative threshold. */
function gatedLoudness(blocks: Blocks): number {
  const above = blocks.loudness
    .map((value, index) => ({ value, index }))
    .filter((entry) => entry.value > ABSOLUTE_GATE);
  if (above.length === 0) return Number.NEGATIVE_INFINITY;

  const average = (entries: { index: number }[]) => {
    const totals = blocks.weights.map(() => 0);
    for (const entry of entries) {
      for (let channel = 0; channel < totals.length; channel += 1) totals[channel] += blocks.power[entry.index][channel];
    }
    return blockLoudness(totals.map((total) => total / entries.length), blocks.weights);
  };

  const relativeThreshold = average(above) - 10;
  const surviving = above.filter((entry) => entry.value > relativeThreshold);
  return surviving.length ? average(surviving) : Number.NEGATIVE_INFINITY;
}

export interface LoudnessReport {
  integrated: number;
  shortTermMax: number;
  momentaryMax: number;
  range: number;
  samplePeak: number;
  truePeak: number;
  correlation: number | null;
}

export function analyseLoudness(channels: Float32Array[], sampleRate: number): LoudnessReport {
  const momentary = gatingBlocks(channels, sampleRate, 0.4);
  const shortTerm = gatingBlocks(channels, sampleRate, 3, 2 / 3);
  return {
    integrated: gatedLoudness(momentary),
    momentaryMax: maxFinite(momentary.loudness),
    shortTermMax: maxFinite(shortTerm.loudness),
    range: loudnessRange(shortTerm.loudness),
    samplePeak: toDecibels(samplePeakOf(channels)),
    truePeak: toDecibels(truePeakOf(channels)),
    correlation: channels.length >= 2 ? correlationOf(channels[0], channels[1]) : null,
  };
}

function maxFinite(values: number[]): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const value of values) if (Number.isFinite(value) && value > best) best = value;
  return best;
}

/** EBU Tech 3342: the 10th to 95th percentile of gated short-term loudness. */
export function loudnessRange(shortTerm: number[]): number {
  const above = shortTerm.filter((value) => value > ABSOLUTE_GATE);
  if (above.length < 2) return 0;
  const mean = 10 * Math.log10(above.reduce((sum, value) => sum + Math.pow(10, value / 10), 0) / above.length);
  const gated = above.filter((value) => value > mean - 20).sort((left, right) => left - right);
  if (gated.length < 2) return 0;
  const at = (fraction: number) => gated[Math.min(gated.length - 1, Math.floor(fraction * (gated.length - 1)))];
  return at(0.95) - at(0.1);
}

/**
 * Spreading a channel into `Math.max(...)` overflows the call stack once the
 * array is long enough, so every peak is found with a loop.
 */
export function peakOfChannel(channel: Float32Array): number {
  let peak = 0;
  for (let index = 0; index < channel.length; index += 1) {
    const value = channel[index] < 0 ? -channel[index] : channel[index];
    if (value > peak) peak = value;
  }
  return peak;
}

export function samplePeakOf(channels: Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) peak = Math.max(peak, peakOfChannel(channel));
  return peak;
}

/**
 * True peak needs the inter-sample maxima, so the signal is reconstructed at 4x
 * with Catmull-Rom interpolation. That is an approximation of the BS.1770
 * filter, and the UI labels it as such.
 */
export function truePeakOf(channels: Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (let index = 0; index < channel.length - 1; index += 1) {
      const p0 = channel[Math.max(0, index - 1)];
      const p1 = channel[index];
      const p2 = channel[index + 1];
      const p3 = channel[Math.min(channel.length - 1, index + 2)];
      for (let step = 0; step < 4; step += 1) {
        const t = step / 4;
        const value = Math.abs(
          0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t),
        );
        if (value > peak) peak = value;
      }
    }
  }
  return peak;
}

export function correlationOf(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  let sumLeft = 0, sumRight = 0, sumBoth = 0;
  for (let index = 0; index < length; index += 1) {
    sumLeft += left[index] * left[index];
    sumRight += right[index] * right[index];
    sumBoth += left[index] * right[index];
  }
  const denominator = Math.sqrt(sumLeft * sumRight);
  return denominator > 0 ? Math.max(-1, Math.min(1, sumBoth / denominator)) : 0;
}

export function toDecibels(amplitude: number): number {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : Number.NEGATIVE_INFINITY;
}

export function formatLufs(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "−∞";
}

export function formatDb(value: number): string {
  return Number.isFinite(value) ? (value > 0 ? "+" : "") + value.toFixed(2) : "−∞";
}

export interface Peaks {
  min: Float32Array;
  max: Float32Array;
  rms: Float32Array;
}

/** Collapses a channel into per-column min/max/RMS for waveform drawing. */
export function buildPeaks(channel: Float32Array, columns: number): Peaks {
  const min = new Float32Array(columns);
  const max = new Float32Array(columns);
  const rms = new Float32Array(columns);
  const perColumn = channel.length / columns;
  for (let column = 0; column < columns; column += 1) {
    const start = Math.floor(column * perColumn);
    const end = Math.min(channel.length, Math.max(start + 1, Math.floor((column + 1) * perColumn)));
    let low = 0, high = 0, square = 0;
    for (let index = start; index < end; index += 1) {
      const value = channel[index];
      if (value < low) low = value;
      if (value > high) high = value;
      square += value * value;
    }
    min[column] = low;
    max[column] = high;
    rms[column] = Math.sqrt(square / Math.max(1, end - start));
  }
  return { min, max, rms };
}

export function midSide(left: Float32Array, right: Float32Array): { mid: Float32Array; side: Float32Array } {
  const length = Math.min(left.length, right.length);
  const mid = new Float32Array(length);
  const side = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    mid[index] = (left[index] + right[index]) / 2;
    side[index] = (left[index] - right[index]) / 2;
  }
  return { mid, side };
}

export function monoSum(channels: Float32Array[]): Float32Array {
  const length = channels[0]?.length ?? 0;
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    let total = 0;
    for (const channel of channels) total += channel[index];
    output[index] = total / channels.length;
  }
  return output;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00.000";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(3).padStart(6, "0")}`;
}
