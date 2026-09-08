import { useEffect, useState } from "react";
import { GitCompare, Settings } from "lucide-react";
import { api } from "../services/tauri";
import { useWorkspace } from "../stores/workspace";
import { useActivePins, useWorkspaces } from "../stores/workspaces";
import { findPath } from "../utils/paths";
import type { DirectoryEntry, RecentFile, WorkspacePath } from "../types/files";
import { countByKind, kindOf } from "../utils/fileKind";

export function Sidebar({ refreshKey, openFiles, createWorkspace, openSettings, openDiff, diffOpen }: { refreshKey: number; openFiles: () => Promise<void>; createWorkspace: () => void; openSettings: () => void; openDiff: () => void; diffOpen: boolean }) {
  const [files, setFiles] = useState<RecentFile[]>([]);
  const openPaths = useWorkspace((state) => state.openPaths);
  const { items, activeId, activate, remove, togglePin } = useWorkspaces();
  const active = items.find((item) => item.id === activeId) ?? null;
  useEffect(() => { void api.recentFiles().then(setFiles).catch(() => setFiles([])); }, [refreshKey]);

  const removeActive = async () => {
    if (active && window.confirm(`Remove “${active.name}” from OneOpen?\n\nYour folders and source files will not be deleted.`)) await remove(active.id);
  };

  return <aside className="sidebar">
    <div className="brand"><span>◇</span> OneOpen</div>
    <div className="workspace-switcher"><label>WORKSPACE</label><div><select value={activeId ?? ""} onChange={(event) => void activate(event.target.value)} disabled={!items.length}>{items.length ? items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) : <option value="">No workspace</option>}</select><button title="Create workspace" onClick={createWorkspace}>＋</button></div></div>
    <button className="sidebar-open" onClick={() => void openFiles()}>▧ Open File… <kbd>Ctrl+O</kbd></button>
    {active && <>
      <div className="sidebar-section-title"><h2>Folders</h2><button onClick={() => void removeActive()} title="Remove workspace">•••</button></div>
      <div className="folder-tree">{active.folders.map((folder) => folder.exists ? <TreeFolder key={folder.path} folder={folder} /> : <div className="tree-folder unavailable" key={folder.path} title={folder.path}><span>⚠</span><span><strong>{folder.name}</strong><small>Unavailable</small></span></div>)}</div>
      <h2>Pinned Files</h2>
      {active.pinnedFiles.map((file) => <div key={file.path} className={`workspace-pin ${file.exists ? "" : "unavailable"}`}>
        <button className="workspace-pin-open" disabled={!file.exists} title={file.path} onClick={() => void openPaths([file.path])}><span>⌖</span><span>{file.name}</span>{!file.exists && <small>Unavailable</small>}</button>
        <button className="workspace-pin-remove" title={`Unpin ${file.name}`} aria-label={`Unpin ${file.name}`} onClick={() => void togglePin(file.path).catch(() => undefined)}>×</button>
      </div>)}
      {!active.pinnedFiles.length && <span className="muted small">Pin a file from the folder tree or the breadcrumb bar.</span>}
    </>}
    {!active && <button className="create-workspace-sidebar" onClick={createWorkspace}>＋ Create Workspace</button>}
    <h2>File Inspection</h2>
    <button className={`sidebar-inspect ${diffOpen ? "active" : ""}`} aria-current={diffOpen} onClick={openDiff}>
      <GitCompare size={13} /> <span>Diff Compare</span>
    </button>
    <h2>Recent Files</h2>
    <div className="recent-list">{files.slice(0, 10).map((file) => <button className={`sidebar-recent ${file.exists ? "" : "missing"}`} key={file.path} disabled={!file.exists} onClick={() => void openPaths([file.path])} title={file.path}><i className={kindOf(file.handlerId).tone}>◇</i><span>{file.displayName}</span></button>)}{!files.length && <span className="muted small">No recent files</span>}</div>
    {!!files.length && <>
      <h2>File Types</h2>
      <div className="file-types">{countByKind(files).map(({ kind, count }) => <div className="file-type-row" key={kind.id}><i className={kind.tone}>◇</i><span>{kind.label}</span><b>{count}</b></div>)}</div>
    </>}
    <div className="sidebar-footer">
      <button className="sidebar-settings" onClick={openSettings} title="Settings">
        <Settings size={13} /> <span>Settings</span> <kbd>Ctrl+,</kbd>
      </button>
      <small className="sidebar-privacy">100% Local · Tauri</small>
    </div>
  </aside>;
}

function TreeFolder({ folder }: { folder: WorkspacePath }) {
  const [expanded, setExpanded] = useState(true);
  const [entries, setEntries] = useState<DirectoryEntry[] | null>(null);
  useEffect(() => { if (expanded && entries === null) void api.listDirectory(folder.path).then(setEntries).catch(() => setEntries([])); }, [expanded, entries, folder.path]);
  return <div><button className="tree-folder" onClick={() => setExpanded((value) => !value)} title={folder.path}><span>{expanded ? "⌄" : "›"}</span><span><strong>▱ {folder.name}</strong><small>{folder.path}</small></span></button>{expanded && <div className="tree-children">{entries?.slice(0, 40).map((entry) => entry.isDirectory ? <TreeDirectory key={entry.path} entry={entry} /> : <TreeFile key={entry.path} entry={entry} />)}{entries === null && <span className="tree-loading">Loading…</span>}</div>}</div>;
}

function TreeDirectory({ entry }: { entry: DirectoryEntry }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirectoryEntry[] | null>(null);
  const toggle = async () => { const next = !expanded; setExpanded(next); if (next && children === null) setChildren(await api.listDirectory(entry.path).catch(() => [])); };
  return <div><button className="tree-entry directory" onClick={() => void toggle()}><span>{expanded ? "⌄" : "›"}</span>▱ {entry.name}</button>{expanded && <div className="tree-children nested">{children?.slice(0, 40).map((child) => child.isDirectory ? <TreeDirectory key={child.path} entry={child} /> : <TreeFile key={child.path} entry={child} />)}</div>}</div>;
}

function TreeFile({ entry }: { entry: DirectoryEntry }) {
  const openPaths = useWorkspace((state) => state.openPaths);
  const togglePin = useWorkspaces((state) => state.togglePin);
  const pinned = findPath(useActivePins(), entry.path) !== null;
  return <div className="tree-entry-row">
    <button className="tree-entry file" title={entry.path} onClick={() => void openPaths([entry.path])}><span />◇ {entry.name}</button>
    <button className={`tree-pin ${pinned ? "pinned" : ""}`} title={pinned ? `Unpin ${entry.name}` : `Pin ${entry.name}`} aria-label={pinned ? `Unpin ${entry.name}` : `Pin ${entry.name}`} aria-pressed={pinned} onClick={() => void togglePin(entry.path).catch(() => undefined)}>⌖</button>
  </div>;
}
