use crate::{
    domain::{AppError, AppResult, FileDescriptor},
    security,
};
use std::{
    fs::File,
    io::Read,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

const SAMPLE_SIZE: usize = 8192;
const OLE2_SIGNATURE: &[u8] = &[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const TEXT_EXTENSIONS: &[&str] = &[
    "txt",
    "log",
    "md",
    "java",
    "kt",
    "kts",
    "js",
    "ts",
    "jsx",
    "tsx",
    "rs",
    "py",
    "yaml",
    "yml",
    "properties",
    "env",
];

pub fn detect(path: impl AsRef<Path>) -> AppResult<FileDescriptor> {
    let canonical = security::canonical_file(path)?;
    let metadata =
        std::fs::metadata(&canonical).map_err(|error| AppError::io(error, &canonical))?;
    let mut sample = vec![0; SAMPLE_SIZE.min(metadata.len() as usize)];
    if !sample.is_empty() {
        File::open(&canonical)
            .and_then(|mut file| file.read_exact(&mut sample))
            .map_err(|error| AppError::io(error, &canonical))?;
    }
    let extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    let (handler, detected, mime) = classify(&sample, extension.as_deref());
    Ok(FileDescriptor {
        path: canonical.to_string_lossy().into_owned(),
        name: canonical
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Unnamed file")
            .to_owned(),
        extension,
        mime_type: mime,
        detected_type: detected,
        handler_id: handler.to_owned(),
        size: metadata.len(),
        created_ms: metadata.created().ok().and_then(epoch_ms),
        modified_ms: metadata.modified().ok().and_then(epoch_ms),
        readonly: metadata.permissions().readonly(),
    })
}

fn epoch_ms(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|value| value.as_millis() as u64)
}

pub fn classify(sample: &[u8], extension: Option<&str>) -> (&'static str, String, Option<String>) {
    if sample.starts_with(b"%PDF-") {
        return ("pdf", "PDF document".into(), Some("application/pdf".into()));
    }
    if sample.starts_with(b"PK\x03\x04")
        || sample.starts_with(b"PK\x05\x06")
        || sample.starts_with(b"PK\x07\x08")
    {
        return classify_office_package(sample, extension).unwrap_or((
            "archive",
            "ZIP archive".into(),
            Some("application/zip".into()),
        ));
    }
    if sample.starts_with(OLE2_SIGNATURE) {
        return classify_legacy_office(extension);
    }
    if let Some(kind) = infer::get(sample) {
        let mime = kind.mime_type().to_owned();
        let handler = if mime.starts_with("image/") {
            "image"
        } else if mime.starts_with("audio/") || mime.starts_with("video/") {
            "media"
        } else {
            "fallback"
        };
        if handler != "fallback" {
            return (handler, mime.clone(), Some(mime));
        }
    }

    let text = decode_sample(sample);
    if let Some(text) = text {
        let trimmed = text.trim_start_matches('\u{feff}').trim_start();
        if trimmed.starts_with("<svg") || (trimmed.starts_with("<?xml") && trimmed.contains("<svg"))
        {
            return ("image", "SVG image".into(), Some("image/svg+xml".into()));
        }
        if matches!(extension, Some("json")) || trimmed.starts_with('{') || trimmed.starts_with('[')
        {
            return (
                "structured",
                "JSON data".into(),
                Some("application/json".into()),
            );
        }
        if matches!(extension, Some("xml")) || trimmed.starts_with("<?xml") {
            return (
                "structured",
                "XML data".into(),
                Some("application/xml".into()),
            );
        }
        if matches!(extension, Some("sql" | "ddl" | "psql")) {
            return ("sql", "SQL script".into(), Some("application/sql".into()));
        }
        if matches!(extension, Some("csv" | "tsv")) {
            return (
                "csv",
                "Delimited text".into(),
                Some(
                    if extension == Some("tsv") {
                        "text/tab-separated-values"
                    } else {
                        "text/csv"
                    }
                    .into(),
                ),
            );
        }
        if extension.is_some_and(|value| TEXT_EXTENSIONS.contains(&value)) || !sample.is_empty() {
            return ("text", "Text document".into(), Some("text/plain".into()));
        }
    }

    if sample.is_empty() && matches!(extension, Some("sql" | "ddl" | "psql")) {
        return (
            "sql",
            "Empty SQL script".into(),
            Some("application/sql".into()),
        );
    }
    if sample.is_empty() && extension.is_some_and(|value| TEXT_EXTENSIONS.contains(&value)) {
        return (
            "text",
            "Empty text document".into(),
            Some("text/plain".into()),
        );
    }
    let mime = extension
        .and_then(|value| mime_guess::from_ext(value).first_raw())
        .map(str::to_owned);
    (
        "fallback",
        mime.clone().unwrap_or_else(|| "Unknown binary file".into()),
        mime,
    )
}

/// Word and Excel files are ZIP packages, so they are recognised by the part
/// names visible in the leading local-file headers before falling back to the
/// extension. `[Content_Types].xml` keeps a plain ZIP that merely contains an
/// unpacked `xl/` or `word/` folder from being mistaken for a workbook.
fn classify_office_package(
    sample: &[u8],
    extension: Option<&str>,
) -> Option<(&'static str, String, Option<String>)> {
    if contains(
        sample,
        b"mimetypeapplication/vnd.oasis.opendocument.spreadsheet",
    ) {
        return Some((
            "spreadsheet",
            "OpenDocument spreadsheet".into(),
            Some("application/vnd.oasis.opendocument.spreadsheet".into()),
        ));
    }
    if contains(sample, b"[Content_Types].xml") {
        if contains(sample, b"word/document.xml") {
            return Some(word_document());
        }
        if contains(sample, b"xl/workbook.xml") || contains(sample, b"xl/worksheets/") {
            return Some(excel_workbook());
        }
    }
    match extension? {
        "docx" | "docm" => Some(word_document()),
        "xlsx" | "xlsm" | "xlsb" => Some(excel_workbook()),
        "ods" => Some((
            "spreadsheet",
            "OpenDocument spreadsheet".into(),
            Some("application/vnd.oasis.opendocument.spreadsheet".into()),
        )),
        _ => None,
    }
}

/// Legacy OLE2 documents share one container signature, so only the extension
/// separates a readable `.xls` workbook from a `.doc` the fallback viewer owns.
fn classify_legacy_office(extension: Option<&str>) -> (&'static str, String, Option<String>) {
    match extension {
        Some("xls" | "xla") => (
            "spreadsheet",
            "Excel 97-2003 workbook".into(),
            Some("application/vnd.ms-excel".into()),
        ),
        Some("doc" | "dot") => (
            "fallback",
            "Word 97-2003 document".into(),
            Some("application/msword".into()),
        ),
        Some("ppt" | "pps") => (
            "fallback",
            "PowerPoint 97-2003 presentation".into(),
            Some("application/vnd.ms-powerpoint".into()),
        ),
        _ => (
            "fallback",
            "Microsoft compound document".into(),
            Some("application/x-ole-storage".into()),
        ),
    }
}

fn word_document() -> (&'static str, String, Option<String>) {
    (
        "document",
        "Word document".into(),
        Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document".into()),
    )
}

fn excel_workbook() -> (&'static str, String, Option<String>) {
    (
        "spreadsheet",
        "Excel workbook".into(),
        Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".into()),
    )
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.len() >= needle.len()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn decode_sample(sample: &[u8]) -> Option<String> {
    if sample.is_empty() {
        return Some(String::new());
    }
    if sample.contains(&0)
        && !(sample.starts_with(&[0xff, 0xfe]) || sample.starts_with(&[0xfe, 0xff]))
    {
        return None;
    }
    if let Ok(text) = std::str::from_utf8(sample) {
        return Some(text.to_owned());
    }
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(sample, true);
    let encoding = detector.guess(None, true);
    let (text, _, had_errors) = encoding.decode(sample);
    (!had_errors).then(|| text.into_owned())
}

#[cfg(test)]
mod tests {
    use super::classify;

    #[test]
    fn detects_magic_before_extension() {
        assert_eq!(classify(b"%PDF-1.7", Some("txt")).0, "pdf");
        assert_eq!(classify(b"PK\x03\x04data", Some("txt")).0, "archive");
    }

    #[test]
    fn uses_extension_only_as_fallback() {
        assert_eq!(classify(b"hello", Some("txt")).0, "text");
        assert_eq!(classify(&[0, 1, 2], Some("txt")).0, "fallback");
    }

    #[test]
    fn routes_office_packages_by_part_names() {
        let word = b"PK\x03\x04....[Content_Types].xml....word/document.xml";
        let excel = b"PK\x03\x04....[Content_Types].xml....xl/workbook.xml";
        assert_eq!(classify(word, Some("zip")).0, "document");
        assert_eq!(classify(excel, Some("zip")).0, "spreadsheet");
        assert_eq!(
            classify(
                b"PK\x03\x04mimetypeapplication/vnd.oasis.opendocument.spreadsheet",
                None
            )
            .0,
            "spreadsheet"
        );
    }

    #[test]
    fn plain_zips_stay_archives_and_extensions_are_the_last_resort() {
        assert_eq!(classify(b"PK\x03\x04word/document.xml", None).0, "archive");
        assert_eq!(classify(b"PK\x03\x04notes.txt", Some("zip")).0, "archive");
        assert_eq!(classify(b"PK\x03\x04opaque", Some("docx")).0, "document");
        assert_eq!(classify(b"PK\x03\x04opaque", Some("xlsx")).0, "spreadsheet");
    }

    #[test]
    fn separates_legacy_office_documents_by_extension() {
        let ole = &[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00];
        assert_eq!(classify(ole, Some("xls")).0, "spreadsheet");
        assert_eq!(classify(ole, Some("doc")).0, "fallback");
        assert_eq!(classify(ole, None).0, "fallback");
    }

    #[test]
    fn routes_sql_scripts_to_their_own_viewer() {
        assert_eq!(classify(b"CREATE TABLE t (id INT);", Some("sql")).0, "sql");
        assert_eq!(classify(b"", Some("sql")).0, "sql");
        assert_eq!(classify(b"-- ddl", Some("ddl")).0, "sql");
        // Content still wins: a PDF named .sql is not a script.
        assert_eq!(classify(b"%PDF-1.7", Some("sql")).0, "pdf");
        // Anything else textual stays with the general text viewer.
        assert_eq!(classify(b"plain", Some("txt")).0, "text");
    }

    #[test]
    fn handles_empty_and_corrupt_data() {
        assert_eq!(classify(&[], Some("txt")).0, "text");
        assert_eq!(classify(&[0, 0xff, 3], Some("json")).0, "fallback");
    }
}
