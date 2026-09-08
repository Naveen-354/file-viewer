import { create } from "zustand";
import { api } from "../services/tauri";
import type { FileDescriptor } from "../types/files";
import { useSettings } from "./settings";
import { resolveHandler } from "../utils/handlers";

export interface WorkspaceTab {
  id: string;
  file: FileDescriptor;
  dirty: boolean;
  status: string;
  loadKey: number;
}

interface WorkspaceState {
  tabs: WorkspaceTab[];
  closed: WorkspaceTab[];
  activeId: string | null;
  busy: boolean;
  error: string | null;
  openPaths: (paths: string[]) => Promise<void>;
  closeTab: (id: string, force?: boolean) => boolean;
  reopenTab: () => void;
  activate: (id: string) => void;
  setDirty: (id: string, dirty: boolean) => void;
  replaceFile: (id: string, file: FileDescriptor) => void;
  renameTab: (id: string, newName: string) => Promise<FileDescriptor>;
  setStatus: (id: string, status: string) => void;
  clearError: () => void;
}

const keyFor = (path: string) => path.toLocaleLowerCase();
const pendingPaths = new Set<string>();
let openOperations = 0;

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  tabs: [],
  closed: [],
  activeId: null,
  busy: false,
  error: null,
  openPaths: async (paths) => {
    openOperations += 1;
    set({ busy: true, error: null });
    try {
      for (const path of paths) {
        const key = keyFor(path);
        const existing = get().tabs.find((tab) => keyFor(tab.file.path) === key);
        if (existing) {
          set({ activeId: existing.id });
          continue;
        }
        if (pendingPaths.has(key)) continue;
        pendingPaths.add(key);
        try {
          const started = performance.now();
          const file = await api.detectFile(path);
          const duplicate = get().tabs.find((tab) => keyFor(tab.file.path) === keyFor(file.path));
          if (duplicate) { set({ activeId: duplicate.id }); continue; }
          // A handler override redirects the viewer for extensions that more
          // than one can open. Detection still decides everything else.
          const routed = {
            ...file,
            handlerId: resolveHandler(file.handlerId, file.extension, useSettings.getState().handlerOverrides),
          };
          const tab: WorkspaceTab = { id: crypto.randomUUID(), file: routed, dirty: false, status: "", loadKey: Date.now() };
          performance.mark(`preview-${tab.id}`);
          if (import.meta.env.DEV) console.debug(`[perf] file detection: ${(performance.now() - started).toFixed(1)}ms`);
          set((state) => ({ tabs: [...state.tabs, tab], activeId: tab.id }));
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) });
        } finally {
          pendingPaths.delete(key);
        }
      }
    } finally {
      openOperations -= 1;
      set({ busy: openOperations > 0 });
    }
  },
  closeTab: (id, force = false) => {
    const state = get();
    const tab = state.tabs.find((item) => item.id === id);
    if (!tab || (tab.dirty && !force)) return false;
    const index = state.tabs.indexOf(tab);
    const tabs = state.tabs.filter((item) => item.id !== id);
    const next = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
    set({ tabs, closed: [tab, ...state.closed].slice(0, 10), activeId: state.activeId === id ? next : state.activeId });
    return true;
  },
  reopenTab: () => set((state) => {
    const tab = state.closed[0];
    if (!tab) return state;
    return { tabs: [...state.tabs, { ...tab, dirty: false }], closed: state.closed.slice(1), activeId: tab.id };
  }),
  activate: (id) => set({ activeId: id }),
  setDirty: (id, dirty) => set((state) => ({ tabs: state.tabs.map((tab) => tab.id === id ? { ...tab, dirty } : tab) })),
  /**
   * Renames the file behind a tab. Rust does the move and returns a freshly
   * detected descriptor, so a changed extension swaps the viewer too.
   *
   * A tab with unsaved changes is refused: `replaceFile` remounts the viewer,
   * which re-reads from disk and would silently drop the edit.
   */
  renameTab: async (id, newName) => {
    const tab = get().tabs.find((item) => item.id === id);
    if (!tab) throw new Error("That tab is no longer open.");
    if (tab.dirty) throw new Error("Save or discard the unsaved changes before renaming.");
    const renamed = await api.renameFile(tab.file.path, newName);
    get().replaceFile(id, renamed);
    return renamed;
  },
  replaceFile: (id, file) => set((state) => ({ tabs: state.tabs.map((tab) => tab.id === id ? { ...tab, file, dirty: false, loadKey: Date.now() } : tab) })),
  setStatus: (id, status) => set((state) => ({ tabs: state.tabs.map((tab) => tab.id === id ? { ...tab, status } : tab) })),
  clearError: () => set({ error: null }),
}));
