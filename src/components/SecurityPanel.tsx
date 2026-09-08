import { useEffect, useState } from "react";
import { AlertTriangle, Eraser, FileWarning, FolderLock, Globe, Lock } from "lucide-react";
import { api } from "../services/tauri";
import type { EngineReport } from "../types/files";

/**
 * How each kind of untrusted content is handled.
 *
 * Every line here was checked against the code before being written, and names
 * the module that implements it so it can be checked again.
 */
const CONTENT_RULES = [
  {
    format: "SVG images",
    treatment: "Sanitised, then rendered as an image",
    detail: "DOMPurify strips <script> and <foreignObject> and every event-handler attribute before the markup becomes a blob, which is then shown in an <img>.",
    where: "handlers/image/ImageViewer.tsx",
  },
  {
    format: "Word and Excel macros",
    treatment: "Detected, never read or run",
    detail: "The parsers only read the XML parts they need. A vbaProject.bin is reported as present in the document inspector; its bytes are never opened.",
    where: "handlers/docx_meta.rs",
  },
  {
    format: "OOXML entities",
    treatment: "Never expanded",
    detail: "quick-xml does not expand custom or external entities, so a document cannot mount an entity-expansion or external-reference attack.",
    where: "handlers/document.rs",
  },
  {
    format: "Document text",
    treatment: "Inserted as text, never markup",
    detail: "Runs become React text nodes, so formatting in a hostile file cannot introduce elements or scripts.",
    where: "handlers/document/DocumentViewer.tsx",
  },
  {
    format: "PDF actions",
    treatment: "Pages rendered; document scripts not run",
    detail: "Pages are drawn with the pdf.js core API. The viewer layer that would execute a document's JavaScript actions is not used.",
    where: "handlers/pdf/PdfViewer.tsx",
  },
  {
    format: "PDF text in the editor",
    treatment: "Escaped before display",
    detail: "Text lifted out of a PDF is HTML-escaped on its way into the annotation editor, and colours are re-parsed to #rrggbb.",
    where: "handlers/pdf/richText.ts",
  },
  {
    format: "Archive entries",
    treatment: "Paths and ratios checked",
    detail: "An entry naming an absolute path, a drive or a .. component is refused, and both the decompressed size and the compression ratio are capped.",
    where: "security/mod.rs, handlers/archive.rs",
  },
];

export function SecurityPanel({ matches }: { matches: (...text: string[]) => boolean }) {
  const [report, setReport] = useState<EngineReport | null>(null);
  const [recents, setRecents] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    void api.engineReport().then((value) => { if (!cancelled) setReport(value); })
      .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    void api.recentFiles().then((value) => { if (!cancelled) setRecents(value.length); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const clear = async (what: "recents" | "session") => {
    const message = what === "recents"
      ? "Clear the recent files list? Workspace pins and open tabs are not affected."
      : "Forget the saved tab list? The next launch will start with no files open.";
    if (!window.confirm(message)) return;
    try {
      if (what === "recents") { await api.clearRecentFiles(); setRecents(0); }
      else await api.clearSavedSession();
      setNotice(what === "recents" ? "Recent files cleared." : "Saved session cleared.");
      window.setTimeout(() => setNotice(""), 4000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <>
      {error && <div className="modal-error">{error}</div>}
      {notice && <div className="validation-error media-captured">{notice}</div>}

      {matches("network", "outbound", "telemetry", "csp", "policy", "offline") && (
        <section className="settings-card">
          <header><Globe size={14} /><div><strong>Network</strong><small>Read from the content policy and capability list this build ships.</small></div></header>
          <div className="setting-row">
            <span><strong>Outbound connections</strong><small>No HTTP or shell plugin is compiled in, and the content policy admits only the local IPC bridge.</small></span>
            <span className="engine-badge ok"><Lock size={11} /> None</span>
          </div>
          <div className="setting-row">
            <span><strong>Telemetry, crash reporting, update checks</strong><small>None of the three exist in the codebase.</small></span>
            <span className="engine-badge ok">Absent</span>
          </div>
          <p className="engine-note">
            <AlertTriangle size={11} />
            This comes from the policy and the capability allowlist, which are listed in full under
            Native Engine. It is <strong>not</strong> a kernel filter: OneOpen installs no driver and
            intercepts no syscall, so nothing here would stop code running outside the app.
          </p>
        </section>
      )}

      {matches("file", "path", "access", "sandbox", "isolation", "process", "permission") && (
        <section className="settings-card">
          <header><FolderLock size={14} /><div><strong>File access</strong><small>How the window reaches the disk.</small></div></header>
          <dl className="engine-facts wide">
            <div><dt>Frontend filesystem API</dt><dd>None — every read and write goes through a named command</dd></div>
            <div><dt>Path handling</dt><dd>Canonicalised in Rust before use; the window never supplies a resolved path</dd></div>
            <div><dt>Reach</dt><dd>Whatever your user account can open — files you pick, drop, or have pinned</dd></div>
            <div><dt>Process model</dt><dd>One process at your normal integrity level</dd></div>
          </dl>
          <p className="engine-note">
            <AlertTriangle size={11} />
            There is no AppContainer, no low-integrity worker per file and no per-handler sandbox.
            A bug in a parser would run with the same rights as the rest of the app, which is why
            the parsers are bounded and refuse malformed input rather than relying on containment.
          </p>
        </section>
      )}

      {matches("untrusted", "macro", "script", "svg", "vba", "content", "execution", "pdf") && (
        <section className="settings-card">
          <header><FileWarning size={14} /><div><strong>Untrusted content</strong><small>What is executed, what is not, and the mechanism in each case.</small></div></header>
          <div className="engine-table-wrap">
            <table className="engine-table wrap-cells">
              <thead><tr><th>Content</th><th>Treatment</th><th>Mechanism</th><th>Implemented in</th></tr></thead>
              <tbody>
                {CONTENT_RULES.map((rule) => (
                  <tr key={rule.format}>
                    <td>{rule.format}</td>
                    <td><span className="engine-runtime core">{rule.treatment}</span></td>
                    <td className="engine-formats">{rule.detail}</td>
                    <td className="engine-module">{rule.where}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="engine-note">
            <AlertTriangle size={11} />
            Nothing is scanned, stripped or disinfected. There is no malware heuristic and no
            payload detector. These are properties of how each format is parsed — an SVG is
            sanitised, but a Word macro is simply never run, not removed from your file.
          </p>
        </section>
      )}

      {matches("storage", "data", "rest", "encryption", "dpapi", "recents", "history", "privacy") && (
        <section className="settings-card">
          <header><Eraser size={14} /><div><strong>Data at rest</strong><small>Everything OneOpen keeps about you, and how it is stored.</small></div></header>

          <div className="setting-row">
            <span><strong>Encryption</strong><small>The database is an ordinary SQLite file in your app-data folder.</small></span>
            <span className="engine-badge">Not encrypted</span>
          </div>

          <div className="setting-row">
            <span><strong>Recent files</strong><small>{recents === null ? "Paths and names of files you have opened." : `${recents.toLocaleString()} record${recents === 1 ? "" : "s"}, stored as plain text.`}</small></span>
            <button className="icon-action labelled" onClick={() => void clear("recents")}><Eraser size={12} /> Clear history</button>
          </div>

          <div className="setting-row">
            <span><strong>Saved session</strong><small>The tab list restored on launch.</small></span>
            <button className="icon-action labelled" onClick={() => void clear("session")}><Eraser size={12} /> Forget tabs</button>
          </div>

          <p className="engine-note">
            <AlertTriangle size={11} />
            There is no DPAPI vault, no TPM binding and no key to rotate. Anyone who can read your
            user profile can read this database. If that matters for a file you open, clearing the
            history above is the control that actually exists.
          </p>
        </section>
      )}

      {matches("audit", "report", "signature", "attestation", "hardening", "claims") && (
        <section className="settings-card muted-card">
          <header><AlertTriangle size={14} /><div><strong>Not claimed</strong><small>Protections OneOpen does not have.</small></div></header>
          <ul className="doc-flags">
            <li className="off">No kernel driver, WFP filter or syscall interception</li>
            <li className="off">No AppContainer, low-integrity worker or per-handler sandbox</li>
            <li className="off">No encryption at rest, DPAPI vault or TPM attestation</li>
            <li className="off">No memory scrubbing on close</li>
            <li className="off">No malware scanning, payload stripping or document disinfection</li>
            <li className="off">No signed security attestation or audit log to export</li>
          </ul>
          <p className="muted">
            A security page is worth less than nothing if it overstates. Each line above is
            something a reasonable person might assume from the others, so it is stated plainly
            rather than left to inference.
          </p>
        </section>
      )}

      {report && matches("build", "unsafe", "rust") && (
        <section className="settings-card">
          <header><Lock size={14} /><div><strong>Build</strong><small>Read from this binary.</small></div></header>
          <dl className="engine-facts">
            <div><dt>Unsafe code</dt><dd>{report.unsafeForbidden ? "Forbidden crate-wide" : "Permitted"}</dd></div>
            <div><dt>Granted capabilities</dt><dd>{report.isolation.permissions.length}</dd></div>
          </dl>
        </section>
      )}
    </>
  );
}
