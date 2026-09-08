use crate::{
    domain::*,
    engine_report, file_detection, file_io,
    handlers::{archive, document, image, spreadsheet},
    persistence, platform, security,
    state::AppState,
    storage_report,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::{path::Path, sync::atomic::Ordering, time::UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

const MAX_PDF_SAVE_BYTES: usize = 64 * 1024 * 1024;

#[tauri::command]
pub async fn detect_file(path: String, state: State<'_, AppState>) -> AppResult<FileDescriptor> {
    let descriptor = tauri::async_runtime::spawn_blocking(move || file_detection::detect(path))
        .await
        .map_err(|error| AppError::new("task_failed", error.to_string()))??;
    persistence::record_recent(
        &state.database,
        &descriptor.path,
        &descriptor.name,
        &descriptor.handler_id,
    )
    .await?;
    Ok(descriptor)
}

#[tauri::command]
pub async fn read_file_metadata(path: String) -> AppResult<FileDescriptor> {
    tauri::async_runtime::spawn_blocking(move || file_detection::detect(path))
        .await
        .map_err(|error| AppError::new("task_failed", error.to_string()))?
}

#[tauri::command]
pub async fn read_file_chunk(request: ReadChunkRequest) -> AppResult<FileChunk> {
    tauri::async_runtime::spawn_blocking(move || {
        file_io::read_chunk(
            &request.path,
            request.offset,
            request.length,
            request.decode_text,
        )
    })
    .await
    .map_err(|error| AppError::new("task_failed", error.to_string()))?
}

#[tauri::command]
pub async fn save_text_file(request: SaveTextRequest) -> AppResult<FileDescriptor> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = security::canonical_file(&request.path)?;
        if let Some(expected) = request.expected_modified_ms {
            let current = std::fs::metadata(&path)
                .and_then(|value| value.modified())
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_millis() as u64);
            if current != Some(expected) {
                return Err(AppError::path(
                    "external_modification",
                    "The file changed outside OneOpen",
                    &path,
                ));
            }
        }
        file_io::atomic_save(&path, &request.content)?;
        file_detection::detect(path)
    })
    .await
    .map_err(|error| AppError::new("task_failed", error.to_string()))?
}

#[tauri::command]
pub async fn save_text_as(request: SaveAsRequest) -> AppResult<FileDescriptor> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(source) = request.source_path {
            let _ = security::canonical_file(source)?;
        }
        let destination = security::destination_file(&request.destination_path)?;
        file_io::atomic_save(&destination, &request.content)?;
        file_detection::detect(destination)
    })
    .await
    .map_err(|error| AppError::new("task_failed", error.to_string()))?
}

#[tauri::command]
pub async fn save_pdf_file(request: SavePdfRequest) -> AppResult<FileDescriptor> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = security::canonical_file(&request.path)?;
        ensure_pdf_extension(&path)?;
        if let Some(expected) = request.expected_modified_ms {
            ensure_not_modified(&path, expected)?;
        }
        let content = decode_pdf(&request.content_base64)?;
        file_io::atomic_save_bytes(&path, &content)?;
        file_detection::detect(path)
    })
    .await
    .map_err(|error| AppError::new("task_failed", error.to_string()))?
}

#[tauri::command]
pub async fn save_pdf_as(request: SavePdfAsRequest) -> AppResult<FileDescriptor> {
    tauri::async_runtime::spawn_blocking(move || {
        let _ = security::canonical_file(&request.source_path)?;
        let destination = security::destination_file(&request.destination_path)?;
        ensure_pdf_extension(&destination)?;
        let content = decode_pdf(&request.content_base64)?;
        file_io::atomic_save_bytes(&destination, &content)?;
        file_detection::detect(destination)
    })
    .await
    .map_err(|error| AppError::new("task_failed", error.to_string()))?
}

const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
const PNG_SIGNATURE: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/// Writes a captured video frame. Only real PNG bytes are accepted, so this
/// cannot be used as a general file-writing primitive.
#[tauri::command]
pub async fn save_image_frame(
    destination_path: String,
    content_base64: String,
) -> AppResult<FileDescriptor> {
    tauri::async_runtime::spawn_blocking(move || {
        let destination = security::destination_file(&destination_path)?;
        if !destination
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("png"))
        {
            return Err(AppError::path(
                "invalid_frame_destination",
                "A captured frame must be saved to a .png file",
                &destination,
            ));
        }
        if content_base64.len() > (MAX_FRAME_BYTES * 4 / 3) + 4 {
            return Err(AppError::new(
                "frame_size_limit",
                "The captured frame exceeds the 64 MiB limit",
            ));
        }
        let content = BASE64
            .decode(&content_base64)
            .map_err(|error| AppError::new("invalid_frame_data", error.to_string()))?;
        if content.len() > MAX_FRAME_BYTES {
            return Err(AppError::new(
                "frame_size_limit",
                "The captured frame exceeds the 64 MiB limit",
            ));
        }
        if !content.starts_with(PNG_SIGNATURE) {
            return Err(AppError::new(
                "invalid_frame_data",
                "The captured frame is not a PNG image",
            ));
        }
        file_io::atomic_save_bytes(&destination, &content)?;
        file_detection::detect(destination)
    })
    .await
    .map_err(|error| AppError::new("task_failed", error.to_string()))?
}

#[tauri::command]
pub async fn open_with_system(path: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || platform::open_with_system(&path))
        .await
        .map_err(|error| AppError::new("task_failed", error.to_string()))?
}

#[tauri::command]
pub async fn show_in_folder(path: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || platform::show_in_folder(&path))
        .await
        .map_err(|error| AppError::new("task_failed", error.to_string()))?
}

#[tauri::command]
pub async fn print_file(path: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || platform::print_file(&path))
        .await
        .map_err(|error| AppError::new("task_failed", error.to_string()))?
}

#[tauri::command]
pub async fn get_recent_files(state: State<'_, AppState>) -> AppResult<Vec<RecentFile>> {
    persistence::recent_files(&state.database).await
}

#[tauri::command]
pub async fn set_pinned(path: String, pinned: bool, state: State<'_, AppState>) -> AppResult<()> {
    persistence::set_pinned(&state.database, &path, pinned).await
}

#[tauri::command]
pub async fn get_workspaces(state: State<'_, AppState>) -> AppResult<Vec<Workspace>> {
    persistence::workspaces(&state.database).await
}

#[tauri::command]
pub async fn create_workspace(
    request: CreateWorkspaceRequest,
    state: State<'_, AppState>,
) -> AppResult<Workspace> {
    persistence::create_workspace(&state.database, &request).await
}

#[tauri::command]
pub async fn activate_workspace(id: String, state: State<'_, AppState>) -> AppResult<()> {
    persistence::activate_workspace(&state.database, &id).await
}

#[tauri::command]
pub async fn remove_workspace(id: String, state: State<'_, AppState>) -> AppResult<()> {
    persistence::remove_workspace(&state.database, &id).await
}

#[tauri::command]
pub async fn pin_file(
    workspace_id: String,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<WorkspacePath>> {
    persistence::pin_file(&state.database, &workspace_id, &path).await
}

#[tauri::command]
pub async fn unpin_file(
    workspace_id: String,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<WorkspacePath>> {
    persistence::unpin_file(&state.database, &workspace_id, &path).await
}

/// Renames a file within its own directory.
///
/// The new name is validated as a bare file name, so this can never move a file
/// somewhere else, and the destination is refused if it is already taken. The
/// returned descriptor is re-detected from the renamed file: changing the
/// extension can change which viewer owns it.
#[tauri::command]
pub async fn rename_file(
    path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> AppResult<FileDescriptor> {
    let (source, destination) =
        tauri::async_runtime::spawn_blocking(move || file_io::rename(&path, &new_name))
            .await
            .map_err(|error| AppError::new("task_failed", error.to_string()))??;

    let descriptor =
        tauri::async_runtime::spawn_blocking(move || file_detection::detect(&destination))
            .await
            .map_err(|error| AppError::new("task_failed", error.to_string()))??;
    persistence::repoint_path(&state.database, &source.to_string_lossy(), &descriptor.path).await?;
    persistence::record_recent(
        &state.database,
        &descriptor.path,
        &descriptor.name,
        &descriptor.handler_id,
    )
    .await?;
    Ok(descriptor)
}

/// Facts about this build for the Native Engine settings page.
#[tauri::command]
pub async fn get_engine_report() -> AppResult<EngineReport> {
    engine_report::build()
}

/// Empties the recent-files list. Pins and open tabs are untouched.
#[tauri::command]
pub async fn clear_recent_files(state: State<'_, AppState>) -> AppResult<()> {
    persistence::clear_recent_files(&state.database).await
}

/// Forgets the saved tab list, so the next launch starts empty.
#[tauri::command]
pub async fn clear_saved_session(state: State<'_, AppState>) -> AppResult<()> {
    persistence::save_session(&state.database, &[]).await
}

/// What the app keeps on disk, for the Storage & Scratch settings page.
#[tauri::command]
pub async fn get_storage_report(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<StorageReport> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::new("no_data_dir", error.to_string()))?;
    storage_report::build(&state.database, &data_dir).await
}

#[tauri::command]
pub async fn list_directory(path: String) -> AppResult<Vec<DirectoryEntry>> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = security::canonical_directory(&path)?;
        let mut entries = std::fs::read_dir(&directory)
            .map_err(|error| AppError::io(error, &directory))?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let file_type = entry.file_type().ok()?;
                Some(DirectoryEntry {
                    path: entry.path().to_string_lossy().into_owned(),
                    name: entry.file_name().to_string_lossy().into_owned(),
                    is_directory: file_type.is_dir(),
                })
            })
            .collect::<Vec<_>>();
        entries.sort_by(|a, b| {
            b.is_directory
                .cmp(&a.is_directory)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        entries.truncate(500);
        Ok(entries)
    })
    .await
    .map_err(|error| AppError::new("task_failed", error.to_string()))?
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> AppResult<UserSettings> {
    persistence::get_settings(&state.database).await
}

#[tauri::command]
pub async fn update_settings(settings: UserSettings, state: State<'_, AppState>) -> AppResult<()> {
    persistence::update_settings(&state.database, &settings).await
}

#[tauri::command]
pub async fn load_session(state: State<'_, AppState>) -> AppResult<Vec<SessionTab>> {
    persistence::load_session(&state.database).await
}

#[tauri::command]
pub async fn save_session(tabs: Vec<SessionTab>, state: State<'_, AppState>) -> AppResult<()> {
    persistence::save_session(&state.database, &tabs).await
}

#[tauri::command]
pub async fn get_window_state(state: State<'_, AppState>) -> AppResult<Option<WindowState>> {
    persistence::get_window_state(&state.database).await
}

#[tauri::command]
pub async fn save_window_state(value: WindowState, state: State<'_, AppState>) -> AppResult<()> {
    persistence::save_window_state(&state.database, &value).await
}

#[tauri::command]
pub async fn read_spreadsheet(request: SpreadsheetRequest) -> AppResult<WorkbookView> {
    tauri::async_runtime::spawn_blocking(move || {
        spreadsheet::read(&request.path, request.sheet_index)
    })
    .await
    .map_err(|error| AppError::new("task_failed", error.to_string()))?
}

#[tauri::command]
pub async fn read_document(path: String) -> AppResult<DocumentContent> {
    tauri::async_runtime::spawn_blocking(move || document::read(&path))
        .await
        .map_err(|error| AppError::new("task_failed", error.to_string()))?
}

#[tauri::command]
pub async fn edit_spreadsheet(request: SpreadsheetEditRequest) -> AppResult<SpreadsheetEdit> {
    tauri::async_runtime::spawn_blocking(move || spreadsheet::edit(&request))
        .await
        .map_err(|error| AppError::new("task_failed", error.to_string()))?
}

#[tauri::command]
pub fn get_image_formats() -> AppResult<Vec<ImageFormatInfo>> {
    Ok(image::formats())
}

#[tauri::command]
pub async fn convert_image(request: ImageConvertRequest) -> AppResult<ImageConversion> {
    tauri::async_runtime::spawn_blocking(move || image::convert(&request))
        .await
        .map_err(|error| AppError::new("task_failed", error.to_string()))?
}

#[tauri::command]
pub async fn list_archive_entries(path: String) -> AppResult<Vec<ArchiveEntry>> {
    tauri::async_runtime::spawn_blocking(move || archive::list(&path))
        .await
        .map_err(|error| AppError::new("task_failed", error.to_string()))?
}

#[tauri::command]
pub async fn extract_archive_entries(
    app: AppHandle,
    request: ExtractionRequest,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let cancellations = state.cancellations.clone();
    tauri::async_runtime::spawn_blocking(move || archive::extract(app, request, cancellations))
        .await
        .map_err(|error| AppError::new("task_failed", error.to_string()))?
}

#[tauri::command]
pub fn cancel_operation(operation_id: String, state: State<'_, AppState>) -> AppResult<()> {
    let value = state.cancellations.get(&operation_id).ok_or_else(|| {
        AppError::new("operation_not_found", "The operation is no longer running")
    })?;
    value.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn take_startup_files(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    let mut files = state
        .startup_files
        .lock()
        .map_err(|_| AppError::new("state_error", "Startup-file state is unavailable"))?;
    Ok(std::mem::take(&mut *files))
}

fn ensure_not_modified(path: &Path, expected: u64) -> AppResult<()> {
    let current = std::fs::metadata(path)
        .and_then(|value| value.modified())
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64);
    if current != Some(expected) {
        return Err(AppError::path(
            "external_modification",
            "The file changed outside OneOpen",
            path,
        ));
    }
    Ok(())
}

fn ensure_pdf_extension(path: &Path) -> AppResult<()> {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("pdf"))
    {
        Ok(())
    } else {
        Err(AppError::path(
            "invalid_pdf_destination",
            "PDF edits must be saved to a .pdf file",
            path,
        ))
    }
}

fn decode_pdf(content_base64: &str) -> AppResult<Vec<u8>> {
    if content_base64.len() > (MAX_PDF_SAVE_BYTES * 4 / 3) + 4 {
        return Err(AppError::new(
            "pdf_save_limit",
            "Edited PDF exceeds the 64 MiB save limit",
        ));
    }
    let content = BASE64
        .decode(content_base64)
        .map_err(|error| AppError::new("invalid_pdf_data", error.to_string()))?;
    if content.len() > MAX_PDF_SAVE_BYTES {
        return Err(AppError::new(
            "pdf_save_limit",
            "Edited PDF exceeds the 64 MiB save limit",
        ));
    }
    if !content.starts_with(b"%PDF-") {
        return Err(AppError::new(
            "invalid_pdf_data",
            "Edited content is not a PDF document",
        ));
    }
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use assert_fs::{fixture::PathChild, TempDir};
    use filetime::{set_file_mtime, FileTime};

    #[test]
    fn external_modification_timestamp_is_observable() {
        let dir = TempDir::new().unwrap();
        let file = dir.child("file.txt");
        std::fs::write(file.path(), "old").unwrap();
        let original = std::fs::metadata(file.path()).unwrap().modified().unwrap();
        set_file_mtime(
            file.path(),
            FileTime::from_unix_time(
                original.duration_since(UNIX_EPOCH).unwrap().as_secs() as i64 + 10,
                0,
            ),
        )
        .unwrap();
        assert_ne!(
            std::fs::metadata(file.path()).unwrap().modified().unwrap(),
            original
        );
    }

    #[test]
    fn accepts_only_pdf_binary_content() {
        let encoded = BASE64.encode(b"%PDF-1.7\nfixture");
        assert_eq!(decode_pdf(&encoded).unwrap(), b"%PDF-1.7\nfixture");
        let invalid = BASE64.encode(b"not a PDF");
        assert_eq!(decode_pdf(&invalid).unwrap_err().code, "invalid_pdf_data");
        assert_eq!(
            decode_pdf("not base64!").unwrap_err().code,
            "invalid_pdf_data"
        );
    }
}
