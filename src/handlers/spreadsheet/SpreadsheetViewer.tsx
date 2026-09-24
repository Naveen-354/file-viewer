import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ViewerProps } from "../../types/handlers";
import type { CellEdit, CellKind, SpreadsheetCell, StructuralInsert, WorkbookView } from "../../types/files";
import { api } from "../../services/tauri";
import { useWorkspace } from "../../stores/workspace";
import { FUNCTIONS, isFormula } from "../../utils/formula";
import {
  cellKey,
  columnName,
  createCalculator,
  insertCells,
  isFiltered,
  rawAt,
  shiftKeys,
  visibleRowIndexes,
  type ColumnFilter,
  type Edits,
} from "../../utils/spreadsheet";
import { FilterMenu } from "./FilterMenu";
import { InsertDialog, SheetContextMenu } from "./InsertMenu";
import { insertFor, type InsertPlacement } from "./placement";

const ROW_HEIGHT = 28;
const MIN_HEIGHT = 16;
const MAX_HEIGHT = 409; // Excel's own row-height ceiling, in points.
const DEFAULT_WIDTH = 132;
const MIN_WIDTH = 48;
const MAX_WIDTH = 720;
const HEADER_WIDTH = 62;
const EDITABLE_EXTENSIONS = ["xlsx", "xlsm"];

interface Position { row: number; column: number }
interface MenuState { x: number; y: number; target: "cell" | "row" | "column"; anchor: Position }
interface DialogState { anchor: Position; initial: InsertPlacement }

export default function SpreadsheetViewer({ file, tabId, onDirtyChange, onStatusChange }: ViewerProps) {
  const [workbook, setWorkbook] = useState<WorkbookView | null>(null);
  const [sheetIndex, setSheetIndex] = useState<number | null>(null);
  // The loaded rows plus any inserted rows and columns not yet saved.
  const [grid, setGrid] = useState<SpreadsheetCell[][]>([]);
  const [inserts, setInserts] = useState<StructuralInsert[]>([]);
  const [minColumns, setMinColumns] = useState(0);
  const [widths, setWidths] = useState<Map<number, number>>(new Map());
  const [heights, setHeights] = useState<Map<number, number>>(new Map());
  const [filters, setFilters] = useState<Map<number, ColumnFilter>>(new Map());
  const [openFilter, setOpenFilter] = useState<number | null>(null);
  const [edits, setEdits] = useState<Edits>(new Map());
  const [selected, setSelected] = useState<Position | null>(null);
  const [editing, setEditing] = useState<Position | null>(null);
  // Typing into the formula bar edits the selected cell without an in-cell box.
  const [editingInBar, setEditingInBar] = useState(false);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  // After a save the file's cached formula values may predate the edit, so
  // keep recalculating until the sheet is reloaded.
  const [savedChanges, setSavedChanges] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
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
  const dirty = edits.size > 0 || inserts.length > 0;

  const showWorkbook = useCallback((result: WorkbookView) => {
    setWorkbook(result);
    setGrid(result.rows);
    setInserts([]);
    setMinColumns(0);
    setEdits(new Map());
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.readSpreadsheet(file.path, sheetIndex)
      .then((result) => {
        if (cancelled) return;
        showWorkbook(result);
        setFilters(new Map());
        setHeights(new Map());
        setSelected(null);
        setEditing(null);
        setSavedChanges(false);
        const sheet = result.sheets[result.activeIndex]?.name ?? "Sheet";
        onStatusChange(`${sheet} · ${result.totalRows.toLocaleString()} rows × ${result.totalColumns.toLocaleString()} columns`);
      })
      .catch((reason) => { if (!cancelled) setError(describe(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [file.path, sheetIndex, onStatusChange, showWorkbook]);

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  const rows = grid;
  const sheetName = workbook?.sheets[workbook.activeIndex]?.name ?? null;
  const origin = useMemo(
    () => ({ row: workbook?.startRow ?? 0, column: workbook?.startColumn ?? 0 }),
    [workbook],
  );
  const calculator = useMemo(
    () => createCalculator(rows, edits, {
      startRow: origin.row,
      startColumn: origin.column,
      sheet: sheetName,
      recalculate: dirty || savedChanges,
    }),
    [rows, edits, origin, sheetName, dirty, savedChanges],
  );
  const textAt = calculator.text;

  const columnCount = useMemo(() => {
    // Spreading one argument per row overflows the stack on a large sheet.
    let fromRows = 0;
    for (const row of rows) if (row.length > fromRows) fromRows = row.length;
    let fromEdits = 0;
    for (const key of edits.keys()) {
      const column = Number(key.split(":")[1]) + 1;
      if (column > fromEdits) fromEdits = column;
    }
    return Math.max(fromRows, fromEdits, minColumns);
  }, [rows, edits, minColumns]);
  const visible = useMemo(() => visibleRowIndexes(rows.length, textAt, filters), [rows.length, textAt, filters]);

  const heightOf = useCallback((row: number) => heights.get(row) ?? ROW_HEIGHT, [heights]);
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => heightOf(visible[index]),
    overscan: 14,
  });
  // The virtualizer caches sizes, so tell it when a row is resized or moved.
  useEffect(() => { virtualizer.measure(); }, [virtualizer, heightOf, visible]);

  const widthOf = useCallback((column: number) => widths.get(column) ?? DEFAULT_WIDTH, [widths]);
  const gridWidth = useMemo(
    () => HEADER_WIDTH + Array.from({ length: columnCount }, (_, index) => widthOf(index)).reduce((sum, value) => sum + value, 0),
    [columnCount, widthOf],
  );

  /** Tracks a drag on a resize handle and reports the pointer's travel. */
  const drag = (event: React.MouseEvent, axis: "x" | "y", onMove: (delta: number) => void) => {
    event.preventDefault();
    event.stopPropagation();
    const start = axis === "x" ? event.clientX : event.clientY;
    const move = (moveEvent: MouseEvent) => onMove((axis === "x" ? moveEvent.clientX : moveEvent.clientY) - start);
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      document.body.classList.remove("sheet-resizing-x", "sheet-resizing-y");
    };
    document.body.classList.add(axis === "x" ? "sheet-resizing-x" : "sheet-resizing-y");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  };

  const startResize = (column: number, event: React.MouseEvent) => {
    const startWidth = widthOf(column);
    drag(event, "x", (delta) => {
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
      setWidths((prior) => new Map(prior).set(column, next));
    });
  };

  const startRowResize = (row: number, event: React.MouseEvent) => {
    const startHeight = heightOf(row);
    drag(event, "y", (delta) => {
      const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight + delta));
      setHeights((prior) => new Map(prior).set(row, next));
    });
  };

  const resetRowHeight = (row: number) => {
    setHeights((prior) => {
      const next = new Map(prior);
      next.delete(row);
      return next;
    });
  };

  const autoFit = (column: number) => {
    const sample = visible.slice(0, 500).map((row) => textAt(row, column).length);
    const longest = Math.max(columnName(column).length, ...sample, 3);
    setWidths((prior) => new Map(prior).set(column, Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, longest * 8 + 22))));
  };

  const commit = (position: Position, value: string, move: "down" | "right" | "none") => {
    const original = rows[position.row]?.[position.column];
    const stored = original?.formula ?? original?.text ?? "";
    setEdits((prior) => {
      const next = new Map(prior);
      if (value === stored) next.delete(cellKey(position.row, position.column));
      else next.set(cellKey(position.row, position.column), value);
      return next;
    });
    setEditing(null);
    setEditingInBar(false);
    if (move === "down") setSelected({ row: Math.min(rows.length - 1, position.row + 1), column: position.column });
    if (move === "right") setSelected({ row: position.row, column: Math.min(columnCount - 1, position.column + 1) });
    rootRef.current?.focus();
  };

  const beginEdit = (position: Position, initial?: string) => {
    if (!editable) return;
    setSelected(position);
    setDraft(initial ?? rawAt(rows, edits, position.row, position.column));
    setEditingInBar(false);
    setEditing(position);
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditingInBar(false);
    rootRef.current?.focus();
  };

  const insert = (placement: InsertPlacement, anchor: Position, count: number) => {
    if (!workbook || !editable) return;
    const change = insertFor(placement, anchor, count);
    const next = insertCells(rows, edits, change, origin, sheetName);
    const absolute = change.axis === "row" ? origin.row + change.index : origin.column + change.index;
    setGrid(next.rows);
    setEdits(next.edits);
    setInserts((prior) => [...prior, { axis: change.axis, index: absolute, count }]);
    if (change.axis === "row") {
      setHeights((prior) => shiftKeys(prior, change.index, count));
      setSelected({ row: change.index, column: anchor.column });
    } else {
      setMinColumns(Math.max(columnCount, change.index) + count);
      setWidths((prior) => shiftKeys(prior, change.index, count));
      setFilters((prior) => shiftKeys(prior, change.index, count));
      setSelected({ row: anchor.row, column: change.index });
    }
    setEditing(null);
    setMenu(null);
    setDialog(null);
    rootRef.current?.focus();
  };

  const discard = () => {
    if (!workbook) return;
    // Inserted rows and columns moved the layout along with them.
    if (inserts.length) {
      setWidths(new Map());
      setHeights(new Map());
      setFilters(new Map());
    }
    showWorkbook(workbook);
    setEditing(null);
  };

  const save = async () => {
    if (!workbook || !dirty) return;
    setSaving(true);
    setError(null);
    const payload: CellEdit[] = [...edits.entries()].map(([key, value]) => {
      const [row, column] = key.split(":").map(Number);
      const edit: CellEdit = { row: workbook.startRow + row, column: workbook.startColumn + column, value };
      if (isFormula(value)) edit.result = calculator.result(row, column);
      return edit;
    });
    try {
      const result = await api.editSpreadsheet({
        path: file.path,
        sheetIndex: workbook.activeIndex,
        edits: payload,
        ...(inserts.length ? { inserts } : {}),
        expectedModifiedMs: file.modifiedMs,
      });
      replaceFile(tabId, result.file);
      showWorkbook(result.view);
      setSavedChanges(true);
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setSaving(false);
    }
  };

  const closeMenu = useCallback(() => setMenu(null), []);

  const openInsertDialog = (anchor: Position, initial: InsertPlacement = "row-above") => {
    if (!editable) return;
    setMenu(null);
    setDialog({ anchor, initial });
  };

  const openMenu = (event: React.MouseEvent, target: MenuState["target"], anchor: Position) => {
    event.preventDefault();
    if (!editable) return;
    if (target !== "column") setSelected(anchor);
    setMenu({ x: event.clientX, y: event.clientY, target, anchor });
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
      return;
    }
    // Excel's Ctrl+Shift+= (Ctrl++) opens the Insert dialog.
    if ((event.ctrlKey || event.metaKey) && (event.key === "+" || (event.shiftKey && event.key === "="))) {
      event.preventDefault();
      openInsertDialog(selected ?? { row: 0, column: 0 });
      return;
    }
    if (!selected || editing) return;
    if (event.key === "Enter" || event.key === "F2") { event.preventDefault(); beginEdit(selected); return; }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); if (editable) commit(selected, "", "none"); return; }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Otherwise the browser types the same key again into the new editor.
      event.preventDefault();
      beginEdit(selected, event.key);
      return;
    }
    const deltas: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const delta = event.key === "Tab" ? [0, event.shiftKey ? -1 : 1] : deltas[event.key];
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
  const pendingCount = edits.size + inserts.length;
  const address = (position: Position) =>
    `${columnName(origin.column + position.column)}${origin.row + position.row + 1}`;
  const barValue = editing ? draft : selected ? rawAt(rows, edits, selected.row, selected.column) : "";

  return (
    <div className="viewer sheet-viewer" tabIndex={0} onKeyDown={onKeyDown} ref={rootRef}>
      <div className="viewer-toolbar">
        <select
          value={workbook?.activeIndex ?? 0}
          disabled={loading || !workbook || saving}
          onChange={(event) => {
            if (dirty && !window.confirm("Discard unsaved changes and switch sheet?")) return;
            setSheetIndex(Number(event.target.value));
          }}
        >
          {(workbook?.sheets ?? []).map((sheet) => (
            <option key={sheet.index} value={sheet.index} disabled={!sheet.selectable}>
              {sheet.name}{sheet.hidden ? " (hidden)" : ""}{sheet.selectable ? "" : " — not a worksheet"}
            </option>
          ))}
        </select>
        <button className="primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "Saving…" : `Save${pendingCount ? ` (${pendingCount})` : ""}`}
        </button>
        <button className="secondary" disabled={!dirty || saving} onClick={discard}>Discard</button>
        {editable && (
          <button
            className="secondary"
            disabled={loading || !workbook || saving}
            title="Insert rows or columns (Ctrl+Shift++)"
            onClick={() => openInsertDialog(selected ?? { row: 0, column: 0 })}
          >
            Insert…
          </button>
        )}
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
          <div className="sheet-formula-bar">
            <span className="sheet-formula-address">{selected ? address(selected) : "—"}</span>
            <span className="sheet-formula-fx" title={`Supported functions: ${FUNCTIONS.join(", ")}`}>fx</span>
            <input
              className="sheet-formula-input"
              aria-label="Formula bar"
              spellCheck={false}
              value={barValue}
              disabled={!selected}
              readOnly={!editable}
              placeholder={editable && selected ? "Type a value or a formula such as =SUM(A1:A5)" : ""}
              onFocus={() => {
                if (!selected || !editable || editing) return;
                setDraft(rawAt(rows, edits, selected.row, selected.column));
                setEditingInBar(true);
                setEditing(selected);
              }}
              onChange={(event) => {
                if (!editing && selected && editable) {
                  setEditingInBar(true);
                  setEditing(selected);
                }
                setDraft(event.target.value);
              }}
              onBlur={() => { if (editing && editingInBar) commit(editing, draft, "none"); }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (!editing) return;
                if (event.key === "Enter") { event.preventDefault(); commit(editing, draft, "down"); }
                if (event.key === "Tab") { event.preventDefault(); commit(editing, draft, "right"); }
                if (event.key === "Escape") { event.preventDefault(); cancelEdit(); }
              }}
            />
          </div>
          <div className="table-header sheet-header" ref={headerRef} style={{ width: gridWidth }}>
            <div className="table-cell header-cell sheet-corner" style={{ width: HEADER_WIDTH }} />
            {Array.from({ length: columnCount }, (_, column) => (
              <div
                className={`table-cell header-cell${selected?.column === column ? " header-active" : ""}`}
                key={column}
                style={{ width: widthOf(column) }}
                onContextMenu={(event) => openMenu(event, "column", { row: selected?.row ?? 0, column })}
              >
                <span className="sheet-column-name">{columnName(origin.column + column)}</span>
                <button
                  className={`sheet-filter-button${isFiltered(filters.get(column)) ? " active" : ""}`}
                  title={`Filter column ${columnName(origin.column + column)}`}
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
                    rowCount={rows.length}
                    textAt={textAt}
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
                const height = heightOf(row);
                return (
                  <div
                    className="table-row"
                    key={row}
                    style={{ transform: `translateY(${virtualRow.start}px)`, width: gridWidth, height }}
                  >
                    <div
                      className={`table-cell sheet-row-number${selected?.row === row ? " header-active" : ""}`}
                      style={{ width: HEADER_WIDTH, height }}
                      onContextMenu={(event) => openMenu(event, "row", { row, column: selected?.column ?? 0 })}
                    >
                      {origin.row + row + 1}
                      <div
                        className="row-resize-handle"
                        onMouseDown={(event) => startRowResize(row, event)}
                        onDoubleClick={() => resetRowHeight(row)}
                        title="Drag to resize, double-click to reset"
                      />
                    </div>
                    {Array.from({ length: columnCount }, (_, column) => {
                      const key = cellKey(row, column);
                      const changed = edits.has(key);
                      const isSelected = selected?.row === row && selected.column === column;
                      const isEditing = editing?.row === row && editing.column === column;
                      if (isEditing && !editingInBar) {
                        return (
                          <input
                            key={column}
                            className="sheet-editor"
                            autoFocus
                            spellCheck={false}
                            value={draft}
                            style={{ width: widthOf(column), height }}
                            onChange={(event) => setDraft(event.target.value)}
                            onBlur={() => commit({ row, column }, draft, "none")}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === "Enter") { event.preventDefault(); commit({ row, column }, draft, "down"); }
                              if (event.key === "Tab") { event.preventDefault(); commit({ row, column }, draft, "right"); }
                              if (event.key === "Escape") { event.preventDefault(); cancelEdit(); }
                            }}
                          />
                        );
                      }
                      const text = isEditing ? draft : textAt(row, column);
                      const formula = isFormula(rawAt(rows, edits, row, column));
                      return (
                        <div
                          key={column}
                          className={`table-cell sheet-cell ${cellClass(calculator.kind(row, column), changed, formula)} ${isSelected ? "selected" : ""}`}
                          style={{ width: widthOf(column), height }}
                          title={text}
                          onClick={() => setSelected({ row, column })}
                          onDoubleClick={() => beginEdit({ row, column })}
                          onContextMenu={(event) => openMenu(event, "cell", { row, column })}
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
            <span className="muted small">{activeSheet?.name}</span>
            <span className="spacer" />
            <span className="muted small">
              {edits.size > 0 && `${edits.size} unsaved cell${edits.size === 1 ? "" : "s"}`}
              {edits.size > 0 && inserts.length > 0 && " · "}
              {inserts.length > 0 && `${inserts.length} unsaved insert${inserts.length === 1 ? "" : "s"}`}
            </span>
          </div>
        </>
      )}
      {menu && (
        <SheetContextMenu
          x={menu.x}
          y={menu.y}
          target={menu.target}
          onPick={(placement) => insert(placement, menu.anchor, 1)}
          onOpenDialog={() => openInsertDialog(menu.anchor, menu.target === "column" ? "column-left" : "row-above")}
          onResetHeight={menu.target === "row" && heights.has(menu.anchor.row) ? () => { resetRowHeight(menu.anchor.row); setMenu(null); } : undefined}
          onClose={closeMenu}
        />
      )}
      {dialog && (
        <InsertDialog
          anchorLabel={address(dialog.anchor)}
          initial={dialog.initial}
          onInsert={(placement, count) => insert(placement, dialog.anchor, count)}
          onClose={() => { setDialog(null); rootRef.current?.focus(); }}
        />
      )}
    </div>
  );
}

function cellClass(kind: CellKind, changed: boolean, formula: boolean): string {
  const classes = [kind === "empty" ? "" : `cell-${kind}`];
  if (changed) classes.push("cell-changed");
  if (formula) classes.push("cell-formula");
  return classes.join(" ");
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
