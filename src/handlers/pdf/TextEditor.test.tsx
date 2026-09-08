import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextEditor } from "./TextEditor";
import { DEFAULT_STYLE, type TextRun } from "./editing";

const run = (text: string, overrides: Partial<TextRun> = {}): TextRun => ({ ...DEFAULT_STYLE, text, ...overrides });

function mount(initial: TextRun[] = []) {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <TextEditor initial={initial} left={10} top={20} scale={1} onCommit={onCommit} onCancel={onCancel} />,
  );
  const surface = view.container.querySelector(".pdf-text-surface") as HTMLDivElement;
  return { ...view, surface, onCommit, onCancel };
}

/** Selects everything in the editable surface, as a user dragging over it would. */
function selectAll(surface: HTMLElement) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(surface);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe("TextEditor", () => {
  afterEach(cleanup);

  it("draws the formatting controls as real icons, not letter glyphs", () => {
    const { container } = mount();
    const toolbar = container.querySelector(".pdf-text-toolbar") as HTMLElement;
    const icons = toolbar.querySelectorAll("svg");
    expect(icons.length).toBeGreaterThanOrEqual(6);
    for (const icon of icons) {
      expect(icon.getAttribute("class")).toContain("lucide");
      expect(icon.querySelectorAll("path, line, rect, circle, polyline").length).toBeGreaterThan(0);
    }
    expect(toolbar.textContent).not.toContain("Cancel");
  });

  it("offers the full formatting toolbar", () => {
    mount();
    for (const label of ["Bold", "Italic", "Underline", "Strikethrough"]) {
      expect(screen.getByTitle(label)).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Font")).toBeInTheDocument();
    expect(screen.getByLabelText("Font size")).toBeInTheDocument();
    expect(screen.getByLabelText("Text colour")).toBeInTheDocument();
  });

  it("commits typed text as a run", () => {
    const { surface, onCommit } = mount();
    surface.textContent = "hello";
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toEqual([expect.objectContaining({ text: "hello", bold: false })]);
  });

  it("applies bold to the selected text only", () => {
    const { surface, onCommit } = mount();
    surface.innerHTML = "<span>plain</span><span>loud</span>";
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(surface.lastChild as Node);
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.click(screen.getByTitle("Bold"));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const runs = onCommit.mock.calls[0][0] as TextRun[];
    expect(runs.map((item) => [item.text, item.bold])).toEqual([["plain", false], ["loud", true]]);
  });

  it("applies size and colour to the selection", () => {
    const { surface, onCommit } = mount();
    surface.textContent = "styled";
    selectAll(surface);
    fireEvent.change(screen.getByLabelText("Font size"), { target: { value: "24" } });
    selectAll(surface);
    fireEvent.change(screen.getByLabelText("Text colour"), { target: { value: "#ff0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const runs = onCommit.mock.calls[0][0] as TextRun[];
    expect(runs[0].size).toBe(24);
    expect(runs[0].color).toBe("#ff0000");
  });

  it("reopens existing runs for editing without losing their formatting", () => {
    const { onCommit } = mount([run("keep me", { bold: true, italic: true, size: 18, color: "#0000ff" })]);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onCommit.mock.calls[0][0]).toEqual([
      expect.objectContaining({ text: "keep me", bold: true, italic: true, size: 18, color: "#0000ff" }),
    ]);
  });

  it("cancels on Escape without committing", () => {
    const { surface, onCommit, onCancel } = mount();
    surface.textContent = "discard";
    fireEvent.keyDown(surface, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
