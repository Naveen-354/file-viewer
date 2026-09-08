import { useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle, ArrowLeftRight, FileInput, FolderOpen, GitCompare, X,
} from "lucide-react";
import { api } from "../services/tauri";
import type { FileDescriptor } from "../types/files";
import { useWorkspace } from "../stores/workspace";
import { checkPair, openFileChoices, sizeDelta, type Slot } from "../utils/diff";
import { formatBytes } from "../utils/fileKind";

export interface DiffSelection { a: FileDescriptor | null; b: FileDescriptor | null }

export function DiffCompare({
  selection, onSelect, onSwap, onCompare, close,
}: {
  selection: DiffSelection;
  onSelect: (slot: Slot, file: FileDescriptor | null) => void;
  onSwap: () => void;
  onCompare: () => void;
  close: () => void;
}) {
  const tabs = useWorkspace((state) => state.tabs);
  const [error, setError] = useState("");

  const check = useMemo(() => checkPair(selection.a, selection.b), [selection]);
  const suggestions = useMemo(
    () => openFileChoices(tabs.map((tab) => tab.file), [selection.a, selection.b]),
    [tabs, selection],
  );
  const delta = selection.a && selection.b ? sizeDelta(selection.a, selection.b) : null;

  const browse = async (slot: Slot) => {
    setError("");
    const picked = await openDialog({ multiple: false, directory: false });
    if (typeof picked !== "string") return;
    try {
      onSelect(slot, await api.detectFile(picked));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="diff-setup">
      <header className="diff-head">
        <span className="settings-crumbs">
          <span>workspace</span><span>compare</span><span className="current">setup</span>
        </span>
        <span className="spacer" />
        <button className="icon-action labelled" onClick={close}><X size={13} /> Close</button>
      </header>

      <div className="diff-body">
        <div className="diff-intro">
          <GitCompare size={20} />
          <div>
            <h1>Compare two files</h1>
            <p>Choose a base and a target. Both must be text — code, SQL, JSON, XML or delimited data.</p>
          </div>
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="diff-slots">
          <Buffer
            slot="a" label="Base" hint="The original to compare against"
            file={selection.a} suggestions={suggestions}
            onBrowse={() => void browse("a")} onPick={(file) => onSelect("a", file)}
            onClear={() => onSelect("a", null)}
          />

          <button
            className="diff-swap"
            title="Swap the two sides"
            aria-label="Swap the two sides"
            disabled={!selection.a && !selection.b}
            onClick={onSwap}
          >
            <ArrowLeftRight size={14} />
            <em>vs</em>
          </button>

          <Buffer
            slot="b" label="Target" hint="The changed version"
            file={selection.b} suggestions={suggestions}
            onBrowse={() => void browse("b")} onPick={(file) => onSelect("b", file)}
            onClear={() => onSelect("b", null)}
          />
        </div>

        {check.problem && (
          <div className="diff-verdict problem"><AlertTriangle size={13} /> {check.problem}</div>
        )}
        {check.warning && (
          <div className="diff-verdict warning"><AlertTriangle size={13} /> {check.warning}</div>
        )}
        {check.ready && delta && (
          <div className="diff-verdict ready">
            <span>Ready to compare.</span>
            <em>
              {delta.direction === "same"
                ? "Both files are the same size."
                : `The target ${delta.direction} by ${formatBytes(Math.abs(delta.bytes))}${
                    delta.percent === null ? "" : ` (${delta.percent > 0 ? "+" : ""}${delta.percent.toFixed(1)}%)`
                  }.`}
            </em>
          </div>
        )}

        <div className="diff-actions">
          <button className="primary" disabled={!check.ready} onClick={onCompare}>
            Compare
          </button>
          {!check.ready && !check.problem && (
            <p className="muted small">Choose a file on each side to compare them.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Buffer({
  slot, label, hint, file, suggestions, onBrowse, onPick, onClear,
}: {
  slot: Slot;
  label: string;
  hint: string;
  file: FileDescriptor | null;
  suggestions: FileDescriptor[];
  onBrowse: () => void;
  onPick: (file: FileDescriptor) => void;
  onClear: () => void;
}) {
  return (
    <section className={`diff-slot ${file ? "filled" : ""}`} aria-label={`${label} file`}>
      <header>
        <span className="diff-slot-tag">{slot.toUpperCase()}</span>
        <span><strong>{label}</strong><small>{hint}</small></span>
        {file && (
          <button className="icon-button" aria-label={`Clear the ${label.toLowerCase()} file`} onClick={onClear}><X size={13} /></button>
        )}
      </header>

      {file ? (
        <dl className="engine-facts wide">
          <div><dt>File</dt><dd>{file.name}</dd></div>
          <div><dt>Path</dt><dd>{file.path}</dd></div>
          <div><dt>Type</dt><dd>{file.detectedType} · {formatBytes(file.size)}</dd></div>
        </dl>
      ) : (
        <div className="diff-drop">
          <FileInput size={22} />
          <strong>Drop a file here</strong>
          <small>Or choose one below. Dropping onto this pane fills it directly.</small>
        </div>
      )}

      <div className="diff-slot-actions">
        <button className="icon-action labelled" onClick={onBrowse}><FolderOpen size={12} /> Browse…</button>
        {suggestions.length > 0 && (
          <span className="diff-suggestions">
            <em>Open now:</em>
            {suggestions.slice(0, 3).map((candidate) => (
              <button key={candidate.path} className="diff-chip" title={candidate.path} onClick={() => onPick(candidate)}>
                {candidate.name}
              </button>
            ))}
          </span>
        )}
      </div>
    </section>
  );
}
