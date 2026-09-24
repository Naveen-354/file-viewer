import { describe, expect, it } from "vitest";
import { columnName, createCalculator, distinctValues, isFiltered, visibleRowIndexes, type Edits } from "../../utils/spreadsheet";
import type { SpreadsheetCell } from "../../types/files";
import { handlerFor, handlers } from "../registry";

describe("spreadsheet column labels", () => {
  it("matches the spreadsheet alphabet past the first cycle", () => {
    expect(columnName(0)).toBe("A");
    expect(columnName(25)).toBe("Z");
    expect(columnName(26)).toBe("AA");
    expect(columnName(27)).toBe("AB");
    expect(columnName(701)).toBe("ZZ");
    expect(columnName(702)).toBe("AAA");
  });
});

describe("office handler registration", () => {
  it("routes workbook and document handler ids to lazily loaded viewers", () => {
    expect(handlerFor("spreadsheet").id).toBe("spreadsheet");
    expect(handlerFor("document").id).toBe("document");
    expect(handlerFor("spreadsheet").supportedExtensions).toContain("xlsx");
    expect(handlerFor("spreadsheet").supportedExtensions).toContain("xls");
    expect(handlerFor("document").supportedExtensions).toContain("docx");
  });

  it("keeps an unknown handler id on the fallback viewer", () => {
    expect(handlerFor("doc").id).toBe("fallback");
    expect(handlers.at(-1)?.id).toBe("fallback");
  });
});

describe("column filters", () => {
  const cell = (text: string): SpreadsheetCell => ({ text, kind: "text" });
  const rows: SpreadsheetCell[][] = [
    [cell("North"), cell("10")],
    [cell("South"), cell("20")],
    [cell("North"), cell("30")],
    [cell(""), cell("40")],
  ];
  const none: Edits = new Map();
  const textOf = (edits: Edits) =>
    createCalculator(rows, edits, { startRow: 0, startColumn: 0, sheet: null, recalculate: false }).text;

  it("keeps only rows matching every active column filter", () => {
    const filters = new Map([[0, { query: "nor", excluded: new Set<string>() }]]);
    expect(visibleRowIndexes(rows.length, textOf(none), filters)).toEqual([0, 2]);
  });

  it("excludes unticked values and combines with the contains box", () => {
    const filters = new Map([
      [0, { query: "", excluded: new Set(["South"]) }],
      [1, { query: "", excluded: new Set(["10"]) }],
    ]);
    expect(visibleRowIndexes(rows.length, textOf(none), filters)).toEqual([2, 3]);
  });

  it("filters on unsaved edits rather than the value on disk", () => {
    const edits: Edits = new Map([["1:0", "North"]]);
    const filters = new Map([[0, { query: "north", excluded: new Set<string>() }]]);
    expect(visibleRowIndexes(rows.length, textOf(edits), filters)).toEqual([0, 1, 2]);
  });

  it("lists distinct values from the other columns' filtered rows, blanks last", () => {
    const { values } = distinctValues(rows.length, textOf(none), new Map(), 0);
    expect(values).toEqual(["North", "South", ""]);
    const narrowed = distinctValues(rows.length, textOf(none), new Map([[1, { query: "40", excluded: new Set<string>() }]]), 0);
    expect(narrowed.values).toEqual([""]);
  });

  it("does not narrow its own column's choices", () => {
    const filters = new Map([[0, { query: "", excluded: new Set(["North"]) }]]);
    expect(distinctValues(rows.length, textOf(none), filters, 0).values).toEqual(["North", "South", ""]);
  });

  it("treats an empty filter as inactive", () => {
    expect(isFiltered({ query: "  ", excluded: new Set() })).toBe(false);
    expect(isFiltered({ query: "", excluded: new Set(["x"]) })).toBe(true);
  });
});
