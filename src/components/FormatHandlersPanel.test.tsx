import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { updateSettings } = vi.hoisted(() => ({ updateSettings: vi.fn() }));
vi.mock("../services/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/tauri")>()),
  api: { updateSettings },
}));

import { FormatHandlersPanel } from "./FormatHandlersPanel";
import { defaults, useSettings } from "../stores/settings";

const all = () => true;

beforeEach(() => {
  vi.clearAllMocks();
  updateSettings.mockResolvedValue(undefined);
  useSettings.setState({ ...defaults, handlerOverrides: {}, loaded: true });
});
afterEach(cleanup);

describe("format handlers panel", () => {
  it("lists the registered viewers with where they decode", () => {
    render(<FormatHandlersPanel matches={all} />);
    const row = screen.getByText("spreadsheet").closest("tr")!;
    expect(within(row).getByText("Rust core")).toBeTruthy();
    expect(within(row).getByText(/\.xlsx/)).toBeTruthy();
    expect(screen.getByText("pdf").closest("tr")!.textContent).toContain("WebView");
  });

  it("says decoding location is not a sandbox boundary", () => {
    render(<FormatHandlersPanel matches={all} />);
    expect(screen.getByText(/not a sandbox\s+boundary/)).toBeTruthy();
    expect(screen.getByText(/same process with the same privileges/)).toBeTruthy();
  });

  it("shows the detected default as selected when nothing is overridden", () => {
    render(<FormatHandlersPanel matches={all} />);
    const group = screen.getByRole("group", { name: "Default viewer for .json" });
    expect(within(group).getByRole("button", { name: "JSON inspector" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(group).getByRole("button", { name: "Code editor" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("stores an override when a non-default viewer is chosen", async () => {
    render(<FormatHandlersPanel matches={all} />);
    const group = screen.getByRole("group", { name: "Default viewer for .json" });
    fireEvent.click(within(group).getByRole("button", { name: "Code editor" }));
    await waitFor(() => expect(useSettings.getState().handlerOverrides).toEqual({ json: "text" }));
    expect(updateSettings.mock.calls[0][0]).toMatchObject({ handlerOverrides: { json: "text" } });
  });

  it("removes the entry rather than storing the default explicitly", async () => {
    useSettings.setState({ handlerOverrides: { json: "text" } });
    render(<FormatHandlersPanel matches={all} />);
    const group = screen.getByRole("group", { name: "Default viewer for .json" });
    fireEvent.click(within(group).getByRole("button", { name: "JSON inspector" }));
    await waitFor(() => expect(useSettings.getState().handlerOverrides).toEqual({}));
  });

  it("leaves other overrides untouched when one changes", async () => {
    useSettings.setState({ handlerOverrides: { csv: "text" } });
    render(<FormatHandlersPanel matches={all} />);
    const group = screen.getByRole("group", { name: "Default viewer for .sql" });
    fireEvent.click(within(group).getByRole("button", { name: "Code editor" }));
    await waitFor(() => expect(useSettings.getState().handlerOverrides).toEqual({ csv: "text", sql: "text" }));
  });

  it("counts the overrides and clears them all", async () => {
    useSettings.setState({ handlerOverrides: { json: "text", csv: "text" } });
    render(<FormatHandlersPanel matches={all} />);
    expect(screen.getByText("2 extensions overridden.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Clear overrides/ }));
    await waitFor(() => expect(useSettings.getState().handlerOverrides).toEqual({}));
  });

  it("disables the clear button when nothing is overridden", () => {
    render(<FormatHandlersPanel matches={all} />);
    expect(screen.getByText("Nothing is overridden.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Clear overrides/ })).toHaveProperty("disabled", true);
  });

  it("says a change only affects files opened from now on", () => {
    render(<FormatHandlersPanel matches={all} />);
    expect(screen.getByText(/Tabs already open keep the viewer/)).toBeTruthy();
  });

  it("explains there is no plugin system instead of offering a dead switch", () => {
    render(<FormatHandlersPanel matches={all} />);
    expect(screen.getByText(/no plugin system/)).toBeTruthy();
    expect(screen.getByText(/cannot load a WebAssembly module/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("honours the settings filter", () => {
    render(<FormatHandlersPanel matches={(...text) => text.includes("plugin")} />);
    expect(screen.getByText("Custom parsers and plugins")).toBeTruthy();
    expect(screen.queryByText("Registered viewers")).toBeNull();
  });
});
