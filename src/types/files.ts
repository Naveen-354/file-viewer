export type HandlerId = "text" | "sql" | "structured" | "csv" | "image" | "pdf" | "media" | "spreadsheet" | "document" | "archive" | "fallback";

export interface FileDescriptor {
  path: string;
  name: string;
  extension: string | null;
  mimeType: string | null;
  detectedType: string;
  handlerId: HandlerId;
  size: number;
  createdMs: number | null;
  modifiedMs: number | null;
  readonly: boolean;
}

export interface FileChunk {
  offset: number;
  bytes: number[];
  text: string | null;
  encoding: string | null;
  eof: boolean;
}

export interface StructuredError {
  code: string;
  message: string;
  path?: string;
  details?: string;
}

export interface RecentFile {
  path: string;
  displayName: string;
  handlerId: string;
  lastOpenedMs: number;
  pinned: boolean;
  exists: boolean;
  size: number;
}

export interface WorkspacePath { path: string; name: string; exists: boolean }
export interface Workspace {
  id: string;
  name: string;
  folders: WorkspacePath[];
  pinnedFiles: WorkspacePath[];
  restoreLastSession: boolean;
  lastOpenedMs: number;
}
export interface CreateWorkspaceRequest {
  name: string;
  folders: string[];
  pinnedFiles: string[];
  restoreLastSession: boolean;
}
export interface DirectoryEntry { path: string; name: string; isDirectory: boolean }

export interface UserSettings {
  theme: "light" | "dark" | "system";
  wordWrap: boolean;
  csvDelimiter: string | null;
  accent: string;
  windowEffect: string;
  tabOverflow: string;
  compactDensity: boolean;
  monoFont: string;
  editorFontSize: number;
  ligatures: boolean;
  tabularFigures: boolean;
  handlerOverrides: Record<string, string>;
  restoreSession: boolean;
}

export interface DecoderEngine { category: string; module: string; version: string; runtime: string; formats: string[] }

export interface EngineLimit { name: string; value: number; unit: string; why: string }

export interface IsolationReport { csp: string; permissions: string[]; networkPlugins: boolean }

export interface EngineReport {
  appVersion: string;
  target: string;
  profile: string;
  tauriVersion: string;
  unsafeForbidden: boolean;
  engines: DecoderEngine[];
  limits: EngineLimit[];
  isolation: IsolationReport;
}

export interface StorageTable { name: string; purpose: string; cap: string | null; rows: number }

export interface StorageReport {
  databasePath: string;
  databaseBytes: number;
  totalRows: number;
  tables: StorageTable[];
}

export interface SessionTab { path: string; active: boolean }

export interface ArchiveEntry {
  index: number;
  path: string;
  isDirectory: boolean;
  compressedSize: number;
  originalSize: number;
  unsafeReason: string | null;
}

export interface ExtractionRequest {
  archivePath: string;
  destination: string;
  entryIndices: number[] | null;
  collision: "skip" | "overwrite" | "rename";
  operationId: string;
}

export interface SavedWindowState { x: number; y: number; width: number; height: number; maximized: boolean }

export type CellKind = "text" | "number" | "date" | "duration" | "boolean" | "error" | "empty";

export interface SpreadsheetCell { text: string; kind: CellKind }

export interface SpreadsheetSheet { index: number; name: string; hidden: boolean; selectable: boolean }

export interface WorkbookView {
  sheets: SpreadsheetSheet[];
  activeIndex: number;
  rows: SpreadsheetCell[][];
  startRow: number;
  startColumn: number;
  totalRows: number;
  totalColumns: number;
  truncated: boolean;
}

export interface DocumentRun { text: string; bold: boolean; italic: boolean; underline: boolean }

export type DocumentBlock =
  | { kind: "paragraph"; style: string | null; headingLevel: number | null; listLevel: number | null; ordered: boolean; runs: DocumentRun[] }
  | { kind: "table"; rows: string[][] };

export interface DocumentPart { name: string; size: number; compressedSize: number }

/** Everything docProps, settings.xml and the package listing actually record. */
export interface DocumentProperties {
  title: string | null;
  subject: string | null;
  author: string | null;
  lastModifiedBy: string | null;
  keywords: string | null;
  revision: string | null;
  created: string | null;
  modified: string | null;
  generator: string | null;
  generatorVersion: string | null;
  company: string | null;
  totalEditMinutes: number | null;
  pages: number | null;
  words: number | null;
  characters: number | null;
  paragraphs: number | null;
  protection: string | null;
  trackChanges: boolean;
  hasMacros: boolean;
  hasSignature: boolean;
  fonts: string[];
  parts: DocumentPart[];
}

export interface DocumentContent {
  blocks: DocumentBlock[];
  wordCount: number;
  truncated: boolean;
  properties: DocumentProperties;
  insertions: number;
  deletions: number;
}

export interface ImageFormatInfo { id: string; label: string; extension: string; lossy: boolean; alpha: boolean }

export interface ImageConvertRequest {
  sourcePath: string;
  destinationPath: string;
  format: string;
  quality: number | null;
  background: string | null;
}

export interface ImageConversion {
  file: FileDescriptor;
  width: number;
  height: number;
  sourceBytes: number;
  outputBytes: number;
}

export interface CellEdit { row: number; column: number; value: string }

export interface SpreadsheetEditRequest {
  path: string;
  sheetIndex: number;
  edits: CellEdit[];
  expectedModifiedMs: number | null;
}

export interface SpreadsheetEdit { file: FileDescriptor; view: WorkbookView }
