use crate::domain::{AppError, AppResult};
use std::path::{Component, Path, PathBuf};

pub fn canonical_file(path: impl AsRef<Path>) -> AppResult<PathBuf> {
    let path = path.as_ref();
    let canonical = std::fs::canonicalize(path).map_err(|error| AppError::io(error, path))?;
    let metadata =
        std::fs::metadata(&canonical).map_err(|error| AppError::io(error, &canonical))?;
    if !metadata.is_file() {
        return Err(AppError::path(
            "not_a_file",
            "The selected path is not a file",
            &canonical,
        ));
    }
    Ok(canonical)
}

pub fn canonical_directory(path: impl AsRef<Path>) -> AppResult<PathBuf> {
    let path = path.as_ref();
    let canonical = std::fs::canonicalize(path).map_err(|error| AppError::io(error, path))?;
    if !canonical.is_dir() {
        return Err(AppError::path(
            "not_a_directory",
            "The selected path is not a directory",
            &canonical,
        ));
    }
    Ok(canonical)
}

pub fn destination_file(path: impl AsRef<Path>) -> AppResult<PathBuf> {
    let path = path.as_ref();
    let name = path.file_name().ok_or_else(|| {
        AppError::path("invalid_path", "Destination must include a file name", path)
    })?;
    let parent = path.parent().ok_or_else(|| {
        AppError::path("invalid_path", "Destination has no parent directory", path)
    })?;
    let parent = canonical_directory(parent)?;
    Ok(parent.join(name))
}

/// Windows reserves these names in every directory, with or without an
/// extension. Creating one succeeds in some tools and then cannot be opened.
const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Checks that `name` is a plain file name a user could have typed.
///
/// A rename takes a name, never a path: anything with a separator, a drive
/// letter or a traversal component is refused here rather than being cleaned
/// up, so a rename can only ever move a file within its own directory.
pub fn validate_file_name(name: &str) -> AppResult<&str> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::new("invalid_name", "Enter a file name"));
    }
    if trimmed.chars().count() > 255 {
        return Err(AppError::new(
            "invalid_name",
            "A file name is limited to 255 characters",
        ));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(AppError::new("invalid_name", "That is not a file name"));
    }
    if let Some(bad) = trimmed.chars().find(|value| {
        matches!(value, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            || (*value as u32) < 0x20
    }) {
        let message = if matches!(bad, '/' | '\\') {
            "A file name cannot contain a folder separator".to_string()
        } else if (bad as u32) < 0x20 {
            "A file name cannot contain control characters".to_string()
        } else {
            format!("A file name cannot contain {bad}")
        };
        return Err(AppError::new("invalid_name", message));
    }
    // Surrounding spaces are trimmed above, but Windows also silently drops a
    // trailing dot, so the file would not end up with the name that was asked for.
    if trimmed.ends_with('.') {
        return Err(AppError::new(
            "invalid_name",
            "A file name cannot end with a dot",
        ));
    }
    let stem = trimmed.split('.').next().unwrap_or(trimmed);
    if RESERVED_NAMES
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
    {
        return Err(AppError::new(
            "invalid_name",
            format!("{stem} is a name Windows reserves for a device"),
        ));
    }
    Ok(trimmed)
}

pub fn safe_archive_path(name: &str) -> AppResult<PathBuf> {
    let candidate = Path::new(name);
    if candidate.is_absolute() || name.contains('\0') || name.contains(':') {
        return Err(AppError::new(
            "unsafe_archive_path",
            "Archive entry uses an absolute or device path",
        ));
    }
    let mut clean = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            _ => {
                return Err(AppError::new(
                    "unsafe_archive_path",
                    "Archive entry attempts directory traversal",
                ))
            }
        }
    }
    if clean.as_os_str().is_empty() {
        return Err(AppError::new(
            "unsafe_archive_path",
            "Archive entry has an empty path",
        ));
    }
    Ok(clean)
}

#[cfg(test)]
mod tests {
    use super::safe_archive_path;

    #[test]
    fn rejects_zip_traversal_and_absolute_paths() {
        for path in [
            "../secret",
            "a/../../secret",
            "/etc/passwd",
            "C:\\Windows\\file",
            "\\\\server\\share",
        ] {
            assert!(safe_archive_path(path).is_err(), "accepted {path}");
        }
        assert!(safe_archive_path("folder/good.txt").is_ok());
    }

    #[test]
    fn rejects_names_that_are_paths_or_reserved_devices() {
        for name in [
            "",
            "   ",
            ".",
            "..",
            "a/b",
            "a\\b",
            "C:file",
            "star*",
            "quote\"",
            "pipe|",
            "trailing.",
            "CON",
            "nul.txt",
            "lpt1.log",
        ] {
            assert!(
                super::validate_file_name(name).is_err(),
                "accepted {name:?}"
            );
        }
    }

    #[test]
    fn accepts_ordinary_names_and_trims_them() {
        assert_eq!(
            super::validate_file_name("  schema.sql  ").unwrap(),
            "schema.sql"
        );
        // Surrounding spaces are trimmed rather than refused.
        assert_eq!(
            super::validate_file_name("notes.txt ").unwrap(),
            "notes.txt"
        );
        assert_eq!(
            super::validate_file_name("report (final).docx").unwrap(),
            "report (final).docx"
        );
        assert_eq!(
            super::validate_file_name("données.csv").unwrap(),
            "données.csv"
        );
        assert_eq!(
            super::validate_file_name(".gitignore").unwrap(),
            ".gitignore"
        );
    }

    #[test]
    fn missing_file_is_a_structured_error() {
        let error = super::canonical_file("definitely-missing-oneopen-fixture").unwrap_err();
        assert_eq!(error.code, "file_not_found");
    }
}
