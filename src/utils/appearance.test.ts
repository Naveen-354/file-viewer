import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCENTS, MONO_FONTS, accentById, applyAppearance, fontById, isFontAvailable } from "./appearance";
import { defaults } from "../stores/settings";

describe("appearance tables", () => {
  it("falls back to the first entry rather than returning undefined", () => {
    expect(accentById("puce").id).toBe("indigo");
    expect(fontById("comic").id).toBe("cascadia");
  });

  it("keeps every font stack ending in a generic family", () => {
    for (const font of MONO_FONTS) {
      expect(font.stack.trim().endsWith("monospace")).toBe(true);
    }
  });

  it("offers only ids the Rust validator accepts", () => {
    expect(ACCENTS.map((accent) => accent.id)).toEqual(["indigo", "cyan", "emerald", "amber", "violet"]);
    expect(MONO_FONTS.map((font) => font.id)).toEqual(["cascadia", "consolas", "jetbrains", "fira", "ibm", "system"]);
  });
});

describe("font availability", () => {
  it("reports what the browser says a font is", () => {
    const check = vi.fn().mockReturnValue(false);
    vi.stubGlobal("document", { ...document, fonts: { check } });
    expect(isFontAvailable(MONO_FONTS[0])).toBe(false);
    expect(check).toHaveBeenCalledWith('12px "Cascadia Code"');
    vi.unstubAllGlobals();
  });

  it("assumes available when the browser cannot answer, rather than hiding every font", () => {
    vi.stubGlobal("document", { ...document, fonts: undefined });
    expect(isFontAvailable(MONO_FONTS[0])).toBe(true);
    vi.unstubAllGlobals();
  });

  it("treats the system default as always present", () => {
    expect(isFontAvailable(MONO_FONTS.at(-1)!)).toBe(true);
  });
});

describe("applying appearance", () => {
  let root: HTMLElement;
  beforeEach(() => { root = document.createElement("div"); });

  it("writes the accent, font stack and size as custom properties", () => {
    applyAppearance({ ...defaults, accent: "amber", monoFont: "fira", editorFontSize: 17 }, root);
    expect(root.style.getPropertyValue("--accent")).toBe("#f8c66d");
    expect(root.style.getPropertyValue("--mono")).toContain("Fira Code");
    expect(root.style.getPropertyValue("--editor-size")).toBe("17px");
  });

  it("turns ligatures and tabular figures into the CSS keywords", () => {
    applyAppearance({ ...defaults, ligatures: false, tabularFigures: false }, root);
    expect(root.style.getPropertyValue("--ligatures")).toBe("none");
    expect(root.style.getPropertyValue("--figures")).toBe("normal");
    applyAppearance({ ...defaults, ligatures: true, tabularFigures: true }, root);
    expect(root.style.getPropertyValue("--ligatures")).toBe("normal");
    expect(root.style.getPropertyValue("--figures")).toBe("tabular-nums");
  });

  it("toggles compact density on and back off", () => {
    applyAppearance({ ...defaults, compactDensity: true }, root);
    expect(root.classList.contains("compact")).toBe(true);
    applyAppearance({ ...defaults, compactDensity: false }, root);
    expect(root.classList.contains("compact")).toBe(false);
  });

  it("records the tab layout as a data attribute the stylesheet keys off", () => {
    applyAppearance({ ...defaults, tabOverflow: "wrap" }, root);
    expect(root.dataset.tabs).toBe("wrap");
  });

  it("never writes a raw setting value into the font stack", () => {
    // An unknown id must not reach CSS; it falls back to a known stack.
    applyAppearance({ ...defaults, monoFont: 'x; background: url(evil)' }, root);
    expect(root.style.getPropertyValue("--mono")).toBe(MONO_FONTS[0].stack);
  });
});
