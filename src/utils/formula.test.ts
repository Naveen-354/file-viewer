import { describe, expect, it } from "vitest";
import { classifyInput, evaluate, shiftFormula, type Scalar } from "./formula";
import { createCalculator, insertCells, rawAt, shiftKeys } from "./spreadsheet";
import type { SpreadsheetCell } from "../types/files";

/** A1-style grid: rows of values, top-left at A1. */
function run(formula: string, grid: Scalar[][] = []): Scalar {
  const lookup = (row: number, column: number) => grid[row]?.[column] ?? null;
  const columns = Math.max(0, ...grid.map((row) => row.length));
  return evaluate(formula, lookup, { rows: grid.length, columns }, "Sheet1");
}

const data: Scalar[][] = [
  ["Region", "Units", "Price"],
  ["North", 10, 2.5],
  ["South", 20, 3],
  ["north", 5, "n/a"],
  [null, true, 4],
];

describe("formula arithmetic", () => {
  it("follows Excel's operator precedence", () => {
    expect(run("=1+2*3")).toBe(7);
    expect(run("=(1+2)*3")).toBe(9);
    expect(run("=-2^2")).toBe(4);
    expect(run("=2^3^2")).toBe(64);
    expect(run("=50%*10")).toBe(5);
    expect(run("=1+2&\"x\"")).toBe("3x");
    expect(run("=1+1=2")).toBe(true);
  });

  it("reads cells and treats blanks as zero", () => {
    expect(run("=B2*C2", data)).toBe(25);
    expect(run("=A5+1", data)).toBe(1);
    expect(run("=A5", data)).toBe(0);
  });

  it("returns Excel's errors", () => {
    expect(run("=1/0")).toEqual({ error: "#DIV/0!" });
    expect(run("=C4*2", data)).toEqual({ error: "#VALUE!" });
    expect(run("=NOPE(1)")).toEqual({ error: "#NAME?" });
    expect(run("=SUM(1,")).toEqual({ error: "#NAME?" });
    expect(run("=Other!A1")).toEqual({ error: "#REF!" });
    expect(run("=Sheet1!B2", data)).toBe(10);
  });

  it("avoids binary noise in results", () => {
    expect(run("=0.1+0.2")).toBeCloseTo(0.3);
  });
});

describe("number functions", () => {
  it("aggregates ranges, skipping text and booleans inside them", () => {
    expect(run("=SUM(B2:B5)", data)).toBe(35);
    expect(run("=SUM(C:C)", data)).toBe(9.5);
    expect(run("=SUM(2:2)", data)).toBe(12.5);
    expect(run("=AVERAGE(B2:B4)", data)).toBeCloseTo(35 / 3);
    expect(run("=MIN(B2:B4)", data)).toBe(5);
    expect(run("=MAX(B2:C4,100)", data)).toBe(100);
    expect(run("=COUNT(A1:C5)", data)).toBe(6);
    expect(run("=COUNTA(A1:A5)", data)).toBe(4);
    expect(run("=COUNTBLANK(A1:A5)", data)).toBe(1);
    expect(run("=PRODUCT(B2,B3)", data)).toBe(200);
    expect(run("=MEDIAN(1,5,3,10)")).toBe(4);
    expect(run("=SUM(\"4\",TRUE)")).toBe(5);
  });

  it("rounds like Excel, including halves away from zero", () => {
    expect(run("=ROUND(2.345,2)")).toBe(2.35);
    expect(run("=ROUND(-2.5,0)")).toBe(-3);
    expect(run("=ROUNDUP(1.21,1)")).toBe(1.3);
    expect(run("=ROUNDDOWN(-1.29,1)")).toBe(-1.2);
    expect(run("=INT(-1.5)")).toBe(-2);
    expect(run("=MOD(-3,2)")).toBe(1);
    expect(run("=ABS(-4)+SQRT(9)+POWER(2,3)")).toBe(15);
  });

  it("applies SUMIF, COUNTIF and AVERAGEIF criteria", () => {
    expect(run("=SUMIF(A2:A4,\"north\",B2:B4)", data)).toBe(15);
    expect(run("=COUNTIF(B2:B5,\">=10\")", data)).toBe(2);
    expect(run("=COUNTIF(A2:A5,\"<>North\")", data)).toBe(2);
    expect(run("=COUNTIF(A2:A5,\"S*\")", data)).toBe(1);
    expect(run("=COUNTIF(A2:A5,\"\")", data)).toBe(1);
    expect(run("=AVERAGEIF(B2:B4,\">5\")", data)).toBe(15);
  });
});

describe("logic functions", () => {
  it("only evaluates the branch IF takes", () => {
    expect(run("=IF(B2>5,\"big\",\"small\")", data)).toBe("big");
    expect(run("=IF(FALSE,1/0,\"safe\")")).toBe("safe");
    expect(run("=IF(FALSE,1)")).toBe(false);
    expect(run("=IFERROR(1/0,\"none\")")).toBe("none");
    expect(run("=IFNA(1/0,0)")).toEqual({ error: "#DIV/0!" });
    expect(run("=IFS(B2>50,\"a\",B2>5,\"b\")", data)).toBe("b");
    expect(run("=SWITCH(2,1,\"one\",2,\"two\",\"other\")")).toBe("two");
    expect(run("=AND(TRUE,1,B2>1)", data)).toBe(true);
    expect(run("=OR(FALSE,0)")).toBe(false);
    expect(run("=NOT(0)")).toBe(true);
  });
});

describe("text functions", () => {
  it("joins and slices strings", () => {
    expect(run("=A2&\" \"&B2", data)).toBe("North 10");
    expect(run("=CONCAT(A2:A3,\"!\")", data)).toBe("NorthSouth!");
    expect(run("=CONCATENATE(\"a\",1,TRUE)")).toBe("a1TRUE");
    expect(run("=TEXTJOIN(\", \",TRUE,A2:A5)", data)).toBe("North, South, north");
    expect(run("=LEFT(\"spreadsheet\",6)&RIGHT(\"abc\")&MID(\"abcdef\",2,3)")).toBe("spreadcbcd");
    expect(run("=LEN(\"héllo\")")).toBe(5);
    expect(run("=UPPER(\"a\")&LOWER(\"B\")&PROPER(\"hello wORLD\")")).toBe("AbHello World");
    expect(run("=TRIM(\"  a   b  \")")).toBe("a b");
    expect(run("=SUBSTITUTE(\"a-b-c\",\"-\",\"+\")")).toBe("a+b+c");
    expect(run("=SUBSTITUTE(\"a-b-c\",\"-\",\"+\",2)")).toBe("a-b+c");
    expect(run("=REPLACE(\"abcdef\",2,3,\"X\")")).toBe("aXef");
    expect(run("=FIND(\"b\",\"abcb\",3)")).toBe(4);
    expect(run("=SEARCH(\"B\",\"abc\")")).toBe(2);
    expect(run("=FIND(\"B\",\"abc\")")).toEqual({ error: "#VALUE!" });
    expect(run("=REPT(\"ab\",3)")).toBe("ababab");
    expect(run("=EXACT(\"a\",\"A\")")).toBe(false);
    expect(run("=VALUE(\"1,234.5\")+1")).toBe(1235.5);
    expect(run("=TEXT(1234.567,\"#,##0.00\")")).toBe("1,234.57");
    expect(run("=TEXT(0.256,\"0.0%\")")).toBe("25.6%");
    expect(run("=\"say \"\"hi\"\"\"")).toBe('say "hi"');
  });

  it("compares text case-insensitively", () => {
    expect(run("=\"abc\"=\"ABC\"")).toBe(true);
    expect(run("=\"a\"<\"B\"")).toBe(true);
    expect(run("=ISTEXT(A2)&ISNUMBER(B2)&ISBLANK(A5)", data)).toBe("TRUETRUETRUE");
  });

  it("accepts the _xlfn prefix files store newer functions with", () => {
    expect(run("=_xlfn.CONCAT(\"a\",\"b\")")).toBe("ab");
  });
});

describe("typed input", () => {
  it("classifies values the way the backend stores them", () => {
    expect(classifyInput("42")).toBe(42);
    expect(classifyInput(" true ")).toBe(true);
    expect(classifyInput("'0042")).toBe("0042");
    expect(classifyInput("")).toBeNull();
    expect(classifyInput("12 apples")).toBe("12 apples");
  });
});

describe("shifting formulas for inserts", () => {
  const rows = (index: number, count = 1) => ({ axis: "row" as const, index, count });
  const columns = (index: number, count = 1) => ({ axis: "column" as const, index, count });

  it("moves references at or after the insert and grows spanning ranges", () => {
    expect(shiftFormula("=A1+A3", rows(2, 2), "S")).toBe("=A1+A5");
    expect(shiftFormula("=SUM($B$2:B10)", rows(2), "S")).toBe("=SUM($B$2:B11)");
    expect(shiftFormula("=SUM(A:A)", rows(0), "S")).toBe("=SUM(A:A)");
    expect(shiftFormula("=SUM(A:B)", columns(1), "S")).toBe("=SUM(A:C)");
    expect(shiftFormula("=B1&\"B1\"", columns(1), "S")).toBe("=C1&\"B1\"");
    expect(shiftFormula("=LOG10(B1)+Other!B1+S!B1", columns(1), "S")).toBe("=LOG10(C1)+Other!B1+S!C1");
    expect(shiftFormula("=XFD1", columns(0), "S")).toBe("=#REF!");
  });
});

describe("sheet calculator", () => {
  const cell = (text: string, kind: SpreadsheetCell["kind"] = "number", formula?: string): SpreadsheetCell =>
    ({ text, kind, ...(formula ? { formula } : {}) });
  const grid: SpreadsheetCell[][] = [
    [cell("2"), cell("3"), cell("5", "number", "=A1+B1")],
  ];
  const options = { startRow: 0, startColumn: 0, sheet: "S", recalculate: false };

  it("shows the file's stored value until something changes", () => {
    const stored = createCalculator(grid, new Map(), options);
    expect(stored.text(0, 2)).toBe("5");
    const edited = createCalculator(grid, new Map([["0:0", "10"]]), { ...options, recalculate: true });
    expect(edited.text(0, 2)).toBe("13");
    expect(edited.kind(0, 2)).toBe("number");
  });

  it("evaluates pending formulas against pending values", () => {
    const edits = new Map([["1:0", "=A1*B1"], ["1:1", "=UPPER(\"ok\")"], ["1:2", "=C2"]]);
    const calculator = createCalculator(grid, edits, options);
    expect(calculator.text(1, 0)).toBe("6");
    expect(calculator.result(1, 1)).toEqual({ kind: "text", text: "OK" });
    expect(calculator.text(1, 2)).toBe("#CIRC!");
    expect(rawAt(grid, edits, 1, 0)).toBe("=A1*B1");
    expect(rawAt(grid, new Map(), 0, 2)).toBe("=A1+B1");
  });

  it("keeps a stored value when the engine lacks the formula's function", () => {
    const unsupported = [[cell("7", "number", "=XLOOKUP(1,A1:A2,B1:B2)")]];
    const calculator = createCalculator(unsupported, new Map(), { ...options, recalculate: true });
    expect(calculator.text(0, 0)).toBe("7");
  });

  it("shows an error that flows in from an edited cell instead of the stale value", () => {
    const edits = new Map([["0:0", "=1/0"]]);
    const calculator = createCalculator(grid, edits, { ...options, recalculate: true });
    expect(calculator.text(0, 2)).toBe("#DIV/0!");
  });

  it("resolves references relative to where the grid starts on the sheet", () => {
    // The loaded grid starts at C3, so A1-style C3 is grid cell (0, 0).
    const calculator = createCalculator(grid, new Map([["1:0", "=C3+D3"]]), { ...options, startRow: 2, startColumn: 2 });
    expect(calculator.text(1, 0)).toBe("5");
  });

  it("follows a long chain without overflowing the stack", () => {
    const edits = new Map<string, string>([["0:0", "1"]]);
    for (let row = 1; row < 5000; row += 1) edits.set(`${row}:0`, `=A${row}+1`);
    expect(createCalculator([], edits, options).text(4999, 0)).toBe("5000");
  });
});

describe("inserting rows and columns in the grid", () => {
  const cell = (text: string, formula?: string): SpreadsheetCell => ({ text, kind: "number", ...(formula ? { formula } : {}) });
  const grid = [[cell("1"), cell("2")], [cell("3"), cell("4", "=A1+A2")]];

  it("adds blank rows and shifts formulas and edits below them", () => {
    const edits = new Map([["1:0", "=B2*2"], ["0:0", "9"]]);
    const result = insertCells(grid, edits, { axis: "row", index: 1, count: 2 }, { row: 0, column: 0 }, "S");
    expect(result.rows.length).toBe(4);
    expect(result.rows[1]).toEqual([]);
    expect(result.rows[3][1].formula).toBe("=A1+A4");
    expect([...result.edits]).toEqual([["3:0", "=B4*2"], ["0:0", "9"]]);
  });

  it("adds blank columns and shifts cells to their right", () => {
    const result = insertCells(grid, new Map(), { axis: "column", index: 1, count: 1 }, { row: 0, column: 0 }, "S");
    expect(result.rows[0].map((item) => item.text)).toEqual(["1", "", "2"]);
    expect(result.rows[1][2].formula).toBe("=A1+A2");
  });

  it("uses absolute positions when the grid does not start at A1", () => {
    const result = insertCells(grid, new Map(), { axis: "row", index: 0, count: 1 }, { row: 4, column: 0 }, "S");
    // Grid row 0 is sheet row 5, so a reference to A1 is above the insert.
    expect(result.rows[2][1].formula).toBe("=A1+A2");
  });

  it("moves per-row settings past the insert", () => {
    expect([...shiftKeys(new Map([[0, 40], [3, 60]]), 2, 5)]).toEqual([[0, 40], [8, 60]]);
  });
});
