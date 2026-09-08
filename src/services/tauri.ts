import { invoke } from "@tauri-apps/api/core";
import type { ArchiveEntry, CreateWorkspaceRequest, DirectoryEntry, DocumentContent, EngineReport, WorkspacePath, SpreadsheetEdit, SpreadsheetEditRequest, ImageConversion, ImageConvertRequest, ImageFormatInfo, ExtractionRequest, FileChunk, FileDescriptor, RecentFile, SavedWindowState, SessionTab, StorageReport, StructuredError, UserSettings, Workspace, WorkbookView } from "../types/files";

export class AppError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: string) {
    super(message);
  }
}

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(name, args);
  } catch (error) {
    throw mapCommandError(error);
  }
}

export function mapCommandError(error: unknown): AppError {
  const value = error as Partial<StructuredError>;
  return new AppError(value.code ?? "unknown", value.message ?? String(error), value.details);
}

export const api = {
  detectFile: (path: string) => command<FileDescriptor>("detect_file", { path }),
  readChunk: async (path: string, offset: number, length: number, decodeText = false) => {
    const result = await command<FileChunk>("read_file_chunk", { request: { path, offset, length, decodeText } });
    if (import.meta.env.DEV) console.debug(`[perf] bytes read: ${result.bytes.length}`);
    return result;
  },
  metadata: (path: string) => command<FileDescriptor>("read_file_metadata", { path }),
  saveText: (path: string, content: string, expectedModifiedMs: number | null) => command<FileDescriptor>("save_text_file", { request: { path, content, expectedModifiedMs } }),
  saveTextAs: (sourcePath: string | null, destinationPath: string, content: string) => command<FileDescriptor>("save_text_as", { request: { sourcePath, destinationPath, content } }),
  savePdf: (path: string, contentBase64: string, expectedModifiedMs: number | null) => command<FileDescriptor>("save_pdf_file", { request: { path, contentBase64, expectedModifiedMs } }),
  savePdfAs: (sourcePath: string, destinationPath: string, contentBase64: string) => command<FileDescriptor>("save_pdf_as", { request: { sourcePath, destinationPath, contentBase64 } }),
  saveImageFrame: (destinationPath: string, contentBase64: string) => command<FileDescriptor>("save_image_frame", { destinationPath, contentBase64 }),
  openSystem: (path: string) => command<void>("open_with_system", { path }),
  showInFolder: (path: string) => command<void>("show_in_folder", { path }),
  renameFile: (path: string, newName: string) => command<FileDescriptor>("rename_file", { path, newName }),
  printFile: (path: string) => command<void>("print_file", { path }),
  recentFiles: () => command<RecentFile[]>("get_recent_files"),
  clearRecentFiles: () => command<void>("clear_recent_files"),
  clearSavedSession: () => command<void>("clear_saved_session"),
  engineReport: () => command<EngineReport>("get_engine_report"),
  storageReport: () => command<StorageReport>("get_storage_report"),
  setPinned: (path: string, pinned: boolean) => command<void>("set_pinned", { path, pinned }),
  workspaces: () => command<Workspace[]>("get_workspaces"),
  createWorkspace: (request: CreateWorkspaceRequest) => command<Workspace>("create_workspace", { request }),
  activateWorkspace: (id: string) => command<void>("activate_workspace", { id }),
  removeWorkspace: (id: string) => command<void>("remove_workspace", { id }),
  pinFile: (workspaceId: string, path: string) => command<WorkspacePath[]>("pin_file", { workspaceId, path }),
  unpinFile: (workspaceId: string, path: string) => command<WorkspacePath[]>("unpin_file", { workspaceId, path }),
  listDirectory: (path: string) => command<DirectoryEntry[]>("list_directory", { path }),
  settings: () => command<UserSettings>("get_settings"),
  updateSettings: (settings: UserSettings) => command<void>("update_settings", { settings }),
  loadSession: () => command<SessionTab[]>("load_session"),
  saveSession: (tabs: SessionTab[]) => command<void>("save_session", { tabs }),
  readSpreadsheet: (path: string, sheetIndex: number | null = null) => command<WorkbookView>("read_spreadsheet", { request: { path, sheetIndex } }),
  editSpreadsheet: (request: SpreadsheetEditRequest) => command<SpreadsheetEdit>("edit_spreadsheet", { request }),
  readDocument: (path: string) => command<DocumentContent>("read_document", { path }),
  imageFormats: () => command<ImageFormatInfo[]>("get_image_formats"),
  convertImage: (request: ImageConvertRequest) => command<ImageConversion>("convert_image", { request }),
  listArchive: (path: string) => command<ArchiveEntry[]>("list_archive_entries", { path }),
  extractArchive: (request: ExtractionRequest) => command<void>("extract_archive_entries", { request }),
  cancel: (operationId: string) => command<void>("cancel_operation", { operationId }),
  takeStartupFiles: () => command<string[]>("take_startup_files"),
  windowState: () => command<SavedWindowState | null>("get_window_state"),
  saveWindowState: (value: SavedWindowState) => command<void>("save_window_state", { value }),
};
