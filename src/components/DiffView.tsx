import { useEffect, useMemo, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown, ArrowLeftRight, ArrowUp, Columns2, Download, Rows3, X,
} from "lucide-react";
import { api } from "../services/tauri";
import type { FileDescriptor } from "../types/files";
import { decodeBytes, readBytes } from "../utils/file";
import { formatBytes } from "../utils/fileKind";
import {
  diffLines, endsWithNewline, toPatch, toUnified,
  type DiffResult, type RowKind,
} from "../utils/lineDiff";

const READ_LIMIT = 8 * 1024 * 1024;

interface Loaded { text: string; encoding: string }

export function DiffView({
  left, right, onSwap, close,
}: {
  left: FileDescriptor;
  right: FileDescriptor;
  onSwap: () => void;
  close: () => void;
}) {
  const [a, setA] = useState<Loaded | null>(null);
  const [b, setB] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unified, setUnified] = useState(false);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [hunk, setHunk] = useState(0);
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setA(null); setB(null); setError("");
    const load = async (file: FileDescriptor) => {
      const bytes = await readBytes(file.path, READ_LIMIT);
      const decoded = decodeBytes(bytes);
      return { text: decoded.text, encoding: decoded.encoding.toUpperCase() };
    };
    void Promise.all([load(left), load(right)])
      .then(([one, two]) => { if (!cancelled) { setA(one); setB(two); setHunk(0); } })
      .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [left, right]);

  const result: DiffResult | null = useMemo(
    () => (a && b ? diffLines(a.text, b.text, { ignoreWhitespace, ignoreCase }) : null),
    [a, b, ignoreWhitespace, ignoreCase],
  );
  const unifiedRows = useMemo(() => (result ? toUnified(result.rows) : []), [result]);

  const goToHunk = (index: number) => {
    if (!result || result.hunks.length === 0) return;
    const wrapped = (index + result.hunks.length) % result.hunks.length;
    setHunk(wrapped);
    const row = result.hunks[wrapped];
    const target = scroller.current?.querySelector(`[data-row="${row}"]`);
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const exportPatch = async () => {
    if (!result || !a || !b) return;
    const patch = toPatch(result.rows, left.name, right.name, {
      left: endsWithNewline(a.text), right: endsWithNewline(b.text),
    });
    if (!patch) { setError("The files are identical, so there is no patch to write."); return; }
    const destination = await saveDialog({
      defaultPath: `${right.name}.patch`,
      filters: [{ name: "Patch", extensions: ["patch", "diff"] }],
    });
    if (!destination) return;
    try {
      await api.saveTextAs(null, destination, patch);
      setNotice(`Patch written to ${destination}`);
      window.setTimeout(() => setNotice(""), 4000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const sizeChange = right.size - left.size;

  return (
    <div className="diff-view">
      <header className="diff-head">
        <span className="settings-crumbs">
          <span>workspace</span><span>compare</span>
          <span className="current">{left.name} ⟷ {right.name}</span>
        </span>
        <span className="spacer" />
        <button className="icon-action labelled" onClick={close}><X size={13} /> Close</button>
      </header>

      <div className="diff-toolbar">
        <span className="segmented" role="group" aria-label="Layout">
          <button className={!unified ? "selected" : ""} aria-pressed={!unified} onClick={() => setUnified(false)}>
            <Columns2 size={12} /> Side by side
          </button>
          <button className={unified ? "selected" : ""} aria-pressed={unified} onClick={() => setUnified(true)}>
            <Rows3 size={12} /> Unified
          </button>
        </span>

        {result && (
          <span className="diff-stats">
            <em className="added">+{result.additions}</em>
            <em className="removed">−{result.deletions}</em>
            <em className="modified">~{result.modifications}</em>
          </span>
        )}

        <span className="toolbar-divider" />
        <label className="diff-toggle">
          <input type="checkbox" checked={ignoreWhitespace} onChange={(event) => setIgnoreWhitespace(event.target.checked)} />
          Ignore whitespace
        </label>
        <label className="diff-toggle">
          <input type="checkbox" checked={ignoreCase} onChange={(event) => setIgnoreCase(event.target.checked)} />
          Ignore case
        </label>

        <span className="spacer" />

        {result && result.hunks.length > 0 && (
          <span className="diff-nav">
            <button className="icon-action" aria-label="Previous change" onClick={() => goToHunk(hunk - 1)}><ArrowUp size={13} /></button>
            <b>{hunk + 1} of {result.hunks.length}</b>
            <button className="icon-action" aria-label="Next change" onClick={() => goToHunk(hunk + 1)}><ArrowDown size={13} /></button>
          </span>
        )}
        <button className="icon-action" aria-label="Swap sides" title="Swap sides" onClick={onSwap}><ArrowLeftRight size={13} /></button>
        <button className="icon-action labelled" disabled={!result || result.identical} onClick={() => void exportPatch()}>
          <Download size={12} /> Export patch
        </button>
      </div>

      <div className="diff-files">
        <FileHead label="Base" file={left} encoding={a?.encoding} delta={null} />
        <FileHead label="Target" file={right} encoding={b?.encoding} delta={sizeChange} />
      </div>

      {error && <div className="modal-error">{error}</div>}
      {notice && <div className="validation-error media-captured">{notice}</div>}
      {result?.truncated && (
        <div className="validation-error">Only the first 20,000 lines of each file were compared.</div>
      )}
      {result?.identical && (
        <div className="validation-error">
          These files are identical{ignoreWhitespace || ignoreCase ? " under the options selected" : ""}.
        </div>
      )}

      {!a || !b ? (
        <div className="center muted">Reading both files…</div>
      ) : (
        <div className="diff-scroll" ref={scroller}>
          {unified ? (
            <table className="diff-table unified">
              <tbody>
                {unifiedRows.map((row, index) => (
                  <tr key={index} className={row.kind}>
                    <td className="diff-num">{row.kind === "added" ? "" : row.number ?? ""}</td>
                    <td className="diff-num">{row.kind === "removed" ? "" : row.other ?? ""}</td>
                    <td className="diff-mark">{mark(row.kind)}</td>
                    <td className="diff-code">{row.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="diff-table split">
              <tbody>
                {result?.rows.map((row, index) => (
                  <tr key={index} data-row={index} className={row.kind}>
                    <td className="diff-num">{row.leftNumber ?? ""}</td>
                    <td className="diff-mark">{row.left === null ? "" : mark(row.kind === "added" ? "same" : row.kind)}</td>
                    <td className="diff-code">{row.left ?? ""}</td>
                    <td className="diff-num">{row.rightNumber ?? ""}</td>
                    <td className="diff-mark">{row.right === null ? "" : mark(row.kind === "removed" ? "same" : row.kind)}</td>
                    <td className="diff-code">{row.right ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="json-status">
        {result && <span>{result.rows.length.toLocaleString()} rows</span>}
        {result && <span>computed in {result.milliseconds.toFixed(1)} ms</span>}
        {a && b && <span>{a.encoding} / {b.encoding}</span>}
        <span className="spacer" />
        {result && <span>{result.hunks.length} change {result.hunks.length === 1 ? "block" : "blocks"}</span>}
      </div>
    </div>
  );
}

function mark(kind: RowKind): string {
  if (kind === "added") return "+";
  if (kind === "removed") return "−";
  if (kind === "modified") return "~";
  return "";
}

function FileHead({
  label, file, encoding, delta,
}: { label: string; file: FileDescriptor; encoding?: string; delta: number | null }) {
  return (
    <div className="diff-file">
      <span className="diff-slot-tag">{label === "Base" ? "A" : "B"}</span>
      <span className="diff-file-text">
        <strong title={file.path}>{file.name}</strong>
        <small>
          {formatBytes(file.size)}
          {delta !== null && delta !== 0 && ` (${delta > 0 ? "+" : "−"}${formatBytes(Math.abs(delta))})`}
          {encoding ? ` · ${encoding}` : ""}
          {file.modifiedMs ? ` · ${new Date(file.modifiedMs).toLocaleString()}` : ""}
        </small>
      </span>
    </div>
  );
}
