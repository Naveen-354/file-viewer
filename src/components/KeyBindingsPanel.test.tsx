import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KeyBindingsPanel } from "./KeyBindingsPanel";
import { GLOBAL_SHORTCUTS, shortcutCount } from "../utils/shortcuts";

const all = () => true;
afterEach(cleanup);

describe("key bindings panel", () => {
  it("lists every global shortcut with its keys", () => {
    render(<KeyBindingsPanel matches={all} />);
    const group = screen.getByText(/Anywhere in the app/).closest(".key-group") as HTMLElement;
    for (const shortcut of GLOBAL_SHORTCUTS) {
      expect(within(group).getByText(shortcut.label)).toBeTruthy();
    }
    expect(within(group).getByText("F2")).toBeTruthy();
    expect(within(group).getAllByText("Ctrl").length).toBeGreaterThan(1);
  });

  it("reports the real total rather than a round number", () => {
    render(<KeyBindingsPanel matches={all} />);
    expect(screen.getByText(new RegExp(`${shortcutCount()} in total`))).toBeTruthy();
  });

  it("says which shortcuts need a file open", () => {
    render(<KeyBindingsPanel matches={all} />);
    const row = screen.getByText("Rename file").closest(".key-row") as HTMLElement;
    expect(row.textContent).toContain("Needs a file open.");
    const open = screen.getByText("Open file").closest(".key-row") as HTMLElement;
    expect(open.textContent).not.toContain("Needs a file open.");
  });

  it("groups the viewer shortcuts and names the module behind each", () => {
    render(<KeyBindingsPanel matches={all} />);
    expect(screen.getByText("Spreadsheet")).toBeTruthy();
    const row = screen.getByText("Move selection").closest(".key-row") as HTMLElement;
    expect(within(row).getByText("SpreadsheetViewer")).toBeTruthy();
  });

  it("shows both alternatives when a command has two combinations", () => {
    render(<KeyBindingsPanel matches={all} />);
    const row = screen.getByText("Redo").closest(".key-row") as HTMLElement;
    expect(within(row).getByText("or")).toBeTruthy();
    expect(within(row).getByText("Y")).toBeTruthy();
  });

  it("filters by name", () => {
    render(<KeyBindingsPanel matches={all} />);
    fireEvent.change(screen.getByLabelText("Find a shortcut"), { target: { value: "rename" } });
    expect(screen.getByText("Rename file")).toBeTruthy();
    expect(screen.queryByText("Open file")).toBeNull();
  });

  it("filters by the key combination itself", () => {
    render(<KeyBindingsPanel matches={all} />);
    fireEvent.change(screen.getByLabelText("Find a shortcut"), { target: { value: "ctrl+w" } });
    expect(screen.getByText("Close tab")).toBeTruthy();
    expect(screen.queryByText("Command palette")).toBeNull();
  });

  it("counts the matches and says so", () => {
    render(<KeyBindingsPanel matches={all} />);
    fireEvent.change(screen.getByLabelText("Find a shortcut"), { target: { value: "rename" } });
    expect(screen.getByText(new RegExp(`of ${shortcutCount()} shortcuts match`))).toBeTruthy();
  });

  it("says so when nothing matches", () => {
    render(<KeyBindingsPanel matches={all} />);
    fireEvent.change(screen.getByLabelText("Find a shortcut"), { target: { value: "zzzz" } });
    expect(screen.getByText(/No shortcut matches/)).toBeTruthy();
  });

  it("states that bindings cannot be remapped instead of offering a fake editor", () => {
    render(<KeyBindingsPanel matches={all} />);
    expect(screen.getByText(/no keymap editor/)).toBeTruthy();
    expect(screen.getByText(/no preset profiles/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Record|Listen|Reset Defaults|Save Mappings/ })).toBeNull();
  });

  it("renders nothing when the settings filter excludes it", () => {
    const { container } = render(<KeyBindingsPanel matches={() => false} />);
    expect(container.firstChild).toBeNull();
  });
});
