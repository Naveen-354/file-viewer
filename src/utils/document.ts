import type { DocumentBlock } from "../types/files";

export interface MarkedBlock { block: DocumentBlock; marker: string | null }

/**
 * Word stores list membership but not the rendered number, so numbered items
 * are counted here per level and reset whenever the list is interrupted.
 */
export function withMarkers(blocks: DocumentBlock[]): MarkedBlock[] {
  const counters: number[] = [];
  return blocks.map((block) => {
    if (block.kind !== "paragraph" || block.listLevel === null) {
      counters.length = 0;
      return { block, marker: null };
    }
    const level = Math.min(block.listLevel, 8);
    counters.length = level + 1;
    if (!block.ordered) {
      counters[level] = 0;
      return { block, marker: "•" };
    }
    counters[level] = (counters[level] ?? 0) + 1;
    return { block, marker: `${counters[level]}.` };
  });
}

export interface OutlineEntry { index: number; level: number; text: string }

/** The headings, in document order, so the index can scroll to a block. */
export function outlineOf(blocks: DocumentBlock[]): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  blocks.forEach((block, index) => {
    if (block.kind !== "paragraph" || !block.headingLevel) return;
    const text = block.runs.map((run) => run.text).join("").trim();
    if (text) entries.push({ index, level: block.headingLevel, text });
  });
  return entries;
}

export interface DocumentDensity {
  headings: number;
  paragraphs: number;
  listItems: number;
  tables: number;
  tableCells: number;
  characters: number;
  emptyParagraphs: number;
}

/** Counts what the block model already holds — nothing here is estimated. */
export function densityOf(blocks: DocumentBlock[]): DocumentDensity {
  const density: DocumentDensity = {
    headings: 0, paragraphs: 0, listItems: 0, tables: 0, tableCells: 0, characters: 0, emptyParagraphs: 0,
  };
  for (const block of blocks) {
    if (block.kind === "table") {
      density.tables += 1;
      for (const row of block.rows) {
        density.tableCells += row.length;
        for (const cell of row) density.characters += cell.length;
      }
      continue;
    }
    const text = block.runs.map((run) => run.text).join("");
    density.characters += text.length;
    if (block.headingLevel) density.headings += 1;
    else if (block.listLevel !== null) density.listItems += 1;
    else if (text.trim() === "") density.emptyParagraphs += 1;
    else density.paragraphs += 1;
  }
  return density;
}

/** Plain text for export and for the find box, one block per line. */
export function documentText(blocks: DocumentBlock[]): string {
  return blocks
    .map((block) => (block.kind === "table"
      ? block.rows.map((row) => row.join("\t")).join("\n")
      : block.runs.map((run) => run.text).join("")))
    .join("\n");
}

/** `Total-Time` is stored in whole minutes; hours read better past an hour. */
export function formatEditTime(minutes: number | null): string | null {
  if (minutes === null || minutes < 0) return null;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** docProps timestamps are ISO 8601; anything else is shown untouched. */
export function formatDocDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
