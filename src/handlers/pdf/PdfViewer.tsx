import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api, AppError } from "../../services/tauri";
import { useWorkspace } from "../../stores/workspace";
import type { ViewerProps } from "../../types/handlers";
import { readBytes } from "../../utils/file";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { buildEditedPdf, isDirty, EMPTY_EDITS, type ImageAnnotation, type PdfEdits, type TextAnnotation, type TextRun } from "./editing";
import { TextEditor } from "./TextEditor";
import { initialPlacement, loadImageForPdf } from "./images";
import { cssFor, plainText } from "./richText";
import {
  ArrowDown, ChevronLeft, ChevronRight, FileDown, FileMinus, FileText, ImagePlus, Info,
  List, Maximize2, MousePointer2, PanelLeft, Pencil, Printer, RotateCw, Save, Scaling, Search,
  Trash, Type, Undo2, ZoomIn, ZoomOut,
} from "lucide-react";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const PDF_LIMIT = 64 * 1024 * 1024;
const PDF_EDIT_LIMIT = 24 * 1024 * 1024;

interface DraftAnnotation {
  id: string | null;
  x: number;
  y: number;
  left: number;
  top: number;
  runs: TextRun[];
}

type Tool = "select" | "text" | "image";

interface PageViewport {
  width: number;
  height: number;
  scale: number;
  convertToPdfPoint(x: number, y: number): number[];
  convertToViewportPoint(x: number, y: number): number[];
}

interface OutlineEntry { title: string; page: number | null; depth: number }

export default function PdfViewer({ file, tabId, onDirtyChange, onStatusChange }: ViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pageViewportRef = useRef<PageViewport | null>(null);
  const suppressDraftBlur = useRef(false);
  const [document, setDocument] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [sourceBytes, setSourceBytes] = useState<Uint8Array | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1.15);
  const [fitWidth, setFitWidth] = useState(true);
  const [showPreviews, setShowPreviews] = useState(true);
  const [showOutline, setShowOutline] = useState(true);
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<number[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState("");
  const [showInfo, setShowInfo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [edits, setEdits] = useState<PdfEdits>(EMPTY_EDITS);
  const [history, setHistory] = useState<PdfEdits[]>([]);
  const [draft, setDraft] = useState<DraftAnnotation | null>(null);
  const [tool, setTool] = useState<Tool>("text");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renderVersion, setRenderVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const replaceFile = useWorkspace((state) => state.replaceFile);
  const dirty = isDirty(edits);
  const editDisabled = file.size > PDF_EDIT_LIMIT;
  const pageDeleted = edits.deletedPages.includes(page);

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  useEffect(() => { if (document) void readOutline(document).then(setOutline).catch(() => setOutline([])); }, [document]);

  useEffect(() => {
    let disposed = false;
    let task: pdfjs.PDFDocumentLoadingTask | null = null;
    if (file.size > PDF_LIMIT) { setError("PDF exceeds the safe preview limit. Open it with the system application."); return; }
    void readBytes(file.path, PDF_LIMIT).then((bytes) => {
      if (disposed) return;
      setSourceBytes(bytes);
      task = pdfjs.getDocument({ data: bytes.slice() });
      task.onPassword = (update: (password: string) => void, reason: number) => {
        const password = window.prompt(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? "Incorrect password. Try again:" : "PDF password:");
        if (password === null) { void task?.destroy(); setError("Password entry cancelled."); } else update(password);
      };
      return task.promise;
    }).then((loaded) => { if (loaded && !disposed) { setDocument(loaded); onStatusChange(`Page 1 of ${loaded.numPages}`); } }).catch((reason) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { disposed = true; void task?.destroy(); };
  }, [file.path, file.size, onStatusChange]);

  useEffect(() => {
    if (!document || !canvasRef.current) return;
    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;
    void document.getPage(page).then((pdfPage) => {
      if (cancelled || !canvasRef.current || !stageRef.current) return;
      const rotation = (pdfPage.rotate + (edits.rotations[page] ?? 0)) % 360;
      const initial = pdfPage.getViewport({ scale: 1, rotation });
      const available = Math.max(320, (viewportRef.current?.clientWidth ?? 800) - 40);
      const scale = fitWidth ? available / initial.width : zoom;
      const viewport = pdfPage.getViewport({ scale: scale * devicePixelRatio, rotation });
      pageViewportRef.current = viewport;
      const canvas = canvasRef.current;
      const cssWidth = viewport.width / devicePixelRatio;
      const cssHeight = viewport.height / devicePixelRatio;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      stageRef.current.style.width = `${cssWidth}px`;
      stageRef.current.style.height = `${cssHeight}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      renderTask = pdfPage.render({ canvas, canvasContext: context, viewport });
      return renderTask.promise;
    }).then(() => {
      if (!cancelled) {
        setRenderVersion((value) => value + 1);
        onStatusChange(`Page ${page} of ${document.numPages}${editMode ? " · Editing" : ""}`);
      }
    }).catch((reason) => { if ((reason as Error).name !== "RenderingCancelledException") setError(String(reason)); });
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [document, page, zoom, fitWidth, showPreviews, edits.rotations, editMode, onStatusChange]);

  const goToPage = (nextPage: number) => {
    setDraft(null);
    setPage(Math.max(1, Math.min(document?.numPages ?? 1, nextPage)));
    viewportRef.current?.scrollTo({ top: 0 });
  };

  const search = async () => {
    if (!document || !query.trim()) { setMatches([]); setSearchMessage(""); return; }
    setSearching(true);
    const found: number[] = [];
    try {
      const needle = query.trim().toLocaleLowerCase();
      for (let index = 1; index <= document.numPages; index++) {
        const content = await (await document.getPage(index)).getTextContent();
        const text = content.items.map((item) => "str" in item ? item.str : "").join(" ").toLocaleLowerCase();
        if (text.includes(needle)) found.push(index);
      }
      setMatches(found);
      setSearchMessage(found.length ? `${found.length} result${found.length === 1 ? "" : "s"}` : "No results");
      if (found[0]) goToPage(found[0]);
    } finally {
      setSearching(false);
    }
  };

  const nextMatch = () => {
    if (!matches.length) return;
    const next = matches.find((match) => match > page) ?? matches[0];
    goToPage(next);
  };

  const updateEdits = (update: (current: PdfEdits) => PdfEdits) => {
    const next = update(edits);
    if (next === edits) return;
    setHistory((items) => [...items, edits].slice(-50));
    setEdits(next);
  };

  const undo = () => {
    const previous = history.at(-1);
    if (previous) setEdits(previous);
    setHistory((items) => items.slice(0, -1));
    setDraft(null);
  };

  const rotatePage = () => updateEdits((current) => {
    const rotations = { ...current.rotations };
    const rotation = ((rotations[page] ?? 0) + 90) % 360;
    if (rotation === 0) delete rotations[page]; else rotations[page] = rotation;
    return { ...current, rotations };
  });

  const toggleDeletePage = () => updateEdits((current) => {
    const deleted = current.deletedPages.includes(page);
    if (!deleted && current.deletedPages.length >= (document?.numPages ?? 1) - 1) return current;
    return { ...current, deletedPages: deleted ? current.deletedPages.filter((value) => value !== page) : [...current.deletedPages, page] };
  });

  const cssScale = () => (pageViewportRef.current?.scale ?? devicePixelRatio) / devicePixelRatio;

  const toPdfPoint = (event: { clientX: number; clientY: number }) => {
    if (!pageViewportRef.current || !stageRef.current) return null;
    const bounds = stageRef.current.getBoundingClientRect();
    const left = event.clientX - bounds.left;
    const top = event.clientY - bounds.top;
    const [x, y] = pageViewportRef.current.convertToPdfPoint(left * devicePixelRatio, top * devicePixelRatio);
    return { x, y, left, top };
  };

  const beginAnnotation = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!editMode || pageDeleted || tool !== "text" || draft) return;
    const point = toPdfPoint(event);
    if (!point) return;
    setSelected(null);
    setDraft({ id: null, ...point, runs: [] });
  };

  const editAnnotation = (annotation: TextAnnotation) => {
    if (!editMode || !pageViewportRef.current) return;
    const [left, top] = pageViewportRef.current.convertToViewportPoint(annotation.x, annotation.y);
    setSelected(null);
    setDraft({
      id: annotation.id,
      x: annotation.x,
      y: annotation.y,
      left: left / devicePixelRatio,
      top: top / devicePixelRatio,
      runs: annotation.runs,
    });
  };

  const commitDraft = (runs: TextRun[]) => {
    const current = draft;
    setDraft(null);
    if (!current) return;
    const meaningful = runs.filter((run) => run.text.trim() !== "" || run.text.includes("\n"));
    if (meaningful.length === 0) {
      if (current.id) updateEdits((state) => ({ ...state, annotations: state.annotations.filter((item) => item.id !== current.id) }));
      return;
    }
    updateEdits((state) => {
      if (current.id) {
        return { ...state, annotations: state.annotations.map((item) => (item.id === current.id ? { ...item, runs } : item)) };
      }
      const annotation: TextAnnotation = { id: crypto.randomUUID(), page, x: current.x, y: current.y, runs };
      return { ...state, annotations: [...state.annotations, annotation] };
    });
  };

  const cancelDraft = () => {
    suppressDraftBlur.current = true;
    setDraft(null);
    queueMicrotask(() => { suppressDraftBlur.current = false; });
  };

  const addImage = async () => {
    if (!pageViewportRef.current || busy) return;
    const chosen = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] }],
    });
    if (!chosen || Array.isArray(chosen)) return;
    setBusy(true);
    setError(null);
    try {
      const descriptor = await api.metadata(chosen);
      const loaded = await loadImageForPdf(descriptor.path, descriptor.extension, descriptor.mimeType);
      const viewport = pageViewportRef.current;
      const [pageWidth, pageHeight] = viewport.convertToPdfPoint(viewport.width, 0);
      const size = initialPlacement(loaded, Math.abs(pageWidth) || 612, Math.abs(pageHeight) || 792);
      const image: ImageAnnotation = {
        id: crypto.randomUUID(),
        page,
        x: 72,
        y: Math.abs(pageHeight) - 72,
        width: size.width,
        height: size.height,
        format: loaded.format,
        dataBase64: loaded.dataBase64,
      };
      updateEdits((state) => ({ ...state, images: [...state.images, image] }));
      setSelected(image.id);
      setTool("select");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const removeSelected = () => {
    if (!selected) return;
    updateEdits((state) => ({
      ...state,
      annotations: state.annotations.filter((item) => item.id !== selected),
      images: state.images.filter((item) => item.id !== selected),
    }));
    setSelected(null);
  };

  /** Drags move an item; the corner handle resizes an image instead. */
  const beginDrag = (id: string, mode: "move" | "resize", event: React.MouseEvent) => {
    if (!editMode) return;
    event.preventDefault();
    event.stopPropagation();
    setSelected(id);
    const scale = cssScale();
    const startX = event.clientX;
    const startY = event.clientY;
    const annotation = edits.annotations.find((item) => item.id === id);
    const image = edits.images.find((item) => item.id === id);
    const origin = annotation ?? image;
    if (!origin) return;
    const base = { x: origin.x, y: origin.y, width: image?.width ?? 0, height: image?.height ?? 0 };
    let moved = false;

    const onMove = (moveEvent: MouseEvent) => {
      const dx = (moveEvent.clientX - startX) / scale;
      const dy = (moveEvent.clientY - startY) / scale;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 1) return;
      moved = true;
      setEdits((state) => {
        if (mode === "resize" && image) {
          const ratio = base.height / Math.max(1, base.width);
          const width = Math.max(12, base.width + dx);
          return { ...state, images: state.images.map((item) => (item.id === id ? { ...item, width, height: Math.max(12, width * ratio) } : item)) };
        }
        if (annotation) {
          return { ...state, annotations: state.annotations.map((item) => (item.id === id ? { ...item, x: base.x + dx, y: base.y - dy } : item)) };
        }
        return { ...state, images: state.images.map((item) => (item.id === id ? { ...item, x: base.x + dx, y: base.y - dy } : item)) };
      });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (moved) setHistory((items) => [...items, edits].slice(-50));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const saveEdits = async (saveAs: boolean) => {
    if (!sourceBytes || !dirty || saving) return;
    let destination: string | null = file.path;
    if (saveAs) destination = await save({ defaultPath: file.name, filters: [{ name: "PDF document", extensions: ["pdf"] }] });
    if (!destination) return;
    setSaving(true);
    setError(null);
    try {
      const content = await buildEditedPdf(sourceBytes, edits);
      const contentBase64 = await bytesToBase64(content);
      let saved;
      if (saveAs) {
        saved = await api.savePdfAs(file.path, destination, contentBase64);
      } else {
        try {
          saved = await api.savePdf(file.path, contentBase64, file.modifiedMs);
        } catch (reason) {
          if (!(reason instanceof AppError) || reason.code !== "external_modification" || !window.confirm("This PDF changed outside OneOpen. Overwrite the external changes?")) throw reason;
          saved = await api.savePdf(file.path, contentBase64, null);
        }
      }
      onDirtyChange(false);
      replaceFile(tabId, saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="viewer pdf-viewer" onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && editMode) { event.preventDefault(); void saveEdits(false); } }}>
      <div className="viewer-toolbar pdf-toolbar">
        <button className="icon-action" title={showPreviews ? "Hide page previews" : "Show page previews"} aria-label={showPreviews ? "Hide previews" : "Show previews"} aria-pressed={showPreviews} onClick={() => setShowPreviews((value) => !value)}><PanelLeft size={15} /></button>
        <button className="icon-action" title="Previous page" aria-label="Previous" disabled={page <= 1} onClick={() => goToPage(page - 1)}><ChevronLeft size={16} /></button>
        <label className="pdf-page-control"><input className="page-input" type="number" min={1} max={document?.numPages ?? 1} value={page} onChange={(event) => goToPage(Number(event.target.value))} /> / {document?.numPages ?? "–"}</label>
        <button className="icon-action" title="Next page" aria-label="Next" disabled={!document || page >= document.numPages} onClick={() => goToPage(page + 1)}><ChevronRight size={16} /></button>
        <button className="icon-action" title="Zoom out" aria-label="Zoom out" onClick={() => { setFitWidth(false); setZoom((value) => Math.max(.25, value - .15)); }}><ZoomOut size={15} /></button>
        <span className="pdf-zoom">{Math.round(zoom * 100)}%</span>
        <button className="icon-action" title="Zoom in" aria-label="Zoom in" onClick={() => { setFitWidth(false); setZoom((value) => Math.min(4, value + .15)); }}><ZoomIn size={15} /></button>
        <button className={`icon-action ${fitWidth ? "selected" : ""}`} title="Fit width" aria-label="Fit Width" aria-pressed={fitWidth} onClick={() => setFitWidth(true)}><Scaling size={15} /></button>
        <button className="icon-action" title="Fit page" aria-label="Fit Page" onClick={() => { setFitWidth(false); setZoom(.85); }}><Maximize2 size={15} /></button>
        <button className={`icon-action labelled ${editMode ? "selected" : ""}`} aria-label={editMode ? "Done editing" : "Edit PDF"} aria-pressed={editMode} disabled={!document || !sourceBytes || editDisabled} title={editDisabled ? "PDF editing is limited to files up to 24 MiB" : editMode ? "Leave edit mode" : "Edit this PDF"} onClick={() => { setEditMode((value) => !value); setDraft(null); }}><Pencil size={15} /> {editMode ? "Done" : "Edit"}</button>
        <span className="spacer" />
        <input placeholder="Search PDF" value={query} onChange={(event) => { setQuery(event.target.value); setSearchMessage(""); }} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} />
        <button className="icon-action" title="Search this PDF" aria-label="Search PDF" disabled={searching} onClick={() => void search()}><Search size={15} /></button>
        <button className="icon-action" title="Next match" aria-label="Next search result" disabled={!matches.length} onClick={nextMatch}><ArrowDown size={15} /></button>
        <span className="pdf-results">{searchMessage}</span>
        <button className="icon-action" title="Document outline" aria-label="Outline" aria-pressed={showOutline} onClick={() => setShowOutline((value) => !value)}><List size={15} /></button>
        <button className="icon-action" title="Print" aria-label="Print" onClick={() => void api.printFile(file.path).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))}><Printer size={15} /></button>
        <button className="icon-action" title="File information" aria-label="File information" aria-pressed={showInfo} onClick={() => setShowInfo((value) => !value)}><Info size={15} /></button>
      </div>
      <div className="pdf-document-bar"><strong><FileText size={13} /> {file.name}</strong><span>• PDF document</span><span className="spacer" /><span className="pdf-secure">✓ Local document</span><span>{formatBytes(file.size)}</span></div>
      {showInfo && <div className="pdf-file-info"><button className="icon-button" onClick={() => setShowInfo(false)}>×</button><div><small>FILE</small><strong>{file.name}</strong></div><div><small>SIZE</small><strong>{formatBytes(file.size)}</strong></div><div><small>PAGES</small><strong>{document?.numPages ?? "–"}</strong></div><div><small>TYPE</small><strong>{file.mimeType ?? "application/pdf"}</strong></div><div className="pdf-info-path"><small>PATH</small><strong title={file.path}>{file.path}</strong></div></div>}
      {editMode && <div className="viewer-toolbar pdf-edit-toolbar">
        <button className={`icon-action ${tool === "text" ? "selected" : ""}`} title="Add text" aria-label="Text tool" aria-pressed={tool === "text"} onClick={() => { setTool("text"); setSelected(null); }}><Type size={15} /></button>
        <button className={`icon-action ${tool === "select" ? "selected" : ""}`} title="Select and move" aria-label="Select tool" aria-pressed={tool === "select"} onClick={() => { setTool("select"); setDraft(null); }}><MousePointer2 size={15} /></button>
        <button className="icon-action" title="Add image" aria-label="Add image" disabled={busy || pageDeleted} onClick={() => void addImage()}><ImagePlus size={15} /></button>
        <button className="icon-action" title="Delete selected item" aria-label="Delete item" disabled={!selected} onClick={removeSelected}><Trash size={15} /></button>
        <span className="toolbar-divider" />
        <button className="icon-action" title="Rotate page" aria-label="Rotate page" onClick={rotatePage}><RotateCw size={15} /></button>
        <button className={`icon-action ${pageDeleted ? "selected" : ""}`} title={pageDeleted ? "Keep this page" : "Delete this page"} aria-label={pageDeleted ? "Keep page" : "Delete page"} onClick={toggleDeletePage}><FileMinus size={15} /></button>
        <button className="icon-action" title="Undo" aria-label="Undo" disabled={!history.length} onClick={undo}><Undo2 size={15} /></button>
        <span className="small muted">{tool === "text" ? "Click the page to add text" : "Drag to move, corner to resize"}</span>
        <span className="spacer" />
        <button className="icon-action labelled" title="Save" aria-label="Save" disabled={!dirty || saving || file.readonly} onClick={() => void saveEdits(false)}><Save size={15} /> {saving ? "Saving…" : "Save"}</button>
        <button className="icon-action" title="Save as a new file" aria-label="Save as…" disabled={!dirty || saving} onClick={() => void saveEdits(true)}><FileDown size={15} /></button>
        {file.readonly && <span className="badge">Save as only</span>}
      </div>}
      {error && <div className="error-state">{error}</div>}
      <div className="pdf-content">
        {document && showPreviews && <PdfPreviews document={document} activePage={page} deletedPages={edits.deletedPages} rotations={edits.rotations} onSelect={goToPage} onClose={() => setShowPreviews(false)} />}
        <div className="pdf-scroll" ref={viewportRef}>
          <div className={`pdf-page-stage ${pageDeleted ? "deleted" : ""}`} ref={stageRef}>
            <canvas ref={canvasRef} />
            {pageDeleted && <div className="pdf-deleted-overlay">Page marked for deletion</div>}
            {edits.images.filter((image) => image.page === page).map((image) => (
              <ImagePreview
                key={`${image.id}-${renderVersion}`}
                image={image}
                viewport={pageViewportRef.current}
                editable={editMode && !pageDeleted}
                selected={selected === image.id}
                onGrab={beginDrag}
              />
            ))}
            {edits.annotations.filter((annotation) => annotation.page === page && annotation.id !== draft?.id).map((annotation) => (
              <AnnotationPreview
                key={`${annotation.id}-${renderVersion}`}
                annotation={annotation}
                viewport={pageViewportRef.current}
                editable={editMode && !pageDeleted}
                selected={selected === annotation.id}
                onGrab={beginDrag}
                onEdit={editAnnotation}
              />
            ))}
            {editMode && !pageDeleted && <div className={`pdf-edit-layer ${tool === "text" ? "placing" : ""}`} aria-label="PDF text annotation area" onClick={(event) => { if (event.target === event.currentTarget) { setSelected(null); beginAnnotation(event); } }}>
              {draft && (
                <TextEditor
                  initial={draft.runs}
                  left={draft.left}
                  top={draft.top}
                  scale={cssScale()}
                  onCommit={commitDraft}
                  onCancel={cancelDraft}
                />
              )}
            </div>}
          </div>
        </div>
        {document && showOutline && <PdfOutline entries={outline} activePage={page} onSelect={goToPage} onClose={() => setShowOutline(false)} />}
      </div>
    </div>
  );
}

function PdfOutline({ entries, activePage, onSelect, onClose }: { entries: OutlineEntry[]; activePage: number; onSelect: (page: number) => void; onClose: () => void }) {
  return <aside className="pdf-outline" aria-label="PDF document outline"><header><strong>▥ Document Outline</strong><button className="icon-button" aria-label="Close document outline" onClick={onClose}>×</button></header><div className="pdf-outline-list">{entries.map((entry, index) => <button key={`${entry.title}-${index}`} className={entry.page === activePage ? "active" : ""} style={{ paddingLeft: 10 + entry.depth * 12 }} disabled={!entry.page} onClick={() => entry.page && onSelect(entry.page)}><span>▧ {entry.title}</span><small>{entry.page ?? "–"}</small></button>)}{!entries.length && <p>No document outline</p>}</div></aside>;
}

async function readOutline(document: pdfjs.PDFDocumentProxy): Promise<OutlineEntry[]> {
  const source = await document.getOutline();
  const result: OutlineEntry[] = [];
  const visit = async (items: Awaited<ReturnType<pdfjs.PDFDocumentProxy["getOutline"]>>, depth: number) => {
    for (const item of items ?? []) {
      let destination = item.dest;
      if (typeof destination === "string") destination = await document.getDestination(destination);
      let page: number | null = null;
      if (Array.isArray(destination) && destination[0]) page = (await document.getPageIndex(destination[0])) + 1;
      result.push({ title: item.title || "Untitled section", page, depth });
      await visit(item.items, depth + 1);
    }
  };
  await visit(source, 0);
  if (!result.length) {
    for (let page = 1; page <= document.numPages; page++) result.push({ title: `Page ${page}`, page, depth: 0 });
  }
  return result;
}

function formatBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }

function AnnotationPreview({ annotation, viewport, editable, selected, onGrab, onEdit }: {
  annotation: TextAnnotation;
  viewport: PageViewport | null;
  editable: boolean;
  selected: boolean;
  onGrab: (id: string, mode: "move" | "resize", event: React.MouseEvent) => void;
  onEdit: (annotation: TextAnnotation) => void;
}) {
  if (!viewport) return null;
  const [left, top] = viewport.convertToViewportPoint(annotation.x, annotation.y);
  const scale = viewport.scale / devicePixelRatio;
  return (
    <div
      className={`pdf-annotation-preview ${editable ? "editable" : ""} ${selected ? "selected" : ""}`}
      style={{ left: left / devicePixelRatio, top: top / devicePixelRatio, transform: `scale(${scale})`, transformOrigin: "top left" }}
      title={editable ? "Drag to move, double-click to edit" : plainText(annotation.runs)}
      onMouseDown={(event) => { if (editable) onGrab(annotation.id, "move", event); }}
      onDoubleClick={(event) => { if (editable) { event.stopPropagation(); onEdit(annotation); } }}
    >
      {annotation.runs.map((run, index) => (
        <span key={index} style={inlineStyle(run)}>{run.text}</span>
      ))}
    </div>
  );
}

function ImagePreview({ image, viewport, editable, selected, onGrab }: {
  image: ImageAnnotation;
  viewport: PageViewport | null;
  editable: boolean;
  selected: boolean;
  onGrab: (id: string, mode: "move" | "resize", event: React.MouseEvent) => void;
}) {
  if (!viewport) return null;
  const [left, top] = viewport.convertToViewportPoint(image.x, image.y);
  const scale = viewport.scale / devicePixelRatio;
  return (
    <div
      className={`pdf-image-preview ${editable ? "editable" : ""} ${selected ? "selected" : ""}`}
      style={{
        left: left / devicePixelRatio,
        top: top / devicePixelRatio,
        width: image.width * scale,
        height: image.height * scale,
      }}
      onMouseDown={(event) => { if (editable) onGrab(image.id, "move", event); }}
    >
      <img src={`data:image/${image.format};base64,${image.dataBase64}`} alt="" draggable={false} />
      {editable && selected && (
        <span
          className="pdf-image-handle"
          role="presentation"
          onMouseDown={(event) => onGrab(image.id, "resize", event)}
        />
      )}
    </div>
  );
}

function inlineStyle(run: TextRun): React.CSSProperties {
  const result: Record<string, string> = {};
  for (const declaration of cssFor(run).split(";")) {
    const [property, value] = declaration.split(":");
    if (!property || !value) continue;
    result[property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  return { ...result, whiteSpace: "pre-wrap" } as React.CSSProperties;
}

function PdfPreviews({ document, activePage, deletedPages, rotations, onSelect, onClose }: { document: pdfjs.PDFDocumentProxy; activePage: number; deletedPages: number[]; rotations: Record<number, number>; onSelect: (page: number) => void; onClose: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: document.numPages, getScrollElement: () => scrollRef.current, estimateSize: () => 190, overscan: 3 });

  useEffect(() => { virtualizer.scrollToIndex(activePage - 1, { align: "auto" }); }, [activePage, virtualizer]);

  return (
    <aside className="pdf-previews" aria-label="PDF page previews">
      <div className="pdf-previews-header"><strong>▣ Pages ({document.numPages})</strong><span>Thumbnails</span><button className="icon-button" aria-label="Close page previews" onClick={onClose}>×</button></div>
      <div className="pdf-previews-scroll" ref={scrollRef}>
        <div className="pdf-previews-virtual" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const pageNumber = item.index + 1;
            return (
              <div className="pdf-preview-row" key={pageNumber} style={{ transform: `translateY(${item.start}px)` }}>
                <PdfPreview document={document} pageNumber={pageNumber} active={pageNumber === activePage} deleted={deletedPages.includes(pageNumber)} rotation={rotations[pageNumber] ?? 0} onSelect={onSelect} />
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

function PdfPreview({ document, pageNumber, active, deleted, rotation, onSelect }: { document: pdfjs.PDFDocumentProxy; pageNumber: number; active: boolean; deleted: boolean; rotation: number; onSelect: (page: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;
    void document.getPage(pageNumber).then((page) => {
      if (cancelled || !canvasRef.current) return;
      const combinedRotation = (page.rotate + rotation) % 360;
      const natural = page.getViewport({ scale: 1, rotation: combinedRotation });
      const viewport = page.getViewport({ scale: (126 / natural.width) * devicePixelRatio, rotation: combinedRotation });
      const canvas = canvasRef.current;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width / devicePixelRatio}px`;
      canvas.style.height = `${viewport.height / devicePixelRatio}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      renderTask = page.render({ canvas, canvasContext: context, viewport });
      return renderTask.promise;
    }).catch((reason) => { if ((reason as Error).name !== "RenderingCancelledException") console.error("PDF preview render failed", (reason as Error).message); });
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [document, pageNumber, rotation]);

  return <button className={`pdf-preview ${active ? "active" : ""} ${deleted ? "deleted" : ""}`} aria-label={`Open page ${pageNumber}`} aria-current={active ? "page" : undefined} onClick={() => onSelect(pageNumber)}><canvas ref={canvasRef} /><span>{pageNumber}{deleted ? " · deleted" : ""}</span></button>;
}

function bytesToBase64(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not encode the edited PDF"));
    reader.onload = () => resolve(String(reader.result).replace(/^data:.*?;base64,/, ""));
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    reader.readAsDataURL(new Blob([copy.buffer]));
  });
}
