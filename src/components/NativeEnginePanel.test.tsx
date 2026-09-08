import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { engineReport, clearRecentFiles, clearSavedSession } = vi.hoisted(() => ({
  engineReport: vi.fn(),
  clearRecentFiles: vi.fn(),
  clearSavedSession: vi.fn(),
}));
vi.mock("../services/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/tauri")>()),
  api: { engineReport, clearRecentFiles, clearSavedSession },
}));

import { NativeEnginePanel } from "./NativeEnginePanel";
import type { EngineReport } from "../types/files";

const report: EngineReport = {
  appVersion: "0.1.0",
  target: "x86_64-pc-windows-msvc",
  profile: "release",
  tauriVersion: "2.11.5",
  unsafeForbidden: true,
  engines: [
    { category: "Spreadsheets", module: "calamine", version: "0.36.1", runtime: "Rust core", formats: ["xlsx", "xls"] },
    { category: "PDF", module: "pdf.js + pdf-lib", version: "bundled", runtime: "WebView", formats: ["pdf"] },
  ],
  limits: [
    { name: "Document", value: 33554432, unit: "bytes", why: "Word files above this are refused" },
    { name: "Archive entries", value: 100000, unit: "files", why: "Entry count ceiling" },
  ],
  isolation: {
    csp: "default-src 'self'; connect-src ipc: http://ipc.localhost",
    permissions: ["core:default", "dialog:allow-open"],
    networkPlugins: false,
  },
};

const all = () => true;

beforeEach(() => {
  vi.clearAllMocks();
  engineReport.mockResolvedValue(report);
});
afterEach(cleanup);

describe("native engine panel", () => {
  it("reports the build facts the binary carries", async () => {
    render(<NativeEnginePanel matches={all} />);
    expect(await screen.findByText(/OneOpen 0.1.0/)).toBeTruthy();
    expect(screen.getByText("x86_64-pc-windows-msvc")).toBeTruthy();
    expect(screen.getByText("Tauri 2.11.5")).toBeTruthy();
    expect(screen.getByText("Forbidden crate-wide")).toBeTruthy();
  });

  it("says plainly that there is no mmap, SIMD or GPU path", async () => {
    render(<NativeEnginePanel matches={all} />);
    const note = await screen.findByText(/no memory-mapping layer/);
    expect(note.textContent).toContain("ordinary buffered I/O");
    expect(note.textContent).toContain("no SIMD-specialised parser");
  });

  it("lists each decoder with the version Cargo resolved and where it runs", async () => {
    render(<NativeEnginePanel matches={all} />);
    const table = await screen.findByRole("table");
    const row = within(table).getByText("calamine").closest("tr")!;
    expect(within(row).getByText("0.36.1")).toBeTruthy();
    expect(within(row).getByText("Rust core")).toBeTruthy();
    expect(within(within(table).getByText("pdf.js + pdf-lib").closest("tr")!).getByText("WebView")).toBeTruthy();
  });

  it("formats byte limits as sizes and other limits with their unit", async () => {
    render(<NativeEnginePanel matches={all} />);
    expect(await screen.findByText("32 MB")).toBeTruthy();
    // Grouping follows the runtime locale, so the expectation is built the same way.
    expect(screen.getByText(`${(100000).toLocaleString()} files`)).toBeTruthy();
  });

  it("shows the real CSP and capability list rather than describing them", async () => {
    render(<NativeEnginePanel matches={all} />);
    expect(await screen.findByText(/connect-src ipc:/)).toBeTruthy();
    expect(screen.getByText("dialog:allow-open")).toBeTruthy();
    expect(screen.getByText(/Granted capabilities \(2\)/)).toBeTruthy();
  });

  it("does not claim a socket filter it has not got", async () => {
    render(<NativeEnginePanel matches={all} />);
    const note = await screen.findByText(/no syscall-level socket filter/);
    expect(note).toBeTruthy();
  });

  it("says the recents database is unencrypted rather than claiming DPAPI", async () => {
    render(<NativeEnginePanel matches={all} />);
    expect(await screen.findByText(/the database is not encrypted/)).toBeTruthy();
  });

  it("clears the recent files after confirmation", async () => {
    clearRecentFiles.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<NativeEnginePanel matches={all} />);
    fireEvent.click(await screen.findByRole("button", { name: /Clear history/ }));
    await waitFor(() => expect(clearRecentFiles).toHaveBeenCalled());
    expect(await screen.findByText("Recent files cleared.")).toBeTruthy();
  });

  it("clears nothing when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<NativeEnginePanel matches={all} />);
    fireEvent.click(await screen.findByRole("button", { name: /Forget tabs/ }));
    expect(clearSavedSession).not.toHaveBeenCalled();
  });

  it("filters down to one section", async () => {
    const only = (...text: string[]) => text.some((value) => value.includes("isolation"));
    render(<NativeEnginePanel matches={only} />);
    expect(await screen.findByText(/connect-src ipc:/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("surfaces a failed report instead of an empty panel", async () => {
    engineReport.mockRejectedValue(new Error("command not registered"));
    render(<NativeEnginePanel matches={all} />);
    expect(await screen.findByText("command not registered")).toBeTruthy();
  });
});
