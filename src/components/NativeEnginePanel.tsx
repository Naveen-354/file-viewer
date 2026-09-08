import { useEffect, useState } from "react";
import { AlertTriangle, Cpu, Database, Eraser, Gauge, Lock, ShieldCheck } from "lucide-react";
import { api } from "../services/tauri";
import type { EngineReport } from "../types/files";
import { formatBytes } from "../utils/fileKind";

/**
 * Limits the frontend enforces itself, which the Rust report cannot see. Each
 * one names the module that applies it so the claim can be checked.
 */
const FRONTEND_LIMITS = [
  { name: "Text editing", value: 8 * 1024 * 1024, where: "TextViewer" },
  { name: "SQL editing", value: 8 * 1024 * 1024, where: "SqlViewer" },
  { name: "Media playback", value: 48 * 1024 * 1024, where: "MediaViewer" },
];

export function NativeEnginePanel({ matches }: { matches: (...text: string[]) => boolean }) {
  const [report, setReport] = useState<EngineReport | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    api.engineReport()
      .then(setReport)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const clear = async (what: "recents" | "session") => {
    const message = what === "recents"
      ? "Clear the recent files list? Workspace pins and open tabs are not affected."
      : "Forget the saved tab list? The next launch will start with no files open.";
    if (!window.confirm(message)) return;
    try {
      if (what === "recents") await api.clearRecentFiles();
      else await api.clearSavedSession();
      setNotice(what === "recents" ? "Recent files cleared." : "Saved session cleared.");
      window.setTimeout(() => setNotice(""), 4000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  if (error) return <section className="settings-card"><p className="modal-error">{error}</p></section>;
  if (!report) return <section className="settings-card"><p className="muted">Reading build information…</p></section>;

  return (
    <>
      {notice && <div className="validation-error media-captured">{notice}</div>}

      {matches("build", "version", "target", "profile", "unsafe", "rust") && (
        <section className="settings-card">
          <header><Cpu size={14} /><div><strong>Build</strong><small>Read from this binary, not from a written-down spec.</small></div></header>
          <dl className="engine-facts">
            <div><dt>Application</dt><dd>OneOpen {report.appVersion} ({report.profile})</dd></div>
            <div><dt>Target triple</dt><dd>{report.target}</dd></div>
            <div><dt>Shell</dt><dd>Tauri {report.tauriVersion}</dd></div>
            <div><dt>Unsafe code</dt><dd>{report.unsafeForbidden ? "Forbidden crate-wide" : "Permitted"}</dd></div>
          </dl>
          <p className="engine-note">
            OneOpen reads files with ordinary buffered I/O. There is no memory-mapping layer,
            no SIMD-specialised parser and no GPU compute path — the decoders below are plain
            safe Rust, and rendering is whatever the system WebView does.
          </p>
        </section>
      )}

      {matches("decoder", "engine", "registry", "library", "crate", "format") && (
        <section className="settings-card">
          <header><Database size={14} /><div><strong>Decoder engines</strong><small>The library that actually handles each family, with the version Cargo resolved for this build.</small></div></header>
          <div className="engine-table-wrap">
            <table className="engine-table">
              <thead>
                <tr><th>Category</th><th>Module</th><th>Version</th><th>Runs in</th><th>Formats</th></tr>
              </thead>
              <tbody>
                {report.engines.map((engine) => (
                  <tr key={`${engine.category}-${engine.module}`}>
                    <td>{engine.category}</td>
                    <td className="engine-module">{engine.module}</td>
                    <td className="engine-version">{engine.version}</td>
                    <td><span className={`engine-runtime ${engine.runtime === "Rust core" ? "core" : "webview"}`}>{engine.runtime}</span></td>
                    <td className="engine-formats" title={engine.formats.join(", ")}>{engine.formats.join(" · ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {matches("limit", "size", "cap", "bomb", "guard", "memory") && (
        <section className="settings-card">
          <header><Gauge size={14} /><div><strong>Enforced limits</strong><small>Fixed ceilings, not preferences. They are compiled in because they are what stops a hostile file exhausting memory.</small></div></header>
          <dl className="engine-facts">
            {report.limits.map((limit) => (
              <div key={limit.name}>
                <dt title={limit.why}>{limit.name}</dt>
                <dd>{limit.unit === "bytes" ? formatBytes(limit.value) : `${limit.value.toLocaleString()} ${limit.unit}`}</dd>
              </div>
            ))}
            {FRONTEND_LIMITS.map((limit) => (
              <div key={limit.name}>
                <dt title={`Applied in ${limit.where}`}>{limit.name}</dt>
                <dd>{formatBytes(limit.value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {matches("isolation", "network", "telemetry", "csp", "permission", "sandbox", "security") && (
        <section className="settings-card">
          <header><ShieldCheck size={14} /><div><strong>Isolation</strong><small>Read from the shipped Tauri configuration, so it reflects what this build actually allows.</small></div></header>

          <div className="setting-row">
            <span><strong>Outbound network</strong><small>The content policy admits only the local IPC bridge, and no HTTP or shell plugin is compiled in.</small></span>
            <span className="engine-badge ok"><Lock size={11} /> None</span>
          </div>

          <div className="engine-block">
            <h4>Content security policy</h4>
            <code>{report.isolation.csp}</code>
          </div>

          <div className="engine-block">
            <h4>Granted capabilities ({report.isolation.permissions.length})</h4>
            <div className="engine-chips">
              {report.isolation.permissions.map((permission) => <span key={permission}>{permission}</span>)}
            </div>
          </div>

          <p className="engine-note">
            <AlertTriangle size={11} /> OneOpen has no crash reporter and no update check, so nothing
            leaves this machine. It also has no syscall-level socket filter: the guarantee above comes
            from the policy and the capability list, not from intercepting Windows networking.
          </p>
        </section>
      )}

      {matches("local", "data", "recents", "history", "privacy", "clear") && (
        <section className="settings-card">
          <header><Eraser size={14} /><div><strong>Local data</strong><small>Everything OneOpen stores lives in one SQLite database in your app-data folder.</small></div></header>

          <div className="setting-row">
            <span><strong>Recent files</strong><small>Paths and names of files you have opened. Stored as plain text — the database is not encrypted.</small></span>
            <button className="icon-action labelled" onClick={() => void clear("recents")}><Eraser size={12} /> Clear history</button>
          </div>

          <div className="setting-row">
            <span><strong>Saved session</strong><small>The tab list restored on launch.</small></span>
            <button className="icon-action labelled" onClick={() => void clear("session")}><Eraser size={12} /> Forget tabs</button>
          </div>
        </section>
      )}
    </>
  );
}
