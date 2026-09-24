use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDescriptor {
    pub path: String,
    pub name: String,
    pub extension: Option<String>,
    pub mime_type: Option<String>,
    pub detected_type: String,
    pub handler_id: String,
    pub size: u64,
    pub created_ms: Option<u64>,
    pub modified_ms: Option<u64>,
    pub readonly: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadChunkRequest {
    pub path: String,
    pub offset: u64,
    pub length: usize,
    pub decode_text: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChunk {
    pub offset: u64,
    pub bytes: Vec<u8>,
    pub text: Option<String>,
    pub encoding: Option<String>,
    pub eof: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTextRequest {
    pub path: String,
    pub content: String,
    pub expected_modified_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAsRequest {
    pub source_path: Option<String>,
    pub destination_path: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePdfRequest {
    pub path: String,
    pub content_base64: String,
    pub expected_modified_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePdfAsRequest {
    pub source_path: String,
    pub destination_path: String,
    pub content_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub path: String,
    pub display_name: String,
    pub handler_id: String,
    pub last_opened_ms: i64,
    pub pinned: bool,
    pub exists: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceRequest {
    pub name: String,
    pub folders: Vec<String>,
    pub pinned_files: Vec<String>,
    pub restore_last_session: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePath {
    pub path: String,
    pub name: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub folders: Vec<WorkspacePath>,
    pub pinned_files: Vec<WorkspacePath>,
    pub restore_last_session: bool,
    pub last_opened_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub path: String,
    pub name: String,
    pub is_directory: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSettings {
    pub theme: String,
    pub word_wrap: bool,
    pub csv_delimiter: Option<String>,
    pub restore_session: bool,
    /// Fields below arrived after the first release. Settings are stored as one
    /// JSON blob, so each needs a serde default or an existing row fails to
    /// parse and the user loses every preference they had.
    #[serde(default = "default_accent")]
    pub accent: String,
    #[serde(default = "default_window_effect")]
    pub window_effect: String,
    #[serde(default = "default_tab_overflow")]
    pub tab_overflow: String,
    #[serde(default)]
    pub compact_density: bool,
    #[serde(default = "default_mono_font")]
    pub mono_font: String,
    #[serde(default = "default_font_size")]
    pub editor_font_size: u8,
    #[serde(default = "default_true")]
    pub ligatures: bool,
    #[serde(default = "default_true")]
    pub tabular_figures: bool,
    /// Extension -> handler id, for the few formats more than one viewer can
    /// open. Empty means every file goes to whichever handler detection picked.
    #[serde(default)]
    pub handler_overrides: std::collections::HashMap<String, String>,
}

fn default_accent() -> String {
    "indigo".into()
}
fn default_window_effect() -> String {
    "none".into()
}
fn default_tab_overflow() -> String {
    "scroll".into()
}
fn default_mono_font() -> String {
    "cascadia".into()
}
fn default_font_size() -> u8 {
    13
}
fn default_true() -> bool {
    true
}

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            word_wrap: true,
            csv_delimiter: None,
            restore_session: true,
            accent: default_accent(),
            window_effect: default_window_effect(),
            tab_overflow: default_tab_overflow(),
            compact_density: false,
            mono_font: default_mono_font(),
            editor_font_size: default_font_size(),
            ligatures: true,
            tabular_figures: true,
            handler_overrides: std::collections::HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecoderEngine {
    pub category: String,
    pub module: String,
    pub version: String,
    pub runtime: String,
    pub formats: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineLimit {
    pub name: String,
    pub value: u64,
    pub unit: String,
    pub why: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IsolationReport {
    pub csp: String,
    pub permissions: Vec<String>,
    pub network_plugins: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineReport {
    pub app_version: String,
    pub target: String,
    pub profile: String,
    pub tauri_version: String,
    pub unsafe_forbidden: bool,
    pub engines: Vec<DecoderEngine>,
    pub limits: Vec<EngineLimit>,
    pub isolation: IsolationReport,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageTable {
    pub name: String,
    pub purpose: String,
    pub cap: Option<String>,
    pub rows: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageReport {
    pub database_path: String,
    pub database_bytes: u64,
    pub total_rows: u64,
    pub tables: Vec<StorageTable>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SessionTab {
    pub path: String,
    pub active: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub index: usize,
    pub path: String,
    pub is_directory: bool,
    pub compressed_size: u64,
    pub original_size: u64,
    pub unsafe_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionRequest {
    pub archive_path: String,
    pub destination: String,
    pub entry_indices: Option<Vec<usize>>,
    pub collision: CollisionPolicy,
    pub operation_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CollisionPolicy {
    Skip,
    Overwrite,
    Rename,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionProgress {
    pub operation_id: String,
    pub completed: usize,
    pub total: usize,
    pub current: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetRequest {
    pub path: String,
    pub sheet_index: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetSheet {
    pub index: usize,
    pub name: String,
    pub hidden: bool,
    pub selectable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetCell {
    pub text: String,
    pub kind: &'static str,
    /// The cell's formula with its leading `=`, when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookView {
    pub sheets: Vec<SpreadsheetSheet>,
    pub active_index: usize,
    pub rows: Vec<Vec<SpreadsheetCell>>,
    pub start_row: usize,
    pub start_column: usize,
    pub total_rows: usize,
    pub total_columns: usize,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRun {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DocumentBlock {
    #[serde(rename_all = "camelCase")]
    Paragraph {
        style: Option<String>,
        heading_level: Option<u8>,
        list_level: Option<u8>,
        ordered: bool,
        runs: Vec<DocumentRun>,
    },
    #[serde(rename_all = "camelCase")]
    Table { rows: Vec<Vec<String>> },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentContent {
    pub blocks: Vec<DocumentBlock>,
    pub word_count: usize,
    pub truncated: bool,
    pub properties: DocumentProperties,
    pub insertions: usize,
    pub deletions: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPart {
    pub name: String,
    pub size: u64,
    pub compressed_size: u64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentProperties {
    pub title: Option<String>,
    pub subject: Option<String>,
    pub author: Option<String>,
    pub last_modified_by: Option<String>,
    pub keywords: Option<String>,
    pub revision: Option<String>,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub generator: Option<String>,
    pub generator_version: Option<String>,
    pub company: Option<String>,
    pub total_edit_minutes: Option<u32>,
    pub pages: Option<u32>,
    pub words: Option<u32>,
    pub characters: Option<u32>,
    pub paragraphs: Option<u32>,
    pub protection: Option<String>,
    pub track_changes: bool,
    pub has_macros: bool,
    pub has_signature: bool,
    pub fonts: Vec<String>,
    pub parts: Vec<DocumentPart>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageConvertRequest {
    pub source_path: String,
    pub destination_path: String,
    pub format: String,
    pub quality: Option<u8>,
    pub background: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFormatInfo {
    pub id: String,
    pub label: String,
    pub extension: String,
    pub lossy: bool,
    pub alpha: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageConversion {
    pub file: FileDescriptor,
    pub width: u32,
    pub height: u32,
    pub source_bytes: u64,
    pub output_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellEdit {
    pub row: u32,
    pub column: u32,
    pub value: String,
    /// The value the viewer computed for a formula, cached so the file reads
    /// correctly before a spreadsheet application recalculates it.
    #[serde(default)]
    pub result: Option<FormulaResult>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaResult {
    pub kind: String,
    pub text: String,
}

/// Inserts `count` empty rows or columns before the zero-based `index`,
/// shifting everything at or after it the way a spreadsheet does.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralInsert {
    pub axis: InsertAxis,
    pub index: u32,
    pub count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InsertAxis {
    Row,
    Column,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetEditRequest {
    pub path: String,
    pub sheet_index: usize,
    pub edits: Vec<CellEdit>,
    /// Applied in order before `edits`, whose coordinates are post-insert.
    #[serde(default)]
    pub inserts: Vec<StructuralInsert>,
    pub expected_modified_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetEdit {
    pub file: FileDescriptor,
    pub view: WorkbookView,
}
