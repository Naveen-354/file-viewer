import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { storageReport, clearRecentFiles, clearSavedSession, showInFolder } = vi.hoisted(() => ({
  storageReport: vi.fn(), clearRecentFiles: vi.fn(), clearSavedSession: vi.fn(), showInFolder: vi.fn(),
}));
vi.mock("../services/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/tauri")>()),
  api: { storageReport, clearRecentFiles, clearSavedSession, showInFolder },
}));

import { StoragePanel } from "./StoragePanel";

const all = () => true;

const report = {
  databasePath: "C:\\Users\\dev\\AppData\\Roaming\\OneOpen\\oneopen.sqlite3",
  databaseBytes: 73728,
  totalRows: 41,
  tables: [
    { name: "settings", purpose: "Your preferences, stored as one JSON row.", cap: null, rows: 1 },
    { name: "recent_files", purpose: "Paths and names of files you have opened.", cap: "100 returned", rows: 37 },
    { name: "session_tabs", purpose: "The tab list restored on launch.", cap: "50 saved", rows: 3 },
    { name: "handler_preferences", purpose: "Created by the first migration and never used.", cap: null, rows: 0 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  storageReport.mockResolvedValue(report);
  clearRecentFiles.mockResolvedValue(undefined);
  clearSavedSession.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("storage panel", () => {
  it("shows where the database is and how big it is", async () => {
    render(<StoragePanel matches={all} />);
    expect(await screen.findByText(report.databasePath)).toBeTruthy();
    expect(screen.getByText("72 KB")).toBeTruthy();
    expect(screen.getByText("41")).toBeTruthy();
  });

  it("says the database has not been created rather than showing 0 bytes", async () => {
    storageReport.mockResolvedValue({ ...report, databaseBytes: 0 });
    render(<StoragePanel matches={all} />);
    expect(await screen.findByText("Not created yet")).toBeTruthy();
  });

  it("lists each table with its row count and the limit that applies", async () => {
    render(<StoragePanel matches={all} />);
    const row = await waitFor(() => screen.getByText("recent_files").closest("tr")!);
    expect(within(row).getByText("37")).toBeTruthy();
    expect(within(row).getByText("100 returned")).toBeTruthy();
  });

  it("shows a table with no limit as a dash rather than inventing one", async () => {
    render(<StoragePanel matches={all} />);
    const row = await waitFor(() => screen.getByText("settings").closest("tr")!);
    expect(within(row).getByText("—")).toBeTruthy();
  });

  it("surfaces the unused table instead of hiding it", async () => {
    render(<StoragePanel matches={all} />);
    const row = await waitFor(() => screen.getByText("handler_preferences").closest("tr")!);
    expect(within(row).getByText(/never used/)).toBeTruthy();
  });

  it("clears recents after confirmation and reloads the counts", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<StoragePanel matches={all} />);
    await screen.findByText("recent_files");
    fireEvent.click(screen.getByRole("button", { name: /Clear recent files/ }));
    await waitFor(() => expect(clearRecentFiles).toHaveBeenCalled());
    // The report is fetched again so the row count reflects the change.
    await waitFor(() => expect(storageReport).toHaveBeenCalledTimes(2));
  });

  it("does nothing when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<StoragePanel matches={all} />);
    await screen.findByText("recent_files");
    fireEvent.click(screen.getByRole("button", { name: /Forget saved tabs/ }));
    expect(clearSavedSession).not.toHaveBeenCalled();
  });

  it("describes the atomic-save temp file and where it lives", () => {
    render(<StoragePanel matches={all} />);
    expect(screen.getByText(/renamed over it/)).toBeTruthy();
    expect(screen.getByText(/never a separate scratch pool/)).toBeTruthy();
    expect(screen.getByText(/no temp directory, no spill file/)).toBeTruthy();
  });

  it("says file content is never copied to disk", () => {
    render(<StoragePanel matches={all} />);
    expect(screen.getByText(/Nothing you view is copied to disk/)).toBeTruthy();
  });

  it("denies the caches, quotas and benchmarks the design showed", () => {
    render(<StoragePanel matches={all} />);
    for (const claim of [/No thumbnail, waveform/, /No scratch quota/, /No memory-mapped or sparse files/, /No disk benchmarking/, /No secure-erase pass/]) {
      expect(screen.getByText(claim)).toBeTruthy();
    }
    expect(screen.getByText(/do not exist, so there is nothing to purge/)).toBeTruthy();
  });

  it("keeps the written sections when the report cannot be read", async () => {
    storageReport.mockRejectedValue(new Error("no data dir"));
    render(<StoragePanel matches={all} />);
    expect(await screen.findByText("no data dir")).toBeTruthy();
    expect(screen.getByText(/renamed over it/)).toBeTruthy();
    expect(screen.queryByText("recent_files")).toBeNull();
  });

  it("honours the settings filter", () => {
    render(<StoragePanel matches={(...text) => text.includes("scratch")} />);
    expect(screen.getByText("Scratch space")).toBeTruthy();
    expect(screen.queryByText("On disk")).toBeNull();
  });
});
