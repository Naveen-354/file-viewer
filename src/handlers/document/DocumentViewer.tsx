import { Fragment, createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle, Contrast, Download, FileText, Info, List, Lock, Minus, Package,
  PanelLeft, Plus, Printer, Search, ShieldCheck, Signature, Type, Unlock,
} from "lucide-react";
import type { ViewerProps } from "../../types/handlers";
import type { DocumentBlock, DocumentContent, DocumentProperties, DocumentRun } from "../../types/files";
import { api } from "../../services/tauri";
import { formatBytes } from "../../utils/file";
import {
  densityOf, documentText, formatDocDate, formatEditTime, outlineOf, withMarkers,
  type DocumentDensity, type MarkedBlock,
} from "../../utils/document";

const ZOOM_STEPS = [0.75, 0.9, 1, 1.15, 1.35, 1.6];
const LAYOUTS = [
  { id: "page", label: "Page Layout" },
  { id: "web", label: "Web Layout" },
  { id: "outline", label: "Outline" },
] as const;
type Layout = (typeof LAYOUTS)[number]["id"];

const TABS = [
  { id: "metadata", label: "Metadata" },
  { id: "fonts", label: "Fonts" },
  { id: "parts", label: "Parts" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** The slices of the composition ring, in the order they are drawn. */
const SLICES = [
  { key: "headings", label: "Headings", colour: "#8292ff" },
  { key: "paragraphs", label: "Paragraphs", colour: "#42d392" },
  { key: "listItems", label: "List items", colour: "#f8c66d" },
  { key: "tables", label: "Tables", colour: "#fb7185" },
  { key: "emptyParagraphs", label: "Spacers", colour: "#6b7280" },
] as const;

export default function DocumentViewer({ file, onStatusChange }: ViewerProps) {
  const [content, setContent] = useState<DocumentContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<Layout>("page");
  const [inverted, setInverted] = useState(false);
  const [index, setIndex] = useState(true);
  const [inspector, setInspector] = useState(true);
  const [tab, setTab] = useState<Tab>("metadata");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    api.readDocument(file.path)
      .then((result) => {
        if (cancelled) return;
        setContent(result);
        onStatusChange(`${result.wordCount.toLocaleString()} words · ${result.blocks.length.toLocaleString()} blocks`);
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [file.path, onStatusChange]);

  const marked = useMemo(() => withMarkers(content?.blocks ?? []), [content]);
  const blocks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const numbered = marked.map((entry, position) => ({ ...entry, position }));
    if (!needle) return numbered;
    return numbered.filter((entry) => blockText(entry.block).toLowerCase().includes(needle));
  }, [marked, query]);

  const outline = useMemo(() => outlineOf(content?.blocks ?? []), [content]);
  const density = useMemo(() => densityOf(content?.blocks ?? []), [content]);
  const properties = content?.properties ?? null;

  const jumpTo = useCallback((blockIndex: number) => {
    const target = scrollRef.current?.querySelector(`[data-block="${blockIndex}"]`);
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  const exportText = async () => {
    if (!content) return;
    const destination = await saveDialog({
      defaultPath: `${file.name.replace(/\.[^.]+$/, "")}.txt`,
      filters: [{ name: "Plain text", extensions: ["txt"] }],
    });
    if (!destination) return;
    try {
      await api.saveTextAs(null, destination, documentText(content.blocks));
      setNotice(`Text exported to ${destination}`);
      window.setTimeout(() => setNotice(null), 4000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  if (error) {
    return (
      <div className="viewer document-viewer">
        <div className="error-state">
          <p>{error}</p>
          <button className="secondary" onClick={() => void api.openSystem(file.path)}>Open in the default app</button>
        </div>
      </div>
    );
  }

  const revisions = content ? content.insertions + content.deletions : 0;

  return (
    <div className="viewer document-viewer doc-studio">
      <div className="viewer-toolbar doc-bar">
        <span className="json-file"><FileText size={13} /> {file.name}</span>
        <em className="json-type">OOXML DOCX</em>
        <span className="doc-badge">{formatBytes(file.size)}</span>
        {properties?.pages != null && <span className="doc-badge">{properties.pages.toLocaleString()} pages</span>}
        {content && <span className="doc-badge">{content.wordCount.toLocaleString()} words</span>}
        <span className="toolbar-divider" />
        <span className="segmented">
          {LAYOUTS.map((option) => (
            <button key={option.id} className={layout === option.id ? "selected" : ""} aria-pressed={layout === option.id} onClick={() => setLayout(option.id)}>{option.label}</button>
          ))}
        </span>
        <span className="spacer" />
        <button className="icon-action" aria-label="Zoom out" title="Zoom out" disabled={zoom <= ZOOM_STEPS[0]} onClick={() => setZoom(step(zoom, -1))}><Minus size={14} /></button>
        <span className="doc-zoom">{Math.round(zoom * 100)}%</span>
        <button className="icon-action" aria-label="Zoom in" title="Zoom in" disabled={zoom >= ZOOM_STEPS.at(-1)!} onClick={() => setZoom(step(zoom, 1))}><Plus size={14} /></button>
        <button className={`icon-action ${inverted ? "selected" : ""}`} aria-label="Invert page" aria-pressed={inverted} title="Invert the page for dark reading" onClick={() => setInverted((value) => !value)}><Contrast size={14} /></button>
        <button className="icon-action" aria-label="Print" title="Print" onClick={() => void api.printFile(file.path).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))}><Printer size={14} /></button>
        <button className="icon-action" aria-label="Export the document text" title="Export the document text" onClick={() => void exportText()}><Download size={14} /></button>
        <span className="toolbar-divider" />
        <button className={`icon-action ${index ? "selected" : ""}`} aria-label="Toggle headings index" aria-pressed={index} title="Headings index" onClick={() => setIndex((value) => !value)}><PanelLeft size={14} /></button>
        <button className={`icon-action labelled ${inspector ? "selected" : ""}`} aria-label="Toggle document inspector" aria-pressed={inspector} onClick={() => setInspector((value) => !value)}><Info size={13} /> Inspector</button>
      </div>

      <div className="viewer-toolbar doc-subbar">
        <label className="doc-find"><Search size={12} />
          <input placeholder="Find in document" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        {query.trim() !== "" && <span className="small muted">{blocks.length.toLocaleString()} of {marked.length.toLocaleString()} blocks match</span>}
        <span className="spacer" />
        {properties?.trackChanges && <span className="doc-badge warn">Track changes on</span>}
        {revisions > 0 && (
          <span className="doc-badge">{content!.insertions.toLocaleString()} insertions · {content!.deletions.toLocaleString()} deletions</span>
        )}
      </div>

      {content?.truncated && <div className="validation-error">Safety limit reached. Showing the first {content.blocks.length.toLocaleString()} blocks of the document.</div>}
      {notice && <div className="validation-error media-captured">{notice}</div>}
      {!content && <div className="center muted">Reading document…</div>}

      {content && (
        <div className="doc-body">
          {index && (
            <nav className="doc-index" aria-label="Headings index">
              <h3><List size={11} /> Outline</h3>
              {outline.length === 0 && <p className="muted small">This document has no headings.</p>}
              {outline.map((entry) => (
                <button key={entry.index} className="doc-index-entry" style={{ paddingInlineStart: `${6 + (entry.level - 1) * 11}px` }} onClick={() => jumpTo(entry.index)}>
                  <span className="doc-index-level">H{entry.level}</span> {entry.text}
                </button>
              ))}
            </nav>
          )}

          <div className={`document-scroll doc-scroll layout-${layout}${inverted ? " inverted" : ""}`} ref={scrollRef}>
            {layout === "outline" ? (
              <article className="document-page doc-outline-view" style={{ fontSize: `${zoom}rem` }}>
                {outline.length === 0 && <p className="muted">This document has no headings to outline.</p>}
                {outline.map((entry) => (
                  <button key={entry.index} className={`doc-outline-row level-${entry.level}`} onClick={() => { setLayout("page"); window.setTimeout(() => jumpTo(entry.index), 0); }}>
                    <span className="doc-index-level">H{entry.level}</span> {entry.text}
                  </button>
                ))}
              </article>
            ) : (
              <article className="document-page" style={{ fontSize: `${zoom}rem` }}>
                {query.trim() !== "" && blocks.length === 0 && <p className="muted">No block matches “{query}”.</p>}
                {blocks.map((entry) => <Block key={entry.position} index={entry.position} block={entry.block} marker={entry.marker} />)}
              </article>
            )}
          </div>

          {inspector && (
            <aside className="doc-inspector" aria-label="Document inspector">
              <div className="json-details-head"><strong><FileText size={13} /> Document Inspector</strong><em className="json-type">DOCX</em></div>

              <span className="segmented doc-tabs">
                {TABS.map((entry) => (
                  <button key={entry.id} className={tab === entry.id ? "selected" : ""} aria-pressed={tab === entry.id} onClick={() => setTab(entry.id)}>{entry.label}</button>
                ))}
              </span>

              {tab === "metadata" && properties && (
                <>
                  <section>
                    <h3>Core properties</h3>
                    <dl className="image-facts">
                      <Row label="Title" value={properties.title} />
                      <Row label="Subject" value={properties.subject} />
                      <Row label="Author" value={properties.author} />
                      <Row label="Last saved by" value={properties.lastModifiedBy} />
                      <Row label="Keywords" value={properties.keywords} />
                      <Row label="Revision" value={properties.revision} />
                      <Row label="Created" value={formatDocDate(properties.created)} />
                      <Row label="Modified" value={formatDocDate(properties.modified)} />
                    </dl>
                    {isEmptyCore(properties) && <p className="muted small">This document records no core properties.</p>}
                  </section>

                  <section>
                    <h3>Application</h3>
                    <dl className="image-facts">
                      <Row label="Generator" value={properties.generator} />
                      <Row label="Version" value={properties.generatorVersion} />
                      <Row label="Company" value={properties.company} />
                      <Row label="Editing time" value={formatEditTime(properties.totalEditMinutes)} />
                      <Row label="Pages" value={properties.pages?.toLocaleString() ?? null} />
                      <Row label="Words" value={properties.words?.toLocaleString() ?? null} />
                      <Row label="Characters" value={properties.characters?.toLocaleString() ?? null} />
                      <Row label="Paragraphs" value={properties.paragraphs?.toLocaleString() ?? null} />
                    </dl>
                    <p className="muted small">These are the counts Word last wrote into the package. The toolbar shows what this reader parsed.</p>
                  </section>

                  <section>
                    <h3>Security</h3>
                    <ul className="doc-flags">
                      <Flag on={properties.hasSignature} icon={<Signature size={12} />}
                        onLabel="Signature part present (_xmlsignatures)"
                        offLabel="No signature part in the package" />
                      <Flag on={properties.hasMacros} warn icon={<AlertTriangle size={12} />}
                        onLabel="Macro project present (vbaProject.bin)"
                        offLabel="No macro project in the package" />
                      <Flag on={properties.protection !== null} icon={properties.protection ? <Lock size={12} /> : <Unlock size={12} />}
                        onLabel={`Editing restricted: ${properties.protection ?? ""}`}
                        offLabel="No editing restriction recorded" />
                      <Flag on={properties.trackChanges} icon={<ShieldCheck size={12} />}
                        onLabel="Track changes is enabled"
                        offLabel="Track changes is off" />
                    </ul>
                    <p className="muted small">Presence only. OneOpen does not verify a signature or evaluate macros.</p>
                  </section>

                  <section>
                    <h3>Composition</h3>
                    <Ring density={density} />
                    <dl className="image-facts">
                      {SLICES.map((slice) => (
                        <div key={slice.key}>
                          <dt><i className="doc-swatch" style={{ background: slice.colour }} /> {slice.label}</dt>
                          <dd>{density[slice.key].toLocaleString()}</dd>
                        </div>
                      ))}
                      <Row label="Table cells" value={density.tableCells.toLocaleString()} />
                      <Row label="Characters" value={density.characters.toLocaleString()} />
                    </dl>
                  </section>
                </>
              )}

              {tab === "fonts" && (
                <section>
                  <h3>Font table</h3>
                  {properties && properties.fonts.length > 0 ? (
                    <ul className="doc-list">
                      {properties.fonts.map((font) => (
                        <li key={font}><Type size={11} /> <span style={{ fontFamily: `"${font}", inherit` }}>{font}</span></li>
                      ))}
                    </ul>
                  ) : <p className="muted small">The package declares no font table.</p>}
                  <p className="muted small">Declared by word/fontTable.xml. The page above renders with the fonts installed on this machine.</p>
                </section>
              )}

              {tab === "parts" && (
                <section>
                  <h3>Package parts</h3>
                  {properties && properties.parts.length > 0 ? (
                    <dl className="image-facts doc-parts">
                      {properties.parts.map((part) => (
                        <div key={part.name}>
                          <dt title={part.name}><Package size={11} /> {part.name.split("/").at(-1)}</dt>
                          <dd title={`${part.name} — ${part.size.toLocaleString()} bytes, stored as ${part.compressedSize.toLocaleString()}`}>
                            {formatBytes(part.size)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : <p className="muted small">No package parts could be listed.</p>}
                  <p className="muted small">Largest first, by uncompressed size.</p>
                </section>
              )}
            </aside>
          )}
        </div>
      )}

      <div className="json-status">
        <span>OOXML DOCX</span>
        {properties?.generator && <span>{properties.generator}</span>}
        {content && <span>{content.blocks.length.toLocaleString()} blocks · {density.tables.toLocaleString()} tables</span>}
        <span className="spacer" />
        {properties?.hasMacros && <span className="bad">Contains macros</span>}
        {properties?.protection && <span>{properties.protection}</span>}
      </div>
    </div>
  );
}

function Block({ block, marker, index }: MarkedBlock & { index: number }) {
  if (block.kind === "table") {
    return (
      <table className="document-table" data-block={index}>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  const runs = block.runs.map((run, runIndex) => <Run key={runIndex} run={run} />);
  if (block.headingLevel) {
    return createElement(`h${block.headingLevel}`, { className: "document-heading", "data-block": index }, runs);
  }
  if (block.listLevel !== null) {
    return (
      <p className="document-list-item" data-block={index} style={{ marginInlineStart: `${1.4 + block.listLevel * 1.4}rem` }}>
        <span className="document-bullet">{marker ?? "•"}</span>
        {runs}
      </p>
    );
  }
  if (block.runs.length === 0) return <p className="document-spacer" data-block={index} />;
  return <p className={`document-paragraph${block.style === "Quote" ? " document-quote" : ""}`} data-block={index}>{runs}</p>;
}

/**
 * Renders a run as plain React text nodes. Word formatting never reaches the
 * DOM as markup, so a hostile document cannot inject elements or scripts.
 */
function Run({ run }: { run: DocumentRun }) {
  const lines = run.text.split("\n");
  const text = lines.map((line, index) => (
    <Fragment key={index}>{index > 0 && <br />}{line}</Fragment>
  ));
  const className = [run.bold && "bold", run.italic && "italic", run.underline && "underline"].filter(Boolean).join(" ");
  return className ? <span className={className}>{text}</span> : <>{text}</>;
}

/** A row is left out entirely when the document does not record the value. */
function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return <div><dt>{label}</dt><dd title={value}>{value}</dd></div>;
}

function Flag(
  { on, icon, onLabel, offLabel, warn }:
  { on: boolean; icon: React.ReactNode; onLabel: string; offLabel: string; warn?: boolean },
) {
  return <li className={on ? (warn ? "on warn" : "on") : "off"}>{icon} {on ? onLabel : offLabel}</li>;
}

/** A donut of the block mix, drawn from the counts the parser produced. */
function Ring({ density }: { density: DocumentDensity }) {
  const total = SLICES.reduce((sum, slice) => sum + density[slice.key], 0);
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="doc-ring">
      <svg viewBox="0 0 68 68" role="img" aria-label="Block composition">
        <circle cx="34" cy="34" r={radius} className="doc-ring-track" />
        {total > 0 && SLICES.map((slice) => {
          const dash = (density[slice.key] / total) * circumference;
          const element = (
            <circle
              key={slice.key}
              cx="34" cy="34" r={radius}
              stroke={slice.colour}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              className="doc-ring-slice"
            />
          );
          offset += dash;
          return element;
        })}
      </svg>
      <div>
        <strong>{total.toLocaleString()}</strong>
        <small>blocks</small>
      </div>
    </div>
  );
}

function isEmptyCore(properties: DocumentProperties): boolean {
  return !properties.title && !properties.author && !properties.created && !properties.modified;
}

function blockText(block: DocumentBlock): string {
  return block.kind === "table"
    ? block.rows.flat().join(" ")
    : block.runs.map((run) => run.text).join("");
}

function step(current: number, direction: number): number {
  const index = ZOOM_STEPS.indexOf(current);
  const next = (index === -1 ? 2 : index) + direction;
  return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, next))];
}
