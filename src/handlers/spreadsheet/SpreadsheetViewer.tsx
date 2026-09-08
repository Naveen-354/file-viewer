import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ViewerProps } from "../../types/handlers";
import type { CellEdit, SpreadsheetCell, WorkbookView } from "../../types/files";
import { api } from "../../services/tauri";
import { useWorkspace } from "../../stores/workspace";
import {
  cellKey,
  columnName,
  isFiltered,
  valueAt,
  visibleRowIndexes,
  type ColumnFilter,
  type Edits,
} from "../../utils/spreadsheet";
import { FilterMenu } from "./FilterMenu";

const ROW_HEIGHT = 28;
const DEFAULT_WIDTH = 132;
const MIN_WIDTH = 48;
const MAX_WIDTH = 720;
const HEADER_WIDTH = 62;
const EDITABLE_EXTENSIONS = ["xlsx", "xlsm"];

interface Position { row: number; column: number }

export default function SpreadsheetViewer({ file, tabId, onDirtyChange, onStatusChange }: ViewerProps) {
  const [workbook, setWorkbook] = useState<WorkbookView | null>(null);
  const [sheetIndex, setSheetIndex] = useState<number | null>(null);
  const [widths, setWidths] = useState<Map<number, number>>(new Map());
  const [filters, setFilters] = useState<Map<number, ColumnFilter>>(new Map());
  const [openFilter, setOpenFilter] = useState<number | null>(null);
  const [edits, setEdits] = useState<Edits>(new Map());
  const [selected, setSelected] = useState<Position | null>(null);
  const [editing, setEditing] = useState<Position | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const replaceFile = useWorkspace((state) => state.replaceFile);

  // The header sits outside the scrolling body, so it has to be moved manually
  // or the column labels drift away from their data on a wide sheet.
  const syncHeader = (event: React.UIEvent<HTMLDivElement>) => {
    if (headerRef.current) {
      headerRef.current.style.transform = `translateX(${-event.currentTarget.scrollLeft}px)`;
    }
  };

  const editable = EDITABLE_EXTENSIONS.includes(file.extension ?? "") && !file.readonly;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.readSpreadsheet(file.path, sheetIndex)
      .then((result) => {
        if (cancelled) return;
        setWorkbook(result);
        setEdits(new Map());
        setFilters(new Map());
        setSelected(null);
        setEditing(null);
        const sheet = result.sheets[result.activeIndex]?.name ?? "Sheet";
        onStatusChange(`${sheet} · ${result.totalRows.toLocaleString()} rows × ${result.totalColumns.toLocaleString()} columns`);
      })
      .catch((reason) => { if (!cancelled) setError(describe(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [file.path, sheetIndex, onStatusChange]);

  useEffect(() => { onDirtyChange(edits.size > 0); }, [edits, onDirtyChange]);

  const rows = useMemo(() => workbook?.rows ?? [], [workbook]);
  const columnCount = useMemo(() => {
    // Spreading one argument per row overflows the stack on a large sheet.
    let fromRows = 0;
    for (const row of rows) if (row.length > fromRows) fromRows = row.length;
    let fromEdits = 0;
    for (const key of edits.keys()) {
      const column = Number(key.split(":")[1]) + 1;
      if (column > fromEdits) fromEdits = column;
    }
    return Math.max(fromRows, fromEdits);
  }, [rows, edits]);
  const visible = useMemo(() => visibleRowIndexes(rows, edits, filters), [rows, edits, filters]);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 14,
  });

  const widthOf = useCallback((column: number) => widths.get(column) ?? DEFAULT_WIDTH, [widths]);
  const gridWidth = useMemo(
    () => HEADER_WIDTH + Array.from({ length: columnCount }, (_, index) => widthOf(index)).reduce((sum, value) => sum + value, 0),
    [columnCount, widthOf],
  );

  const startResize = (column: number, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = widthOf(column);
    const move = (moveEvent: MouseEvent) => {
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + moveEvent.clientX - startX));
      setWidths((prior) => new Map(prior).set(column, next));
    };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  };

  const autoFit = (column: number) => {
    const sample = visible.slice(0, 500).map((row) => valueAt(rows, edits, row, column).length);
    const longest = Math.max(columnName(column).length, ...sample, 3);
    setWidths((prior) => new Map(prior).set(column, Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, longest * 8 + 22))));
  };

  const commit = (position: Position, value: string, move: "down" | "right" | "none") => {
    const original = rows[position.row]?.[position.column]?.text ?? "";
    setEdits((prior) => {
      const next = new Map(prior);
      if (value === original) next.delete(cellKey(position.row, position.column));
      else next.set(cellKey(position.row, position.column), value);
      return next;
    });
    setEditing(null);
    if (move === "down") setSelected({ row: Math.min(rows.length - 1, position.row + 1), column: position.column });
    if (move === "right") setSelected({ row: position.row, column: Math.min(columnCount - 1, position.column + 1) });
  };

  const beginEdit = (position: Position, initial?: string) => {
    if (!editable) return;
    setSelected(position);
    setDraft(initial ?? valueAt(rows, edits, position.row, position.column));
    setEditing(position);
  };

  const save = async () => {
    if (!workbook || !edits.size) return;
    setSaving(true);
    setError(null);
    const payload: CellEdit[] = [...edits.entries()].map(([key, value]) => {
      const [row, column] = key.split(":").map(Number);
      return { row: workbook.startRow + row, column: workbook.startColumn + column, value };
    });
    try {
      const result = await api.editSpreadsheet({
        path: file.path,
        sheetIndex: workbook.activeIndex,
        edits: payload,
        expectedModifiedMs: file.modifiedMs,
      });
      replaceFile(tabId, result.file);
      setWorkbook(result.view);
      setEdits(new Map());
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
      return;
    }
    if (!selected || editing) return;
    if (event.key === "Enter" || event.key === "F2") { event.preventDefault(); beginEdit(selected); return; }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); commit(selected, "", "none"); return; }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { beginEdit(selected, event.key); return; }
    const deltas: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const delta = deltas[event.key];
    if (delta) {
      event.preventDefault();
      setSelected({
        row: Math.min(rows.length - 1, Math.max(0, selected.row + delta[0])),
        column: Math.min(columnCount - 1, Math.max(0, selected.column + delta[1])),
      });
    }
  };

  if (error && !workbook) {
    return (
      <div className="viewer sheet-viewer">
        <div className="error-state">
          <p>{error}</p>
          <button className="secondary" onClick={() => void api.openSystem(file.path)}>Open in the default app</button>
        </div>
      </div>
    );
  }

  const activeSheet = workbook?.sheets[workbook.activeIndex];

  return (
    <div className="viewer sheet-viewer" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="viewer-toolbar">
        <select
          value={workbook?.activeIndex ?? 0}
          disabled={loading || !workbook || saving}
          onChange={(event) => {
            if (edits.size && !window.confirm("Discard unsaved cell changes and switch sheet?")) return;
            setSheetIndex(Number(event.target.value));
          }}
        >
          {(workbook?.sheets ?? []).map((sheet) => (
            <option key={sheet.index} value={sheet.index} disabled={!sheet.selectable}>
              {sheet.name}{sheet.hidden ? " (hidden)" : ""}{sheet.selectable ? "" : " — not a worksheet"}
            </option>
          ))}
        </select>
        <button className="primary" disabled={!edits.size || saving} onClick={() => void save()}>
          {saving ? "Saving…" : `Save${edits.size ? ` (${edits.size})` : ""}`}
        </button>
        <button className="secondary" disabled={!edits.size || saving} onClick={() => setEdits(new Map())}>Discard</button>
        {filters.size > 0 && (
          <button className="secondary" onClick={() => setFilters(new Map())}>Clear filters</button>
        )}
        <span className="spacer" />
        {!editable && <span className="muted small">{file.readonly ? "Read-only file" : "Editing needs .xlsx or .xlsm"}</span>}
        <span className="muted small">
          {visible.length.toLocaleString()} of {rows.length.toLocaleString()} rows
        </span>
      </div>
      {error && <div className="validation-error">{error}</div>}
      {workbook?.truncated && (
        <div className="validation-error">
          Safety limit reached. Showing the first {rows.length.toLocaleString()} rows and {columnCount.toLocaleString()} columns of {workbook.totalRows.toLocaleString()} × {workbook.totalColumns.toLocaleString()}. Saving only writes the cells you changed.
        </div>
      )}
      {loading && <div className="center muted">Reading workbook…</div>}
      {!loading && workbook && (
        <>
          <div className="table-header sheet-header" ref={headerRef} style={{ width: gridWidth }}>
            <div className="table-cell header-cell sheet-corner" style={{ width: HEADER_WIDTH }} />
            {Array.from({ length: columnCount }, (_, column) => (
              <div className="table-cell header-cell" key={column} style={{ width: widthOf(column) }}>
                <span className="sheet-column-name">{columnName(workbook.startColumn + column)}</span>
                <button
                  className={`sheet-filter-button${isFiltered(filters.get(column)) ? " active" : ""}`}
                  title={`Filter column ${columnName(workbook.startColumn + column)}`}
                  onClick={() => setOpenFilter((current) => (current === column ? null : column))}
                >
                  ▾
                </button>
                <div
                  className="resize-handle"
                  onMouseDown={(event) => startResize(column, event)}
                  onDoubleClick={() => autoFit(column)}
                  title="Drag to resize, double-click to fit"
                />
                {openFilter === column && (
                  <FilterMenu
                    rows={rows}
                    edits={edits}
                    filters={filters}
                    column={column}
                    onApply={(filter) => {
                      setFilters((prior) => {
                        const next = new Map(prior);
                        if (filter) next.set(column, filter);
                        else next.delete(column);
                        return next;
                      });
                      setOpenFilter(null);
                    }}
                    onClose={() => setOpenFilter(null)}
                  />
                )}
              </div>
            ))}
          </div>
          <div ref={scrollRef} className="table-scroll" onScroll={syncHeader}>
            <div style={{ height: virtualizer.getTotalSize(), width: gridWidth, position: "relative" }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = visible[virtualRow.index];
                return (
                  <div className="table-row" key={row} style={{ transform: `translateY(${virtualRow.start}px)`, width: gridWidth }}>
                    <div className="table-cell sheet-row-number" style={{ width: HEADER_WIDTH }}>
                      {workbook.startRow + row + 1}
                    </div>
                    {Array.from({ length: columnCount }, (_, column) => {
                      const key = cellKey(row, column);
                      const changed = edits.has(key);
                      const text = valueAt(rows, edits, row, column);
                      const isSelected = selected?.row === row && selected.column === column;
                      const isEditing = editing?.row === row && editing.column === column;
                      if (isEditing) {
                        return (
                          <input
                            key={column}
                            className="sheet-editor"
                            autoFocus
                            value={draft}
                            style={{ width: widthOf(column) }}
                            onChange={(event) => setDraft(event.target.value)}
                            onBlur={() => commit({ row, column }, draft, "none")}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === "Enter") { event.preventDefault(); commit({ row, column }, draft, "down"); }
                              if (event.key === "Tab") { event.preventDefault(); commit({ row, column }, draft, "right"); }
                              if (event.key === "Escape") { event.preventDefault(); setEditing(null); }
                            }}
                          />
                        );
                      }
                      return (
                        <div
                          key={column}
                          className={`table-cell sheet-cell ${cellClass(rows[row]?.[column], changed)} ${isSelected ? "selected" : ""}`}
                          style={{ width: widthOf(column) }}
                          title={text}
                          onClick={() => setSelected({ row, column })}
                          onDoubleClick={() => beginEdit({ row, column })}
                        >
                          {text}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="sheet-formula">
            <span className="muted">
              {selected
                ? `${columnName(workbook.startColumn + selected.column)}${workbook.startRow + selected.row + 1}`
                : "—"}
            </span>
            <span className="sheet-formula-value">
              {selected ? valueAt(rows, edits, selected.row, selected.column) : ""}
            </span>
            <span className="spacer" />
            <span className="muted small">
              {activeSheet?.name}
              {edits.size > 0 && ` · ${edits.size} unsaved cell${edits.size === 1 ? "" : "s"}`}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function cellClass(cell: SpreadsheetCell | undefined, changed: boolean): string {
  const kind = !cell || cell.kind === "empty" ? "" : `cell-${cell.kind}`;
  return changed ? `${kind} cell-changed` : kind;
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
