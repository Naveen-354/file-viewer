import { create } from "zustand";
import { api } from "../services/tauri";
import type { CreateWorkspaceRequest, Workspace, WorkspacePath } from "../types/files";
import { findPath } from "../utils/paths";

interface WorkspacesState {
  items: Workspace[];
  activeId: string | null;
  loading: boolean;
  load: () => Promise<void>;
  createWorkspace: (request: CreateWorkspaceRequest) => Promise<void>;
  activate: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  togglePin: (path: string) => Promise<void>;
}

const selectedKey = "oneopen.activeWorkspace";

/**
 * `localStorage` only caches which workspace was last selected; the database is
 * the source of truth. A WebView with site data blocked can make these throw or
 * hand back a stub, so a failure here must not stop the store from loading.
 */
function readSelected(): string | null {
  try {
    return window.localStorage?.getItem(selectedKey) ?? null;
  } catch {
    return null;
  }
}

function writeSelected(id: string | null): void {
  try {
    if (id) window.localStorage?.setItem(selectedKey, id);
    else window.localStorage?.removeItem(selectedKey);
  } catch {
    // The selection still applies for this session.
  }
}

export const useWorkspaces = create<WorkspacesState>((set, get) => ({
  items: [],
  activeId: readSelected(),
  loading: false,
  load: async () => {
    set({ loading: true });
    try {
      const items = await api.workspaces();
      const current = get().activeId;
      const activeId = items.some((item) => item.id === current) ? current : items[0]?.id ?? null;
      writeSelected(activeId);
      set({ items, activeId });
    } finally { set({ loading: false }); }
  },
  createWorkspace: async (request) => {
    const workspace = await api.createWorkspace(request);
    writeSelected(workspace.id);
    set((state) => ({ items: [workspace, ...state.items], activeId: workspace.id }));
  },
  activate: async (id) => {
    await api.activateWorkspace(id);
    writeSelected(id);
    set((state) => ({ activeId: id, items: state.items.map((item) => item.id === id ? { ...item, lastOpenedMs: Date.now() } : item) }));
  },
  /**
   * Pins belong to a workspace, so this does nothing without an active one.
   * The command returns the new pin list, which replaces the active
   * workspace's copy instead of forcing a full reload.
   */
  togglePin: async (path) => {
    const activeId = get().activeId;
    const active = get().items.find((item) => item.id === activeId);
    if (!activeId || !active) return;
    const stored = findPath(active.pinnedFiles, path);
    const pinnedFiles = stored
      ? await api.unpinFile(activeId, stored)
      : await api.pinFile(activeId, path);
    set((state) => ({
      items: state.items.map((item) => (item.id === activeId ? { ...item, pinnedFiles } : item)),
    }));
  },
  remove: async (id) => {
    await api.removeWorkspace(id);
    const items = get().items.filter((item) => item.id !== id);
    const activeId = get().activeId === id ? items[0]?.id ?? null : get().activeId;
    writeSelected(activeId);
    set({ items, activeId });
  },
}));

const NO_PINS: WorkspacePath[] = [];

/** The active workspace's pins, or an empty list when none is selected. */
export function useActivePins(): WorkspacePath[] {
  return useWorkspaces((state) => state.items.find((item) => item.id === state.activeId)?.pinnedFiles ?? NO_PINS);
}
