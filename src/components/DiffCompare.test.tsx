import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { detectFile } = vi.hoisted(() => ({ detectFile: vi.fn() }));
vi.mock("../services/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/tauri")>()),
  api: { detectFile },
}));
const { openDialog } = vi.hoisted(() => ({ openDialog: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));

import { DiffCompare, type DiffSelection } from "./DiffCompare";
import { useWorkspace } from "../stores/workspace";
import type { FileDescriptor, HandlerId } from "../types/files";

const file = (name: string, handlerId: HandlerId = "sql", size = 100): FileDescriptor => ({
  path: `D:/files/${name}`, name, extension: name.split(".").pop() ?? null, mimeType: null,
  detectedType: "SQL script", handlerId, size, createdMs: null, modifiedMs: 1, readonly: false,
});

const noop = () => {};

function show(selection: DiffSelection, overrides: Partial<Parameters<typeof DiffCompare>[0]> = {}) {
  return render(
    <DiffCompare selection={selection} onSelect={noop} onSwap={noop} onCompare={noop} close={noop} {...overrides} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspace.setState({ tabs: [], closed: [], activeId: null, busy: false, error: null });
});
afterEach(cleanup);

describe("diff setup", () => {
  it("starts empty, with a drop target on each side", () => {
    show({ a: null, b: null });
    expect(screen.getAllByText("Drop a file here")).toHaveLength(2);
    expect(screen.getByLabelText("Base file")).toBeTruthy();
    expect(screen.getByLabelText("Target file")).toBeTruthy();
  });

  it("enables Compare only once a valid pair is chosen", () => {
    const { rerender } = show({ a: null, b: null });
    expect(screen.getByRole("button", { name: "Compare" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/Choose a file on each side/)).toBeTruthy();

    rerender(<DiffCompare selection={{ a: file("a.sql"), b: file("logo.png", "image") }}
      onSelect={noop} onSwap={noop} onCompare={noop} close={noop} />);
    expect(screen.getByRole("button", { name: "Compare" })).toHaveProperty("disabled", true);

    rerender(<DiffCompare selection={{ a: file("a.sql"), b: file("b.sql") }}
      onSelect={noop} onSwap={noop} onCompare={noop} close={noop} />);
    expect(screen.getByRole("button", { name: "Compare" })).toHaveProperty("disabled", false);
  });

  it("starts the comparison when Compare is pressed", () => {
    const onCompare = vi.fn();
    show({ a: file("a.sql"), b: file("b.sql") }, { onCompare });
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(onCompare).toHaveBeenCalled();
  });

  it("shows the chosen file's details in its slot", () => {
    show({ a: file("schema.sql", "sql", 2048), b: null });
    const slot = screen.getByLabelText("Base file");
    expect(within(slot).getByText("schema.sql")).toBeTruthy();
    // The type row reads "SQL script - 2.0 KB" across several text nodes.
    expect(slot.textContent).toContain("2.0 KB");
    expect(slot.textContent).toContain("SQL script");
    expect(within(slot).queryByText("Drop a file here")).toBeNull();
  });

  it("reports readiness and the size change once both sides are set", () => {
    show({ a: file("a.sql", "sql", 200), b: file("b.sql", "sql", 250) });
    expect(screen.getByText("Ready to compare.")).toBeTruthy();
    expect(screen.getByText(/grew by 50 B \(\+25\.0%\)/)).toBeTruthy();
  });

  it("refuses a binary side instead of offering to compare it", () => {
    show({ a: file("a.sql"), b: file("logo.png", "image") });
    expect(screen.getByText(/logo\.png is not text/)).toBeTruthy();
    expect(screen.queryByText("Ready to compare.")).toBeNull();
  });

  it("warns about mismatched extensions but stays ready", () => {
    show({ a: file("a.sql", "sql"), b: file("b.txt", "text") });
    expect(screen.getByText(/Comparing a \.sql with a \.txt/)).toBeTruthy();
    expect(screen.getByText("Ready to compare.")).toBeTruthy();
  });

  it("swaps the two sides", () => {
    const onSwap = vi.fn();
    show({ a: file("a.sql"), b: null }, { onSwap });
    fireEvent.click(screen.getByLabelText("Swap the two sides"));
    expect(onSwap).toHaveBeenCalled();
  });

  it("cannot swap while both sides are empty", () => {
    show({ a: null, b: null });
    expect(screen.getByLabelText("Swap the two sides")).toHaveProperty("disabled", true);
  });

  it("clears a slot", () => {
    const onSelect = vi.fn();
    show({ a: file("a.sql"), b: null }, { onSelect });
    fireEvent.click(screen.getByLabelText("Clear the base file"));
    expect(onSelect).toHaveBeenCalledWith("a", null);
  });

  it("offers open text tabs as one-click sources, excluding binaries", () => {
    useWorkspace.setState({
      tabs: [
        { id: "1", file: file("open.sql"), dirty: false, status: "", loadKey: 1 },
        { id: "2", file: file("pic.png", "image"), dirty: false, status: "", loadKey: 1 },
      ],
    });
    const onSelect = vi.fn();
    show({ a: null, b: null }, { onSelect });
    expect(screen.queryByRole("button", { name: "pic.png" })).toBeNull();
    fireEvent.click(within(screen.getByLabelText("Target file")).getByRole("button", { name: "open.sql" }));
    expect(onSelect).toHaveBeenCalledWith("b", expect.objectContaining({ name: "open.sql" }));
  });

  it("browses for a file and detects it through the backend", async () => {
    openDialog.mockResolvedValue("D:/files/picked.sql");
    detectFile.mockResolvedValue(file("picked.sql"));
    const onSelect = vi.fn();
    show({ a: null, b: null }, { onSelect });
    fireEvent.click(within(screen.getByLabelText("Base file")).getByRole("button", { name: /Browse/ }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("a", expect.objectContaining({ name: "picked.sql" })));
  });

  it("selects nothing when the picker is dismissed", async () => {
    openDialog.mockResolvedValue(null);
    const onSelect = vi.fn();
    show({ a: null, b: null }, { onSelect });
    fireEvent.click(within(screen.getByLabelText("Base file")).getByRole("button", { name: /Browse/ }));
    await waitFor(() => expect(openDialog).toHaveBeenCalled());
    expect(onSelect).not.toHaveBeenCalled();
    expect(detectFile).not.toHaveBeenCalled();
  });

  it("surfaces a detection failure instead of failing silently", async () => {
    openDialog.mockResolvedValue("D:/files/broken.sql");
    detectFile.mockRejectedValue(new Error("file is gone"));
    show({ a: null, b: null });
    fireEvent.click(within(screen.getByLabelText("Base file")).getByRole("button", { name: /Browse/ }));
    expect(await screen.findByText("file is gone")).toBeTruthy();
  });

  it("closes on request", () => {
    const close = vi.fn();
    show({ a: null, b: null }, { close });
    fireEvent.click(screen.getByRole("button", { name: /Close/ }));
    expect(close).toHaveBeenCalled();
  });
});
