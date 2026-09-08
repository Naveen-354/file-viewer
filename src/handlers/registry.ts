import type { FileHandler } from "../types/handlers";

const simple = (id: string, displayName: string, extensions: string[], mimeTypes: string[], loader: FileHandler["load"]): FileHandler => ({
  id,
  displayName,
  supportedExtensions: extensions,
  supportedMimeTypes: mimeTypes,
  canOpen: async (file) => file.handlerId === id,
  load: async () => {
    const started = performance.now();
    const module = await loader();
    if (import.meta.env.DEV) console.debug(`[perf] handler load (${id}): ${(performance.now() - started).toFixed(1)}ms`);
    return module;
  },
});

export const handlers: FileHandler[] = [
  simple("text", "Text editor", ["txt", "log", "md", "java", "kt", "kts", "js", "ts", "jsx", "tsx", "rs", "py", "yaml", "yml", "properties", "env"], ["text/*"], () => import("./text/TextViewer")),
  simple("sql", "SQL script", ["sql", "ddl", "psql"], ["application/sql", "text/x-sql"], () => import("./sql/SqlViewer")),
  simple("structured", "Structured data", ["json", "xml"], ["application/json", "application/xml", "text/xml"], () => import("./structured-data/StructuredViewer")),
  simple("csv", "Table", ["csv", "tsv"], ["text/csv", "text/tab-separated-values"], () => import("./csv/CsvViewer")),
  simple("image", "Image", ["png", "jpg", "jpeg", "gif", "webp", "svg"], ["image/*"], () => import("./image/ImageViewer")),
  simple("pdf", "PDF", ["pdf"], ["application/pdf"], () => import("./pdf/PdfViewer")),
  simple("media", "Media", ["mp3", "wav", "ogg", "m4a", "mp4", "webm"], ["audio/*", "video/*"], () => import("./media/MediaViewer")),
  simple("spreadsheet", "Spreadsheet", ["xlsx", "xlsm", "xlsb", "xls", "ods"], ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel", "application/vnd.oasis.opendocument.spreadsheet"], () => import("./spreadsheet/SpreadsheetViewer")),
  simple("document", "Document", ["docx", "docm"], ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"], () => import("./document/DocumentViewer")),
  simple("archive", "Archive", ["zip"], ["application/zip"], () => import("./archive/ArchiveViewer")),
  simple("fallback", "File details", [], [], () => import("./fallback/FallbackViewer")),
];

export function handlerFor(id: string): FileHandler {
  return handlers.find((handler) => handler.id === id) ?? handlers.at(-1)!;
}
