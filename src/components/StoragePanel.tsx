import { useEffect, useState } from "react";
import { AlertTriangle, Copy, Database, Eraser, FolderOpen, HardDrive } from "lucide-react";
import { api } from "../services/tauri";
import type { StorageReport } from "../types/files";
import { formatBytes } from "../utils/fileKind";

export function StoragePanel({ matches }: { matches: (...text: string[]) => boolean }) {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = () => {
    void api.storageReport()
      .then(setReport)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  useEffect(load, []);

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 4000);
  };

  const clear = async (what: "recents" | "session") => {
    const message = what === "recents"
      ? "Clear the recent files list? Workspace pins and open tabs are not affected."
      : "Forget the saved tab list? The next launch will start with no files open.";
    if (!window.confirm(message)) return;
    try {
      if (what === "recents") await api.clearRecentFiles();
      else await api.clearSavedSession();
      flash(what === "recents" ? "Recent files cleared." : "Saved session cleared.");
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const copyPath = () => {
    if (!report) return;
    void navigator.clipboard?.writeText(report.databasePath)
      .then(() => flash("Path copied."))
      .catch(() => setError("The clipboard is not available."));
  };

  return (
    <>
      {error && <div className="modal-error">{error}</div>}
      {notice && <div className="validation-error media-captured">{notice}</div>}

      {matches("storage", "database", "disk", "where", "location", "size") && (
        <section className="settings-card">
          <header><Database size={14} /><div><strong>On disk</strong><small>Everything OneOpen stores lives in one SQLite file.</small></div></header>
          {!report && !error && <p className="muted">Reading the database…</p>}
          {report && (
            <>
              <dl className="engine-facts wide">
                <div><dt>Database</dt><dd>{report.databasePath}</dd></div>
                <div><dt>Size on disk</dt><dd>{report.databaseBytes > 0 ? formatBytes(report.databaseBytes) : "Not created yet"}</dd></div>
                <div><dt>Rows in total</dt><dd>{report.totalRows.toLocaleString()}</dd></div>
              </dl>
              <div className="storage-actions">
                <button className="icon-action labelled" onClick={copyPath}><Copy size={12} /> Copy path</button>
                <button className="icon-action labelled" onClick={() => void api.showInFolder(report.databasePath)}><FolderOpen size={12} /> Show in folder</button>
              </div>
            </>
          )}
        </section>
      )}

      {matches("table", "rows", "contents", "recents", "session", "workspace", "limit", "cap") && report && (
        <section className="settings-card">
          <header><HardDrive size={14} /><div><strong>What is in it</strong><small>Counted now, table by table.</small></div></header>
          <div className="engine-table-wrap">
            <table className="engine-table wrap-cells">
              <thead><tr><th>Table</th><th>Rows</th><th>Limit</th><th>Holds</th></tr></thead>
              <tbody>
                {report.tables.map((table) => (
                  <tr key={table.name}>
                    <td className="engine-module">{table.name}</td>
                    <td className="engine-version">{table.rows.toLocaleString()}</td>
                    <td className="engine-version">{table.cap ?? "—"}</td>
                    <td className="engine-formats">{table.purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="storage-actions">
            <button className="icon-action labelled" onClick={() => void clear("recents")}><Eraser size={12} /> Clear recent files</button>
            <button className="icon-action labelled" onClick={() => void clear("session")}><Eraser size={12} /> Forget saved tabs</button>
          </div>
        </section>
      )}

      {matches("scratch", "temp", "cache", "buffer", "spill", "atomic", "write") && (
        <section className="settings-card">
          <header><Eraser size={14} /><div><strong>Scratch space</strong><small>What the app writes besides that database.</small></div></header>
          <dl className="engine-facts wide">
            <div>
              <dt>During a save</dt>
              <dd>A temporary file is written next to the target and then renamed over it, so an interrupted save cannot leave a half-written file. It is removed as part of the rename.</dd>
            </div>
            <div>
              <dt>Location</dt>
              <dd>The folder the file you are saving already lives in — never a separate scratch pool.</dd>
            </div>
            <div>
              <dt>Anywhere else</dt>
              <dd>Nothing. There is no temp directory, no spill file and no working set kept between runs.</dd>
            </div>
          </dl>
          <p className="engine-note">
            <AlertTriangle size={11} />
            File content is read fresh every time you open a file and dropped when the tab closes.
            Nothing you view is copied to disk.
          </p>
        </section>
      )}

      {matches("cache", "thumbnail", "index", "eviction", "not claimed", "quota") && (
        <section className="settings-card muted-card">
          <header><AlertTriangle size={14} /><div><strong>Not claimed</strong><small>Storage machinery OneOpen does not have.</small></div></header>
          <ul className="doc-flags">
            <li className="off">No thumbnail, waveform, page-render or search-index cache</li>
            <li className="off">No scratch quota, eviction policy or size cap to configure</li>
            <li className="off">No memory-mapped or sparse files — reads are ordinary buffered I/O</li>
            <li className="off">No disk benchmarking, IOPS counters or device identification</li>
            <li className="off">No secure-erase pass; deleting a row does not scrub the disk</li>
          </ul>
          <p className="muted">
            The four cache arenas in the original design — audio waveforms, document tiles, WASM
            bytecode and ephemeral SQL tables — do not exist, so there is nothing to purge and no
            quota to divide. The clear actions above are the only storage controls that do anything.
          </p>
        </section>
      )}
    </>
  );
}
