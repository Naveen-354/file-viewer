export type FontFamily = "helvetica" | "times" | "courier";

export interface TextStyle {
  font: FontFamily;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: string;
}

export interface TextRun extends TextStyle {
  text: string;
}

export interface TextAnnotation {
  id: string;
  page: number;
  x: number;
  y: number;
  runs: TextRun[];
}

export interface ImageAnnotation {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  format: "png" | "jpeg";
  dataBase64: string;
}

export interface PdfEdits {
  annotations: TextAnnotation[];
  images: ImageAnnotation[];
  rotations: Record<number, number>;
  deletedPages: number[];
}

export const EMPTY_EDITS: PdfEdits = { annotations: [], images: [], rotations: {}, deletedPages: [] };

export const DEFAULT_STYLE: TextStyle = {
  font: "helvetica",
  size: 14,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: "#111111",
};

/** The 12 built-in faces a PDF reader always has, so nothing has to be embedded. */
const FACES: Record<FontFamily, Record<string, string>> = {
  helvetica: { regular: "Helvetica", bold: "Helvetica-Bold", italic: "Helvetica-Oblique", boldItalic: "Helvetica-BoldOblique" },
  times: { regular: "Times-Roman", bold: "Times-Bold", italic: "Times-Italic", boldItalic: "Times-BoldItalic" },
  courier: { regular: "Courier", bold: "Courier-Bold", italic: "Courier-Oblique", boldItalic: "Courier-BoldOblique" },
};

export function faceFor(style: TextStyle): string {
  const variant = style.bold && style.italic ? "boldItalic" : style.bold ? "bold" : style.italic ? "italic" : "regular";
  return FACES[style.font][variant];
}

/**
 * The built-in fonts only encode WinAnsi, so the characters a word processor
 * silently substitutes are folded back to their ASCII originals rather than
 * failing the save.
 */
const SUBSTITUTIONS: Record<string, string> = {
  "‘": "'", "’": "'", "‚": ",", "‛": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"',
  "–": "-", "—": "-", "―": "-", "−": "-",
  "…": "...", " ": " ", "•": "∙", "‹": "<", "›": ">",
  "‐": "-", "‑": "-", "ʼ": "'", "­": "",
};

const WIN_ANSI_EXTRAS = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

export function supportedByStandardFont(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  if (character === "\n" || character === "\t") return true;
  if (code >= 0x20 && code <= 0x7e) return true;
  if (code >= 0xa0 && code <= 0xff) return true;
  return WIN_ANSI_EXTRAS.includes(character);
}

/** Returns the encodable text plus any characters that had to be dropped. */
export function sanitizeText(input: string): { text: string; dropped: string[] } {
  const dropped = new Set<string>();
  let text = "";
  for (const character of input) {
    const mapped = SUBSTITUTIONS[character] ?? character;
    for (const candidate of mapped) {
      if (supportedByStandardFont(candidate)) text += candidate;
      else dropped.add(character);
    }
  }
  return { text, dropped: [...dropped] };
}

export function hexToRgb(hex: string): [number, number, number] {
  const digits = hex.trim().replace("#", "");
  const full = digits.length === 3 ? [...digits].map((value) => value + value).join("") : digits;
  if (!/^[0-9a-f]{6}$/i.test(full)) return [0, 0, 0];
  return [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16) / 255) as [number, number, number];
}

export interface LaidOutSegment {
  run: TextRun;
  text: string;
  offsetX: number;
  lineIndex: number;
}

export interface LaidOutLine {
  height: number;
  baselineOffset: number;
  width: number;
}

/**
 * Splits runs into lines on newlines and measures each segment, so the preview
 * and the written PDF place text identically.
 */
export function layoutRuns(
  runs: TextRun[],
  measure: (text: string, run: TextRun) => number,
): { segments: LaidOutSegment[]; lines: LaidOutLine[] } {
  const segments: LaidOutSegment[] = [];
  const lines: LaidOutLine[] = [];
  let lineIndex = 0;
  let offsetX = 0;
  let lineHeight = 0;
  let maxSize = 0;

  const closeLine = () => {
    lines[lineIndex] = { height: lineHeight || 0, baselineOffset: maxSize * 0.8, width: offsetX };
    lineIndex += 1;
    offsetX = 0;
    lineHeight = 0;
    maxSize = 0;
  };

  for (const run of runs) {
    const pieces = run.text.split("\n");
    pieces.forEach((piece, index) => {
      if (index > 0) closeLine();
      lineHeight = Math.max(lineHeight, run.size * 1.2);
      maxSize = Math.max(maxSize, run.size);
      if (piece) {
        segments.push({ run, text: piece, offsetX, lineIndex });
        offsetX += measure(piece, run);
      }
    });
  }
  closeLine();
  return { segments, lines };
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function isDirty(edits: PdfEdits): boolean {
  return (
    edits.annotations.length > 0 ||
    edits.images.length > 0 ||
    edits.deletedPages.length > 0 ||
    Object.keys(edits.rotations).length > 0
  );
}

export async function buildEditedPdf(source: Uint8Array, edits: PdfEdits): Promise<Uint8Array> {
  const { PDFDocument, degrees, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.load(source);
  const pages = pdf.getPages();
  const fonts = new Map<string, Awaited<ReturnType<typeof pdf.embedFont>>>();
  const fontFor = async (style: TextStyle) => {
    const face = faceFor(style);
    const existing = fonts.get(face);
    if (existing) return existing;
    const embedded = await pdf.embedFont(face as Parameters<typeof pdf.embedFont>[0]);
    fonts.set(face, embedded);
    return embedded;
  };

  for (const [pageNumber, rotation] of Object.entries(edits.rotations)) {
    const target = pages[Number(pageNumber) - 1];
    if (target) target.setRotation(degrees((target.getRotation().angle + rotation) % 360));
  }

  for (const image of edits.images) {
    const target = pages[image.page - 1];
    if (!target || edits.deletedPages.includes(image.page)) continue;
    const bytes = decodeBase64(image.dataBase64);
    const embedded = image.format === "png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    target.drawImage(embedded, { x: image.x, y: image.y - image.height, width: image.width, height: image.height });
  }

  for (const annotation of edits.annotations) {
    const target = pages[annotation.page - 1];
    if (!target || edits.deletedPages.includes(annotation.page)) continue;
    const measured = new Map<TextRun, Awaited<ReturnType<typeof fontFor>>>();
    for (const run of annotation.runs) measured.set(run, await fontFor(run));
    const { segments, lines } = layoutRuns(annotation.runs, (text, run) => {
      const font = measured.get(run);
      return font ? font.widthOfTextAtSize(sanitizeText(text).text, run.size) : 0;
    });

    for (const segment of segments) {
      const font = measured.get(segment.run);
      if (!font) continue;
      const { text } = sanitizeText(segment.text);
      if (!text) continue;
      const above = lines.slice(0, segment.lineIndex).reduce((sum, line) => sum + line.height, 0);
      const baseline = annotation.y - above - (lines[segment.lineIndex]?.baselineOffset ?? segment.run.size * 0.8);
      const [red, green, blue] = hexToRgb(segment.run.color);
      const width = font.widthOfTextAtSize(text, segment.run.size);
      target.drawText(text, {
        x: annotation.x + segment.offsetX,
        y: baseline,
        size: segment.run.size,
        font,
        color: rgb(red, green, blue),
      });
      if (segment.run.underline) {
        target.drawLine({
          start: { x: annotation.x + segment.offsetX, y: baseline - segment.run.size * 0.12 },
          end: { x: annotation.x + segment.offsetX + width, y: baseline - segment.run.size * 0.12 },
          thickness: Math.max(0.5, segment.run.size * 0.06),
          color: rgb(red, green, blue),
        });
      }
      if (segment.run.strike) {
        target.drawLine({
          start: { x: annotation.x + segment.offsetX, y: baseline + segment.run.size * 0.28 },
          end: { x: annotation.x + segment.offsetX + width, y: baseline + segment.run.size * 0.28 },
          thickness: Math.max(0.5, segment.run.size * 0.06),
          color: rgb(red, green, blue),
        });
      }
    }
  }

  [...edits.deletedPages].sort((a, b) => b - a).forEach((pageNumber) => pdf.removePage(pageNumber - 1));
  return pdf.save({ useObjectStreams: true });
}
