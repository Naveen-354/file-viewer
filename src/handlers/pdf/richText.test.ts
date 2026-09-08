import { describe, expect, it } from "vitest";
import { DEFAULT_STYLE, faceFor, hexToRgb, layoutRuns, sanitizeText, type TextRun } from "./editing";
import { familyFrom, htmlFromRuns, mergeRuns, runsFromElement, toHex } from "./richText";

const run = (text: string, overrides: Partial<TextRun> = {}): TextRun => ({ ...DEFAULT_STYLE, text, ...overrides });

function parse(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  return runsFromElement(root, DEFAULT_STYLE);
}

describe("editor markup to PDF runs", () => {
  it("reads bold, italic, underline and strike from tags and inline styles", () => {
    expect(parse("<b>a</b>")[0].bold).toBe(true);
    expect(parse("<i>a</i>")[0].italic).toBe(true);
    expect(parse("<u>a</u>")[0].underline).toBe(true);
    expect(parse("<s>a</s>")[0].strike).toBe(true);
    expect(parse('<span style="font-weight:700">a</span>')[0].bold).toBe(true);
    expect(parse('<span style="text-decoration:line-through">a</span>')[0].strike).toBe(true);
  });

  it("lets an inner span override an outer one, the way CSS cascades", () => {
    const runs = parse('<span style="font-weight:700">bold <span style="font-weight:400">normal</span></span>');
    expect(runs.map((item) => [item.text, item.bold])).toEqual([["bold ", true], ["normal", false]]);
  });

  it("carries size, colour and family across", () => {
    const [only] = parse('<span style="font-size:22px;color:rgb(255, 0, 0);font-family:Times New Roman, serif">x</span>');
    expect(only.size).toBe(22);
    expect(only.color).toBe("#ff0000");
    expect(only.font).toBe("times");
  });

  it("turns line breaks and block elements into newlines", () => {
    expect(parse("a<br>b").map((item) => item.text).join("")).toBe("a\nb");
    expect(parse("<div>a</div><div>b</div>").map((item) => item.text).join("")).toBe("a\nb");
  });

  it("merges neighbouring runs that share every attribute", () => {
    expect(mergeRuns([run("a"), run("b"), run("c", { bold: true })])).toEqual([
      run("ab"),
      run("c", { bold: true }),
    ]);
  });

  it("round-trips runs through editable markup", () => {
    const original = [run("plain "), run("bold", { bold: true, size: 20 })];
    expect(parse(htmlFromRuns(original))).toEqual(original);
  });

  it("escapes markup typed into the editor instead of interpreting it", () => {
    const [only] = parse(htmlFromRuns([run("<script>alert(1)</script>")]));
    expect(only.text).toBe("<script>alert(1)</script>");
    expect(parse(htmlFromRuns([run("<b>x</b>")]))[0].bold).toBe(false);
  });
});

describe("colour and family parsing", () => {
  it("normalises every colour notation to six-digit hex", () => {
    expect(toHex("#ABCDEF")).toBe("#abcdef");
    expect(toHex("#abc")).toBe("#aabbcc");
    expect(toHex("rgb(1, 2, 3)")).toBe("#010203");
    expect(toHex("rgba(255, 0, 0, 0.5)")).toBe("#ff0000");
    expect(toHex("nonsense")).toBeNull();
  });

  it("maps CSS families onto the built-in PDF faces", () => {
    expect(familyFrom("Courier New, monospace")).toBe("courier");
    expect(familyFrom("Times New Roman, serif")).toBe("times");
    expect(familyFrom("Helvetica, Arial, sans-serif")).toBe("helvetica");
    expect(familyFrom("Wingdings")).toBeNull();
  });
});

describe("PDF text placement", () => {
  it("picks the right built-in face for each combination", () => {
    expect(faceFor({ ...DEFAULT_STYLE })).toBe("Helvetica");
    expect(faceFor({ ...DEFAULT_STYLE, bold: true })).toBe("Helvetica-Bold");
    expect(faceFor({ ...DEFAULT_STYLE, bold: true, italic: true })).toBe("Helvetica-BoldOblique");
    expect(faceFor({ ...DEFAULT_STYLE, font: "times", italic: true })).toBe("Times-Italic");
    expect(faceFor({ ...DEFAULT_STYLE, font: "courier", bold: true })).toBe("Courier-Bold");
  });

  it("advances each segment by the measured width of the one before it", () => {
    const { segments, lines } = layoutRuns([run("ab"), run("cd", { bold: true })], (text) => text.length * 10);
    expect(segments.map((segment) => segment.offsetX)).toEqual([0, 20]);
    expect(lines).toHaveLength(1);
    expect(lines[0].width).toBe(40);
  });

  it("starts a new line at each newline and keeps its own height", () => {
    const { segments, lines } = layoutRuns([run("a\nb", { size: 10 })], (text) => text.length * 10);
    expect(segments.map((segment) => segment.lineIndex)).toEqual([0, 1]);
    expect(segments[1].offsetX).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0].height).toBeCloseTo(12);
  });

  it("sizes a line from its tallest run", () => {
    const { lines } = layoutRuns([run("small", { size: 10 }), run("big", { size: 30 })], () => 0);
    expect(lines[0].height).toBeCloseTo(36);
    expect(lines[0].baselineOffset).toBeCloseTo(24);
  });

  it("converts hex colours to the 0-1 range pdf-lib expects", () => {
    expect(hexToRgb("#ffffff")).toEqual([1, 1, 1]);
    expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
    expect(hexToRgb("#ff8000")[0]).toBe(1);
    expect(hexToRgb("bogus")).toEqual([0, 0, 0]);
  });
});

describe("built-in font encoding", () => {
  it("folds typographic characters back to their ASCII originals", () => {
    expect(sanitizeText("“quoted” — dash… it’s").text).toBe('"quoted" - dash... it\'s');
    expect(sanitizeText("“quoted”").dropped).toEqual([]);
  });

  it("reports characters the built-in fonts cannot encode instead of writing rubbish", () => {
    const result = sanitizeText("hello 日本語");
    expect(result.text).toBe("hello ");
    expect(result.dropped).toEqual(["日", "本", "語"]);
  });

  it("keeps latin-1 accents, tabs and newlines", () => {
    const result = sanitizeText("café\trésumé\n");
    expect(result.text).toBe("café\trésumé\n");
    expect(result.dropped).toEqual([]);
  });
});
