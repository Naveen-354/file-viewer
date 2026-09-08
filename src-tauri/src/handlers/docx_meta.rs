//! Package-level facts about a Word document.
//!
//! Everything here is read out of the OOXML package itself: `docProps`,
//! `settings.xml`, `fontTable.xml` and the part listing. Nothing is inferred,
//! so a field the document does not carry stays `None` and the panel omits it.

use crate::domain::{AppError, AppResult, DocumentPart, DocumentProperties};
use quick_xml::{events::Event, Reader};
use std::io::{Read, Seek};
use zip::ZipArchive;

const MAX_PART_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FONTS: usize = 60;
const MAX_PARTS: usize = 200;

pub fn read<R: Read + Seek>(archive: &mut ZipArchive<R>) -> AppResult<DocumentProperties> {
    let mut properties = DocumentProperties::default();

    if let Some(bytes) = small_part(archive, "docProps/core.xml")? {
        for (name, value) in elements(&bytes)? {
            match name.as_str() {
                "title" => properties.title = non_empty(value),
                "subject" => properties.subject = non_empty(value),
                "creator" => properties.author = non_empty(value),
                "lastModifiedBy" => properties.last_modified_by = non_empty(value),
                "revision" => properties.revision = non_empty(value),
                "created" => properties.created = non_empty(value),
                "modified" => properties.modified = non_empty(value),
                "keywords" => properties.keywords = non_empty(value),
                _ => {}
            }
        }
    }

    if let Some(bytes) = small_part(archive, "docProps/app.xml")? {
        for (name, value) in elements(&bytes)? {
            match name.as_str() {
                "Application" => properties.generator = non_empty(value),
                "AppVersion" => properties.generator_version = non_empty(value),
                "Company" => properties.company = non_empty(value),
                "TotalTime" => properties.total_edit_minutes = value.parse().ok(),
                "Pages" => properties.pages = value.parse().ok(),
                "Words" => properties.words = value.parse().ok(),
                "Characters" => properties.characters = value.parse().ok(),
                "Paragraphs" => properties.paragraphs = value.parse().ok(),
                _ => {}
            }
        }
    }

    if let Some(bytes) = small_part(archive, "word/settings.xml")? {
        let mut reader = xml(&bytes);
        let mut buffer = Vec::new();
        loop {
            match reader
                .read_event_into(&mut buffer)
                .map_err(|error| AppError::new("invalid_document", error.to_string()))?
            {
                Event::Start(element) | Event::Empty(element) => {
                    match element.local_name().as_ref() {
                        b"documentProtection" => {
                            properties.protection = attribute(&element, b"edit")
                                .map(|value| protection_label(&value).to_owned());
                        }
                        b"trackChanges" => properties.track_changes = true,
                        _ => {}
                    }
                }
                Event::Eof => break,
                _ => {}
            }
            buffer.clear();
        }
    }

    if let Some(bytes) = small_part(archive, "word/fontTable.xml")? {
        let mut reader = xml(&bytes);
        let mut buffer = Vec::new();
        loop {
            match reader
                .read_event_into(&mut buffer)
                .map_err(|error| AppError::new("invalid_document", error.to_string()))?
            {
                Event::Start(element) | Event::Empty(element) => {
                    if element.local_name().as_ref() == b"font" {
                        if let Some(name) = attribute(&element, b"name") {
                            if !name.is_empty()
                                && !properties.fonts.contains(&name)
                                && properties.fonts.len() < MAX_FONTS
                            {
                                properties.fonts.push(name);
                            }
                        }
                    }
                }
                Event::Eof => break,
                _ => {}
            }
            buffer.clear();
        }
    }

    for index in 0..archive.len().min(MAX_PARTS) {
        let entry = archive
            .by_index_raw(index)
            .map_err(|error| AppError::new("invalid_document", error.to_string()))?;
        let name = entry.name().to_owned();
        // A macro project or a signature block is worth surfacing on its own.
        if name.eq_ignore_ascii_case("word/vbaProject.bin") {
            properties.has_macros = true;
        }
        if name.starts_with("_xmlsignatures/") {
            properties.has_signature = true;
        }
        properties.parts.push(DocumentPart {
            name,
            size: entry.size(),
            compressed_size: entry.compressed_size(),
        });
    }
    properties
        .parts
        .sort_by_key(|part| std::cmp::Reverse(part.size));
    Ok(properties)
}

/// `w:documentProtection w:edit="readOnly"` becomes something a person reads.
fn protection_label(value: &str) -> &'static str {
    match value {
        "readOnly" => "Read-only",
        "comments" => "Comments only",
        "trackedChanges" => "Tracked changes only",
        "forms" => "Form fields only",
        "none" => "None",
        _ => "Restricted",
    }
}

/// Counts the tracked insertions and deletions already present in the body.
pub fn count_revisions(body: &[u8]) -> AppResult<(usize, usize)> {
    let mut reader = xml(body);
    let mut buffer = Vec::new();
    let mut insertions = 0;
    let mut deletions = 0;
    loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|error| AppError::new("invalid_document", error.to_string()))?
        {
            Event::Start(element) | Event::Empty(element) => match element.local_name().as_ref() {
                b"ins" => insertions += 1,
                b"del" => deletions += 1,
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    Ok((insertions, deletions))
}

fn small_part<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> AppResult<Option<Vec<u8>>> {
    let mut entry = match archive.by_name(name) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(error) => return Err(AppError::new("invalid_document", error.to_string())),
    };
    if entry.size() > MAX_PART_BYTES {
        return Ok(None);
    }
    let mut buffer = Vec::with_capacity(entry.size().min(MAX_PART_BYTES) as usize);
    entry
        .by_ref()
        .take(MAX_PART_BYTES)
        .read_to_end(&mut buffer)
        .map_err(|error| AppError::new("invalid_document", error.to_string()))?;
    Ok(Some(buffer))
}

fn xml(bytes: &[u8]) -> Reader<&[u8]> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().check_end_names = false;
    reader
}

/// Flat list of every element's local name and its text, which is all the
/// `docProps` parts need.
fn elements(bytes: &[u8]) -> AppResult<Vec<(String, String)>> {
    let mut reader = xml(bytes);
    let mut buffer = Vec::new();
    let mut found = Vec::new();
    let mut current: Option<String> = None;
    let mut text = String::new();
    loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|error| AppError::new("invalid_document", error.to_string()))?
        {
            Event::Start(element) => {
                current = Some(String::from_utf8_lossy(element.local_name().as_ref()).into_owned());
                text.clear();
            }
            Event::Text(value) => {
                if current.is_some() {
                    text.push_str(
                        value
                            .unescape()
                            .map_err(|error| AppError::new("invalid_document", error.to_string()))?
                            .as_ref(),
                    );
                }
            }
            Event::End(_) => {
                if let Some(name) = current.take() {
                    found.push((name, text.trim().to_owned()));
                    text.clear();
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    Ok(found)
}

fn attribute(element: &quick_xml::events::BytesStart<'_>, name: &[u8]) -> Option<String> {
    element.attributes().flatten().find_map(|attribute| {
        (attribute.key.local_name().as_ref() == name)
            .then(|| String::from_utf8_lossy(attribute.value.as_ref()).into_owned())
    })
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.chars().take(200).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    fn package(parts: &[(&str, &[u8])]) -> ZipArchive<Cursor<Vec<u8>>> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, content) in parts {
            zip::write::ZipWriter::start_file(&mut writer, *name, options).unwrap();
            writer.write_all(content).unwrap();
        }
        ZipArchive::new(writer.finish().unwrap()).unwrap()
    }

    const CORE: &[u8] = br#"<cp:coreProperties xmlns:cp="c" xmlns:dc="d" xmlns:dcterms="t">
      <dc:title>Master Services Agrmt</dc:title>
      <dc:creator>A. Sterling (Legal)</dc:creator>
      <cp:lastModifiedBy>A. Sterling</cp:lastModifiedBy>
      <cp:revision>14</cp:revision>
      <dcterms:created>2025-01-14T09:30:00Z</dcterms:created>
      <dcterms:modified>2025-02-02T11:24:00Z</dcterms:modified>
    </cp:coreProperties>"#;

    const APP: &[u8] = br#"<Properties><Application>Microsoft Office Word</Application>
      <AppVersion>16.0.37029</AppVersion><TotalTime>184</TotalTime>
      <Pages>8</Pages><Words>3420</Words><Characters>19004</Characters>
      <Company>OneOpen Systems</Company></Properties>"#;

    #[test]
    fn reads_core_and_application_properties() {
        let mut archive = package(&[("docProps/core.xml", CORE), ("docProps/app.xml", APP)]);
        let properties = read(&mut archive).unwrap();
        assert_eq!(properties.title.as_deref(), Some("Master Services Agrmt"));
        assert_eq!(properties.author.as_deref(), Some("A. Sterling (Legal)"));
        assert_eq!(properties.revision.as_deref(), Some("14"));
        assert_eq!(properties.created.as_deref(), Some("2025-01-14T09:30:00Z"));
        assert_eq!(
            properties.generator.as_deref(),
            Some("Microsoft Office Word")
        );
        assert_eq!(properties.total_edit_minutes, Some(184));
        assert_eq!(properties.pages, Some(8));
        assert_eq!(properties.words, Some(3420));
        assert_eq!(properties.company.as_deref(), Some("OneOpen Systems"));
    }

    #[test]
    fn leaves_absent_properties_empty_rather_than_guessing() {
        let mut archive = package(&[("word/document.xml", b"<w:document/>")]);
        let properties = read(&mut archive).unwrap();
        assert!(properties.title.is_none());
        assert!(properties.author.is_none());
        assert!(properties.pages.is_none());
        assert!(properties.fonts.is_empty());
    }

    #[test]
    fn reports_document_protection_in_words() {
        let settings = br#"<w:settings xmlns:w="w"><w:documentProtection w:edit="readOnly" w:enforcement="1"/><w:trackChanges/></w:settings>"#;
        let mut archive = package(&[("word/settings.xml", settings)]);
        let properties = read(&mut archive).unwrap();
        assert_eq!(properties.protection.as_deref(), Some("Read-only"));
        assert!(properties.track_changes);
    }

    #[test]
    fn flags_a_macro_project_and_a_signature() {
        let mut plain = package(&[("word/document.xml", b"<w:document/>")]);
        let clean = read(&mut plain).unwrap();
        assert!(!clean.has_macros);
        assert!(!clean.has_signature);

        let mut risky = package(&[
            ("word/document.xml", b"<w:document/>"),
            ("word/vbaProject.bin", b"\x00\x01"),
            ("_xmlsignatures/sig1.xml", b"<sig/>"),
        ]);
        let flagged = read(&mut risky).unwrap();
        assert!(flagged.has_macros);
        assert!(flagged.has_signature);
    }

    #[test]
    fn lists_fonts_without_duplicates() {
        let fonts = br#"<w:fonts xmlns:w="w"><w:font w:name="Calibri"/><w:font w:name="Cambria"/><w:font w:name="Calibri"/></w:fonts>"#;
        let mut archive = package(&[("word/fontTable.xml", fonts)]);
        assert_eq!(
            read(&mut archive).unwrap().fonts,
            vec!["Calibri", "Cambria"]
        );
    }

    #[test]
    fn lists_package_parts_largest_first() {
        let mut archive = package(&[
            ("word/small.xml", b"<a/>"),
            ("word/document.xml", &[b'x'; 400]),
        ]);
        let parts = read(&mut archive).unwrap().parts;
        assert_eq!(parts[0].name, "word/document.xml");
        assert_eq!(parts[0].size, 400);
        assert!(parts.iter().any(|part| part.name == "word/small.xml"));
    }

    #[test]
    fn counts_tracked_insertions_and_deletions() {
        let body = br#"<w:body xmlns:w="w"><w:ins><w:r><w:t>new</w:t></w:r></w:ins>
          <w:del><w:r><w:delText>old</w:delText></w:r></w:del><w:ins/></w:body>"#;
        assert_eq!(count_revisions(body).unwrap(), (2, 1));
        assert_eq!(count_revisions(b"<w:body/>").unwrap(), (0, 0));
    }
}
