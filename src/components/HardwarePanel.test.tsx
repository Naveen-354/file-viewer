import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readGraphics, readDisplay, readRuntime, readAudio, readCodecs, sampleFrames } = vi.hoisted(() => ({
  readGraphics: vi.fn(), readDisplay: vi.fn(), readRuntime: vi.fn(),
  readAudio: vi.fn(), readCodecs: vi.fn(), sampleFrames: vi.fn(),
}));
vi.mock("../utils/hardware", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/hardware")>()),
  readGraphics, readDisplay, readRuntime, readAudio, readCodecs, sampleFrames,
}));

import { HardwarePanel } from "./HardwarePanel";

const all = () => true;

beforeEach(() => {
  vi.clearAllMocks();
  readGraphics.mockReturnValue({
    api: "WebGL 2.0 (OpenGL ES 3.0 Chromium)", vendor: "Google Inc. (Intel)",
    renderer: "ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
    gpu: "Intel(R) UHD Graphics", backend: "D3D11", maxTextureSize: 16384, webgpu: false,
  });
  readDisplay.mockReturnValue({ width: 1920, height: 1080, colorDepth: 32, pixelRatio: 1, hdr: false, reducedMotion: false });
  readRuntime.mockReturnValue({ cores: 8, deviceMemoryGb: null, jsHeapMb: 42, jsHeapLimitMb: 4096 });
  readAudio.mockResolvedValue({ sampleRate: 48000, baseLatencyMs: 10.6, outputLatencyMs: 21.3 });
  readCodecs.mockResolvedValue([
    { label: "H.264 High", codec: "avc1.640028", supported: true, hardware: true },
    { label: "AV1 Main", codec: "av01.0.04M.08", supported: false, hardware: null },
  ]);
  sampleFrames.mockResolvedValue(null);
});
afterEach(cleanup);

describe("hardware panel", () => {
  it("reports the adapter and backend the WebView actually named", async () => {
    render(<HardwarePanel matches={all} />);
    expect(screen.getByText("Intel(R) UHD Graphics")).toBeTruthy();
    expect(screen.getByText("D3D11")).toBeTruthy();
    expect(screen.getByText("16384 px")).toBeTruthy();
  });

  it("says the app cannot choose a backend or manage a shader cache", () => {
    render(<HardwarePanel matches={all} />);
    expect(screen.getByText(/does not pick a graphics backend/)).toBeTruthy();
    expect(screen.getByText(/nothing to configure/)).toBeTruthy();
  });

  it("omits adapter rows the runtime declines to report", () => {
    readGraphics.mockReturnValue({ api: null, vendor: null, renderer: null, gpu: null, backend: null, maxTextureSize: null, webgpu: false });
    render(<HardwarePanel matches={all} />);
    expect(screen.getByText(/does not expose the adapter/)).toBeTruthy();
    expect(screen.queryByText("D3D11")).toBeNull();
  });

  it("measures frame timing only when asked, and draws the result", async () => {
    sampleFrames.mockResolvedValue({
      frames: 60, medianMs: 16.67, averageMs: 16.9, peakMs: 33.2, hz: 59.99,
      intervals: Array.from({ length: 60 }, (_, i) => (i === 30 ? 33.2 : 16.67)),
    });
    const { container } = render(<HardwarePanel matches={all} />);
    expect(sampleFrames).not.toHaveBeenCalled();
    expect(container.querySelector(".frame-spark")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Measure/ }));
    await waitFor(() => expect(screen.getByText("16.67 ms")).toBeTruthy());
    // The row rounds to one decimal, so 59.99 renders as 60.0.
    expect(screen.getByText("60.0 Hz measured")).toBeTruthy();
    expect(container.querySelector(".frame-spark polyline")).toBeTruthy();
  });

  it("warns that a short sample is not representative", async () => {
    sampleFrames.mockResolvedValue({
      frames: 3, medianMs: 16.7, averageMs: 16.7, peakMs: 17, hz: 59.9, intervals: [16.7, 16.7, 17],
    });
    render(<HardwarePanel matches={all} />);
    fireEvent.click(screen.getByRole("button", { name: /Measure/ }));
    await waitFor(() => expect(screen.getByText(/Only 3 frames arrived/)).toBeTruthy());
    expect(screen.getByText(/hidden or minimised/)).toBeTruthy();
  });

  it("lists codec support with hardware status", async () => {
    render(<HardwarePanel matches={all} />);
    const row = await waitFor(() => screen.getByText("avc1.640028").closest("tr")!);
    expect(within(row).getByText("Yes")).toBeTruthy();
    expect(within(row).getByText("Accepted")).toBeTruthy();
  });

  it("says the codec question could not be asked when WebCodecs is missing", async () => {
    readCodecs.mockResolvedValue(null);
    render(<HardwarePanel matches={all} />);
    expect(await screen.findByText(/no WebCodecs API/)).toBeTruthy();
    expect(screen.getByText(/no bundled codecs/)).toBeTruthy();
  });

  it("reports audio latency and disclaims exclusive-mode control", async () => {
    render(<HardwarePanel matches={all} />);
    expect(await screen.findByText("48,000 Hz")).toBeTruthy();
    expect(screen.getByText("10.60 ms")).toBeTruthy();
    expect(screen.getByText(/does not open an\s+exclusive-mode or ASIO device/)).toBeTruthy();
  });

  it("marks device memory as not exposed rather than guessing a number", () => {
    render(<HardwarePanel matches={all} />);
    const card = screen.getByText("Processor and memory").closest("section")!;
    expect(within(card).getByText("Not exposed")).toBeTruthy();
    expect(within(card).getByText("8")).toBeTruthy();
    expect(within(card).getByText("4,096 MB")).toBeTruthy();
  });

  it("says the heap figures are not the process footprint", () => {
    render(<HardwarePanel matches={all} />);
    expect(screen.getByText(/not the process's total\s+memory/)).toBeTruthy();
    expect(screen.getByText(/does not measure GPU memory/)).toBeTruthy();
  });

  it("honours the settings filter, showing only matching cards", () => {
    render(<HardwarePanel matches={(...text) => text.includes("audio")} />);
    expect(screen.getByText("Audio output")).toBeTruthy();
    expect(screen.queryByText("Graphics adapter")).toBeNull();
  });
});
