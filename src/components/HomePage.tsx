import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../services/tauri";
import { useWorkspace } from "../stores/workspace";
import { useWorkspaces } from "../stores/workspaces";
import type { RecentFile, Workspace, WorkspacePath } from "../types/files";
import { formatBytes, formatLabel, kindOf, relativeTime } from "../utils/fileKind";

interface HomePageProps {
  refreshKey: number;
  openFiles: () => Promise<void>;
  createWorkspace: () => void;
}

export function HomePage({ refreshKey, openFiles, createWorkspace }: HomePageProps) {
  const openPaths = useWorkspace((state) => state.openPaths);
  const workspaces = useWorkspaces((state) => state.items);
  const activeId = useWorkspaces((state) => state.activeId);
  const activateWorkspace = useWorkspaces((state) => state.activate);
  const [recent, setRecent] = useState<RecentFile[]>([]);

  useEffect(() => { void api.recentFiles().then(setRecent).catch(() => setRecent([])); }, [refreshKey]);

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeId) ?? null;
  const pinned = activeWorkspace?.pinnedFiles.slice(0, 4) ?? [];

  const openDirectory = async () => {
    const chosen = await open({ directory: true, multiple: false });
    if (chosen && !Array.isArray(chosen)) createWorkspace();
  };

  return (
    <div className="home-scroll">
      <div className="home-page">
        <section className="home-intro">
          <div>
            <div className="runtime-label"><span /> LOCAL-FIRST RUNTIME · TAURI V2</div>
            <h1>OneOpen Workspace</h1>
            <p>Fast, zero-latency viewer and multi-format inspector for codebases, analytical tables, specs, and binary artifacts.</p>
          </div>
          <div className="runtime-chips">
            <span className="runtime-chip"><span /> LOCAL · PRIVATE</span>
            <span className="runtime-chip muted-chip">0 Network Hooks</span>
          </div>
        </section>

        <section className="drop-zone">
          <div className="drop-icon">⤓</div>
          <strong>Drop any file or folder here to inspect</strong>
          <p>Streamed directly into memory. No uploads, no cloud round-trip.</p>
          <div className="drop-actions">
            <button className="primary" onClick={() => void openFiles()}>▧&nbsp; Open File <kbd>Ctrl+O</kbd></button>
            <button className="secondary" onClick={() => void openDirectory()}>▤&nbsp; Open Directory</button>
          </div>
          <div className="format-strip">
            <span><i className="blue" />Code <small>.sql .json .ts .py .rs</small></span>
            <span><i className="green" />Data <small>.csv .tsv .xlsx .ods</small></span>
            <span><i className="red" />Doc <small>.pdf .md .docx</small></span>
            <span><i className="cyan" />Binary <small>.png .svg .mp4 .zip</small></span>
          </div>
        </section>

        <div className="home-columns">
          <div className="home-left">
            <section className="home-section">
              <div className="section-heading">
                <h2>Recent Files <span>{recent.length} cached</span></h2>
                <span className="last-opened small muted">Newest first</span>
              </div>
              <div className="recent-table">
                <div className="recent-table-head">
                  <span>FILE &amp; PATH</span><span>FORMAT</span><span>SIZE</span><span>LAST INSPECTED</span>
                </div>
                {recent.slice(0, 6).map((file) => <RecentRow key={file.path} file={file} open={() => void openPaths([file.path])} />)}
                {!recent.length && <div className="home-empty">Nothing inspected yet. Open a file to get started.</div>}
              </div>
            </section>

            <section className="home-section">
              <div className="section-heading">
                <h2>Workspaces <span>{workspaces.length} local</span></h2>
                <button className="section-action" onClick={createWorkspace}>＋ New</button>
              </div>
              <div className="recent-table">
                {workspaces.slice(0, 4).map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} active={workspace.id === activeId} open={() => void activateWorkspace(workspace.id)} />)}
                {!workspaces.length && <div className="home-empty">No workspaces yet. Create one from local folders.</div>}
              </div>
            </section>
          </div>

          <aside className="home-right">
            <section className="home-section">
              <div className="section-heading"><h2><b>⌖</b> Pinned Files</h2><span>{pinned.length} slots</span></div>
              <div className="pinned-cards">
                {pinned.map((file) => <PinnedCard key={file.path} file={file} open={() => void openPaths([file.path])} />)}
                {!pinned.length && <div className="home-empty compact">Pin a file from the folder tree, or with Pin on the breadcrumb bar.</div>}
              </div>
            </section>
            <section className="home-section keybindings">
              <div className="section-heading"><h2>Key Bindings</h2><span>Win Fluent</span></div>
              <KeyRow label="Open File Dialog" keys="Ctrl+O" />
              <KeyRow label="Quick Command Palette" keys="Ctrl+P" />
              <KeyRow label="Close Active Buffer" keys="Ctrl+W" />
              <KeyRow label="Reopen Closed Tab" keys="Ctrl+Shift+T" />
            </section>
          </aside>
        </div>

        <footer className="home-footer">
          <span>100% Local · Zero Telemetry · No network calls</span>
          <span>Engine: Tauri v2 · WebView2</span>
        </footer>
      </div>
    </div>
  );
}

function RecentRow({ file, open }: { file: RecentFile; open: () => void }) {
  const kind = kindOf(file.handlerId);
  return (
    <button className={`recent-row ${file.exists ? "" : "unavailable"}`} disabled={!file.exists} onClick={open} title={file.path}>
      <span className="recent-file">
        <i className={kind.tone}>◇</i>
        <span><strong>{file.displayName}</strong><small>{file.path}</small></span>
      </span>
      <span><em className={kind.tone}>{formatLabel(file.displayName, file.handlerId)}</em></span>
      <span className="recent-size">{file.exists ? formatBytes(file.size) : "Missing"}</span>
      <span className="last-opened">{relativeTime(file.lastOpenedMs)}</span>
    </button>
  );
}

function WorkspaceRow({ workspace, active, open }: { workspace: Workspace; active: boolean; open: () => void }) {
  const availableFolders = workspace.folders.filter((folder) => folder.exists).length;
  return (
    <button className={`recent-row workspace-row ${active ? "current" : ""}`} onClick={open}>
      <span className="recent-file">
        <i className="blue">▱</i>
        <span><strong>{workspace.name}</strong><small>{workspace.folders.map((folder) => folder.name).join(" · ") || "No folders"}</small></span>
      </span>
      <span><em className={availableFolders === workspace.folders.length ? "green" : "red"}>{availableFolders}/{workspace.folders.length} LOCAL</em></span>
      <span className="last-opened">{relativeTime(workspace.lastOpenedMs)}</span>
    </button>
  );
}

function PinnedCard({ file, open }: { file: WorkspacePath; open: () => void }) {
  const extension = file.name.split(".").pop()?.toUpperCase() ?? "FILE";
  return (
    <button className={`pinned-card ${file.exists ? "" : "unavailable"}`} disabled={!file.exists} onClick={open} title={file.path}>
      <i className={extension === "PDF" ? "red" : "blue"}>◇</i>
      <span><strong>{file.name}</strong><small>{file.exists ? extension : "UNAVAILABLE"}</small></span>
      <b>›</b>
    </button>
  );
}

function KeyRow({ label, keys }: { label: string; keys: string }) {
  return <div className="key-row"><span>{label}</span><kbd>{keys}</kbd></div>;
}
