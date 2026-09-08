import { handlers } from "../handlers/registry";
import type { HandlerId } from "../types/files";

export interface HandlerRow {
  id: HandlerId;
  label: string;
  extensions: string[];
  mimeTypes: string[];
  /** Where the work happens, which is the honest version of a "sandbox level". */
  runtime: "Rust core" | "WebView";
}

/**
 * Which side of the IPC boundary each viewer's decoding actually happens on.
 * The Rust ones parse in the backend; the rest run entirely in the WebView.
 */
const RUNTIME: Record<string, HandlerRow["runtime"]> = {
  spreadsheet: "Rust core",
  document: "Rust core",
  archive: "Rust core",
  image: "Rust core",
};

/** The viewer registry as a table, so the settings page cannot drift from it. */
export function handlerRows(): HandlerRow[] {
  return handlers.map((handler) => ({
    id: handler.id as HandlerId,
    label: handler.displayName,
    extensions: [...handler.supportedExtensions],
    mimeTypes: [...handler.supportedMimeTypes],
    runtime: RUNTIME[handler.id] ?? "WebView",
  }));
}

export interface OverrideOption { id: HandlerId; label: string }
export interface OverrideChoice {
  extension: string;
  /** What detection picks when there is no override. */
  fallback: HandlerId;
  options: OverrideOption[];
}

/**
 * The extensions worth offering a choice for.
 *
 * Only text-decodable formats appear here: routing a binary to the code editor
 * would produce nothing useful, so those are deliberately absent rather than
 * offered and then disappointing.
 */
export const OVERRIDABLE: OverrideChoice[] = [
  {
    extension: "json", fallback: "structured",
    options: [{ id: "structured", label: "JSON inspector" }, { id: "text", label: "Code editor" }],
  },
  {
    extension: "xml", fallback: "structured",
    options: [{ id: "structured", label: "Tree inspector" }, { id: "text", label: "Code editor" }],
  },
  {
    extension: "csv", fallback: "csv",
    options: [{ id: "csv", label: "Table" }, { id: "text", label: "Code editor" }],
  },
  {
    extension: "tsv", fallback: "csv",
    options: [{ id: "csv", label: "Table" }, { id: "text", label: "Code editor" }],
  },
  {
    extension: "sql", fallback: "sql",
    options: [{ id: "sql", label: "SQL studio" }, { id: "text", label: "Code editor" }],
  },
  {
    extension: "md", fallback: "text",
    options: [{ id: "text", label: "Code editor" }, { id: "structured", label: "Tree inspector" }],
  },
];

const OVERRIDABLE_IDS = new Set(OVERRIDABLE.map((entry) => entry.extension));

/**
 * Applies a stored override to a detected handler id.
 *
 * An override only ever redirects an extension the settings page offers a
 * choice for, and only to one of the options it offered — so a stale or edited
 * setting cannot send a file to an unrelated viewer.
 */
export function resolveHandler(
  handlerId: HandlerId,
  extension: string | null,
  overrides: Record<string, string>,
): HandlerId {
  if (!extension) return handlerId;
  const key = extension.toLowerCase();
  if (!OVERRIDABLE_IDS.has(key)) return handlerId;
  const wanted = overrides[key];
  if (!wanted) return handlerId;
  const choice = OVERRIDABLE.find((entry) => entry.extension === key)!;
  const option = choice.options.find((entry) => entry.id === wanted);
  return option ? option.id : handlerId;
}
