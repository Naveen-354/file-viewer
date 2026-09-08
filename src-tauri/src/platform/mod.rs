use crate::domain::{AppError, AppResult};
use crate::security;

pub fn open_with_system(path: &str) -> AppResult<()> {
    let canonical = security::canonical_file(path)?;
    open::that_detached(&canonical)
        .map_err(|error| AppError::path("external_open_failed", error.to_string(), &canonical))
}

pub fn show_in_folder(path: &str) -> AppResult<()> {
    let canonical = security::canonical_file(path)?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", canonical.to_string_lossy()))
            .spawn()
            .map(|_| ())
            .map_err(|error| AppError::path("show_in_folder_failed", error.to_string(), &canonical))
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&canonical)
            .spawn()
            .map(|_| ())
            .map_err(|error| AppError::path("show_in_folder_failed", error.to_string(), &canonical))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        open::that_detached(canonical.parent().unwrap_or(&canonical))
            .map_err(|error| AppError::path("show_in_folder_failed", error.to_string(), &canonical))
    }
}

pub fn print_file(path: &str) -> AppResult<()> {
    let canonical = security::canonical_file(path)?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                "Start-Process -FilePath $env:ONEOPEN_PRINT_FILE -Verb Print",
            ])
            .env("ONEOPEN_PRINT_FILE", &canonical)
            .creation_flags(0x08000000)
            .spawn()
            .map(|_| ())
            .map_err(|error| AppError::path("print_failed", error.to_string(), &canonical))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("lp")
            .arg(&canonical)
            .spawn()
            .map(|_| ())
            .map_err(|error| AppError::path("print_failed", error.to_string(), &canonical))
    }
}
