import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readSpreadsheet, editSpreadsheet, openSystem } = vi.hoisted(() => ({
  readSpreadsheet: vi.fn(),
  editSpreadsheet: vi.fn(),
  openSystem: vi.fn(),
}));

vi.mock("../../services/tauri", () => ({ api: { readSpreadsheet, editSpreadsheet, openSystem } }));

import SpreadsheetViewer from "./SpreadsheetViewer";
import type { FileDescriptor, WorkbookView } from "../../types/files";

const text = (value: string) => ({ text: value, kind: "text" as const });
const number = (value: string) => ({ text: value, kind: "number" as const });

const view: WorkbookView = {
  sheets: [{ index: 0, name: "Sales", hidden: false, selectable: true }],
  activeIndex: 0,
  rows: [
    [text("Region"), text("Units")],
    [text("North"), number("120")],
    [text("South"), number("98")],
  ],
  startRow: 0,
  startColumn: 0,
  totalRows: 3,
  totalColumns: 2,
  truncated: false,
};

const file: FileDescriptor = {
  path: "C:\\book.xlsx",
  name: "book.xlsx",
  extension: "xlsx",
  mimeType: null,
  detectedType: "Excel workbook",
  handlerId: "spreadsheet",
  size: 100,
  createdMs: null,
  modifiedMs: 42,
  readonly: false,
};

function mount(descriptor: FileDescriptor = file) {
  const onDirtyChange = vi.fn();
  const result = render(
    <SpreadsheetViewer file={descriptor} tabId="sheet" onDirtyChange={onDirtyChange} onStatusChange={vi.fn()} />,
  );
  return { ...result, onDirtyChange };
}

const cellsOf = (container: HTMLElement) => [...container.querySelectorAll(".sheet-cell")].map((cell) => cell.textContent);

/**
 * jsdom reports every element as zero-sized and has no ResizeObserver, so the
 * virtualizer would render no rows at all. Give it a viewport to measure.
 */
function giveElementsSize() {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  for (const property of ["offsetHeight", "clientHeight"]) {
    Object.defineProperty(HTMLElement.prototype, property, { configurable: true, value: 600 });
  }
  for (const property of ["offsetWidth", "clientWidth"]) {
    Object.defineProperty(HTMLElement.prototype, property, { configurable: true, value: 900 });
  }
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 600, width: 900, height: 600, toJSON: () => ({}) }),
  });
}

describe("SpreadsheetViewer", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    giveElementsSize();
    readSpreadsheet.mockResolvedValue(structuredClone(view));
    editSpreadsheet.mockResolvedValue({ file, view: structuredClone(view) });
  });

  it("resizes a column by dragging its handle", async () => {
    const { container } = mount();
    await screen.findByText("Region");
    const header = container.querySelectorAll(".sheet-header .header-cell")[1] as HTMLElement;
    const before = header.style.width;
    fireEvent.mouseDown(header.querySelector(".resize-handle")!, { clientX: 200 });
    fireEvent.mouseMove(window, { clientX: 260 });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(header.style.width).not.toBe(before));
    expect(parseInt(header.style.width, 10)).toBe(parseInt(before, 10) + 60);
  });

  it("opens a column filter menu and narrows the rows", async () => {
    const { container } = mount();
    await screen.findByText("Region");
    expect(cellsOf(container)).toContain("South");

    fireEvent.click(screen.getAllByTitle(/^Filter column/)[0]);
    const menu = await screen.findByPlaceholderText("Contains…");
    fireEvent.change(menu, { target: { value: "north" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(cellsOf(container)).not.toContain("South"));
    expect(cellsOf(container)).toContain("North");
  });

  it("filters by unticking a value in the checklist", async () => {
    const { container } = mount();
    await screen.findByText("Region");
    fireEvent.click(screen.getAllByTitle(/^Filter column/)[0]);
    const menu = await screen.findByPlaceholderText("Contains…");
    const panel = menu.closest(".filter-menu") as HTMLElement;
    fireEvent.click(within(panel).getByText("North").closest("label")!.querySelector("input")!);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(cellsOf(container)).not.toContain("North"));
    expect(cellsOf(container)).toContain("South");
  });

  it("edits a cell, marks the tab dirty, and saves the absolute coordinates", async () => {
    const { container, onDirtyChange } = mount();
    await screen.findByText("Region");
    const target = [...container.querySelectorAll(".sheet-cell")].find((cell) => cell.textContent === "North")!;
    fireEvent.doubleClick(target);
    const editor = container.querySelector(".sheet-editor") as HTMLInputElement;
    expect(editor).toBeTruthy();
    fireEvent.change(editor, { target: { value: "Northwest" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(cellsOf(container)).toContain("Northwest"));
    expect(onDirtyChange).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(editSpreadsheet).toHaveBeenCalledTimes(1));
    expect(editSpreadsheet).toHaveBeenCalledWith({
      path: file.path,
      sheetIndex: 0,
      edits: [{ row: 1, column: 0, value: "Northwest" }],
      expectedModifiedMs: 42,
    });
  });

  it("offsets edits by the sheet's used range so the right cell is written", async () => {
    readSpreadsheet.mockResolvedValue({ ...structuredClone(view), startRow: 4, startColumn: 2 });
    const { container } = mount();
    await screen.findByText("Region");
    fireEvent.doubleClick([...container.querySelectorAll(".sheet-cell")].find((c) => c.textContent === "North")!);
    fireEvent.change(container.querySelector(".sheet-editor")!, { target: { value: "X" } });
    fireEvent.keyDown(container.querySelector(".sheet-editor")!, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(editSpreadsheet).toHaveBeenCalled());
    expect(editSpreadsheet.mock.calls[0][0].edits).toEqual([{ row: 5, column: 2, value: "X" }]);
  });

  it("discards pending edits and clears the dirty flag", async () => {
    const { container, onDirtyChange } = mount();
    await screen.findByText("Region");
    fireEvent.doubleClick([...container.querySelectorAll(".sheet-cell")].find((c) => c.textContent === "North")!);
    fireEvent.change(container.querySelector(".sheet-editor")!, { target: { value: "Changed" } });
    fireEvent.keyDown(container.querySelector(".sheet-editor")!, { key: "Enter" });
    await waitFor(() => expect(cellsOf(container)).toContain("Changed"));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(cellsOf(container)).toContain("North"));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("does not offer editing for a format that cannot be written back", async () => {
    const { container } = mount({ ...file, name: "old.xls", extension: "xls" });
    await screen.findByText("Region");
    expect(screen.getByText("Editing needs .xlsx or .xlsm")).toBeInTheDocument();
    fireEvent.doubleClick([...container.querySelectorAll(".sheet-cell")].find((c) => c.textContent === "North")!);
    expect(container.querySelector(".sheet-editor")).toBeNull();
  });

  it("surfaces a save failure instead of clearing the pending edits", async () => {
    editSpreadsheet.mockRejectedValue(new Error("The workbook changed outside OneOpen"));
    const { container } = mount();
    await screen.findByText("Region");
    fireEvent.doubleClick([...container.querySelectorAll(".sheet-cell")].find((c) => c.textContent === "North")!);
    fireEvent.change(container.querySelector(".sheet-editor")!, { target: { value: "Nope" } });
    fireEvent.keyDown(container.querySelector(".sheet-editor")!, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: /^Save/ }));
    expect(await screen.findByText("The workbook changed outside OneOpen")).toBeInTheDocument();
    expect(cellsOf(container)).toContain("Nope");
  });
});
