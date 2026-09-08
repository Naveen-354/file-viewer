import type { UserSettings } from "../types/files";

export interface AccentOption { id: string; label: string; swatch: string }

/** Must match the accent list `persistence::validate_settings` accepts. */
export const ACCENTS: AccentOption[] = [
  { id: "indigo", label: "Indigo", swatch: "#8292ff" },
  { id: "cyan", label: "Cyan", swatch: "#6ee7ff" },
  { id: "emerald", label: "Emerald", swatch: "#42d392" },
  { id: "amber", label: "Amber", swatch: "#f8c66d" },
  { id: "violet", label: "Violet", swatch: "#c4b5fd" },
];

export interface FontOption { id: string; label: string; stack: string; probe: string }

/**
 * Editor font choices. Only the stack is ever written into CSS, never anything
 * the user typed, so a font name cannot be used to smuggle CSS in.
 * Must match the list `persistence::validate_settings` accepts.
 */
export const MONO_FONTS: FontOption[] = [
  { id: "cascadia", label: "Cascadia Code", probe: "Cascadia Code", stack: '"Cascadia Code", "Cascadia Mono", Consolas, monospace' },
  { id: "consolas", label: "Consolas", probe: "Consolas", stack: 'Consolas, "Cascadia Mono", monospace' },
  { id: "jetbrains", label: "JetBrains Mono", probe: "JetBrains Mono", stack: '"JetBrains Mono", "Cascadia Code", Consolas, monospace' },
  { id: "fira", label: "Fira Code", probe: "Fira Code", stack: '"Fira Code", "Cascadia Code", Consolas, monospace' },
  { id: "ibm", label: "IBM Plex Mono", probe: "IBM Plex Mono", stack: '"IBM Plex Mono", Consolas, monospace' },
  { id: "system", label: "System default", probe: "", stack: "ui-monospace, monospace" },
];

export function fontById(id: string): FontOption {
  return MONO_FONTS.find((font) => font.id === id) ?? MONO_FONTS[0];
}

export function accentById(id: string): AccentOption {
  return ACCENTS.find((accent) => accent.id === id) ?? ACCENTS[0];
}

/**
 * Whether a font is actually installed on this machine.
 *
 * The stacks all end in a generic fallback, so a missing font degrades quietly
 * — the settings page says which ones are really present rather than offering a
 * list where half the entries do nothing.
 */
export function isFontAvailable(font: FontOption): boolean {
  if (!font.probe) return true;
  const check = document.fonts?.check;
  if (typeof check !== "function") return true;
  try {
    return document.fonts.check(`12px "${font.probe}"`);
  } catch {
    return true;
  }
}

/**
 * Writes the appearance settings onto the document as custom properties and
 * classes. Everything applied here comes from a fixed table, never from raw
 * user input.
 */
export function applyAppearance(settings: UserSettings, root: HTMLElement = document.documentElement): void {
  const accent = accentById(settings.accent);
  const font = fontById(settings.monoFont);
  root.style.setProperty("--accent", accent.swatch);
  root.style.setProperty("--accent-soft", `color-mix(in srgb, ${accent.swatch} 18%, transparent)`);
  root.style.setProperty("--mono", font.stack);
  root.style.setProperty("--editor-size", `${settings.editorFontSize}px`);
  root.style.setProperty("--ligatures", settings.ligatures ? "normal" : "none");
  root.style.setProperty("--figures", settings.tabularFigures ? "tabular-nums" : "normal");
  root.classList.toggle("compact", settings.compactDensity);
  root.dataset.tabs = settings.tabOverflow;
}
