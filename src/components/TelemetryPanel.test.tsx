import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { engineReport } = vi.hoisted(() => ({ engineReport: vi.fn() }));
vi.mock("../services/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/tauri")>()),
  api: { engineReport },
}));
const { probeEgress } = vi.hoisted(() => ({ probeEgress: vi.fn() }));
vi.mock("../utils/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/network")>()),
  probeEgress,
}));

import { TelemetryPanel } from "./TelemetryPanel";

const CSP = "default-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' blob: data:; object-src 'none'; frame-src 'none'";
const all = () => true;

beforeEach(() => {
  vi.clearAllMocks();
  engineReport.mockResolvedValue({
    appVersion: "0.1.0", target: "x86_64-pc-windows-msvc", profile: "release",
    tauriVersion: "2.9.1", unsafeForbidden: true, engines: [], limits: [],
    isolation: { csp: CSP, permissions: ["core:default", "dialog:allow-open", "dialog:allow-save"] },
  });
  probeEgress.mockResolvedValue(null);
});
afterEach(cleanup);

describe("telemetry & network panel", () => {
  it("says only the IPC bridge may be contacted", async () => {
    render(<TelemetryPanel matches={all} />);
    expect(screen.getByText("IPC only")).toBeTruthy();
    expect(await screen.findByText(/not even this origin/)).toBeTruthy();
  });

  it("breaks the policy into directives and explains each", async () => {
    render(<TelemetryPanel matches={all} />);
    const row = await waitFor(() => screen.getByText("connect-src").closest("tr")!);
    expect(within(row).getByText("ipc: http://ipc.localhost")).toBeTruthy();
    expect(within(row).getByText(/Only the local IPC bridge/)).toBeTruthy();
  });

  it("marks the directives that forbid everything", async () => {
    render(<TelemetryPanel matches={all} />);
    const row = await waitFor(() => screen.getByText("object-src").closest("tr")!);
    expect(within(row).getByText("nothing")).toBeTruthy();
  });

  it("only runs the egress check when asked", async () => {
    render(<TelemetryPanel matches={all} />);
    await screen.findByText("IPC only");
    expect(probeEgress).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Test egress/ }));
    await waitFor(() => expect(probeEgress).toHaveBeenCalled());
  });

  it("reports a policy block as the confirming result", async () => {
    probeEgress.mockResolvedValue({
      verdict: "blocked-by-policy", directive: "connect-src",
      blockedUri: "https://egress-check.invalid/oneopen",
      detail: "The window refused the connection before it left the process.",
    });
    render(<TelemetryPanel matches={all} />);
    fireEvent.click(screen.getByRole("button", { name: /Test egress/ }));
    expect(await screen.findByText("Blocked by the content policy")).toBeTruthy();
    expect(screen.getByText("violated connect-src")).toBeTruthy();
  });

  it("does not present an ordinary failure as proof", async () => {
    probeEgress.mockResolvedValue({
      verdict: "failed-otherwise", directive: null, blockedUri: null,
      detail: "The request failed, but no content-policy violation was reported — so this does not prove the policy blocked it.",
    });
    render(<TelemetryPanel matches={all} />);
    fireEvent.click(screen.getByRole("button", { name: /Test egress/ }));
    expect(await screen.findByText(/not provably by the policy/)).toBeTruthy();
  });

  it("flags an unblocked request rather than reporting success", async () => {
    probeEgress.mockResolvedValue({
      verdict: "not-blocked", directive: null, blockedUri: "https://egress-check.invalid/oneopen",
      detail: "The request was not refused by the content policy. That is unexpected for this build.",
    });
    render(<TelemetryPanel matches={all} />);
    fireEvent.click(screen.getByRole("button", { name: /Test egress/ }));
    const result = await screen.findByText("Not blocked");
    expect(result.closest(".egress-result")!.className).toContain("not-blocked");
  });

  it("promises the check sends nothing anywhere", () => {
    render(<TelemetryPanel matches={all} />);
    expect(screen.getByText(/can never resolve/)).toBeTruthy();
    expect(screen.getByText(/Nothing is sent anywhere/)).toBeTruthy();
  });

  it("lists the granted capabilities and says none grants network access", async () => {
    render(<TelemetryPanel matches={all} />);
    expect(await screen.findByText("dialog:allow-save")).toBeTruthy();
    expect(screen.getByText(/None of them grants\s+HTTP access/)).toBeTruthy();
  });

  it("says telemetry is absent by construction, not switched off", () => {
    render(<TelemetryPanel matches={all} />);
    expect(screen.getByText("Usage analytics")).toBeTruthy();
    expect(screen.getByText("Crash reporting")).toBeTruthy();
    expect(screen.getByText(/absent by construction rather than switched off/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("denies the kernel driver, packet counters and attestation", () => {
    render(<TelemetryPanel matches={all} />);
    expect(screen.getByText(/No kernel driver and no Windows Filtering Platform/)).toBeTruthy();
    expect(screen.getByText(/nothing is measured/)).toBeTruthy();
    expect(screen.getByText(/No cryptographic attestation/)).toBeTruthy();
    expect(screen.getByText(/would not stop another program on this machine/)).toBeTruthy();
  });

  it("still shows the written sections when the report cannot be read", async () => {
    engineReport.mockRejectedValue(new Error("command failed"));
    render(<TelemetryPanel matches={all} />);
    expect(await screen.findByText("command failed")).toBeTruthy();
    expect(screen.getByText("Usage analytics")).toBeTruthy();
    expect(screen.queryByText("connect-src")).toBeNull();
  });

  it("honours the settings filter", () => {
    render(<TelemetryPanel matches={(...text) => text.includes("telemetry")} />);
    expect(screen.getByText("What is not here")).toBeTruthy();
    expect(screen.queryByText("Outbound network")).toBeNull();
  });
});
