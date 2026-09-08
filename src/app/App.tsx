import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { ViewerHost } from "./ViewerHost";
import { CommandPalette } from "../components/CommandPalette";
import { CreateWorkspaceModal } from "../components/CreateWorkspaceModal";
import { DiffCompare, type DiffSelection } from "../components/DiffCompare";
import { DiffView } from "../components/DiffView";
import { RenameDialog } from "../components/RenameDialog";
import { ErrorBanner } from "../components/ErrorBanner";
import { HomePage } from "../components/HomePage";
import { SettingsPage } from "../components/SettingsPage";
import { Sidebar } from "../components/Sidebar";
import { TabBar } from "../components/TabBar";
import { api } from "../services/tauri";
import { mark, measure } from "../services/performance";
import { useSettings } from "../stores/settings";
import { breadcrumbSegments, formatBytes } from "../utils/fileKind";
import { useWorkspace } from "../stores/workspace";
import { useActivePins, useWorkspaces } from "../stores/workspaces";
import { findPath } from "../utils/paths";
import { GLOBAL_SHORTCUTS, type ShortcutId } from "../utils/shortcuts";
import type { Slot } from "../utils/diff";
import type { FileDescriptor } from "../types/files";

mark("app-start");

export function App() {
  const tabs = useWorkspace((state) => state.tabs);
  const activeId = useWorkspace((state) => state.activeId);
  const busy = useWorkspace((state) => state.busy);
  const openPaths = useWorkspace((state) => state.openPaths);
  const closeTab = useWorkspace((state) => state.closeTab);
  const reopenTab = useWorkspace((state) => state.reopenTab);
  const theme = useSettings((state) => state.theme);
  const wordWrap = useSettings((state) => state.wordWrap);
  const windowEffect = useSettings((state) => state.windowEffect);
  const updateSettings = useSettings((state) => state.update);
  const loadSettings = useSettings((state) => state.load);
  const [palette, setPalette] = useState(false);
  const [createWorkspace, setCreateWorkspace] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diff, setDiff] = useState<DiffSelection>({ a: null, b: null });
  const [comparing, setComparing] = useState(false);
  const diffOpenRef = useRef(false);
  diffOpenRef.current = diffOpen;

  const diffRef = useRef<DiffSelection>({ a: null, b: null });
  diffRef.current = diff;

  const selectDiff = useCallback((slot: Slot, file: FileDescriptor | null) => {
    setDiff((current) => ({ ...current, [slot]: file }));
  }, []);

  /**
   * Fills the empty compare slots, base first, from dropped paths. The ref is
   * advanced as each file resolves, because a second drop in the same batch
   * must see the slot the first one took before React has re-rendered.
   */
  const fillDiffSlots = useCallback(async (paths: string[]) => {
    for (const path of paths) {
      const slot: Slot | null = diffRef.current.a === null ? "a" : diffRef.current.b === null ? "b" : null;
      if (slot === null) return;
      try {
        const file = await api.detectFile(path);
        diffRef.current = { ...diffRef.current, [slot]: file };
        setDiff(diffRef.current);
      } catch {
        return;
      }
    }
  }, []);
  const [recentKey, setRecentKey] = useState(0);
  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const workspaceId = useWorkspaces((state) => state.activeId);
  const togglePin = useWorkspaces((state) => state.togglePin);
  const pins = useActivePins();
  const pinned = !!active && findPath(pins, active.file.path) !== null;

  const pickFiles = useCallback(async () => {
    const paths = await open({ multiple: true, directory: false });
    if (paths) await openPaths(Array.isArray(paths) ? paths : [paths]);
  }, [openPaths]);

  useEffect(() => {
    void Promise.all([loadSettings(), useWorkspaces.getState().load()]).then(async () => {
      if (!useSettings.getState().restoreSession) return;
      const workspaceState = useWorkspaces.getState();
      const selected = workspaceState.items.find((item) => item.id === workspaceState.activeId);
      if (selected && !selected.restoreLastSession) return;
      const savedTabs = await api.loadSession();
      await openPaths(savedTabs.map((tab) => tab.path));
      const activePath = savedTabs.find((tab) => tab.active)?.path;
      const restored = useWorkspace.getState().tabs.find((tab) => tab.file.path === activePath);
      if (restored) useWorkspace.getState().activate(restored.id);
    }).catch(() => undefined);
    void api.takeStartupFiles().then((paths) => openPaths(paths)).catch(() => undefined);
    const unlistenOpen = listen<string[]>("open-files", ({ payload }) => void openPaths(payload));
    const unlistenDrop = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      // While the compare view is up, a dropped file fills its next empty slot
      // instead of opening a tab, which is what the drop targets promise.
      if (diffOpenRef.current) { void fillDiffSlots(event.payload.paths); return; }
      void openPaths(event.payload.paths);
    });
    return () => { void unlistenOpen.then((fn) => fn()); void unlistenDrop.then((fn) => fn()); };
  }, [loadSettings, openPaths, fillDiffSlots]);

  useEffect(() => {
    if (tabs.length) setRecentKey((key) => key + 1);
    const timer = window.setTimeout(() => void api.saveSession(tabs.map((tab) => ({ path: tab.file.path, active: tab.id === activeId }))), 250);
    return () => clearTimeout(timer);
  }, [tabs, activeId]);

  /**
   * Dispatches against the same table the Key Bindings settings page lists, so
   * the documented shortcuts and the working ones cannot drift apart.
   */
  useEffect(() => {
    const actions: Record<ShortcutId, () => void> = {
      open: () => void pickFiles(),
      palette: () => setPalette(true),
      reopen: () => reopenTab(),
      rename: () => activeId && setRenaming(activeId),
      settings: () => setSettingsOpen(true),
      close: () => {
        if (!activeId) return;
        if (!closeTab(activeId) && window.confirm("Discard unsaved changes?")) closeTab(activeId, true);
      },
    };
    const handler = (event: KeyboardEvent) => {
      for (const shortcut of GLOBAL_SHORTCUTS) {
        if (!shortcut.matches(event)) continue;
        if (shortcut.needsActiveTab && !activeId) continue;
        event.preventDefault();
        actions[shortcut.id]();
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [pickFiles, activeId, closeTab, reopenTab]);

  useEffect(() => {
    const windowApi = getCurrentWindow();
    let timer = 0;
    const persist = () => {
      clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const [position, size] = await Promise.all([windowApi.outerPosition(), windowApi.innerSize()]);
        const maximized = await windowApi.isMaximized();
        await api.saveWindowState({ x: position.x, y: position.y, width: size.width, height: size.height, maximized });
      }, 300);
    };
    void api.windowState().then(async (value) => {
      if (!value) return;
      const { PhysicalPosition, PhysicalSize } = await import("@tauri-apps/api/dpi");
      const monitors = await availableMonitors();
      const visible = monitors.some((monitor) => value.x + value.width > monitor.position.x && value.x < monitor.position.x + monitor.size.width && value.y + value.height > monitor.position.y && value.y < monitor.position.y + monitor.size.height);
      await windowApi.setSize(new PhysicalSize(value.width, value.height));
      if (visible) await windowApi.setPosition(new PhysicalPosition(value.x, value.y)); else await windowApi.center();
      if (value.maximized) await windowApi.maximize();
    }).catch(() => undefined);
    const a = windowApi.onMoved(persist);
    const b = windowApi.onResized(persist);
    return () => { clearTimeout(timer); void a.then((fn) => fn()); void b.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    const current = getCurrentWindow();
    const unlisten = current.onCloseRequested((event) => {
      if (!useWorkspace.getState().tabs.some((tab) => tab.dirty)) return;
      event.preventDefault();
      if (window.confirm("Discard all unsaved changes and quit OneOpen?")) void current.destroy();
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, []);

  /**
   * Window materials are a Windows 11 feature. The window manager refuses the
   * call elsewhere, so the failure is swallowed here and the app keeps its
   * solid background rather than showing an error the user cannot act on.
   */
  useEffect(() => {
    const current = getCurrentWindow();
    if (windowEffect === "none") { void current.clearEffects().catch(() => undefined); return; }
    void current.setEffects({ effects: [windowEffect as never] }).catch(() => undefined);
  }, [windowEffect]);

  useEffect(() => { requestAnimationFrame(() => measure("startup-to-first-paint", "app-start")); }, []);

  const appliedTheme = theme === "system" ? undefined : theme;
  return (
    <div className="app" data-theme={appliedTheme}>
      <Sidebar refreshKey={recentKey} openFiles={pickFiles} createWorkspace={() => setCreateWorkspace(true)} openSettings={() => setSettingsOpen(true)} openDiff={() => setDiffOpen(true)} diffOpen={diffOpen} />
      <section className="workspace">
        <header className="topbar">
          <TabBar />
          <button className="icon-button palette-trigger" title="Command palette" onClick={() => setPalette(true)}>⋮</button>
        </header>
        {active && (
          <div className="breadcrumb-bar">
            <nav className="breadcrumbs" aria-label="File location">
              {breadcrumbSegments(active.file.path).map((segment, index, all) => (
                <span key={`${segment}-${index}`} className={index === all.length - 1 ? "current" : ""}>{segment}</span>
              ))}
            </nav>
            <span className="spacer" />
            <button className={wordWrap ? "selected" : ""} title="Toggle word wrap" onClick={() => void updateSettings({ wordWrap: !wordWrap })}>Wrap</button>
            {workspaceId && (
              <button
                className={pinned ? "selected" : ""}
                title={pinned ? "Remove this file from the workspace pins" : "Pin this file to the active workspace"}
                aria-pressed={pinned}
                onClick={() => void togglePin(active.file.path).catch(() => undefined)}
              >{pinned ? "Pinned" : "Pin"}</button>
            )}
            <button title="Rename this file on disk (F2)" onClick={() => setRenaming(active.id)}>Rename</button>
            <button title="Show the file in its folder" onClick={() => void api.showInFolder(active.file.path)}>Reveal</button>
            <button title="Open with the system application" onClick={() => void api.openSystem(active.file.path)}>Open external</button>
          </div>
        )}
        <ErrorBanner />
        <main className="viewer-area">
          {diffOpen
            ? comparing && diff.a && diff.b
              ? <DiffView
                  left={diff.a}
                  right={diff.b}
                  onSwap={() => setDiff((current) => ({ a: current.b, b: current.a }))}
                  close={() => setComparing(false)}
                />
              : <DiffCompare
                  selection={diff}
                  onSelect={selectDiff}
                  onSwap={() => setDiff((current) => ({ a: current.b, b: current.a }))}
                  onCompare={() => setComparing(true)}
                  close={() => setDiffOpen(false)}
                />
            : active
              ? <ViewerHost tab={active} />
              : <HomePage refreshKey={recentKey} openFiles={pickFiles} createWorkspace={() => setCreateWorkspace(true)} />}
          {busy && <div className="busy" role="status">Opening…</div>}
        </main>
        <footer className="statusbar">
          {active ? (
            <>
              <span className="status-kind">{active.file.detectedType}</span>
              <span>{formatBytes(active.file.size)}</span>
              {active.file.readonly && <span className="status-flag">Read-only</span>}
              {active.dirty && <span className="status-flag dirty-flag">Modified</span>}
              <span className="status-detail">{active.status}</span>
            </>
          ) : (
            <>
              <span className="status-kind">Ready</span>
              <span className="status-detail">100% Local · Zero Telemetry</span>
            </>
          )}
        </footer>
      </section>
      <CommandPalette visible={palette} close={() => setPalette(false)} />
      <CreateWorkspaceModal visible={createWorkspace} close={() => setCreateWorkspace(false)} />
      <SettingsPage visible={settingsOpen} close={() => setSettingsOpen(false)} />
      <RenameDialog tab={tabs.find((tab) => tab.id === renaming) ?? null} close={() => setRenaming(null)} />
    </div>
  );
}
