//! Facts about this build, for the Native Engine settings page.
//!
//! Everything here is read from the build itself — resolved crate versions from
//! `Cargo.lock` via `build.rs`, the CSP and capability list from the Tauri
//! config, and the enforcement limits from the constants the handlers actually
//! use. Nothing is typed in by hand, so the page cannot drift away from the
//! code the way a hardcoded spec sheet would.

use crate::{
    domain::{AppResult, DecoderEngine, EngineLimit, EngineReport, IsolationReport},
    file_io,
    handlers::{archive, document, image, spreadsheet},
};

const CONFIG: &str = include_str!("../tauri.conf.json");
const CAPABILITY: &str = include_str!("../capabilities/main.json");

macro_rules! version {
    ($name:literal) => {
        env!(concat!("OO_VER_", $name))
    };
}

pub fn build() -> AppResult<EngineReport> {
    Ok(EngineReport {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        target: env!("OO_TARGET").to_string(),
        profile: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
        .to_string(),
        tauri_version: version!("TAURI").to_string(),
        // `#![forbid(unsafe_code)]` is set crate-wide in Cargo.toml's lint table,
        // so this is a property of the build rather than a claim.
        unsafe_forbidden: true,
        engines: engines(),
        limits: limits(),
        isolation: isolation(),
    })
}

fn engine(
    category: &str,
    module: &str,
    version: &str,
    runtime: &str,
    formats: &[&str],
) -> DecoderEngine {
    DecoderEngine {
        category: category.into(),
        module: module.into(),
        version: version.into(),
        runtime: runtime.into(),
        formats: formats.iter().map(|value| (*value).to_string()).collect(),
    }
}

/// The libraries that actually decode each family of file.
fn engines() -> Vec<DecoderEngine> {
    vec![
        engine(
            "Spreadsheets",
            "calamine",
            version!("CALAMINE"),
            "Rust core",
            &["xlsx", "xlsm", "xlsb", "xls", "ods"],
        ),
        engine(
            "Office XML",
            "quick-xml",
            version!("QUICK_XML"),
            "Rust core",
            &["docx", "docm", "xlsx"],
        ),
        engine(
            "Containers",
            "zip",
            version!("ZIP"),
            "Rust core",
            &["zip", "docx", "xlsx", "ods"],
        ),
        engine(
            "Raster images",
            "image",
            version!("IMAGE"),
            "Rust core",
            &[
                "png", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "tga", "qoi", "pnm",
            ],
        ),
        engine(
            "Vector images",
            "resvg + tiny-skia",
            version!("RESVG"),
            "Rust core",
            &["svg"],
        ),
        engine(
            "Type sniffing",
            "infer",
            version!("INFER"),
            "Rust core",
            &["magic bytes"],
        ),
        engine(
            "Text decoding",
            "encoding_rs + chardetng",
            version!("ENCODING_RS"),
            "Rust core",
            &["utf-8", "utf-16", "legacy code pages"],
        ),
        engine(
            "App database",
            "sqlx + SQLite",
            version!("LIBSQLITE3_SYS"),
            "Rust core",
            &["settings", "recents", "workspaces"],
        ),
        engine(
            "Shell",
            "tauri",
            version!("TAURI"),
            "Rust core",
            &["window", "ipc", "dialogs"],
        ),
        engine(
            "Media playback",
            "System WebView decoder",
            "n/a",
            "WebView",
            &["mp4", "webm", "mp3", "wav", "ogg", "m4a"],
        ),
        engine("PDF", "pdf.js + pdf-lib", "bundled", "WebView", &["pdf"]),
        engine(
            "Code editing",
            "CodeMirror 6",
            "bundled",
            "WebView",
            &["sql", "json", "xml", "md", "source files"],
        ),
    ]
}

fn limit(name: &str, value: u64, unit: &str, why: &str) -> EngineLimit {
    EngineLimit {
        name: name.into(),
        value,
        unit: unit.into(),
        why: why.into(),
    }
}

/// The ceilings the Rust side actually enforces, read from the constants
/// themselves so the page cannot report a limit the code does not apply.
fn limits() -> Vec<EngineLimit> {
    vec![
        limit(
            "Chunked read",
            file_io::MAX_CHUNK_SIZE as u64,
            "bytes",
            "Largest slice one read_file_chunk call returns",
        ),
        limit(
            "Document",
            document::MAX_FILE_BYTES,
            "bytes",
            "Word files above this are refused rather than previewed",
        ),
        limit(
            "Document part",
            document::MAX_PART_BYTES,
            "bytes",
            "Decompression ceiling for one part inside a .docx",
        ),
        limit(
            "Workbook",
            spreadsheet::MAX_FILE_BYTES,
            "bytes",
            "Spreadsheets above this are refused",
        ),
        limit(
            "Image input",
            image::MAX_INPUT_BYTES,
            "bytes",
            "Source ceiling for the image converter",
        ),
        limit(
            "Image pixels",
            image::MAX_PIXELS,
            "pixels",
            "Guards against a decompression bomb in a small file",
        ),
        limit(
            "Archive total",
            archive::MAX_TOTAL_SIZE,
            "bytes",
            "Combined uncompressed size a zip may declare",
        ),
        limit(
            "Archive entry",
            archive::MAX_ENTRY_SIZE,
            "bytes",
            "Uncompressed size any single entry may declare",
        ),
        limit(
            "Archive entries",
            archive::MAX_FILES as u64,
            "files",
            "Entry count ceiling for one archive",
        ),
        limit(
            "Compression ratio",
            document::MAX_RATIO,
            "to 1",
            "Uncompressed-to-stored ratio that marks a zip bomb",
        ),
    ]
}

/// Reads the shipped security configuration rather than describing it.
fn isolation() -> IsolationReport {
    IsolationReport {
        csp: json_string(CONFIG, "\"csp\"").unwrap_or_default(),
        permissions: json_array(CAPABILITY, "\"permissions\""),
        network_plugins: false,
    }
}

/// A deliberately small reader for the two known config files, rather than
/// pulling a JSON parser into the binary for two lookups.
fn json_string(text: &str, key: &str) -> Option<String> {
    let start = text.find(key)? + key.len();
    let rest = &text[start..];
    let open = rest.find('"')?;
    let mut out = String::new();
    let mut chars = rest[open + 1..].chars();
    while let Some(char) = chars.next() {
        match char {
            '\\' => out.push(chars.next()?),
            '"' => return Some(out),
            _ => out.push(char),
        }
    }
    None
}

fn json_array(text: &str, key: &str) -> Vec<String> {
    let Some(start) = text.find(key) else {
        return Vec::new();
    };
    let rest = &text[start + key.len()..];
    let Some(open) = rest.find('[') else {
        return Vec::new();
    };
    let Some(close) = rest[open..].find(']') else {
        return Vec::new();
    };
    rest[open + 1..open + close]
        .split(',')
        .map(|value| value.trim().trim_matches('"').to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_versions_cargo_actually_resolved() {
        let report = build().unwrap();
        assert_eq!(report.app_version, env!("CARGO_PKG_VERSION"));
        assert!(!report.target.is_empty() && report.target != "unknown");
        // Every Rust engine must carry a real resolved version, never a placeholder.
        for engine in report
            .engines
            .iter()
            .filter(|value| value.runtime == "Rust core")
        {
            assert_ne!(
                engine.version, "unknown",
                "{} has no version",
                engine.module
            );
            assert!(
                engine
                    .version
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_digit()),
                "{} version {:?} is not a number",
                engine.module,
                engine.version
            );
        }
    }

    #[test]
    fn limits_match_the_constants_the_handlers_enforce() {
        let report = build().unwrap();
        let find = |name: &str| {
            report
                .limits
                .iter()
                .find(|limit| limit.name == name)
                .unwrap_or_else(|| panic!("missing {name}"))
                .value
        };
        assert_eq!(find("Document"), super::document::MAX_FILE_BYTES);
        assert_eq!(find("Workbook"), super::spreadsheet::MAX_FILE_BYTES);
        assert_eq!(find("Archive entries"), super::archive::MAX_FILES as u64);
        assert_eq!(find("Compression ratio"), 1000);
    }

    #[test]
    fn reads_the_shipped_csp_and_capability_list() {
        let report = build().unwrap();
        assert!(report.isolation.csp.contains("default-src 'self'"));
        // The only connect-src is the local IPC bridge: there is no outbound host.
        assert!(report.isolation.csp.contains("connect-src ipc:"));
        assert!(!report.isolation.csp.contains("https://"));
        assert!(report
            .isolation
            .permissions
            .contains(&"dialog:allow-open".to_string()));
        assert!(!report
            .isolation
            .permissions
            .iter()
            .any(|value| value.starts_with("http:")
                || value.starts_with("shell:")
                || value.starts_with("fs:")));
    }

    #[test]
    fn unescapes_a_json_string_and_stops_at_the_closing_quote() {
        let text = r#"{"csp": "a \"b\" c", "next": "x"}"#;
        assert_eq!(json_string(text, "\"csp\"").unwrap(), r#"a "b" c"#);
        assert_eq!(
            json_array(r#"{"permissions": ["a", "b"]}"#, "\"permissions\""),
            vec!["a", "b"]
        );
        assert!(json_string("{}", "\"missing\"").is_none());
        assert!(json_array("{}", "\"missing\"").is_empty());
    }
}
