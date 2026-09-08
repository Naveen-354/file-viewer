import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { createFindPanel } from "./findPanel";
import { MSSQL, MySQL, PLSQL, PostgreSQL, SQLite, StandardSQL, sql } from "@codemirror/lang-sql";
import {
  AlertTriangle, Check, Copy, Database, FileCode2, FolderOpen, Info, ListTree, PanelRight,
  Save, Search as SearchIcon, Sparkles, WrapText,
} from "lucide-react";
import type { ViewerProps } from "../../types/handlers";
import { api, AppError } from "../../services/tauri";
import { decodeBytes, readBytes } from "../../utils/file";
import { formatBytes } from "../../utils/fileKind";
import { useSettings } from "../../stores/settings";
import { useWorkspace } from "../../stores/workspace";
import {
  countLines, countStatements, detectDialect, formatSql, lineEndingOf, parseObjects,
  type SqlObjectKind,
} from "../../utils/sql";

const EDIT_LIMIT = 8 * 1024 * 1024;
const POLL_MS = 3000;

/**
 * Highlighting follows the detected dialect, so `$$` bodies and backtick
 * identifiers are coloured the way the engine that owns them reads them.
 */
const DIALECTS: Record<string, typeof StandardSQL> = {
  PostgreSQL, MySQL, SQLite, "SQL Server": MSSQL, Oracle: PLSQL,
};

/** Outline groups, in the order a schema is usually read. */
const GROUPS: { kind: SqlObjectKind; label: string; plural: string }[] = [
  { kind: "extension", label: "Extension", plural: "Extensions" },
  { kind: "schema", label: "Schema", plural: "Schemas" },
  { kind: "type", label: "Type", plural: "Types" },
  { kind: "sequence", label: "Sequence", plural: "Sequences" },
  { kind: "table", label: "Table", plural: "Tables" },
  { kind: "view", label: "View", plural: "Views" },
  { kind: "index", label: "Index", plural: "Indexes" },
  { kind: "function", label: "Function", plural: "Functions" },
  { kind: "procedure", label: "Procedure", plural: "Procedures" },
  { kind: "trigger", label: "Trigger", plural: "Triggers" },
];

export default function SqlViewer({ file, tabId, onDirtyChange, onStatusChange }: ViewerProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const editor = useRef<EditorView | null>(null);
  const wrapCompartment = useRef(new Compartment());
  const languageCompartment = useRef(new Compartment());
  const [text, setText] = useState("");
  const [encoding, setEncoding] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [modified, setModified] = useState(file.modifiedMs);
  const [outline, setOutline] = useState(true);
  const [inspector, setInspector] = useState(true);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const readonly = file.readonly || file.size > EDIT_LIMIT;
  const dialect = useMemo(() => detectDialect(text), [text]);
  const dialectName = dialect?.name ?? null;
  const wrap = useSettings((state) => state.wordWrap);
  const updateSettings = useSettings((state) => state.update);
  const replaceFile = useWorkspace((state) => state.replaceFile);

  useEffect(() => {
    let disposed = false;
    void readBytes(file.path, EDIT_LIMIT).then((bytes) => {
      if (disposed || !host.current) return;
      const decoded = decodeBytes(bytes);
      setText(decoded.text);
      setEncoding(decoded.encoding.toUpperCase());
      const extensions: Extension[] = [
        lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), history(),
        bracketMatching(), syntaxHighlighting(defaultHighlightStyle),
        // The stock panel docks to the bottom of the editor with its own markup;
        // this one sits over the top of the code and shows a match counter.
        search({ top: true, createPanel: createFindPanel }),
        languageCompartment.current.of(sql({ dialect: StandardSQL, upperCaseKeywords: true })),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        EditorView.editable.of(!readonly), EditorState.readOnly.of(readonly),
        wrapCompartment.current.of(useSettings.getState().wordWrap ? EditorView.lineWrapping : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            setText(update.state.doc.toString());
            onDirtyChange(true);
          }
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            setCursor({ line: line.number, column: head - line.from + 1 });
          }
        }),
      ];
      editor.current = new EditorView({
        state: EditorState.create({ doc: decoded.text, extensions }),
        parent: host.current,
      });
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { disposed = true; editor.current?.destroy(); editor.current = null; };
  }, [file.path, readonly, onDirtyChange]);

  useEffect(() => {
    editor.current?.dispatch({
      effects: wrapCompartment.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  /** Re-tunes highlighting once the script's dialect is known. */
  useEffect(() => {
    const view = editor.current;
    if (!view) return;
    const chosen = (dialectName && DIALECTS[dialectName]) || StandardSQL;
    view.dispatch({
      effects: languageCompartment.current.reconfigure(
        sql({ dialect: chosen, upperCaseKeywords: true }),
      ),
    });
  }, [dialectName]);

  /** Polls the file's timestamp so an edit made elsewhere is not overwritten. */
  useEffect(() => {
    const timer = window.setInterval(() => void api.metadata(file.path).then((latest) => {
      if (modified !== null && latest.modifiedMs !== modified) setConflict(true);
    }).catch(() => undefined), POLL_MS);
    return () => clearInterval(timer);
  }, [file.path, modified]);

  const objects = useMemo(() => parseObjects(text), [text]);
  const statements = useMemo(() => countStatements(text), [text]);
  const lines = useMemo(() => countLines(text), [text]);
  const ending = useMemo(() => lineEndingOf(text), [text]);
  const counts = useMemo(() => {
    const totals = new Map<SqlObjectKind, number>();
    for (const object of objects) totals.set(object.kind, (totals.get(object.kind) ?? 0) + 1);
    return totals;
  }, [objects]);

  useEffect(() => {
    const parts = [dialect ? dialect.name : "SQL", `${lines.toLocaleString()} lines`];
    if (objects.length) parts.push(`${objects.length} objects`);
    if (readonly) parts.push("Read only");
    onStatusChange(parts.join(" · "));
  }, [dialect, lines, objects.length, readonly, onStatusChange]);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 3500);
  }, []);

  const replaceDocument = (next: string) => {
    const view = editor.current;
    if (!view || view.state.doc.toString() === next) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
      selection: { anchor: Math.min(view.state.selection.main.head, next.length) },
    });
  };

  const reload = async () => {
    try {
      const bytes = await readBytes(file.path, EDIT_LIMIT);
      const decoded = decodeBytes(bytes);
      replaceDocument(decoded.text);
      setText(decoded.text);
      const latest = await api.metadata(file.path);
      setModified(latest.modifiedMs);
      setConflict(false);
      onDirtyChange(false);
      flash("Reloaded from disk.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const saveCurrent = async () => {
    if (readonly || !editor.current) return;
    if (conflict && !window.confirm("This file changed outside OneOpen. Overwrite those changes?")) return;
    try {
      const content = editor.current.state.doc.toString();
      const result = await api.saveText(file.path, content, conflict ? null : modified);
      setModified(result.modifiedMs);
      setConflict(false);
      onDirtyChange(false);
      flash("Saved.");
    } catch (reason) {
      if (reason instanceof AppError && reason.code === "external_modification") setConflict(true);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const saveAs = async () => {
    if (!editor.current) return;
    const destination = await saveDialog({
      defaultPath: file.name,
      filters: [{ name: "SQL script", extensions: ["sql"] }],
    });
    if (!destination) return;
    try {
      const saved = await api.saveTextAs(file.path, destination, editor.current.state.doc.toString());
      replaceFile(tabId, saved);
      onDirtyChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const format = () => {
    if (readonly || !editor.current) return;
    const current = editor.current.state.doc.toString();
    const formatted = formatSql(current);
    if (formatted === current) { flash("Already tidy — nothing to change."); return; }
    replaceDocument(formatted);
  };

  const jumpTo = (line: number) => {
    const view = editor.current;
    if (!view || line > view.state.doc.lines) return;
    const position = view.state.doc.line(line).from;
    view.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(position, { y: "center" }),
    });
    view.focus();
  };

  const copyPath = () => {
    void navigator.clipboard?.writeText(file.path)
      .then(() => flash("Full path copied."))
      .catch(() => setError("The clipboard is not available."));
  };

  return (
    <div
      className="viewer sql-studio"
      onKeyDown={(event) => {
        const mod = event.ctrlKey || event.metaKey;
        if (mod && event.key.toLowerCase() === "s") { event.preventDefault(); void saveCurrent(); }
      }}
    >
      <div className="viewer-toolbar sql-bar">
        <span className="json-file"><Database size={13} /> {file.name}</span>
        <em className="json-type">{dialect ? dialect.name : "SQL"}</em>
        <span className="toolbar-divider" />
        <button className="icon-action labelled" disabled={readonly} onClick={() => void saveCurrent()}><Save size={13} /> Save <kbd>Ctrl+S</kbd></button>
        <button className="icon-action labelled" onClick={() => void saveAs()}>Save as…</button>
        <button className="icon-action labelled" disabled={readonly} title="Upper-case reserved words, trim trailing spaces and collapse blank lines. Statements are not re-indented." onClick={format}><Sparkles size={13} /> Format SQL</button>
        <button className={`icon-action labelled ${wrap ? "selected" : ""}`} aria-pressed={wrap} onClick={() => void updateSettings({ wordWrap: !wrap })}><WrapText size={13} /> Wrap: {wrap ? "On" : "Off"}</button>
        <button className="icon-action labelled" onClick={() => editor.current && openSearchPanel(editor.current)}><SearchIcon size={13} /> Find <kbd>Ctrl+F</kbd></button>
        <span className="spacer" />
        <button className={`icon-action ${outline ? "selected" : ""}`} aria-label="Toggle schema outline" aria-pressed={outline} title="Schema outline" onClick={() => setOutline((value) => !value)}><ListTree size={14} /></button>
        <button className={`icon-action labelled ${inspector ? "selected" : ""}`} aria-label="Toggle file inspector" aria-pressed={inspector} onClick={() => setInspector((value) => !value)}><Info size={13} /> Inspector</button>
      </div>

      {conflict && (
        <div className="validation-error sql-conflict">
          <AlertTriangle size={13} />
          <span>{file.name} was modified outside OneOpen.</span>
          <span className="spacer" />
          <button className="icon-action labelled" onClick={() => void reload()}>Reload from disk</button>
          <button className="icon-action labelled" onClick={() => setConflict(false)}>Keep my changes</button>
        </div>
      )}
      {notice && <div className="validation-error media-captured"><Check size={13} /> {notice}</div>}
      {error && <div className="validation-error">{error}</div>}
      {readonly && !file.readonly && <div className="validation-error">This script is larger than 8 MiB, so it is open read-only.</div>}

      <div className="sql-body">
        {outline && (
          <nav className="sql-outline" aria-label="Schema outline">
            <h3><ListTree size={11} /> Objects</h3>
            {objects.length === 0 && <p className="muted small">This script does not create any objects.</p>}
            {GROUPS.map((group) => {
              const members = objects.filter((object) => object.kind === group.kind);
              if (!members.length) return null;
              return (
                <section key={group.kind}>
                  <h4>{group.plural} <b>{members.length}</b></h4>
                  {members.map((object) => (
                    <button key={`${object.offset}`} className="sql-outline-entry" title={`Line ${object.line}`} onClick={() => jumpTo(object.line)}>
                      <span className={`sql-dot ${object.kind}`} />
                      <span className="sql-outline-name">{object.name}</span>
                      <small>{object.line}</small>
                    </button>
                  ))}
                </section>
              );
            })}
          </nav>
        )}

        <div ref={host} className="sql-editor editor-host" />

        {inspector && (
          <aside className="sql-inspector" aria-label="File inspector">
            <div className="json-details-head"><strong><FileCode2 size={13} /> File Inspector</strong><em className="json-type">{file.extension?.toUpperCase() ?? "SQL"}</em></div>

            <section>
              <dl className="image-facts">
                <Row label="File name" value={file.name} />
                <Row label="Size" value={`${formatBytes(file.size)} (${lines.toLocaleString()} lines)`} />
                <Row label="Access" value={file.readonly ? "Read-only" : "Read / write"} />
                <Row label="Encoding" value={`${encoding}, ${ending}`} />
                <Row label="Dialect" value={dialect ? dialect.name : "Not identifiable"} hint={dialect ? `Guessed from ${dialect.because}` : "No engine-specific syntax found"} />
                <Row label="Modified" value={modified ? new Date(modified).toLocaleString() : null} />
                <Row label="Statements" value={statements.toLocaleString()} />
              </dl>
              <button className="sql-path" title={file.path} onClick={copyPath}>
                <Copy size={11} /> <span>{file.path}</span>
              </button>
            </section>

            <section>
              <h3>Objects declared</h3>
              {objects.length === 0
                ? <p className="muted small">None. Counted from CREATE statements outside comments and strings.</p>
                : <dl className="image-facts">
                    {GROUPS.filter((group) => counts.has(group.kind)).map((group) => (
                      <div key={group.kind}>
                        <dt><span className={`sql-dot ${group.kind}`} /> {group.plural}</dt>
                        <dd>{counts.get(group.kind)!.toLocaleString()}</dd>
                      </div>
                    ))}
                  </dl>}
            </section>

            <section>
              <h3>Quick actions</h3>
              <ul className="doc-list sql-actions">
                <li><button onClick={() => void api.showInFolder(file.path)}><FolderOpen size={12} /> Show in folder</button></li>
                <li><button onClick={copyPath}><Copy size={12} /> Copy full path</button></li>
                <li><button onClick={() => void api.openSystem(file.path)}><PanelRight size={12} /> Open in the default app</button></li>
              </ul>
            </section>
          </aside>
        )}
      </div>

      <div className="json-status">
        <span>{dialect ? `${dialect.name} (detected)` : "SQL"}</span>
        <span>{encoding}</span>
        <span>{ending}</span>
        <span>{objects.length.toLocaleString()} objects · {statements.toLocaleString()} statements</span>
        <span className="spacer" />
        {conflict && <span className="bad">Changed on disk</span>}
        <span>Ln {cursor.line}, Col {cursor.column}</span>
        <span>{formatBytes(file.size)}</span>
      </div>
    </div>
  );
}

/** A row is left out entirely when there is nothing to report. */
function Row({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  if (!value) return null;
  return <div><dt>{label}</dt><dd title={hint ?? value}>{value}</dd></div>;
}
