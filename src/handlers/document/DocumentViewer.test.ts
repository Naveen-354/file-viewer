import { describe, expect, it } from "vitest";
import {
  densityOf, documentText, formatDocDate, formatEditTime, outlineOf, withMarkers,
} from "../../utils/document";
import type { DocumentBlock } from "../../types/files";

const paragraph = (listLevel: number | null, ordered = false): DocumentBlock => ({
  kind: "paragraph",
  style: null,
  headingLevel: null,
  listLevel,
  ordered,
  runs: [{ text: "item", bold: false, italic: false, underline: false }],
});

describe("document list markers", () => {
  it("numbers ordered items and restarts after the list ends", () => {
    const markers = withMarkers([
      paragraph(0, true),
      paragraph(0, true),
      paragraph(null),
      paragraph(0, true),
    ]).map((entry) => entry.marker);
    expect(markers).toEqual(["1.", "2.", null, "1."]);
  });

  it("counts nested levels independently and resets them when the level closes", () => {
    const markers = withMarkers([
      paragraph(0, true),
      paragraph(1, true),
      paragraph(1, true),
      paragraph(0, true),
      paragraph(1, true),
    ]).map((entry) => entry.marker);
    expect(markers).toEqual(["1.", "1.", "2.", "2.", "1."]);
  });

  it("bullets unordered items and leaves tables unmarked", () => {
    const markers = withMarkers([
      paragraph(0),
      { kind: "table", rows: [["a"]] },
    ]).map((entry) => entry.marker);
    expect(markers).toEqual(["•", null]);
  });
});

const heading = (level: number, text: string): DocumentBlock => ({
  kind: "paragraph", style: `Heading${level}`, headingLevel: level, listLevel: null, ordered: false,
  runs: [{ text, bold: false, italic: false, underline: false }],
});

const body = (text: string): DocumentBlock => ({
  kind: "paragraph", style: null, headingLevel: null, listLevel: null, ordered: false,
  runs: [{ text, bold: false, italic: false, underline: false }],
});

describe("document outline", () => {
  it("keeps headings in order with the block index the page can scroll to", () => {
    expect(outlineOf([body("intro"), heading(1, "One"), body("x"), heading(2, "Two")])).toEqual([
      { index: 1, level: 1, text: "One" },
      { index: 3, level: 2, text: "Two" },
    ]);
  });

  it("skips a heading with no text rather than listing a blank entry", () => {
    expect(outlineOf([heading(1, "   ")])).toEqual([]);
  });
});

describe("document density", () => {
  it("separates headings, list items, empty paragraphs and body text", () => {
    const density = densityOf([
      heading(1, "Title"),
      body("hello"),
      body(""),
      paragraph(0, true),
      { kind: "table", rows: [["a", "bb"], ["c", "d"]] },
    ]);
    expect(density.headings).toBe(1);
    expect(density.paragraphs).toBe(1);
    expect(density.emptyParagraphs).toBe(1);
    expect(density.listItems).toBe(1);
    expect(density.tables).toBe(1);
    expect(density.tableCells).toBe(4);
    expect(density.characters).toBe("Title".length + "hello".length + "item".length + 5);
  });
});

describe("document export text", () => {
  it("writes one line per block and tabs between table cells", () => {
    expect(documentText([heading(1, "T"), { kind: "table", rows: [["a", "b"]] }])).toBe("T\na\tb");
  });
});

describe("document formatting", () => {
  it("shows edit time in minutes and then in hours", () => {
    expect(formatEditTime(0)).toBe("0 min");
    expect(formatEditTime(59)).toBe("59 min");
    expect(formatEditTime(135)).toBe("2 h 15 min");
    expect(formatEditTime(null)).toBeNull();
  });

  it("leaves an unparseable date exactly as the document stored it", () => {
    expect(formatDocDate("not a date")).toBe("not a date");
    expect(formatDocDate(null)).toBeNull();
    expect(formatDocDate("2024-03-01T10:00:00Z")).not.toBe("2024-03-01T10:00:00Z");
  });
});
