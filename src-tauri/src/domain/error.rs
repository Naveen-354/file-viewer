use serde::Serialize;
use std::path::Path;
use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Error, Serialize)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            path: None,
            details: None,
        }
    }

    pub fn path(code: &'static str, message: impl Into<String>, path: &Path) -> Self {
        Self {
            code,
            message: message.into(),
            path: Some(path.to_string_lossy().into_owned()),
            details: None,
        }
    }

    pub fn io(error: std::io::Error, path: &Path) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => "file_not_found",
            std::io::ErrorKind::PermissionDenied => "permission_denied",
            _ => "io_error",
        };
        Self {
            code,
            message: error.to_string(),
            path: Some(path.to_string_lossy().into_owned()),
            details: None,
        }
    }
}

impl From<sqlx::Error> for AppError {
    fn from(error: sqlx::Error) -> Self {
        Self::new("database_error", error.to_string())
    }
}
