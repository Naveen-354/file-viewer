import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { updateSettings, saveTextAs, engineReport } = vi.hoisted(() => ({
  updateSettings: vi.fn(), saveTextAs: vi.fn(), engineReport: vi.fn(),
}));
vi.mock("../services/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/tauri")>()),
  api: { updateSettings, saveTextAs, engineReport },
}));
const { saveDialog } = vi.hoisted(() => ({ saveDialog: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveDialog }));

import { SettingsPage } from "./SettingsPage";
import { defaults, useSettings } from "../stores/settings";

beforeEach(() => {
  vi.clearAllMocks();
  updateSettings.mockResolvedValue(undefined);
  engineReport.mockResolvedValue(new Promise(() => {}));
  useSettings.setState({ ...defaults, loaded: true });
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
});
afterEach(cleanup);

/** The category buttons in the settings rail, in order. */
function categories(): HTMLElement[] {
  const nav = screen.getByLabelText("Settings categories");
  return within(nav).getAllByRole("button").filter((button) => button.className.includes("settings-nav-item"));
}

const isUnbuilt = (item: HTMLElement) => item.textContent?.includes("Soon") === true;

describe("settings page", () => {
  it("renders nothing until it is opened", () => {
    const { container } = render(<SettingsPage visible={false} close={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("lists every category and marks the ones that are not built", () => {
    render(<SettingsPage visible close={() => {}} />);
    const items = categories();
    // Names are not hard-coded: this asserts the rule ("built categories carry
    // no Soon chip") so building another one does not break the test.
    expect(items.length).toBeGreaterThan(1);
    expect(items.filter((item) => !isUnbuilt(item)).length).toBeGreaterThanOrEqual(1);
    expect(items[0].textContent).toContain("General & Interface");
    expect(isUnbuilt(items[0])).toBe(false);
  });

  it("says an unbuilt section has no controls rather than showing dead ones", () => {
    render(<SettingsPage visible close={() => {}} />);
    const unbuilt = categories().find(isUnbuilt);
    if (!unbuilt) return; // Every category is built; there is nothing to assert.
    fireEvent.click(unbuilt);
    expect(screen.getByText(/not built yet/)).toBeTruthy();
    expect(screen.queryByLabelText("Accent palette")).toBeNull();
  });

  it("persists a change and paints it onto the document", async () => {
    render(<SettingsPage visible close={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Emerald" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(updateSettings.mock.calls[0][0]).toMatchObject({ accent: "emerald" });
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#42d392");
  });

  it("rolls the UI back when Rust rejects a value", async () => {
    updateSettings.mockRejectedValue(new Error("Unsupported accent colour"));
    render(<SettingsPage visible close={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Violet" }));
    expect(await screen.findByText("Unsupported accent colour")).toBeTruthy();
    expect(useSettings.getState().accent).toBe("indigo");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#8292ff");
  });

  it("applies compact density and the tab layout to the document", async () => {
    render(<SettingsPage visible close={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Compact density" }));
    await waitFor(() => expect(document.documentElement.classList.contains("compact")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Multi-row wrap" }));
    await waitFor(() => expect(document.documentElement.dataset.tabs).toBe("wrap"));
  });

  it("moves the font size slider within the range Rust allows", async () => {
    render(<SettingsPage visible close={() => {}} />);
    fireEvent.change(screen.getByLabelText("Editor font size"), { target: { value: "18" } });
    await waitFor(() => expect(useSettings.getState().editorFontSize).toBe(18));
    expect(document.documentElement.style.getPropertyValue("--editor-size")).toBe("18px");
    const slider = screen.getByLabelText("Editor font size") as HTMLInputElement;
    expect(slider.min).toBe("10");
    expect(slider.max).toBe("24");
  });

  it("filters the page down to the matching sections", () => {
    render(<SettingsPage visible close={() => {}} />);
    expect(screen.getByLabelText("Accent palette")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Filter preferences"), { target: { value: "delimiter" } });
    expect(screen.queryByLabelText("Accent palette")).toBeNull();
    expect(screen.getByLabelText("CSV delimiter")).toBeTruthy();
  });

  it("explains why shell integration is absent instead of offering a dead toggle", () => {
    render(<SettingsPage visible close={() => {}} />);
    const text = screen.getByText(/writing to the\s+Windows registry/);
    expect(text).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Explorer/ })).toBeNull();
  });

  it("resets everything after confirmation", async () => {
    useSettings.setState({ accent: "violet", editorFontSize: 20, compactDensity: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SettingsPage visible close={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Reset to default/ }));
    await waitFor(() => expect(useSettings.getState().accent).toBe("indigo"));
    expect(useSettings.getState().editorFontSize).toBe(13);
    expect(useSettings.getState().compactDensity).toBe(false);
  });

  it("leaves settings alone when the reset is declined", () => {
    useSettings.setState({ accent: "violet" });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<SettingsPage visible close={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Reset to default/ }));
    expect(useSettings.getState().accent).toBe("violet");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("exports the settings as TOML to a chosen file", async () => {
    saveDialog.mockResolvedValue("C:\\tmp\\oneopen-settings.toml");
    saveTextAs.mockResolvedValue({});
    render(<SettingsPage visible close={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Export config.toml/ }));
    await waitFor(() => expect(saveTextAs).toHaveBeenCalled());
    const [, destination, body] = saveTextAs.mock.calls[0];
    expect(destination).toBe("C:\\tmp\\oneopen-settings.toml");
    expect(body).toContain("[appearance]");
    expect(body).toContain('theme = "system"');
  });

  it("writes nothing when the export dialog is dismissed", async () => {
    saveDialog.mockResolvedValue(null);
    render(<SettingsPage visible close={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Export config.toml/ }));
    await waitFor(() => expect(saveDialog).toHaveBeenCalled());
    expect(saveTextAs).not.toHaveBeenCalled();
  });

  it("shows the engine panel when that category is selected", async () => {
    render(<SettingsPage visible close={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Native Engine/ }));
    // The panel owns this category, so the not-built placeholder must be gone.
    expect(screen.queryByText(/not built yet/)).toBeNull();
    await waitFor(() => expect(engineReport).toHaveBeenCalled());
  });
});
