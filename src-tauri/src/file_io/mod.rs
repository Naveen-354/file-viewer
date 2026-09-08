use crate::{
    domain::{AppError, AppResult, FileChunk},
    security,
};
use atomicwrites::{AllowOverwrite, AtomicFile};
use std::{
    fs::OpenOptions,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

pub const MAX_CHUNK_SIZE: usize = 4 * 1024 * 1024;

pub fn read_chunk(
    path: &str,
    offset: u64,
    length: usize,
    decode_text: bool,
) -> AppResult<FileChunk> {
    if length == 0 || length > MAX_CHUNK_SIZE {
        return Err(AppError::new(
            "invalid_chunk_size",
            format!("Chunk length must be between 1 and {MAX_CHUNK_SIZE} bytes"),
        ));
    }
    let canonical = security::canonical_file(path)?;
    let size = std::fs::metadata(&canonical)
        .map_err(|error| AppError::io(error, &canonical))?
        .len();
    if offset > size {
        return Err(AppError::path(
            "invalid_offset",
            "Read offset exceeds file size",
            &canonical,
        ));
    }
    let amount = length.min((size - offset) as usize);
    let mut bytes = vec![0; amount];
    let mut file = OpenOptions::new()
        .read(true)
        .open(&canonical)
        .map_err(|error| AppError::io(error, &canonical))?;
    file.seek(SeekFrom::Start(offset))
        .and_then(|_| file.read_exact(&mut bytes))
        .map_err(|error| AppError::io(error, &canonical))?;
    let (text, encoding) = if decode_text {
        let mut detector = chardetng::EncodingDetector::new();
        detector.feed(&bytes, true);
        let selected = detector.guess(None, true);
        let (value, _, _) = selected.decode(&bytes);
        (Some(value.into_owned()), Some(selected.name().to_owned()))
    } else {
        (None, None)
    };
    Ok(FileChunk {
        offset,
        bytes,
        text,
        encoding,
        eof: offset + amount as u64 >= size,
    })
}

pub fn atomic_save(path: &Path, content: &str) -> AppResult<()> {
    atomic_save_bytes(path, content.as_bytes())
}

pub fn atomic_save_bytes(path: &Path, content: &[u8]) -> AppResult<()> {
    let target = path.to_path_buf();
    AtomicFile::new(path, AllowOverwrite)
        .write(|file| {
            file.write_all(content)?;
            file.sync_all()
        })
        .map_err(|error| AppError::path("save_failed", error.to_string(), &target))
}

/// Works out where a rename would land, and refuses the ones that would lose
/// data or escape the folder.
///
/// Split out from the command so the awkward cases — a name that is really a
/// path, a destination that already exists, a rename that only changes case —
/// can be tested against real files.
pub fn plan_rename(path: &str, new_name: &str) -> AppResult<(PathBuf, PathBuf)> {
    let source = security::canonical_file(path)?;
    let name = security::validate_file_name(new_name)?;
    let parent = source
        .parent()
        .ok_or_else(|| AppError::path("invalid_path", "The file has no parent folder", &source))?;
    let destination = parent.join(name);
    if destination == source {
        return Err(AppError::path(
            "unchanged_name",
            "That is already the file's name",
            &source,
        ));
    }
    // Checked before the rename because `fs::rename` replaces an existing file
    // without asking. A case-only rename on Windows still resolves to the same
    // file, so it is allowed through: the equality check above ruled out a no-op.
    if destination.exists() && !same_file(&source, &destination) {
        return Err(AppError::path(
            "destination_exists",
            format!("{name} already exists in this folder"),
            &destination,
        ));
    }
    Ok((source, destination))
}

/// Windows compares file names case-insensitively, so `a.sql` and `A.SQL` are
/// the same file and a case-only rename must not look like a collision.
fn same_file(left: &Path, right: &Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

pub fn rename(path: &str, new_name: &str) -> AppResult<(PathBuf, PathBuf)> {
    let (source, destination) = plan_rename(path, new_name)?;
    std::fs::rename(&source, &destination).map_err(|error| AppError::io(error, &destination))?;
    Ok((source, destination))
}

#[cfg(test)]
mod tests {

    #[test]
    fn plans_a_rename_inside_the_same_folder() {
        let dir = TempDir::new().unwrap();
        let file = dir.child("old.sql");
        std::fs::write(file.path(), "select 1;").unwrap();
        let (source, destination) =
            super::plan_rename(&file.path().to_string_lossy(), "new.sql").unwrap();
        assert_eq!(source.parent(), destination.parent());
        assert_eq!(destination.file_name().unwrap(), "new.sql");
    }

    #[test]
    fn refuses_a_name_that_would_move_the_file_elsewhere() {
        let dir = TempDir::new().unwrap();
        let file = dir.child("old.sql");
        std::fs::write(file.path(), "select 1;").unwrap();
        let path = file.path().to_string_lossy().into_owned();
        for name in ["../escaped.sql", "sub\\nested.sql", "C:\\elsewhere.sql"] {
            let error = super::plan_rename(&path, name).unwrap_err();
            assert_eq!(error.code, "invalid_name", "accepted {name}");
        }
    }

    #[test]
    fn refuses_to_overwrite_an_existing_file() {
        let dir = TempDir::new().unwrap();
        let file = dir.child("old.sql");
        let taken = dir.child("taken.sql");
        std::fs::write(file.path(), "select 1;").unwrap();
        std::fs::write(taken.path(), "keep me").unwrap();
        let error = super::plan_rename(&file.path().to_string_lossy(), "taken.sql").unwrap_err();
        assert_eq!(error.code, "destination_exists");
        // The file that was already there is untouched.
        assert_eq!(std::fs::read_to_string(taken.path()).unwrap(), "keep me");
    }

    #[test]
    fn refuses_a_rename_that_changes_nothing() {
        let dir = TempDir::new().unwrap();
        let file = dir.child("old.sql");
        std::fs::write(file.path(), "select 1;").unwrap();
        let error = super::plan_rename(&file.path().to_string_lossy(), "old.sql").unwrap_err();
        assert_eq!(error.code, "unchanged_name");
    }

    #[test]
    fn allows_a_rename_that_only_changes_case() {
        let dir = TempDir::new().unwrap();
        let file = dir.child("old.sql");
        std::fs::write(file.path(), "select 1;").unwrap();
        let (_, destination) =
            super::plan_rename(&file.path().to_string_lossy(), "OLD.SQL").unwrap();
        assert_eq!(destination.file_name().unwrap(), "OLD.SQL");
    }

    #[test]
    fn renaming_moves_the_content_and_leaves_nothing_behind() {
        let dir = TempDir::new().unwrap();
        let file = dir.child("old.sql");
        std::fs::write(file.path(), "select 1;").unwrap();
        let (source, destination) =
            super::rename(&file.path().to_string_lossy(), "new.sql").unwrap();
        assert!(!source.exists());
        assert_eq!(std::fs::read_to_string(&destination).unwrap(), "select 1;");
    }
    use super::atomic_save;
    use assert_fs::{fixture::PathChild, TempDir};

    #[test]
    fn replaces_file_atomically() {
        let dir = TempDir::new().unwrap();
        let file = dir.child("with spaces Ω.txt");
        std::fs::write(file.path(), "old").unwrap();
        atomic_save(file.path(), "new content").unwrap();
        assert_eq!(std::fs::read_to_string(file.path()).unwrap(), "new content");
    }

    #[test]
    fn rejects_unbounded_chunk_requests() {
        let result = super::read_chunk("missing", 0, super::MAX_CHUNK_SIZE + 1, false);
        assert_eq!(result.unwrap_err().code, "invalid_chunk_size");
    }
}
