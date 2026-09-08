import type { FontFamily, TextRun, TextStyle } from "./editing";

/** `rgb(17, 17, 17)` and `#111` both become `#111111`. */
export function toHex(value: string): string | null {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${[...trimmed.slice(1)].map((digit) => digit + digit).join("")}`.toLowerCase();
  }
  const match = trimmed.match(/^rgba?\(([^)]+)\)$/i);
  if (!match) return null;
  const parts = match[1].split(",").map((part) => Number(part.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
  return `#${parts.slice(0, 3).map((part) => Math.max(0, Math.min(255, Math.round(part))).toString(16).padStart(2, "0")).join("")}`;
}

export function familyFrom(value: string): FontFamily | null {
  const lower = value.toLowerCase();
  if (lower.includes("courier") || lower.includes("mono")) return "courier";
  if (lower.includes("times") || lower.includes("serif") && !lower.includes("sans")) return "times";
  if (lower.includes("helvetica") || lower.includes("arial") || lower.includes("sans")) return "helvetica";
  return null;
}

export const CSS_FAMILY: Record<FontFamily, string> = {
  helvetica: "Helvetica, Arial, sans-serif",
  times: '"Times New Roman", Times, serif',
  courier: '"Courier New", Courier, monospace',
};

const BLOCK_TAGS = new Set(["DIV", "P", "LI", "TR"]);

function styleOf(element: HTMLElement, inherited: TextStyle): TextStyle {
  const next = { ...inherited };
  switch (element.tagName) {
    case "B":
    case "STRONG":
      next.bold = true;
      break;
    case "I":
    case "EM":
      next.italic = true;
      break;
    case "U":
      next.underline = true;
      break;
    case "S":
    case "STRIKE":
    case "DEL":
      next.strike = true;
      break;
  }
  const style = element.style;
  if (style.fontWeight) next.bold = style.fontWeight === "bold" || Number(style.fontWeight) >= 600;
  if (style.fontStyle) next.italic = style.fontStyle === "italic" || style.fontStyle === "oblique";
  const decoration = style.textDecorationLine || style.textDecoration;
  if (decoration) {
    next.underline = decoration.includes("underline");
    next.strike = decoration.includes("line-through");
  }
  if (style.color) next.color = toHex(style.color) ?? next.color;
  if (style.fontSize) {
    const size = Number.parseFloat(style.fontSize);
    if (Number.isFinite(size) && size > 0) next.size = size;
  }
  if (style.fontFamily) next.font = familyFrom(style.fontFamily) ?? next.font;
  return next;
}

/**
 * Flattens the editor's DOM into the run model the PDF writer consumes.
 * Nested spans cascade, so the innermost declaration wins, exactly as CSS does.
 */
export function runsFromElement(root: HTMLElement, base: TextStyle): TextRun[] {
  const runs: TextRun[] = [];
  const push = (text: string, style: TextStyle) => {
    if (!text) return;
    runs.push({ ...style, text });
  };

  const walk = (node: Node, style: TextStyle, isFirstBlock: { value: boolean }) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        push(child.textContent ?? "", style);
        continue;
      }
      if (!(child instanceof HTMLElement)) continue;
      if (child.tagName === "BR") {
        push("\n", style);
        continue;
      }
      if (BLOCK_TAGS.has(child.tagName)) {
        if (!isFirstBlock.value) push("\n", style);
        isFirstBlock.value = false;
        walk(child, styleOf(child, style), { value: true });
        continue;
      }
      walk(child, styleOf(child, style), isFirstBlock);
    }
  };

  walk(root, base, { value: true });
  return mergeRuns(runs);
}

/** Adjacent runs that look identical are joined so the PDF has fewer draw calls. */
export function mergeRuns(runs: TextRun[]): TextRun[] {
  const merged: TextRun[] = [];
  for (const run of runs) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.bold === run.bold &&
      previous.italic === run.italic &&
      previous.underline === run.underline &&
      previous.strike === run.strike &&
      previous.size === run.size &&
      previous.font === run.font &&
      previous.color === run.color
    ) {
      previous.text += run.text;
    } else {
      merged.push({ ...run });
    }
  }
  return merged.filter((run) => run.text !== "");
}

export function cssFor(style: TextStyle): string {
  const decorations = [style.underline && "underline", style.strike && "line-through"].filter(Boolean).join(" ");
  return [
    `font-family:${CSS_FAMILY[style.font]}`,
    `font-size:${style.size}px`,
    `font-weight:${style.bold ? 700 : 400}`,
    `font-style:${style.italic ? "italic" : "normal"}`,
    `text-decoration:${decorations || "none"}`,
    `color:${style.color}`,
  ].join(";");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character] ?? character);
}

/** Rebuilds editable markup from runs when an existing annotation is reopened. */
export function htmlFromRuns(runs: TextRun[]): string {
  if (runs.length === 0) return "";
  return runs
    .map((run) =>
      escapeHtml(run.text)
        .split("\n")
        .map((line) => `<span style="${cssFor(run)}">${line}</span>`)
        .join("<br>"),
    )
    .join("");
}

export function plainText(runs: TextRun[]): string {
  return runs.map((run) => run.text).join("");
}
