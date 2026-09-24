import type { CellKind, FormulaResult, SpreadsheetCell } from "../types/files";
import {
  canEvaluate,
  classifyInput,
  evaluate,
  formatNumber,
  isError,
  isFormula,
  shiftFormula,
  type Insert,
  type Scalar,
} from "./formula";

/** Converts a zero-based column index into its spreadsheet letters (0 → A, 26 → AA). */
export function columnName(index: number): string {
  let name = "";
  for (let value = index; value >= 0; value = Math.floor(value / 26) - 1) {
    name = String.fromCharCode(65 + (value % 26)) + name;
  }
  return name;
}

/** A column filter combines Excel's search box with its value checklist. */
export interface ColumnFilter {
  query: string;
  excluded: Set<string>;
}

export type Edits = Map<string, string>;

/** Reads the text a cell displays, by row and column in the loaded grid. */
export type TextAt = (row: number, column: number) => string;

export function cellKey(row: number, column: number): string {
  return `${row}:${column}`;
}

/** What the cell holds as typed: a pending edit, else its formula, else its value. */
export function rawAt(rows: SpreadsheetCell[][], edits: Edits, row: number, column: number): string {
  const pending = edits.get(cellKey(row, column));
  if (pending !== undefined) return pending;
  const cell = rows[row]?.[column];
  return cell?.formula ?? cell?.text ?? "";
}

export interface CalculatorOptions {
  /** Where the loaded grid sits on the sheet, so A1 references resolve. */
  startRow: number;
  startColumn: number;
  sheet: string | null;
  /**
   * Recompute formulas read from the file. Off until something changes, so an
   * untouched workbook shows exactly the values its author's app saved.
   */
  recalculate: boolean;
}

export interface Calculator {
  scalar: (row: number, column: number) => Scalar;
  text: TextAt;
  kind: (row: number, column: number) => CellKind;
  /** The computed value to cache in the file alongside a formula. */
  result: (row: number, column: number) => FormulaResult;
}

const KEY_STRIDE = 1 << 15;

/**
 * Evaluates the grid lazily, memoising every cell. Unsaved edits shadow the
 * value read from the file, and formulas see those edits.
 */
export function createCalculator(rows: SpreadsheetCell[][], edits: Edits, options: CalculatorOptions): Calculator {
  const cache = new Map<number, Scalar>();
  const evaluating = new Set<number>();
  let columns = 0;
  for (const row of rows) if (row.length > columns) columns = row.length;
  let lastRow = rows.length;
  for (const key of edits.keys()) {
    const [row, column] = key.split(":").map(Number);
    if (column + 1 > columns) columns = column + 1;
    if (row + 1 > lastRow) lastRow = row + 1;
  }
  const bounds = { rows: options.startRow + lastRow, columns: options.startColumn + columns };

  // A formula the engine cannot compute keeps the value the file was saved with.
  const computes = (row: number, column: number) => {
    const pending = edits.get(cellKey(row, column));
    if (pending !== undefined) return isFormula(pending);
    const formula = rows[row]?.[column]?.formula;
    return options.recalculate && !!formula && canEvaluate(formula, options.sheet);
  };

  const scalar = (row: number, column: number): Scalar => {
    if (row < 0 || column < 0) return null;
    const key = row * KEY_STRIDE + column;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const pending = edits.get(cellKey(row, column));
    const cell = rows[row]?.[column];
    let value: Scalar;
    if (pending !== undefined) {
      value = isFormula(pending) ? compute(key, pending) : classifyInput(pending);
    } else if (cell?.formula && computes(row, column)) {
      value = compute(key, cell.formula);
    } else {
      value = fromCell(cell);
    }
    cache.set(key, value);
    return value;
  };

  const compute = (key: number, formula: string): Scalar => {
    if (evaluating.has(key)) return { error: "#CIRC!" };
    evaluating.add(key);
    let value: Scalar;
    try {
      value = evaluate(
        formula,
        (row, column) => scalar(row - options.startRow, column - options.startColumn),
        bounds,
        options.sheet,
      );
    } finally {
      evaluating.delete(key);
    }
    return value;
  };

  // Chains that run down the sheet (A2 = A1 + 1, ...) are the norm; filling
  // the cache in reading order keeps each lookup one level deep instead of
  // recursing through the whole chain.
  if (options.recalculate || [...edits.values()].some(isFormula)) {
    for (let row = 0; row < lastRow; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        if (computes(row, column)) scalar(row, column);
      }
    }
  }

  const stored = (row: number, column: number) => !computes(row, column) && !edits.has(cellKey(row, column));
  return {
    scalar,
    text: (row, column) => (stored(row, column) ? rows[row]?.[column]?.text ?? "" : display(scalar(row, column))),
    kind: (row, column) => (stored(row, column) ? rows[row]?.[column]?.kind ?? "empty" : kindOf(scalar(row, column))),
    result: (row, column) => {
      const value = scalar(row, column);
      const kind = kindOf(value);
      return { kind: kind === "empty" ? "text" : (kind as FormulaResult["kind"]), text: display(value) };
    },
  };
}

function fromCell(cell: SpreadsheetCell | undefined): Scalar {
  if (!cell) return null;
  switch (cell.kind) {
    case "empty": return null;
    case "number": {
      const number = Number(cell.text);
      return Number.isFinite(number) ? number : cell.text;
    }
    case "boolean": return cell.text.toUpperCase() === "TRUE";
    case "error": return { error: cell.text };
    default: return cell.text;
  }
}

function display(value: Scalar): string {
  if (value === null) return "";
  if (isError(value)) return value.error;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return formatNumber(value);
  return value;
}

function kindOf(value: Scalar): CellKind {
  if (value === null) return "empty";
  if (isError(value)) return "error";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "text";
}

/**
 * Inserts blank rows or columns into the loaded grid and moves everything
 * after them, including the references inside formulas and pending edits.
 * `insert.index` is relative to the grid; `start` is the grid's offset.
 */
export function insertCells(
  rows: SpreadsheetCell[][],
  edits: Edits,
  insert: Insert,
  start: { row: number; column: number },
  sheet: string | null,
): { rows: SpreadsheetCell[][]; edits: Edits } {
  const absolute: Insert = { ...insert, index: insert.index + (insert.axis === "row" ? start.row : start.column) };
  const shifted = rows.map((row) => {
    const cells = row.some((cell) => cell.formula)
      ? row.map((cell) => (cell.formula ? { ...cell, formula: shiftFormula(cell.formula, absolute, sheet) } : cell))
      : row;
    if (insert.axis === "row" || cells.length <= insert.index) return cells;
    const blanks = Array.from({ length: insert.count }, (): SpreadsheetCell => ({ text: "", kind: "empty" }));
    return [...cells.slice(0, insert.index), ...blanks, ...cells.slice(insert.index)];
  });
  if (insert.axis === "row") {
    shifted.splice(Math.min(insert.index, shifted.length), 0, ...Array.from({ length: insert.count }, () => []));
  }

  const moved: Edits = new Map();
  for (const [key, value] of edits) {
    let [row, column] = key.split(":").map(Number);
    if (insert.axis === "row" && row >= insert.index) row += insert.count;
    if (insert.axis === "column" && column >= insert.index) column += insert.count;
    moved.set(cellKey(row, column), isFormula(value) ? shiftFormula(value, absolute, sheet) : value);
  }
  return { rows: shifted, edits: moved };
}

/** Moves per-row or per-column settings (widths, heights, filters) past an insert. */
export function shiftKeys<T>(map: Map<number, T>, index: number, count: number): Map<number, T> {
  const next = new Map<number, T>();
  for (const [key, value] of map) next.set(key >= index ? key + count : key, value);
  return next;
}

export function isFiltered(filter: ColumnFilter | undefined): boolean {
  return !!filter && (filter.query.trim() !== "" || filter.excluded.size > 0);
}

/**
 * Excel lists the values still reachable through the *other* columns' filters,
 * so unticking a value never makes the remaining choices disappear.
 */
export function distinctValues(
  rowCount: number,
  textAt: TextAt,
  filters: Map<number, ColumnFilter>,
  column: number,
  limit = 1000,
): { values: string[]; truncated: boolean } {
  const others = new Map(filters);
  others.delete(column);
  const seen = new Set<string>();
  for (const row of visibleRowIndexes(rowCount, textAt, others)) {
    seen.add(textAt(row, column));
    if (seen.size > limit) break;
  }
  const values = [...seen].sort((left, right) =>
    left === "" ? 1 : right === "" ? -1 : left.localeCompare(right, undefined, { numeric: true }),
  );
  return { values: values.slice(0, limit), truncated: values.length > limit };
}

export function visibleRowIndexes(
  rowCount: number,
  textAt: TextAt,
  filters: Map<number, ColumnFilter>,
): number[] {
  const active = [...filters.entries()].filter(([, filter]) => isFiltered(filter));
  const indexes: number[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    if (active.every(([column, filter]) => matches(textAt(row, column), filter))) {
      indexes.push(row);
    }
  }
  return indexes;
}

function matches(value: string, filter: ColumnFilter): boolean {
  const query = filter.query.trim().toLowerCase();
  if (query && !value.toLowerCase().includes(query)) return false;
  return !filter.excluded.has(value);
}
