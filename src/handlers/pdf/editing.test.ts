import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { buildEditedPdf, DEFAULT_STYLE, EMPTY_EDITS, type PdfEdits, type TextRun } from "./editing";

// A 1x1 red PNG, small enough to keep inline.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const run = (text: string, overrides: Partial<TextRun> = {}): TextRun => ({ ...DEFAULT_STYLE, text, ...overrides });

async function blank(pages = 1) {
  const source = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) source.addPage([300, 400]);
  return source.save();
}

/**
 * Reads the values a PDF actually stored, rather than trusting the writer.
 * Images live in stream objects, so their dictionaries have to be unwrapped.
 */
function collect(pdf: PDFDocument, key: string): string[] {
  return pdf.context
    .enumerateIndirectObjects()
    .map(([, object]) => (object instanceof PDFDict ? object : (object as { dict?: unknown }).dict))
    .filter((dict): dict is PDFDict => dict instanceof PDFDict)
    .map((dict) => dict.get(PDFName.of(key)))
    .filter((value): value is NonNullable<typeof value> => value !== undefined)
    .map((value) => value.toString());
}

async function build(edits: Partial<PdfEdits>, pages = 1) {
  const output = await buildEditedPdf(await blank(pages), { ...EMPTY_EDITS, ...edits });
  return PDFDocument.load(output);
}

describe("writing rich text into a PDF", () => {
  it("embeds a distinct built-in face for every style combination used", async () => {
    const saved = await build({
      annotations: [
        {
          id: "a",
          page: 1,
          x: 20,
          y: 300,
          runs: [
            run("plain "),
            run("bold ", { bold: true }),
            run("italic ", { italic: true }),
            run("both", { bold: true, italic: true, font: "times" }),
          ],
        },
      ],
    });
    const fonts = collect(saved, "BaseFont");
    expect(fonts).toContain("/Helvetica");
    expect(fonts).toContain("/Helvetica-Bold");
    expect(fonts).toContain("/Helvetica-Oblique");
    expect(fonts).toContain("/Times-BoldItalic");
  });

  it("reuses one font object when a style repeats", async () => {
    const saved = await build({
      annotations: [
        { id: "a", page: 1, x: 10, y: 300, runs: [run("one", { bold: true })] },
        { id: "b", page: 1, x: 10, y: 200, runs: [run("two", { bold: true })] },
      ],
    });
    expect(collect(saved, "BaseFont").filter((name) => name === "/Helvetica-Bold")).toHaveLength(1);
  });

  it("stores an added image as an image XObject", async () => {
    const saved = await build({
      images: [{ id: "i", page: 1, x: 10, y: 200, width: 80, height: 60, format: "png", dataBase64: PNG }],
    });
    expect(collect(saved, "Subtype")).toContain("/Image");
  });

  it("keeps text and images off pages that were deleted", async () => {
    const saved = await build(
      {
        annotations: [{ id: "a", page: 2, x: 10, y: 100, runs: [run("gone", { bold: true })] }],
        images: [{ id: "i", page: 2, x: 10, y: 100, width: 10, height: 10, format: "png", dataBase64: PNG }],
        deletedPages: [2],
      },
      2,
    );
    expect(saved.getPageCount()).toBe(1);
    expect(collect(saved, "BaseFont")).not.toContain("/Helvetica-Bold");
    expect(collect(saved, "Subtype")).not.toContain("/Image");
  });

  it("writes underline and strike as drawn lines, not as font state", async () => {
    const plain = await buildEditedPdf(await blank(), {
      ...EMPTY_EDITS,
      annotations: [{ id: "a", page: 1, x: 10, y: 300, runs: [run("text")] }],
    });
    const decorated = await buildEditedPdf(await blank(), {
      ...EMPTY_EDITS,
      annotations: [{ id: "a", page: 1, x: 10, y: 300, runs: [run("text", { underline: true, strike: true })] }],
    });
    expect(decorated.byteLength).toBeGreaterThan(plain.byteLength);
  });

  it("drops characters the built-in fonts cannot encode instead of failing the save", async () => {
    await expect(
      build({ annotations: [{ id: "a", page: 1, x: 10, y: 300, runs: [run("ok 日本語 ok")] }] }),
    ).resolves.toBeDefined();
  });

  it("still applies rotation and page deletion", async () => {
    const saved = await build({ rotations: { 1: 90 }, deletedPages: [2] }, 2);
    expect(saved.getPageCount()).toBe(1);
    expect(saved.getPage(0).getRotation().angle).toBe(90);
  });
});
