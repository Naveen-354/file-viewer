import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import type { ViewerProps } from "../../types/handlers";
import type { ArchiveEntry } from "../../types/files";
import { api } from "../../services/tauri";
import { formatBytes } from "../../utils/file";

interface Progress { operationId: string; completed: number; total: number; current: string }

export default function ArchiveViewer({ file, onStatusChange }: ViewerProps) {
  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);

  useEffect(() => { void api.listArchive(file.path).then((items) => { setEntries(items); onStatusChange(`${items.length.toLocaleString()} entries`); }).catch((reason) => setError(String(reason))); }, [file.path, onStatusChange]);
  useEffect(() => { const unlisten = listen<Progress>("archive-progress", ({ payload }) => setProgress(payload)); return () => { void unlisten.then((fn) => fn()); }; }, []);
  const visible = useMemo(() => entries.filter((entry) => entry.path.toLowerCase().includes(query.toLowerCase())), [entries, query]);

  const extract = async (all: boolean) => {
    const destination = await open({ directory: true, multiple: false });
    if (!destination || Array.isArray(destination)) return;
    if (all && !window.confirm(`Extract all ${entries.length} entries?`)) return;
    const operationId = crypto.randomUUID();
    setProgress({ operationId, completed: 0, total: all ? entries.length : selected.size, current: "" });
    try { await api.extractArchive({ archivePath: file.path, destination, entryIndices: all ? null : [...selected], collision: "rename", operationId }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setProgress(null); }
  };

  return (
    <div className="viewer archive-viewer">
      <div className="viewer-toolbar">
        <button disabled={!selected.size || !!progress} onClick={() => void extract(false)}>Extract selected…</button>
        <button disabled={!!progress} onClick={() => void extract(true)}>Extract all…</button>
        {progress && <><progress value={progress.completed} max={progress.total} /><button onClick={() => void api.cancel(progress.operationId)}>Cancel</button></>}
        <span className="spacer" /><input placeholder="Filter entries" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      {error && <div className="error-state">{error}</div>}
      <div className="archive-head"><span></span><span>Name</span><span>Compressed</span><span>Original</span></div>
      <div className="archive-list">
        {visible.map((entry) => <label key={entry.index} className={`archive-row ${entry.unsafeReason ? "unsafe" : ""}`} title={entry.unsafeReason ?? entry.path}>
          <input type="checkbox" disabled={!!entry.unsafeReason || entry.isDirectory} checked={selected.has(entry.index)} onChange={(event) => setSelected((prior) => { const next = new Set(prior); if (event.target.checked) next.add(entry.index); else next.delete(entry.index); return next; })} />
          <span style={{ paddingLeft: Math.min(8, entry.path.split("/").length - 1) * 12 }}>{entry.isDirectory ? "📁" : "📄"} {entry.path}</span><span>{formatBytes(entry.compressedSize)}</span><span>{formatBytes(entry.originalSize)}</span>
        </label>)}
      </div>
    </div>
  );
}
