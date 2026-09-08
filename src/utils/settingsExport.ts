import type { UserSettings } from "../types/files";

/** TOML basic strings escape the backslash, the quote and the control range. */
function quote(value: string): string {
  let out = "";
  for (const char of value) {
    if (char === "\\") out += "\\\\";
    else if (char === '"') out += '\\"';
    else if (char === "\t") out += "\\t";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char < " ") out += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return `"${out}"`;
}

function value(input: string | number | boolean | null): string {
  if (input === null) return '""';
  if (typeof input === "boolean") return String(input);
  if (typeof input === "number") return String(input);
  return quote(input);
}

/**
 * Writes the current settings as TOML.
 *
 * This is an export for reading and keeping, not an import format — OneOpen has
 * no way to load one back, and the header says so rather than implying a
 * round trip that does not exist.
 */
export function toToml(settings: UserSettings): string {
  const lines = [
    "# OneOpen settings export",
    "# Generated for reference. OneOpen cannot import this file back.",
    "",
    "[appearance]",
    `theme = ${value(settings.theme)}`,
    `accent = ${value(settings.accent)}`,
    `window_effect = ${value(settings.windowEffect)}`,
    `compact_density = ${value(settings.compactDensity)}`,
    "",
    "[workspace]",
    `restore_session = ${value(settings.restoreSession)}`,
    `tab_overflow = ${value(settings.tabOverflow)}`,
    "",
    "[typography]",
    `mono_font = ${value(settings.monoFont)}`,
    `editor_font_size = ${value(settings.editorFontSize)}`,
    `ligatures = ${value(settings.ligatures)}`,
    `tabular_figures = ${value(settings.tabularFigures)}`,
    "",
    "[editing]",
    `word_wrap = ${value(settings.wordWrap)}`,
    `csv_delimiter = ${value(settings.csvDelimiter)}`,
    "",
  ];
  return lines.join("\n");
}
