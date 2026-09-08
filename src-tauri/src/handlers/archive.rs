use crate::{
    domain::{
        AppError, AppResult, ArchiveEntry, CollisionPolicy, ExtractionProgress, ExtractionRequest,
    },
    security,
};
use dashmap::DashMap;
use std::{
    collections::HashSet,
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter};
use zip::ZipArchive;

pub const MAX_FILES: usize = 100_000;
pub const MAX_TOTAL_SIZE: u64 = 4 * 1024 * 1024 * 1024;
pub const MAX_ENTRY_SIZE: u64 = 1024 * 1024 * 1024;
const MAX_RATIO: u64 = 1000;

pub fn list(path: &str) -> AppResult<Vec<ArchiveEntry>> {
    let canonical = security::canonical_file(path)?;
    let file = File::open(&canonical).map_err(|error| AppError::io(error, &canonical))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| AppError::path("invalid_archive", error.to_string(), &canonical))?;
    let entry_count = archive.len();
    validate_limits(entry_count, 0)?;
    let mut total = 0u64;
    let mut entries = Vec::with_capacity(entry_count);
    for index in 0..entry_count {
        let entry = archive
            .by_index(index)
            .map_err(|error| AppError::new("invalid_archive", error.to_string()))?;
        total = total.saturating_add(entry.size());
        validate_limits(entry_count, total)?;
        let unsafe_reason = entry_safety(&entry);
        entries.push(ArchiveEntry {
            index,
            path: entry.name().to_owned(),
            is_directory: entry.is_dir(),
            compressed_size: entry.compressed_size(),
            original_size: entry.size(),
            unsafe_reason,
        });
    }
    Ok(entries)
}

pub fn extract(
    app: AppHandle,
    request: ExtractionRequest,
    cancellations: Arc<DashMap<String, Arc<AtomicBool>>>,
) -> AppResult<()> {
    let archive_path = security::canonical_file(&request.archive_path)?;
    let destination = security::canonical_directory(&request.destination)?;
    let cancel = Arc::new(AtomicBool::new(false));
    cancellations.insert(request.operation_id.clone(), cancel.clone());
    let result = extract_inner(&app, &request, &archive_path, &destination, &cancel);
    cancellations.remove(&request.operation_id);
    result
}

fn extract_inner(
    app: &AppHandle,
    request: &ExtractionRequest,
    archive_path: &Path,
    destination: &Path,
    cancel: &AtomicBool,
) -> AppResult<()> {
    let file = File::open(archive_path).map_err(|error| AppError::io(error, archive_path))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| AppError::path("invalid_archive", error.to_string(), archive_path))?;
    let chosen: Option<HashSet<usize>> = request
        .entry_indices
        .as_ref()
        .map(|items| items.iter().copied().collect());
    let total = chosen.as_ref().map_or(archive.len(), HashSet::len);
    if total > MAX_FILES {
        return Err(AppError::new(
            "archive_file_limit",
            "Too many entries selected",
        ));
    }
    let mut extracted_size = 0u64;
    let mut completed = 0usize;
    for index in 0..archive.len() {
        if chosen.as_ref().is_some_and(|set| !set.contains(&index)) {
            continue;
        }
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::new("operation_cancelled", "Extraction cancelled"));
        }
        let mut entry = archive
            .by_index(index)
            .map_err(|error| AppError::new("invalid_archive", error.to_string()))?;
        if let Some(reason) = entry_safety(&entry) {
            return Err(AppError::new(
                "unsafe_archive_entry",
                format!("{}: {reason}", entry.name()),
            ));
        }
        extracted_size = extracted_size.saturating_add(entry.size());
        if extracted_size > MAX_TOTAL_SIZE {
            return Err(AppError::new(
                "archive_size_limit",
                "Extraction exceeds the decompressed-size limit",
            ));
        }
        let relative = security::safe_archive_path(entry.name())?;
        let mut target = destination.join(relative);
        if !target.starts_with(destination) {
            return Err(AppError::new(
                "unsafe_archive_path",
                "Entry escapes the destination directory",
            ));
        }
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|error| AppError::io(error, &target))?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|error| AppError::io(error, parent))?;
            }
            target = collision_target(target, request.collision)?;
            if request.collision == CollisionPolicy::Skip && target.exists() {
                completed += 1;
                continue;
            }
            let mut output = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&target)
                .map_err(|error| AppError::io(error, &target))?;
            let mut buffer = [0u8; 64 * 1024];
            loop {
                if cancel.load(Ordering::Relaxed) {
                    let _ = std::fs::remove_file(&target);
                    return Err(AppError::new("operation_cancelled", "Extraction cancelled"));
                }
                let count = entry
                    .read(&mut buffer)
                    .map_err(|error| AppError::io(error, archive_path))?;
                if count == 0 {
                    break;
                }
                output
                    .write_all(&buffer[..count])
                    .map_err(|error| AppError::io(error, &target))?;
            }
            output
                .sync_all()
                .map_err(|error| AppError::io(error, &target))?;
        }
        completed += 1;
        let _ = app.emit(
            "archive-progress",
            ExtractionProgress {
                operation_id: request.operation_id.clone(),
                completed,
                total,
                current: entry.name().to_owned(),
            },
        );
    }
    Ok(())
}

fn entry_safety<R: Read>(entry: &zip::read::ZipFile<'_, R>) -> Option<String> {
    if security::safe_archive_path(entry.name()).is_err() {
        return Some("Unsafe path".into());
    }
    if entry.size() > MAX_ENTRY_SIZE {
        return Some("Entry exceeds 1 GiB".into());
    }
    if entry.compressed_size() > 0 && entry.size() / entry.compressed_size().max(1) > MAX_RATIO {
        return Some("Suspicious compression ratio".into());
    }
    if entry
        .unix_mode()
        .is_some_and(|mode| mode & 0o170000 == 0o120000)
    {
        return Some("Symbolic links are not extracted".into());
    }
    None
}

fn collision_target(path: PathBuf, policy: CollisionPolicy) -> AppResult<PathBuf> {
    if !path.exists() || policy != CollisionPolicy::Rename {
        return Ok(path);
    }
    let parent = path.parent().unwrap_or(Path::new("."));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 1..10_000 {
        let name = extension.map_or_else(
            || format!("{stem} ({index})"),
            |ext| format!("{stem} ({index}).{ext}"),
        );
        let candidate = parent.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(AppError::new(
        "collision_limit",
        "Could not find a free destination name",
    ))
}

fn validate_limits(file_count: usize, total_size: u64) -> AppResult<()> {
    if file_count > MAX_FILES {
        return Err(AppError::new(
            "archive_file_limit",
            format!("Archive contains more than {MAX_FILES} entries"),
        ));
    }
    if total_size > MAX_TOTAL_SIZE {
        return Err(AppError::new(
            "archive_size_limit",
            "Archive decompressed size exceeds the 4 GiB safety limit",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{validate_limits, MAX_FILES, MAX_TOTAL_SIZE};

    #[test]
    fn enforces_archive_resource_limits() {
        assert_eq!(
            validate_limits(MAX_FILES + 1, 0).unwrap_err().code,
            "archive_file_limit"
        );
        assert_eq!(
            validate_limits(1, MAX_TOTAL_SIZE + 1).unwrap_err().code,
            "archive_size_limit"
        );
        assert!(validate_limits(MAX_FILES, MAX_TOTAL_SIZE).is_ok());
    }
}
