import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { engineReport, recentFiles, clearRecentFiles, clearSavedSession } = vi.hoisted(() => ({
  engineReport: vi.fn(), recentFiles: vi.fn(), clearRecentFiles: vi.fn(), clearSavedSession: vi.fn(),
}));
vi.mock("../services/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/tauri")>()),
  api: { engineReport, recentFiles, clearRecentFiles, clearSavedSession },
}));

import { SecurityPanel } from "./SecurityPanel";

const all = () => true;

beforeEach(() => {
  vi.clearAllMocks();
  engineReport.mockResolvedValue({
    appVersion: "0.1.0", target: "x86_64-pc-windows-msvc", profile: "release",
    tauriVersion: "2.9.1", unsafeForbidden: true,
    engines: [], limits: [],
    isolation: { csp: "default-src 'self'", permissions: ["core:default", "dialog:allow-open"] },
  });
  recentFiles.mockResolvedValue([{ path: "a" }, { path: "b" }, { path: "c" }]);
  clearRecentFiles.mockResolvedValue(undefined);
  clearSavedSession.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("security panel", () => {
  it("says there are no outbound connections and no telemetry", async () => {
    render(<SecurityPanel matches={all} />);
    expect(screen.getByText("None")).toBeTruthy();
    expect(screen.getByText("Absent")).toBeTruthy();
    expect(await screen.findByText(/Granted capabilities/)).toBeTruthy();
  });

  it("denies the kernel filter the design claimed", () => {
    render(<SecurityPanel matches={all} />);
    expect(screen.getByText(/installs no driver and\s+intercepts no syscall/)).toBeTruthy();
  });

  it("denies the AppContainer and per-handler sandbox", () => {
    render(<SecurityPanel matches={all} />);
    expect(screen.getByText(/no AppContainer, no low-integrity worker/)).toBeTruthy();
    expect(screen.getByText(/One process at your normal integrity level/)).toBeTruthy();
  });

  it("states plainly that nothing is encrypted at rest", async () => {
    render(<SecurityPanel matches={all} />);
    expect(screen.getByText("Not encrypted")).toBeTruthy();
    expect(await screen.findByText(/no DPAPI vault, no TPM binding and no key to rotate/)).toBeTruthy();
  });

  it("lists how each untrusted format is actually handled", () => {
    render(<SecurityPanel matches={all} />);
    const svg = screen.getByText("SVG images").closest("tr")!;
    expect(within(svg).getByText(/DOMPurify strips/)).toBeTruthy();
    const macros = screen.getByText("Word and Excel macros").closest("tr")!;
    expect(within(macros).getByText("Detected, never read or run")).toBeTruthy();
  });

  it("does not claim to scan, strip or disinfect anything", () => {
    render(<SecurityPanel matches={all} />);
    expect(screen.getByText(/Nothing is scanned, stripped or disinfected/)).toBeTruthy();
    expect(screen.getByText(/never run, not removed from your file/)).toBeTruthy();
  });

  it("shows the real number of stored recent files", async () => {
    render(<SecurityPanel matches={all} />);
    expect(await screen.findByText(/3 records, stored as plain text/)).toBeTruthy();
  });

  it("clears recents after confirmation and updates the count", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SecurityPanel matches={all} />);
    await screen.findByText(/3 records/);
    fireEvent.click(screen.getByRole("button", { name: /Clear history/ }));
    await waitFor(() => expect(clearRecentFiles).toHaveBeenCalled());
    expect(await screen.findByText(/0 records/)).toBeTruthy();
  });

  it("clears nothing when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<SecurityPanel matches={all} />);
    fireEvent.click(screen.getByRole("button", { name: /Forget tabs/ }));
    expect(clearSavedSession).not.toHaveBeenCalled();
  });

  it("enumerates the protections it does not have", () => {
    render(<SecurityPanel matches={all} />);
    for (const claim of [/No kernel driver/, /No AppContainer/, /No encryption at rest/, /No memory scrubbing/, /No malware scanning/, /No signed security attestation/]) {
      expect(screen.getByText(claim)).toBeTruthy();
    }
  });

  it("still renders the written facts when the report cannot be read", async () => {
    engineReport.mockRejectedValue(new Error("command failed"));
    render(<SecurityPanel matches={all} />);
    expect(await screen.findByText("command failed")).toBeTruthy();
    // The parts that do not depend on the backend must survive.
    expect(screen.getByText("SVG images")).toBeTruthy();
    expect(screen.getByText("Not encrypted")).toBeTruthy();
  });

  it("honours the settings filter", () => {
    render(<SecurityPanel matches={(...text) => text.includes("dpapi")} />);
    expect(screen.getByText("Data at rest")).toBeTruthy();
    expect(screen.queryByText("Untrusted content")).toBeNull();
  });
});
