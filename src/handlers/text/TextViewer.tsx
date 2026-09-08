import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { save } from "@tauri-apps/plugin-dialog";
import type { Extension } from "@codemirror/state";
import type { ViewerProps } from "../../types/handlers";
import { api, AppError } from "../../services/tauri";
import { decodeBytes, readBytes } from "../../utils/file";
import { useSettings } from "../../stores/settings";
import { useWorkspace } from "../../stores/workspace";

const EDIT_LIMIT = 16 * 1024 * 1024;
const PREVIEW_LIMIT = 4 * 1024 * 1024;
const RICH_MARKDOWN_LIMIT = 2 * 1024 * 1024;
const MarkdownEditor = lazy(() => import("./MarkdownEditor"));

export default function TextViewer({ file, tabId, onDirtyChange, onStatusChange }: ViewerProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const richMarkdown = useRef("");
  const suppressSourceDirty = useRef(false);
  const wrapCompartment = useRef(new Compartment());
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<"source" | "rich">("source");
  const readonly = file.readonly || file.size > EDIT_LIMIT;
  const isMarkdown = file.extension?.toLowerCase() === "md";
  const richMarkdownDisabled = file.size > RICH_MARKDOWN_LIMIT;
  const [modified, setModified] = useState(file.modifiedMs);
  const [conflict, setConflict] = useState(false);
  const wrap = useSettings((state) => state.wordWrap);
  const setWrap = useSettings((state) => state.update);
  const replaceFile = useWorkspace((state) => state.replaceFile);

  useEffect(() => {
    let disposed = false;
    setLoaded(false);
    setMode("source");
    const max = readonly ? PREVIEW_LIMIT : EDIT_LIMIT;
    void Promise.all([readBytes(file.path, max), languageFor(file.extension)]).then(([bytes, language]) => {
      if (disposed || !host.current) return;
      const decoded = decodeBytes(bytes);
      richMarkdown.current = decoded.text;
      const extensions: Extension[] = [
        lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), history(), bracketMatching(), syntaxHighlighting(defaultHighlightStyle),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]), search(), language,
        EditorView.editable.of(!readonly), EditorState.readOnly.of(readonly), wrapCompartment.current.of(useSettings.getState().wordWrap ? EditorView.lineWrapping : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !suppressSourceDirty.current) onDirtyChange(true);
          if (update.selectionSet || update.docChanged) {
            const line = update.state.doc.lineAt(update.state.selection.main.head);
            onStatusChange(`${decoded.encoding.toUpperCase()} · Ln ${line.number}, Col ${update.state.selection.main.head - line.from + 1}${readonly ? " · Read only" : ""}`);
          }
        }),
      ];
      const state = EditorState.create({ doc: decoded.text, extensions });
      editor.current = new EditorView({ state, parent: host.current });
      setLoaded(true);
      onStatusChange(`${decoded.encoding.toUpperCase()}${readonly ? " · Read only preview" : ""}`);
    }).catch((reason) => setError(String(reason)));
    return () => { disposed = true; editor.current?.destroy(); editor.current = null; };
  }, [file.path, file.extension, onDirtyChange, onStatusChange, readonly]);

  useEffect(() => { if (editor.current) editor.current.dispatch({ effects: wrapCompartment.current.reconfigure(wrap ? EditorView.lineWrapping : []) }); }, [wrap]);

  const currentContent = () => mode === "rich" ? richMarkdown.current : (editor.current?.state.doc.toString() ?? richMarkdown.current);

  const syncSource = (content: string) => {
    if (!editor.current || editor.current.state.doc.toString() === content) return;
    suppressSourceDirty.current = true;
    editor.current.dispatch({ changes: { from: 0, to: editor.current.state.doc.length, insert: content } });
    suppressSourceDirty.current = false;
  };

  const showRichText = () => {
    richMarkdown.current = editor.current?.state.doc.toString() ?? richMarkdown.current;
    setMode("rich");
    onStatusChange(`Markdown · Rich text${readonly ? " · Read only" : ""}`);
  };

  const showSource = () => {
    syncSource(richMarkdown.current);
    setMode("source");
    onStatusChange(`Markdown source${readonly ? " · Read only" : ""}`);
  };

  const handleRichChange = useCallback((content: string) => {
    richMarkdown.current = content;
    onDirtyChange(true);
    onStatusChange("Markdown · Rich text · Modified");
  }, [onDirtyChange, onStatusChange]);

  useEffect(() => {
    const timer = window.setInterval(() => void api.metadata(file.path).then((latest) => {
      if (modified !== null && latest.modifiedMs !== modified) setConflict(true);
    }).catch(() => setError("The file was moved or deleted.")), 3000);
    return () => clearInterval(timer);
  }, [file.path, modified]);

  const saveCurrent = async () => {
    if (!editor.current || readonly) return;
    if (conflict && !window.confirm("This file changed outside OneOpen. Overwrite the external changes?")) return;
    try {
      const content = currentContent();
      const result = await api.saveText(file.path, content, conflict ? null : modified);
      syncSource(content);
      setModified(result.modifiedMs); setConflict(false); onDirtyChange(false);
    } catch (reason) {
      if (reason instanceof AppError && reason.code === "external_modification") setConflict(true);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const saveAs = async () => {
    if (!editor.current) return;
    const destination = await save({ defaultPath: file.name });
    if (!destination) return;
    try { const saved = await api.saveTextAs(file.path, destination, currentContent()); replaceFile(tabId, saved); onDirtyChange(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const goToLine = () => {
    const raw = window.prompt("Line number");
    const line = Number(raw);
    if (!editor.current || !Number.isInteger(line) || line < 1 || line > editor.current.state.doc.lines) return;
    const position = editor.current.state.doc.line(line).from;
    editor.current.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "center" }) });
    editor.current.focus();
  };

  return (
    <div className="viewer text-viewer" onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void saveCurrent(); } }}>
      <div className="viewer-toolbar">
        <button disabled={readonly} onClick={() => void saveCurrent()}>Save <kbd>Ctrl+S</kbd></button>
        <button onClick={() => void saveAs()}>Save as…</button>
        {isMarkdown && <button className={mode === "rich" ? "selected" : ""} disabled={!loaded || richMarkdownDisabled} title={richMarkdownDisabled ? "Rich-text mode is limited to Markdown files up to 2 MiB" : undefined} onClick={mode === "rich" ? showSource : showRichText}>{mode === "rich" ? "Markdown source" : "Rich text"}</button>}
        {mode === "source" && <button onClick={() => editor.current && openSearchPanel(editor.current)}>Find</button>}
        {mode === "source" && <button onClick={goToLine}>Go to line</button>}
        {mode === "source" && <label><input type="checkbox" checked={wrap} onChange={(event) => void setWrap({ wordWrap: event.target.checked })} /> Wrap</label>}
        <span className="spacer" />
        {conflict && <span className="warning">Changed externally</span>}
        {readonly && <span className="badge">Large file · read only</span>}
      </div>
      {error && <div className="error-state">{error}</div>}
      <div ref={host} className="editor-host" hidden={mode === "rich"} />
      {isMarkdown && mode === "rich" && <Suspense fallback={<div className="empty-state">Loading rich-text editor…</div>}><MarkdownEditor content={richMarkdown.current} editable={!readonly} onChange={handleRichChange} /></Suspense>}
    </div>
  );
}

async function languageFor(extension: string | null): Promise<Extension> {
  switch (extension) {
    case "js": case "jsx": case "ts": case "tsx": return (await import("@codemirror/lang-javascript")).javascript({ typescript: extension.startsWith("t"), jsx: extension.endsWith("x") });
    case "json": return (await import("@codemirror/lang-json")).json();
    case "xml": return (await import("@codemirror/lang-xml")).xml();
    case "md": return (await import("@codemirror/lang-markdown")).markdown();
    case "java": case "kt": case "kts": return (await import("@codemirror/lang-java")).java();
    case "py": return (await import("@codemirror/lang-python")).python();
    case "rs": return (await import("@codemirror/lang-rust")).rust();
    case "sql": return (await import("@codemirror/lang-sql")).sql();
    case "yaml": case "yml": return (await import("@codemirror/lang-yaml")).yaml();
    default: return [];
  }
}
