import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAngle, readDisplay, readGraphics, readRuntime, sampleFrames, summariseFrames } from "./hardware";

describe("ANGLE renderer parsing", () => {
  it("pulls the adapter and the backend out of a Chromium renderer string", () => {
    const result = parseAngle("ANGLE (Intel, Intel(R) UHD Graphics (0x00009B41) Direct3D11 vs_5_0 ps_5_0, D3D11)");
    expect(result.gpu).toBe("Intel(R) UHD Graphics (0x00009B41) Direct3D11");
    expect(result.backend).toBe("D3D11");
  });

  it("keeps a comma that sits inside parentheses with its adapter", () => {
    const result = parseAngle("ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 (0x00002757) Direct3D11 vs_5_0 ps_5_0, D3D11)");
    expect(result.gpu).toContain("NVIDIA GeForce RTX 4080");
    expect(result.backend).toBe("D3D11");
  });

  it("reports a Vulkan backend as Vulkan, not as D3D", () => {
    expect(parseAngle("ANGLE (AMD, AMD Radeon 780M, Vulkan 1.3.280)").backend).toBe("Vulkan 1.3.280");
  });

  it("passes a plain renderer string through untouched", () => {
    expect(parseAngle("Apple M2")).toEqual({ gpu: "Apple M2", backend: null });
  });

  it("returns nulls rather than throwing when nothing is reported", () => {
    expect(parseAngle(null)).toEqual({ gpu: null, backend: null });
    expect(parseAngle("")).toEqual({ gpu: null, backend: null });
  });
});

describe("frame summary", () => {
  it("computes median, average, peak and refresh rate from timestamps", () => {
    // Five intervals of ~16.67 ms with one dropped frame at 33 ms.
    const stamps = [0, 16.67, 33.34, 66.34, 83.01, 99.68];
    const summary = summariseFrames(stamps)!;
    expect(summary.frames).toBe(5);
    expect(summary.medianMs).toBeCloseTo(16.67, 1);
    expect(summary.peakMs).toBeCloseTo(33, 0);
    expect(summary.hz).toBeCloseTo(60, 0);
    expect(summary.averageMs).toBeGreaterThan(summary.medianMs);
  });

  it("uses the median for the rate so one long frame does not halve it", () => {
    const stamps = [0, 16.7, 33.4, 50.1, 500];
    expect(summariseFrames(stamps)!.hz).toBeCloseTo(60, 0);
  });

  it("returns null when there are not two timestamps to compare", () => {
    expect(summariseFrames([])).toBeNull();
    expect(summariseFrames([12])).toBeNull();
  });
});

describe("frame sampling", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("gives up and reports what it has when frames stop arriving", async () => {
    // A hidden or minimised window stops receiving animation frames; the sampler
    // must not hang waiting for callbacks that will never come.
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      calls += 1;
      if (calls <= 3) queueMicrotask(() => fn(calls * 16.7));
      return calls;
    });
    const promise = sampleFrames(60, 1000);
    await vi.advanceTimersByTimeAsync(1200);
    const summary = await promise;
    expect(summary).not.toBeNull();
    expect(summary!.frames).toBe(2);
  });

  it("returns null where there is no animation frame clock at all", async () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    await expect(sampleFrames(10, 50)).resolves.toBeNull();
  });
});

describe("environment probes degrade instead of throwing", () => {
  it("reports nulls when WebGL is unavailable, as it is under jsdom", () => {
    const graphics = readGraphics();
    expect(graphics.gpu).toBeNull();
    expect(graphics.renderer).toBeNull();
    expect(typeof graphics.webgpu).toBe("boolean");
  });

  it("reads what the test environment does expose without throwing", () => {
    expect(() => readDisplay()).not.toThrow();
    expect(() => readRuntime()).not.toThrow();
    const display = readDisplay();
    expect(display.pixelRatio).not.toBeUndefined();
  });
});
