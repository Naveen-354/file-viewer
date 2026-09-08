import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Braces, ChevronDown, ChevronRight, Clipboard, Code, Copy, FileDown, ListTree, Pencil,
  Save, Sparkles, Table2, X,
} from "lucide-react";
import type { ViewerProps } from "../../types/handlers";
import { api, AppError } from "../../services/tauri";
import { useWorkspace } from "../../stores/workspace";
import { JsonEditor } from "./JsonEditor";
import { decodeBytes, readBytes } from "../../utils/file";
import TextViewer from "../text/TextViewer";
import { parseStructured, type JsonValue } from "../../utils/structured";
import {
  allExpandableIds, ancestorIds, byteOffset, collectStats, composition, flatten, jsonPath,
  matchingNodes, nodeFromValue, parseWithOffsets, pathSegments, previewOf, tableOf,
  type JsonNode,
} from "../../utils/jsonTree";

const LIMIT = 12 * 1024 * 1024;
const ROW_HEIGHT = 22;
type Mode = "tree" | "raw" | "table";

export default function StructuredViewer(props: ViewerProps) {
  const { file, tabId, onDirtyChange, onStatusChange } = props;
  const [text, setText] = useState("");
  const [encoding, setEncoding] = useState("utf-8");
  const [mode, setMode] = useState<Mode>("tree");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [parseFailed, setParseFailed] = useState(false);
  const [root, setRoot] = useState<JsonNode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["$"]));
  const [selectedId, setSelectedId] = useState<string>("$");
  const [prettified, setPrettified] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [editorKey, setEditorKey] = useState(0);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [saving, setSaving] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const replaceFile = useWorkspace((state) => state.replaceFile);
  const isJson = file.extension !== "xml";

  useEffect(() => {
    if (file.size > LIMIT) { setMode("raw"); setError("Document is too large for tree parsing; showing a bounded raw preview."); }
    void readBytes(file.path, LIMIT).then((bytes) => {
      const decoded = decodeBytes(bytes);
      setText(decoded.text);
      setDraft(decoded.text);
      setEncoding(decoded.encoding);
      if (file.size > LIMIT) return;
      try {
        const parsed = isJson
          ? parseWithOffsets(decoded.text)
          : nodeFromValue(parseStructured(decoded.text, file.extension) as JsonValue, null, null);
        setRoot(parsed);
        setExpanded(new Set(["$", ...parsed.children.filter((child) => child.children.length).map((child) => child.id)]));
      } catch (reason) {
        setError(`Validation error: ${reason instanceof Error ? reason.message : String(reason)}`);
        setParseFailed(true);
      }
    }).catch((reason) => setError(String(reason)));
  }, [file.path, file.extension, file.size, isJson]);

  const stats = useMemo(() => (root ? collectStats(root) : null), [root]);
  const matches = useMemo(() => (root ? matchingNodes(root, query) : []), [root, query]);
  const filter = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return undefined;
    const ids = new Set(matches.map((node) => node.id));
    return (node: JsonNode) => ids.has(node.id);
  }, [query, matches]);
  const rows = useMemo(() => (root ? flatten(root, expanded, filter) : []), [root, expanded, filter]);
  const selected = useMemo(() => rows.find((row) => row.node.id === selectedId)?.node ?? findById(root, selectedId), [rows, root, selectedId]);

  useEffect(() => {
    if (!stats) return;
    onStatusChange(`${stats.nodes.toLocaleString()} nodes · depth ${stats.maxDepth}`);
  }, [stats, onStatusChange]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const toggle = (id: string) => setExpanded((prior) => {
    const next = new Set(prior);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const revealFirstMatch = () => {
    const first = matches[0];
    if (!first) return;
    setExpanded((prior) => new Set([...prior, ...ancestorIds(first)]));
    setSelectedId(first.id);
  };

  const copy = (value: string) => void navigator.clipboard?.writeText(value);

  const dirty = editing && draft !== text;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  /** Live validation of the edit buffer, so a broken document cannot be saved. */
  const draftError = useMemo(() => {
    if (!editing) return null;
    try {
      if (isJson) parseWithOffsets(draft);
      else parseStructured(draft, file.extension);
      return null;
    } catch (reason) {
      return reason instanceof Error ? reason.message : String(reason);
    }
  }, [editing, draft, isJson, file.extension]);

  const applyParsed = (content: string) => {
    try {
      const parsed = isJson
        ? parseWithOffsets(content)
        : nodeFromValue(parseStructured(content, file.extension) as JsonValue, null, null);
      setRoot(parsed);
      setSelectedId("$");
    } catch {
      setRoot(null);
    }
  };

  const startEditing = () => {
    setDraft(text);
    setEditorKey((value) => value + 1);
    setEditing(true);
  };

  const stopEditing = () => {
    if (dirty && !window.confirm("Discard your unsaved changes?")) return;
    setDraft(text);
    setEditing(false);
    setError(null);
  };

  const formatDraft = () => {
    if (!isJson || draftError) return;
    setDraft(JSON.stringify(JSON.parse(draft), null, 2));
    setEditorKey((value) => value + 1);
  };

  const saveDraft = async () => {
    if (draftError || file.readonly || saving) return;
    setSaving(true);
    setError(null);
    try {
      let saved;
      try {
        saved = await api.saveText(file.path, draft, file.modifiedMs);
      } catch (reason) {
        if (!(reason instanceof AppError) || reason.code !== "external_modification") throw reason;
        if (!window.confirm("This file changed outside OneOpen. Overwrite the external changes?")) return;
        saved = await api.saveText(file.path, draft, null);
      }
      setText(draft);
      applyParsed(draft);
      replaceFile(tabId, saved);
      onDirtyChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const saveDraftAs = async () => {
    if (draftError || saving) return;
    const destination = await saveDialog({ defaultPath: file.name });
    if (!destination) return;
    setSaving(true);
    try {
      const saved = await api.saveTextAs(file.path, destination, draft);
      setText(draft);
      applyParsed(draft);
      replaceFile(tabId, saved);
      onDirtyChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const table = useMemo(() => (selected ? tableOf(selected) : null), [selected]);
  const rawText = prettified && root ? JSON.stringify(root.value, null, 2) : text;

  if (parseFailed) {
    return (
      <div className="viewer structured-viewer">
        <div className="validation-error">{error} · Opened with the text handler.</div>
        <div className="nested-viewer"><TextViewer {...props} /></div>
      </div>
    );
  }

  return (
    <div className="viewer structured-viewer json-inspector">
      <div className="viewer-toolbar json-bar">
        <span className="json-file"><Braces size={13} /> {file.name}</span>
        <span className="segmented">
          <button className={mode === "tree" ? "selected" : ""} disabled={!root} onClick={() => setMode("tree")}><ListTree size={13} /> Tree View</button>
          <button className={mode === "raw" ? "selected" : ""} onClick={() => setMode("raw")}><Code size={13} /> Raw Code</button>
          <button className={mode === "table" ? "selected" : ""} disabled={!table} title={table ? "Show this array as a table" : "Select an array of objects to use the table view"} onClick={() => setMode("table")}><Table2 size={13} /> Table</button>
        </span>
        <span className="spacer" />
        {selected && <span className="json-path-chip" title={jsonPath(selected)}>{jsonPath(selected)}</span>}
        <input aria-label="Search structure" placeholder="Search keys and values" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") revealFirstMatch(); }} />
        {query && <span className="json-matches">{matches.length} match{matches.length === 1 ? "" : "es"}<button className="icon-button" aria-label="Clear search" onClick={() => setQuery("")}><X size={12} /></button></span>}
      </div>

      <div className="viewer-toolbar json-subbar">
        <button disabled={!root} onClick={() => setExpanded(new Set(root ? allExpandableIds(root) : []))}>Expand All</button>
        <button disabled={!root} onClick={() => setExpanded(new Set(["$"]))}>Collapse All</button>
        {isJson && mode !== "raw" && <button className={prettified ? "selected" : ""} disabled={!root} title="Reformat the raw view with two-space indentation. The file on disk is not changed." onClick={() => setPrettified((value) => !value)}><Sparkles size={13} /> Prettify</button>}
        {mode === "raw" && !editing && (
          <button className="icon-action labelled" onClick={startEditing}><Pencil size={13} /> Edit {isJson ? "JSON" : "XML"}</button>
        )}
        {mode === "raw" && editing && (
          <>
            <button className="icon-action labelled" disabled={!!draftError || file.readonly || saving || !dirty} title={file.readonly ? "This file is read-only" : draftError ?? "Save to this file"} onClick={() => void saveDraft()}><Save size={13} /> {saving ? "Saving…" : "Save"}</button>
            <button className="icon-action labelled" disabled={!!draftError || saving} title={draftError ?? "Save to a new file"} onClick={() => void saveDraftAs()}><FileDown size={13} /> Save as…</button>
            {isJson && <button className="icon-action labelled" disabled={!!draftError} title="Reformat the buffer with two-space indentation" onClick={formatDraft}><Sparkles size={13} /> Format</button>}
            <button onClick={stopEditing}>Cancel</button>
          </>
        )}
        <span className={`json-valid ${root ? "ok" : ""}`}>{root ? `✓ Valid ${isJson ? "JSON" : "XML"}` : "Not parsed"}</span>
        <span className="spacer" />
        {stats && <><span className="json-stat">Nodes: <b>{stats.nodes.toLocaleString()}</b></span><span className="json-stat">Max Depth: <b>{stats.maxDepth}</b></span></>}
        <button onClick={() => copy(rawText)}><Copy size={13} /> Copy {prettified ? "formatted" : "JSON"}</button>
      </div>

      {error && <div className="validation-error">{error}</div>}
      {editing && draftError && <div className="validation-error">Invalid {isJson ? "JSON" : "XML"}: {draftError}</div>}

      <div className="json-body">
        <div className="json-main">
          {mode === "tree" && root && (
            <div className="json-tree" ref={scrollRef}>
              <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const row = rows[item.index];
                  return (
                    <TreeRow
                      key={row.node.id}
                      row={row}
                      top={item.start}
                      selected={row.node.id === selectedId}
                      onToggle={toggle}
                      onSelect={setSelectedId}
                    />
                  );
                })}
              </div>
              {rows.length === 0 && <div className="home-empty">Nothing matches “{query}”.</div>}
            </div>
          )}
          {mode === "raw" && (editing ? (
            <JsonEditor
              key={editorKey}
              initial={draft}
              readonly={false}
              language={isJson ? "json" : "xml"}
              onChange={setDraft}
              onCursor={(line, column) => setCursor({ line, column })}
            />
          ) : (
            <pre className="raw-view">{rawText}</pre>
          ))}
          {mode === "table" && table && (
            <div className="json-table-scroll">
              <table className="json-table">
                <thead><tr><th>#</th>{table.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
                <tbody>
                  {table.rows.map((cells, index) => (
                    <tr key={index}><td className="json-table-index">{index}</td>{cells.map((cell, position) => <td key={position}>{cell ?? <span className="muted">—</span>}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {selected && mode !== "raw" && (
          <aside className="json-details" aria-label="Node details">
            <div className="json-details-head"><strong>Node Details</strong><em className={`json-type ${selected.type}`}>{selected.type.toUpperCase()}</em></div>
            <dl className="json-facts">
              <div><dt>Selected key</dt><dd>{selected.key ?? (selected.index !== null ? `[${selected.index}]` : "root")}</dd></div>
              <div><dt>Raw value</dt><dd className="json-raw-value" title={previewOf(selected)}>{previewOf(selected)}</dd></div>
              {selected.start >= 0 && <div><dt>Byte offset</dt><dd>{byteOffset(text, selected.start).toLocaleString()} bytes</dd></div>}
              <div><dt>Tree depth</dt><dd>Level {selected.depth}</dd></div>
              {selected.children.length > 0 && <div><dt>Children</dt><dd>{selected.children.length.toLocaleString()}</dd></div>}
            </dl>
            <div className="json-pathbox">
              <small>EXACT JSONPATH</small>
              <code>{jsonPath(selected)}</code>
            </div>
            <button className="primary json-copy-path" onClick={() => copy(jsonPath(selected))}><Clipboard size={13} /> Copy JSONPath</button>
            <div className="json-detail-actions">
              <button onClick={() => copy(previewOf(selected).replace(/^"|"$/g, ""))}>Copy value</button>
              <button onClick={() => copy(JSON.stringify(selected.value, null, 2))}>Copy subtree</button>
            </div>
            {stats && <Composition stats={stats} />}
          </aside>
        )}
      </div>

      {selected && (
        <div className="json-breadcrumb">
          {pathSegments(selected).map((segment, index, all) => (
            <span key={`${segment}-${index}`} className={index === all.length - 1 ? "current" : ""}>{segment}</span>
          ))}
          <span className="spacer" />
          <button onClick={() => copy(jsonPath(selected))}><Copy size={12} /> Copy Path</button>
        </div>
      )}

      <div className="json-status">
        {editing
          ? <span className={draftError ? "bad" : "ok"}>{draftError ? `Invalid ${isJson ? "JSON" : "XML"}` : `Valid ${isJson ? "JSON" : "XML"}`}</span>
          : <span className={root ? "ok" : ""}>{root ? `Valid ${isJson ? "JSON" : "XML"}` : "Unparsed"}</span>}
        {editing && <span>Ln {cursor.line}, Col {cursor.column}</span>}
        {dirty && <span className="bad">Modified</span>}
        <span>{formatSize(file.size)}</span>
        {stats && <span>{stats.maxDepth} levels deep</span>}
        <span>{encoding.toUpperCase()}</span>
        <span>{text.includes("\r\n") ? "CRLF" : "LF"}</span>
      </div>
    </div>
  );
}

function TreeRow({ row, top, selected, onToggle, onSelect }: {
  row: { node: JsonNode; expandable: boolean; expanded: boolean };
  top: number;
  selected: boolean;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const { node, expandable, expanded } = row;
  const label = node.key ?? (node.index !== null ? `[${node.index}]` : "root");
  return (
    <div
      className={`json-row ${selected ? "selected" : ""}`}
      style={{ top, paddingLeft: 8 + node.depth * 15 }}
      onClick={() => onSelect(node.id)}
    >
      <button
        className="json-disclosure"
        tabIndex={-1}
        aria-hidden={!expandable}
        aria-label={expandable ? (expanded ? `Collapse ${label}` : `Expand ${label}`) : undefined}
        onClick={(event) => { event.stopPropagation(); if (expandable) onToggle(node.id); }}
      >
        {expandable ? (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
      </button>
      <span className={`json-key ${node.index !== null ? "index" : ""}`}>{node.index !== null ? `[${node.index}]` : `"${label}"`}</span>
      {node.children.length === 0 && <span className="json-colon">:</span>}
      <span className={`json-value ${node.type}`}>{node.children.length === 0 ? previewOf(node) : ""}</span>
      {node.children.length > 0 && <span className="json-count">{previewOf(node)}</span>}
      {selected && <span className="json-selected-badge">SELECTED NODE</span>}
    </div>
  );
}

function Composition({ stats }: { stats: ReturnType<typeof collectStats> }) {
  const parts = composition(stats);
  const circumference = 2 * Math.PI * 26;
  let offset = 0;
  return (
    <section className="json-composition">
      <h3>Type Composition</h3>
      <div className="json-composition-body">
        <svg viewBox="0 0 64 64" role="img" aria-label="Share of node types">
          {parts.map((part) => {
            const length = part.portion * circumference;
            const circle = (
              <circle
                key={part.label}
                cx="32" cy="32" r="26" fill="none" strokeWidth="9"
                className={`ring-${part.tone}`}
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 32 32)"
              />
            );
            offset += length;
            return circle;
          })}
        </svg>
        <ul>
          {parts.map((part) => (
            <li key={part.label}><i className={part.tone} />{part.label}<b>{Math.round(part.portion * 100)}%</b></li>
          ))}
        </ul>
      </div>
      <small>{stats.nodes.toLocaleString()} nodes</small>
    </section>
  );
}

function findById(root: JsonNode | null, id: string): JsonNode | undefined {
  if (!root) return undefined;
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findById(child, id);
    if (found) return found;
  }
  return undefined;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
