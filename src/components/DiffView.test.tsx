import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { saveTextAs } = vi.hoisted(() => ({ saveTextAs: vi.fn() }));
vi.mock("../services/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/tauri")>()),
  api: { saveTextAs },
}));
const { saveDialog } = vi.hoisted(() => ({ saveDialog: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveDialog }));
const { readBytes } = vi.hoisted(() => ({ readBytes: vi.fn() }));
vi.mock("../utils/file", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/file")>()),
  readBytes,
}));

import { DiffView } from "./DiffView";
import type { FileDescriptor } from "../types/files";

const descriptor = (name: string, size = 100): FileDescriptor => ({
  path: `D:/files/${name}`, name, extension: "sql", mimeType: null,
  detectedType: "SQL script", handlerId: "sql", size, createdMs: null, modifiedMs: 1_700_000_000_000, readonly: false,
});

const LEFT = "CREATE TABLE users (\n  id UUID,\n  status VARCHAR(32)\n);\nDROP TABLE legacy;\n";
const RIGHT = "CREATE TABLE users (\n  id UUID,\n  status user_status_enum\n);\nCREATE INDEX idx ON users(id);\n";

function mount(left = LEFT, right = RIGHT) {
  const encoder = new TextEncoder();
  readBytes.mockImplementation((path: string) =>
    Promise.resolve(encoder.encode(path.endsWith("a.sql") ? left : right)));
  return render(
    <DiffView left={descriptor("a.sql", 100)} right={descriptor("b.sql", 160)} onSwap={() => {}} close={() => {}} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  saveTextAs.mockResolvedValue({});
});
afterEach(cleanup);

describe("diff view", () => {
  it("shows both files with the size change", async () => {
    mount();
    await screen.findByText(/computed in/);
    expect(screen.getByText("a.sql")).toBeTruthy();
    expect(screen.getByText("b.sql")).toBeTruthy();
    expect(screen.getByText(/\(\+60 B\)/)).toBeTruthy();
  });

  it("counts additions, deletions and modifications", async () => {
    mount();
    await screen.findByText(/computed in/);
    // status line changed; DROP replaced by CREATE INDEX.
    expect(screen.getByText("~2")).toBeTruthy();
    expect(screen.getByText("+0")).toBeTruthy();
    expect(screen.getByText("−0")).toBeTruthy();
  });

  it("renders both sides in the split table with line numbers", async () => {
    const { container } = mount();
    await screen.findByText(/computed in/);
    const table = container.querySelector(".diff-table.split")!;
    expect(table).toBeTruthy();
    // An unchanged line appears in both columns, so there are two of it.
    expect(within(table as HTMLElement).getAllByText("CREATE TABLE users (")).toHaveLength(2);
    // Text matching normalises whitespace, so the indentation is checked directly.
    const cells = [...table.querySelectorAll(".diff-code")].map((cell) => cell.textContent);
    expect(cells).toContain("  status VARCHAR(32)");
    expect(cells).toContain("  status user_status_enum");
    expect(within(table as HTMLElement).getAllByText("1").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("tr.modified").length).toBe(2);
  });

  it("switches to the unified layout", async () => {
    const { container } = mount();
    await screen.findByText(/computed in/);
    fireEvent.click(screen.getByRole("button", { name: /Unified/ }));
    expect(container.querySelector(".diff-table.unified")).toBeTruthy();
    expect(container.querySelector(".diff-table.split")).toBeNull();
    // A modified row becomes a removal followed by an addition.
    expect(container.querySelectorAll("tr.removed").length).toBe(2);
    expect(container.querySelectorAll("tr.added").length).toBe(2);
  });

  it("recomputes when whitespace is ignored", async () => {
    mount("SELECT  1;\n", "SELECT 1;\n");
    await screen.findByText(/computed in/);
    expect(screen.queryByText(/identical/)).toBeNull();
    fireEvent.click(screen.getByLabelText(/Ignore whitespace/i, { selector: "input" }));
    await waitFor(() => expect(screen.getByText(/identical under the options selected/)).toBeTruthy());
  });

  it("says when the files match exactly", async () => {
    mount("same\n", "same\n");
    expect(await screen.findByText(/These files are identical/)).toBeTruthy();
    expect(screen.queryByText(/under the options selected/)).toBeNull();
  });

  it("counts the change blocks and offers navigation", async () => {
    mount();
    await screen.findByText(/computed in/);
    expect(screen.getByText("1 of 2")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Next change"));
    expect(screen.getByText("2 of 2")).toBeTruthy();
    // Wraps around rather than stopping at the end.
    fireEvent.click(screen.getByLabelText("Next change"));
    expect(screen.getByText("1 of 2")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Previous change"));
    expect(screen.getByText("2 of 2")).toBeTruthy();
  });

  it("exports a patch to a chosen file", async () => {
    saveDialog.mockResolvedValue("D:/out/change.patch");
    mount();
    await screen.findByText(/computed in/);
    fireEvent.click(screen.getByRole("button", { name: /Export patch/ }));
    await waitFor(() => expect(saveTextAs).toHaveBeenCalled());
    const [, destination, body] = saveTextAs.mock.calls[0];
    expect(destination).toBe("D:/out/change.patch");
    expect(body).toContain("--- a/a.sql");
    expect(body).toContain("+++ b/b.sql");
    expect(body).toContain("-  status VARCHAR(32)");
  });

  it("writes nothing when the save dialog is dismissed", async () => {
    saveDialog.mockResolvedValue(null);
    mount();
    await screen.findByText(/computed in/);
    fireEvent.click(screen.getByRole("button", { name: /Export patch/ }));
    await waitFor(() => expect(saveDialog).toHaveBeenCalled());
    expect(saveTextAs).not.toHaveBeenCalled();
  });

  it("cannot export a patch for identical files", async () => {
    mount("same\n", "same\n");
    await screen.findByText(/identical/);
    expect(screen.getByRole("button", { name: /Export patch/ })).toHaveProperty("disabled", true);
  });

  it("reports a read failure instead of an empty comparison", async () => {
    readBytes.mockRejectedValue(new Error("file vanished"));
    render(<DiffView left={descriptor("a.sql")} right={descriptor("b.sql")} onSwap={() => {}} close={() => {}} />);
    expect(await screen.findByText("file vanished")).toBeTruthy();
  });

  it("reports how long the comparison took", async () => {
    mount();
    expect(await screen.findByText(/computed in \d/)).toBeTruthy();
  });
});
