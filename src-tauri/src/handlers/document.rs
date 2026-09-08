use crate::{
    domain::{
        AppError, AppResult, DocumentBlock, DocumentContent, DocumentProperties, DocumentRun,
    },
    security,
};
use quick_xml::{events::BytesStart, events::Event, Reader};
use std::{
    collections::HashMap,
    fs::File,
    io::{BufReader, Read},
    path::Path,
};
use zip::ZipArchive;

pub const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_PART_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_RATIO: u64 = 1000;
const MAX_BLOCKS: usize = 20_000;
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_TABLE_ROWS: usize = 5_000;
const MAX_TABLE_COLUMNS: usize = 64;

pub fn read(path: &str) -> AppResult<DocumentContent> {
    let canonical = security::canonical_file(path)?;
    let size = std::fs::metadata(&canonical)
        .map_err(|error| AppError::io(error, &canonical))?
        .len();
    if size > MAX_FILE_BYTES {
        return Err(AppError::path(
            "document_size_limit",
            "Document exceeds the 32 MiB preview limit",
            &canonical,
        ));
    }
    let file = File::open(&canonical).map_err(|error| AppError::io(error, &canonical))?;
    let mut archive = ZipArchive::new(BufReader::new(file))
        .map_err(|error| AppError::path("invalid_document", error.to_string(), &canonical))?;
    let body = part(&mut archive, "word/document.xml")?.ok_or_else(|| {
        AppError::path(
            "invalid_document",
            "The file is not a Word document because word/document.xml is missing",
            &canonical,
        )
    })?;
    let numbering = match part(&mut archive, "word/numbering.xml")? {
        Some(bytes) => parse_numbering(&bytes)?,
        None => HashMap::new(),
    };
    let properties = crate::handlers::docx_meta::read(&mut archive)?;
    let (insertions, deletions) = crate::handlers::docx_meta::count_revisions(&body)?;
    let mut content = parse_body(&body, &numbering).map_err(|error| annotate(error, &canonical))?;
    content.properties = properties;
    content.insertions = insertions;
    content.deletions = deletions;
    Ok(content)
}

fn annotate(error: AppError, path: &Path) -> AppError {
    if error.path.is_some() {
        error
    } else {
        AppError::path(error.code, error.message, path)
    }
}

/// Reads one package part with the same decompression defenses the archive
/// handler applies, so a hostile `.docx` cannot act as a zip bomb.
fn part<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> AppResult<Option<Vec<u8>>> {
    let mut entry = match archive.by_name(name) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(error) => return Err(AppError::new("invalid_document", error.to_string())),
    };
    if entry.size() > MAX_PART_BYTES {
        return Err(AppError::new(
            "document_size_limit",
            "A document part exceeds the 64 MiB decompression limit",
        ));
    }
    if entry.compressed_size() > 0 && entry.size() / entry.compressed_size().max(1) > MAX_RATIO {
        return Err(AppError::new(
            "unsafe_document_entry",
            "A document part has a suspicious compression ratio",
        ));
    }
    let mut buffer = Vec::with_capacity(entry.size().min(MAX_PART_BYTES) as usize);
    entry
        .by_ref()
        .take(MAX_PART_BYTES)
        .read_to_end(&mut buffer)
        .map_err(|error| AppError::new("invalid_document", error.to_string()))?;
    Ok(Some(buffer))
}

/// quick-xml never expands custom or external entities, so document XML cannot
/// mount an entity-expansion or external-reference attack.
fn xml(bytes: &[u8]) -> Reader<&[u8]> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().check_end_names = false;
    reader
}

fn attribute(element: &BytesStart<'_>, name: &[u8]) -> Option<String> {
    element.attributes().flatten().find_map(|attribute| {
        (attribute.key.local_name().as_ref() == name)
            .then(|| String::from_utf8_lossy(attribute.value.as_ref()).into_owned())
    })
}

/// `w:b`, `w:i` and `w:u` are on unless an explicit falsy `w:val` turns them off.
fn toggle(element: &BytesStart<'_>) -> bool {
    !matches!(
        attribute(element, b"val").as_deref(),
        Some("0" | "false" | "none" | "off")
    )
}

/// Maps each `numId` to whether its list levels are numbered rather than bulleted.
fn parse_numbering(bytes: &[u8]) -> AppResult<HashMap<String, Vec<bool>>> {
    let mut reader = xml(bytes);
    let mut buffer = Vec::new();
    let mut formats: HashMap<String, Vec<bool>> = HashMap::new();
    let mut instances: HashMap<String, String> = HashMap::new();
    let mut abstract_id: Option<String> = None;
    let mut num_id: Option<String> = None;
    let mut level = 0usize;
    loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|error| AppError::new("invalid_document", error.to_string()))?
        {
            Event::Start(element) | Event::Empty(element) => match element.local_name().as_ref() {
                b"abstractNum" => {
                    abstract_id = attribute(&element, b"abstractNumId");
                    num_id = None;
                }
                b"num" => {
                    num_id = attribute(&element, b"numId");
                    abstract_id = None;
                }
                b"abstractNumId" => {
                    if let (Some(id), Some(target)) = (&num_id, attribute(&element, b"val")) {
                        instances.insert(id.clone(), target);
                    }
                }
                b"lvl" => {
                    level = attribute(&element, b"ilvl")
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(0);
                }
                b"numFmt" => {
                    if let Some(id) = &abstract_id {
                        let ordered = !matches!(
                            attribute(&element, b"val").as_deref(),
                            Some("bullet" | "none")
                        );
                        let levels = formats.entry(id.clone()).or_default();
                        if levels.len() <= level {
                            levels.resize(level + 1, false);
                        }
                        levels[level] = ordered;
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    Ok(instances
        .into_iter()
        .filter_map(|(id, target)| formats.get(&target).map(|levels| (id, levels.clone())))
        .collect())
}

#[derive(Default)]
struct Paragraph {
    style: Option<String>,
    outline: Option<u8>,
    num_id: Option<String>,
    list_level: Option<u8>,
    runs: Vec<DocumentRun>,
}

#[derive(Default)]
struct Formatting {
    bold: bool,
    italic: bool,
    underline: bool,
}

fn parse_body(bytes: &[u8], numbering: &HashMap<String, Vec<bool>>) -> AppResult<DocumentContent> {
    let mut reader = xml(bytes);
    let mut buffer = Vec::new();
    let mut blocks: Vec<DocumentBlock> = Vec::new();
    let mut budget = MAX_TEXT_BYTES;
    let mut truncated = false;

    let mut paragraph = Paragraph::default();
    let mut format = Formatting::default();
    let mut in_properties = false;
    let mut in_run_properties = false;
    let mut capture = false;
    let mut pending = String::new();

    let mut table_depth = 0usize;
    let mut table_rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell: Option<String> = None;

    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| AppError::new("invalid_document", error.to_string()))?;
        // A self-closing `<w:p/>` never reaches the End arm, so the blank
        // paragraph it represents is emitted here instead of being dropped.
        let self_closing_paragraph =
            matches!(&event, Event::Empty(element) if element.local_name().as_ref() == b"p");
        match event {
            Event::Start(element) | Event::Empty(element) => match element.local_name().as_ref() {
                b"p" => paragraph = Paragraph::default(),
                b"pPr" => in_properties = true,
                b"rPr" => in_run_properties = true,
                b"pStyle" if in_properties => paragraph.style = attribute(&element, b"val"),
                b"outlineLvl" if in_properties => {
                    paragraph.outline =
                        attribute(&element, b"val").and_then(|value| value.parse().ok());
                }
                b"numPr" if in_properties => paragraph.list_level = Some(0),
                b"ilvl" if in_properties => {
                    paragraph.list_level =
                        attribute(&element, b"val").and_then(|value| value.parse().ok());
                }
                b"numId" if in_properties => paragraph.num_id = attribute(&element, b"val"),
                b"r" => format = Formatting::default(),
                b"b" if in_run_properties => format.bold = toggle(&element),
                b"i" if in_run_properties => format.italic = toggle(&element),
                b"u" if in_run_properties => format.underline = toggle(&element),
                b"t" => capture = true,
                b"tab" if !in_properties && !in_run_properties => pending.push('\t'),
                b"br" | b"cr" => pending.push('\n'),
                b"tbl" => {
                    table_depth += 1;
                    if table_depth == 1 {
                        table_rows.clear();
                    }
                }
                b"tr" if table_depth == 1 => row = Vec::new(),
                b"tc" if table_depth == 1 => cell = Some(String::new()),
                _ => {}
            },
            Event::Text(text) if capture => {
                let value = text
                    .unescape()
                    .map_err(|error| AppError::new("invalid_document", error.to_string()))?;
                pending.push_str(value.as_ref());
            }
            Event::End(element) => match element.local_name().as_ref() {
                b"pPr" => in_properties = false,
                b"rPr" => in_run_properties = false,
                b"t" => capture = false,
                b"r" => push_run(
                    &mut paragraph.runs,
                    &mut pending,
                    &format,
                    &mut budget,
                    &mut truncated,
                ),
                b"p" => {
                    push_run(
                        &mut paragraph.runs,
                        &mut pending,
                        &format,
                        &mut budget,
                        &mut truncated,
                    );
                    let finished = std::mem::take(&mut paragraph);
                    match cell.as_mut() {
                        Some(text) => {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            for run in &finished.runs {
                                text.push_str(&run.text);
                            }
                        }
                        None => blocks.push(finish(finished, numbering)),
                    }
                }
                b"tc" if table_depth == 1 => {
                    if let Some(text) = cell.take() {
                        if row.len() < MAX_TABLE_COLUMNS {
                            row.push(text);
                        } else {
                            truncated = true;
                        }
                    }
                }
                b"tr" if table_depth == 1 => {
                    if table_rows.len() < MAX_TABLE_ROWS {
                        table_rows.push(std::mem::take(&mut row));
                    } else {
                        truncated = true;
                        row.clear();
                    }
                }
                b"tbl" => {
                    table_depth = table_depth.saturating_sub(1);
                    if table_depth == 0 && !table_rows.is_empty() {
                        blocks.push(DocumentBlock::Table {
                            rows: std::mem::take(&mut table_rows),
                        });
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        if self_closing_paragraph && cell.is_none() {
            blocks.push(finish(Paragraph::default(), numbering));
        }
        buffer.clear();
        if blocks.len() >= MAX_BLOCKS {
            truncated = true;
            break;
        }
    }

    let word_count = blocks.iter().map(words_in).sum();
    Ok(DocumentContent {
        blocks,
        word_count,
        truncated,
        properties: DocumentProperties::default(),
        insertions: 0,
        deletions: 0,
    })
}

fn words_in(block: &DocumentBlock) -> usize {
    match block {
        DocumentBlock::Paragraph { runs, .. } => runs
            .iter()
            .map(|run| run.text.split_whitespace().count())
            .sum(),
        DocumentBlock::Table { rows } => rows
            .iter()
            .flatten()
            .map(|value| value.split_whitespace().count())
            .sum(),
    }
}

fn push_run(
    runs: &mut Vec<DocumentRun>,
    pending: &mut String,
    format: &Formatting,
    budget: &mut usize,
    truncated: &mut bool,
) {
    let mut text = std::mem::take(pending);
    if text.is_empty() {
        return;
    }
    if text.len() > *budget {
        *truncated = true;
        let mut boundary = *budget;
        while boundary > 0 && !text.is_char_boundary(boundary) {
            boundary -= 1;
        }
        text.truncate(boundary);
        if text.is_empty() {
            return;
        }
    }
    *budget -= text.len();
    match runs.last_mut() {
        Some(last)
            if last.bold == format.bold
                && last.italic == format.italic
                && last.underline == format.underline =>
        {
            last.text.push_str(&text);
        }
        _ => runs.push(DocumentRun {
            text,
            bold: format.bold,
            italic: format.italic,
            underline: format.underline,
        }),
    }
}

fn finish(paragraph: Paragraph, numbering: &HashMap<String, Vec<bool>>) -> DocumentBlock {
    let ordered = paragraph
        .num_id
        .as_ref()
        .and_then(|id| numbering.get(id))
        .and_then(|levels| {
            levels
                .get(paragraph.list_level.unwrap_or(0) as usize)
                .copied()
        })
        .unwrap_or(false);
    DocumentBlock::Paragraph {
        heading_level: heading_level(paragraph.style.as_deref(), paragraph.outline),
        style: paragraph.style,
        list_level: paragraph.list_level,
        ordered,
        runs: paragraph.runs,
    }
}

fn heading_level(style: Option<&str>, outline: Option<u8>) -> Option<u8> {
    let Some(style) = style else {
        return outline.map(|value| value.saturating_add(1).clamp(1, 6));
    };
    let normalized = style.to_ascii_lowercase().replace([' ', '-', '_'], "");
    if let Some(rest) = normalized.strip_prefix("heading") {
        if let Ok(level) = rest.parse::<u8>() {
            return Some(level.clamp(1, 6));
        }
    }
    match normalized.as_str() {
        "title" => Some(1),
        "subtitle" => Some(2),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use assert_fs::{fixture::PathChild, TempDir};

    const BODY: &[u8] = br#"<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title here</w:t></w:r></w:p>
      <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r><w:r><w:t xml:space="preserve"> plain &amp; free</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>Item</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    </w:body></w:document>"#;

    #[test]
    fn parses_headings_runs_lists_and_tables() {
        let numbering = HashMap::from([("3".to_owned(), vec![true])]);
        let content = parse_body(BODY, &numbering).unwrap();
        assert_eq!(content.blocks.len(), 4);
        assert_eq!(content.word_count, 9);
        assert!(!content.truncated);
        match &content.blocks[0] {
            DocumentBlock::Paragraph {
                heading_level,
                runs,
                ..
            } => {
                assert_eq!(*heading_level, Some(1));
                assert_eq!(runs[0].text, "Title here");
            }
            other => panic!("expected a paragraph, got {other:?}"),
        }
        match &content.blocks[1] {
            DocumentBlock::Paragraph { runs, .. } => {
                assert_eq!(runs.len(), 2);
                assert!(runs[0].bold && !runs[1].bold);
                assert_eq!(runs[1].text, " plain & free");
            }
            other => panic!("expected a paragraph, got {other:?}"),
        }
        match &content.blocks[2] {
            DocumentBlock::Paragraph {
                list_level,
                ordered,
                ..
            } => {
                assert_eq!(*list_level, Some(0));
                assert!(*ordered);
            }
            other => panic!("expected a paragraph, got {other:?}"),
        }
        match &content.blocks[3] {
            DocumentBlock::Table { rows } => {
                assert_eq!(rows, &vec![vec!["A1".to_owned(), "B1".to_owned()]]);
            }
            other => panic!("expected a table, got {other:?}"),
        }
    }

    #[test]
    fn bulleted_lists_are_not_numbered() {
        let numbering = HashMap::from([("3".to_owned(), vec![false])]);
        let content = parse_body(BODY, &numbering).unwrap();
        match &content.blocks[2] {
            DocumentBlock::Paragraph { ordered, .. } => assert!(!*ordered),
            other => panic!("expected a paragraph, got {other:?}"),
        }
    }

    #[test]
    fn reads_numbering_definitions() {
        let numbering = parse_numbering(
            br#"<w:numbering xmlns:w="x">
              <w:abstractNum w:abstractNumId="7">
                <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>
                <w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl>
              </w:abstractNum>
              <w:num w:numId="2"><w:abstractNumId w:val="7"/></w:num>
            </w:numbering>"#,
        )
        .unwrap();
        assert_eq!(numbering.get("2"), Some(&vec![true, false]));
    }

    /// Builds a real `.docx` package so the zip, part-selection and parsing
    /// path is exercised end to end rather than only the XML state machine.
    fn write_docx(path: &std::path::Path, parts: &[(&str, &[u8])]) {
        let file = std::fs::File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in parts {
            zip::write::ZipWriter::start_file(&mut writer, *name, options).unwrap();
            std::io::Write::write_all(&mut writer, content).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn reads_a_real_word_package() {
        let directory = TempDir::new().unwrap();
        let file = directory.child("report.docx");
        let path = file.path();
        write_docx(
            path,
            &[
                ("[Content_Types].xml", br#"<?xml version="1.0"?><Types/>"#),
                ("word/document.xml", BODY),
                (
                    "word/numbering.xml",
                    br#"<w:numbering xmlns:w="x"><w:abstractNum w:abstractNumId="9"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="3"><w:abstractNumId w:val="9"/></w:num></w:numbering>"#,
                ),
            ],
        );
        let content = read(&path.to_string_lossy()).unwrap();
        assert_eq!(content.blocks.len(), 4);
        assert_eq!(content.word_count, 9);
        match &content.blocks[2] {
            DocumentBlock::Paragraph { ordered, .. } => {
                assert!(*ordered, "numbering.xml was ignored")
            }
            other => panic!("expected a paragraph, got {other:?}"),
        }
    }

    #[test]
    fn rejects_zip_files_that_are_not_word_documents() {
        let directory = TempDir::new().unwrap();
        let file = directory.child("notes.docx");
        let path = file.path();
        write_docx(path, &[("notes.txt", b"hello")]);
        let error = read(&path.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, "invalid_document");
        assert!(error.path.is_some());
    }

    #[test]
    fn blank_self_closing_paragraphs_keep_their_spacing() {
        let content = parse_body(
            br#"<w:body><w:p><w:r><w:t>a</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>b</w:t></w:r></w:p></w:body>"#,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(content.blocks.len(), 3);
        match &content.blocks[1] {
            DocumentBlock::Paragraph { runs, .. } => assert!(runs.is_empty()),
            other => panic!("expected a blank paragraph, got {other:?}"),
        }
    }

    #[test]
    fn corrupt_and_missing_input_stays_structured() {
        assert_eq!(
            read("missing-oneopen-document.docx").unwrap_err().code,
            "file_not_found"
        );
        match parse_body(b"<w:p><w:r><w:t>unterminated", &HashMap::new()) {
            Ok(content) => assert!(content.blocks.is_empty()),
            Err(error) => assert_eq!(error.code, "invalid_document"),
        }
    }

    #[test]
    fn maps_heading_styles_and_outline_levels() {
        assert_eq!(heading_level(Some("Heading 3"), None), Some(3));
        assert_eq!(heading_level(Some("Title"), None), Some(1));
        assert_eq!(heading_level(Some("BodyText"), None), None);
        assert_eq!(heading_level(None, Some(0)), Some(1));
    }

    #[test]
    fn text_budget_stops_runaway_documents() {
        let mut runs = Vec::new();
        let mut budget = 4usize;
        let mut truncated = false;
        let mut pending = "abcdefgh".to_owned();
        push_run(
            &mut runs,
            &mut pending,
            &Formatting::default(),
            &mut budget,
            &mut truncated,
        );
        assert_eq!(runs[0].text, "abcd");
        assert!(truncated);
        assert_eq!(budget, 0);
    }
}
