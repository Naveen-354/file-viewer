import { useEffect, useMemo, useRef, useState } from "react";
import { flexRender, getCoreRowModel, getFilteredRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ViewerProps } from "../../types/handlers";
import { api } from "../../services/tauri";
import { useSettings } from "../../stores/settings";
import TextViewer from "../text/TextViewer";
import { detectDelimiter } from "../../utils/csv";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 100_000;
const MAX_COLUMNS = 256;

export default function CsvViewer(props: ViewerProps) {
  const { file, onStatusChange } = props;
  const configuredDelimiter = useSettings((state) => state.csvDelimiter);
  const [delimiter, setDelimiter] = useState(configuredDelimiter ?? (file.extension === "tsv" ? "\t" : ","));
  const [delimiterOverride, setDelimiterOverride] = useState<string | null>(configuredDelimiter);
  const [raw, setRaw] = useState(false);
  const [rows, setRows] = useState<string[][]>([]);
  const [header, setHeader] = useState(true);
  const [filter, setFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [selectedColumn, setSelectedColumn] = useState(0);
  const [showInspector, setShowInspector] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRows([]); setError(null); setTruncated(false);
    void parseCsvFile(file.path, delimiterOverride, (detected, result, isTruncated) => {
      if (cancelled) return;
      setDelimiter(detected); setRows(result); setHeader(detectHeader(result)); setTruncated(isTruncated);
      onStatusChange(`${result.length.toLocaleString()} rows · ${detected === "\t" ? "Tab" : detected} delimiter`);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { cancelled = true; };
  }, [file.path, delimiterOverride, onStatusChange]);

  const data = useMemo(() => header ? rows.slice(1) : rows, [rows, header]);
  const columnCount = Math.min(MAX_COLUMNS, Math.max(0, ...rows.slice(0, 100).map((row) => row.length)));
  const columns = useMemo<ColumnDef<string[]>[]>(() => Array.from({ length: columnCount }, (_, index) => ({
    id: String(index),
    accessorFn: (row) => row[index] ?? "",
    header: header ? rows[0]?.[index] || `Column ${index + 1}` : `Column ${index + 1}`,
    cell: (info) => String(info.getValue() ?? ""),
    size: 160,
    minSize: 60,
    maxSize: 700,
  })), [columnCount, header, rows]);
  const table = useReactTable({ data, columns, state: { sorting, globalFilter: filter }, onSortingChange: setSorting, onGlobalFilterChange: setFilter, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getFilteredRowModel: getFilteredRowModel(), columnResizeMode: "onChange" });
  const visibleRows = table.getRowModel().rows;
  const stats = useMemo(() => columnStats(data, selectedColumn, columns[selectedColumn]?.header?.toString() ?? `Column ${selectedColumn + 1}`), [data, selectedColumn, columns]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerScrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: visibleRows.length, getScrollElement: () => scrollRef.current, estimateSize: () => 30, overscan: 12 });

  if (raw) return <div className="viewer csv-raw-mode"><div className="viewer-toolbar csv-raw-toolbar"><button className="primary" onClick={() => setRaw(false)}>← Back to Grid</button><span>{file.name}</span><span className="spacer" /></div><div className="csv-raw-content"><TextViewer {...props} /></div></div>;

  return (
    <div className="viewer csv-viewer">
      <div className="csv-filebar"><strong><span>▦</span> {file.name}</strong><span>{data.length.toLocaleString()} rows · {columnCount} columns · {formatBytes(file.size)} (mapped)</span><button onClick={() => setShowInspector((value) => !value)}>▥ Inspector</button></div>
      <div className="viewer-toolbar csv-toolbar">
        <span className="csv-tool-label">▥ Columns <b>{columnCount}/14</b></span>
        <label>Delimiter <select value={delimiterOverride ?? "auto"} onChange={(event) => setDelimiterOverride(event.target.value === "auto" ? null : event.target.value)}><option value="auto">Auto ({delimiter === "\t" ? "Tab" : delimiter})</option><option value=",">Comma</option><option value="\t">Tab</option><option value=";">Semicolon</option><option value="|">Pipe</option></select></label>
        <label><input type="checkbox" checked={header} onChange={(event) => setHeader(event.target.checked)} /> Header</label>
        <button onClick={() => setRaw(true)}>⌁ Raw</button>
        <span className="csv-badge">CSV</span>
        <button onClick={() => setShowInspector((value) => !value)}>⌁ Stats</button>
        <span className="spacer" />
        <input className="csv-search" placeholder="Search rows (text or number)" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>
      {truncated && <div className="validation-error">Safety limit reached. Displaying the first {rows.length.toLocaleString()} rows.</div>}
      {error && <div className="error-state">{error}</div>}
      <div className={`csv-content ${showInspector ? "with-inspector" : ""}`}>
        <div className="csv-grid">
          <div ref={headerScrollRef} className="csv-header-scroll"><div className="table-header" style={{ width: table.getTotalSize() + 42 }}><div className="table-cell csv-row-number">#</div>{table.getHeaderGroups()[0]?.headers.map((item, index) => (
            <div className={`table-cell header-cell ${selectedColumn === index ? "column-selected" : ""}`} key={item.id} style={{ width: item.getSize() }} onClick={(event) => { setSelectedColumn(index); item.column.getToggleSortingHandler()?.(event); }}>
              <span>{flexRender(item.column.columnDef.header, item.getContext())}{item.column.getIsSorted() === "asc" ? " ↑" : item.column.getIsSorted() === "desc" ? " ↓" : ""}</span><span className="column-type">{inferType(data.map((row) => row[index] ?? ""))}</span>
              <div className="resize-handle" onMouseDown={item.getResizeHandler()} onTouchStart={item.getResizeHandler()} />
            </div>
          ))}</div></div>
          <div ref={scrollRef} className="table-scroll" onScroll={(event) => { if (headerScrollRef.current) headerScrollRef.current.scrollLeft = event.currentTarget.scrollLeft; }}>
            <div style={{ height: virtualizer.getTotalSize(), width: table.getTotalSize() + 42, position: "relative" }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = visibleRows[virtualRow.index];
                return <div className="table-row" key={row.id} style={{ transform: `translateY(${virtualRow.start}px)`, width: table.getTotalSize() + 42 }}><div className="table-cell csv-row-number">{virtualRow.index + 1}</div>{row.getVisibleCells().map((cell, index) => <div className={`table-cell ${selectedColumn === index ? "column-selected" : ""}`} key={cell.id} style={{ width: cell.column.getSize() }} title={String(cell.getValue() ?? "")} onClick={() => setSelectedColumn(index)}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</div>)}</div>;
              })}
            </div>
          </div>
        </div>
        {showInspector && <StatisticsPanel stats={stats} />}
      </div>
    </div>
  );
}

interface ColumnStatistics { name: string; type: string; count: number; nulls: number; distinct: number; numbers: number[]; min: number; max: number; average: number; median: number; sum: number; histogram: number[] }

function StatisticsPanel({ stats }: { stats: ColumnStatistics }) {
  const numeric = stats.numbers.length > 0;
  return <aside className="csv-inspector"><header><strong>▥ Column Statistics</strong><span>{stats.name}</span></header><div className="stats-summary"><Stat label="DETECTED TYPE" value={stats.type} accent /><Stat label="NULL RATE" value={`${stats.count ? ((stats.nulls / stats.count) * 100).toFixed(2) : "0.00"}% (${stats.nulls} rows)`} /><Stat label="DISTINCT VALUES" value={stats.distinct.toLocaleString()} /><Stat label="ANALYZED ROWS" value={stats.count.toLocaleString()} /></div>{numeric && <><section className="metrics"><h3>METRICS BREAKDOWN</h3><StatLine label="Min" value={formatNumber(stats.min)} /><StatLine label="Max" value={formatNumber(stats.max)} positive /><StatLine label="Avg" value={formatNumber(stats.average)} /><StatLine label="Median" value={formatNumber(stats.median)} /><StatLine label="Sum (Total)" value={formatNumber(stats.sum)} /></section><section className="distribution"><h3>FREQUENCY DISTRIBUTION</h3><div className="histogram">{stats.histogram.map((height, index) => <i key={index} style={{ height: `${Math.max(8, height * 100)}%` }} />)}</div><div><span>{formatNumber(stats.min)}</span><span>{formatNumber(stats.max)}</span></div></section></>}<section className="schema"><h3>DETECTED SCHEMA</h3><div><span>Column</span><b>{stats.name}</b></div><div><span>Storage</span><b>{stats.type}</b></div><div><span>Encoding</span><b>UTF-8</b></div></section></aside>;
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) { return <div><small>{label}</small><strong className={accent ? "green" : ""}>{value}</strong></div>; }
function StatLine({ label, value, positive = false }: { label: string; value: string; positive?: boolean }) { return <div><span>{label}:</span><b className={positive ? "green" : ""}>{value}</b></div>; }

function columnStats(rows: string[][], index: number, name: string): ColumnStatistics {
  const values = rows.slice(0, 100_000).map((row) => (row[index] ?? "").trim());
  const present = values.filter(Boolean);
  const numbers = present.map(parseNumeric).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const min = numbers[0] ?? 0, max = numbers.at(-1) ?? 0, sum = numbers.reduce((total, value) => total + value, 0);
  const histogram = Array(6).fill(0) as number[];
  if (numbers.length) for (const value of numbers) histogram[Math.min(5, Math.floor(((value - min) / Math.max(1, max - min)) * 6))] += 1;
  const peak = Math.max(1, ...histogram);
  return { name, type: inferType(values), count: values.length, nulls: values.length - present.length, distinct: new Set(present).size, numbers, min, max, sum, average: numbers.length ? sum / numbers.length : 0, median: numbers.length ? numbers[Math.floor(numbers.length / 2)] : 0, histogram: histogram.map((value) => value / peak) };
}

function parseNumeric(value: string): number | null { const cleaned = value.replace(/[$€£¥,%\s]/g, ""); const number = Number(cleaned); return cleaned && Number.isFinite(number) ? number : null; }
function inferType(values: string[]): string { const present = values.filter((value) => value.trim()).slice(0, 500); if (!present.length) return "Empty"; if (present.every((value) => parseNumeric(value) !== null)) return present.some((value) => /[$€£¥]/.test(value)) ? "Float64 / Currency" : "Float64"; if (present.every((value) => !Number.isNaN(Date.parse(value)))) return "Timestamp"; if (present.every((value) => /^(true|false)$/i.test(value))) return "Boolean"; return "String"; }
function formatNumber(value: number): string { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value); }
function formatBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }

function detectHeader(rows: string[][]): boolean {
  if (rows.length < 2) return true;
  const numeric = (value: string) => value.trim() !== "" && Number.isFinite(Number(value));
  return rows[0].some((value, index) => !numeric(value) && numeric(rows[1]?.[index] ?? ""));
}

async function parseCsvFile(path: string, preferred: string | null, done: (delimiter: string, rows: string[][], truncated: boolean) => void): Promise<void> {
  const first = await api.readChunk(path, 0, 64 * 1024, true);
  const decoder = new TextDecoder(first.encoding ?? "utf-8");
  const sample = decoder.decode(Uint8Array.from(first.bytes), { stream: !first.eof });
  const delimiter = preferred ?? detectDelimiter(sample);
  const parser = new CsvParser(delimiter);
  parser.feed(sample);
  let offset = first.bytes.length;
  while (!first.eof && offset < MAX_BYTES && parser.rows.length < MAX_ROWS) {
    const chunk = await api.readChunk(path, offset, Math.min(1024 * 1024, MAX_BYTES - offset));
    parser.feed(decoder.decode(Uint8Array.from(chunk.bytes), { stream: !chunk.eof }));
    offset += chunk.bytes.length;
    if (chunk.eof || !chunk.bytes.length) break;
  }
  parser.finish();
  done(delimiter, parser.rows.slice(0, MAX_ROWS), offset >= MAX_BYTES || parser.rows.length > MAX_ROWS);
}

class CsvParser {
  rows: string[][] = [];
  private row: string[] = [];
  private field = "";
  private quoted = false;
  private pendingQuote = false;
  constructor(private readonly delimiter: string) {}
  feed(input: string): void {
    for (const char of input) {
      if (this.pendingQuote) {
        if (char === '"') { this.field += '"'; this.pendingQuote = false; continue; }
        this.quoted = false; this.pendingQuote = false;
      }
      if (this.quoted) { if (char === '"') this.pendingQuote = true; else this.field += char; continue; }
      if (char === '"' && !this.field) this.quoted = true;
      else if (char === this.delimiter) this.pushField();
      else if (char === "\n") this.pushRow();
      else if (char !== "\r") this.field += char;
    }
  }
  finish(): void { if (this.pendingQuote) this.quoted = false; if (this.field || this.row.length) this.pushRow(); }
  private pushField(): void { this.row.push(this.field); this.field = ""; }
  private pushRow(): void { this.pushField(); this.rows.push(this.row); this.row = []; }
}
