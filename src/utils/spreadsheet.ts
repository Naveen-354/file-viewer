import type { SpreadsheetCell } from "../types/files";

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

export function cellKey(row: number, column: number): string {
  return `${row}:${column}`;
}

/** Unsaved edits shadow the value read from the file. */
export function valueAt(rows: SpreadsheetCell[][], edits: Edits, row: number, column: number): string {
  const pending = edits.get(cellKey(row, column));
  return pending ?? rows[row]?.[column]?.text ?? "";
}

export function isFiltered(filter: ColumnFilter | undefined): boolean {
  return !!filter && (filter.query.trim() !== "" || filter.excluded.size > 0);
}

/**
 * Excel lists the values still reachable through the *other* columns' filters,
 * so unticking a value never makes the remaining choices disappear.
 */
export function distinctValues(
  rows: SpreadsheetCell[][],
  edits: Edits,
  filters: Map<number, ColumnFilter>,
  column: number,
  limit = 1000,
): { values: string[]; truncated: boolean } {
  const others = new Map(filters);
  others.delete(column);
  const seen = new Set<string>();
  for (const row of visibleRowIndexes(rows, edits, others)) {
    seen.add(valueAt(rows, edits, row, column));
    if (seen.size > limit) break;
  }
  const values = [...seen].sort((left, right) =>
    left === "" ? 1 : right === "" ? -1 : left.localeCompare(right, undefined, { numeric: true }),
  );
  return { values: values.slice(0, limit), truncated: values.length > limit };
}

export function visibleRowIndexes(
  rows: SpreadsheetCell[][],
  edits: Edits,
  filters: Map<number, ColumnFilter>,
): number[] {
  const active = [...filters.entries()].filter(([, filter]) => isFiltered(filter));
  const indexes: number[] = [];
  for (let row = 0; row < rows.length; row += 1) {
    if (active.every(([column, filter]) => matches(valueAt(rows, edits, row, column), filter))) {
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
