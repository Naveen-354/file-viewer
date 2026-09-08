import { create } from "zustand";
import { api } from "../services/tauri";
import type { UserSettings } from "../types/files";
import { applyAppearance } from "../utils/appearance";

interface SettingsState extends UserSettings {
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<UserSettings>) => Promise<void>;
  reset: () => Promise<void>;
}

export const defaults: UserSettings = {
  theme: "system",
  wordWrap: true,
  csvDelimiter: null,
  restoreSession: true,
  accent: "indigo",
  windowEffect: "none",
  tabOverflow: "scroll",
  compactDensity: false,
  monoFont: "cascadia",
  editorFontSize: 13,
  ligatures: true,
  tabularFigures: true,
  handlerOverrides: {},
};

function snapshot(state: UserSettings): UserSettings {
  return {
    theme: state.theme,
    wordWrap: state.wordWrap,
    csvDelimiter: state.csvDelimiter,
    restoreSession: state.restoreSession,
    accent: state.accent,
    windowEffect: state.windowEffect,
    tabOverflow: state.tabOverflow,
    compactDensity: state.compactDensity,
    monoFont: state.monoFont,
    editorFontSize: state.editorFontSize,
    ligatures: state.ligatures,
    tabularFigures: state.tabularFigures,
    handlerOverrides: state.handlerOverrides,
  };
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...defaults,
  loaded: false,
  load: async () => {
    try {
      const stored = await api.settings();
      set({ ...stored, loaded: true });
      applyAppearance(stored);
    } catch {
      set({ loaded: true });
      applyAppearance(defaults);
    }
  },
  /**
   * The new value is shown before the write lands, then rolled back if Rust
   * rejects it, so a refused setting never leaves the UI showing something the
   * database does not hold.
   */
  update: async (patch) => {
    const previous = snapshot(get());
    const next = { ...previous, ...patch };
    set(next);
    applyAppearance(next);
    try {
      await api.updateSettings(next);
    } catch (error) {
      set(previous);
      applyAppearance(previous);
      throw error;
    }
  },
  reset: async () => {
    const previous = snapshot(get());
    set(defaults);
    applyAppearance(defaults);
    try {
      await api.updateSettings(defaults);
    } catch (error) {
      set(previous);
      applyAppearance(previous);
      throw error;
    }
  },
}));
