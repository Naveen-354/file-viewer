//! In-place cell editing for OOXML workbooks.
//!
//! Only the worksheet part that actually changes is rewritten. Every other part
//! of the package is copied compressed-byte for compressed-byte, so charts,
//! images, pivot tables, macros, conditional formatting and styles survive an
//! edit untouched. That is why this does not go through a workbook model.

use crate::{
    domain::{AppError, AppResult, CellEdit},
    file_io, security,
};
use quick_xml::{
    events::{BytesEnd, BytesStart, BytesText, Event},
    Reader, Writer,
};
use std::{
    collections::HashMap,
    io::{Cursor, Read, Write},
    path::Path,
};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

const MAX_PART_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RATIO: u64 = 1000;
const MAX_EDITS: usize = 10_000;
const MAX_VALUE_CHARS: usize = 32_767; // Excel's own per-cell text limit.

/// Rewrites `path` with `edits` applied to the worksheet at `sheet_index`.
pub fn apply(path: &Path, sheet_index: usize, edits: &[CellEdit]) -> AppResult<()> {
    if edits.is_empty() {
        return Err(AppError::new("no_edits", "No cell changes were supplied"));
    }
    if edits.len() > MAX_EDITS {
        return Err(AppError::new(
            "edit_limit",
            format!("A single save is limited to {MAX_EDITS} cells"),
        ));
    }
    for edit in edits {
        if edit.value.chars().count() > MAX_VALUE_CHARS {
            return Err(AppError::new(
                "cell_value_limit",
                format!("A cell is limited to {MAX_VALUE_CHARS} characters"),
            ));
        }
        if edit.value.starts_with('=') {
            return Err(AppError::new(
                "formula_not_supported",
                "OneOpen can enter values but not formulas. Prefix with an apostrophe to store it as text.",
            ));
        }
    }

    let file = std::fs::File::open(path).map_err(|error| AppError::io(error, path))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| AppError::path("invalid_spreadsheet", error.to_string(), path))?;

    let workbook = part(&mut archive, "xl/workbook.xml")?.ok_or_else(|| {
        AppError::path(
            "invalid_spreadsheet",
            "The file is not an Excel workbook because xl/workbook.xml is missing",
            path,
        )
    })?;
    let relationships = part(&mut archive, "xl/_rels/workbook.xml.rels")?.unwrap_or_default();
    let sheet_part = locate_sheet(&workbook, &relationships, sheet_index)?;
    let sheet_xml = part(&mut archive, &sheet_part)?.ok_or_else(|| {
        AppError::path(
            "invalid_spreadsheet",
            format!("The workbook is missing its {sheet_part} part"),
            path,
        )
    })?;

    let mut sorted: Vec<&CellEdit> = edits.iter().collect();
    sorted.sort_by_key(|edit| (edit.row, edit.column));
    let mut replacements = HashMap::new();
    replacements.insert(sheet_part, patch_sheet(&sheet_xml, &sorted)?);
    replacements.insert("xl/workbook.xml".to_owned(), recalculate(&workbook)?);

    let mut output = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for index in 0..archive.len() {
        let entry = archive
            .by_index_raw(index)
            .map_err(|error| AppError::new("invalid_spreadsheet", error.to_string()))?;
        let name = entry.name().to_owned();
        match replacements.get(&name) {
            Some(content) => {
                let content = content.clone();
                drop(entry);
                output
                    .start_file(&name, options)
                    .and_then(|()| output.write_all(&content).map_err(Into::into))
                    .map_err(|error| AppError::new("save_failed", error.to_string()))?;
            }
            // Untouched parts keep their exact compressed bytes.
            None => output
                .raw_copy_file(entry)
                .map_err(|error| AppError::new("save_failed", error.to_string()))?,
        }
    }
    let bytes = output
        .finish()
        .map_err(|error| AppError::new("save_failed", error.to_string()))?
        .into_inner();
    // Windows refuses to replace a file that still has an open handle, and the
    // archive holds one on the very file being saved.
    drop(archive);
    file_io::atomic_save_bytes(path, &bytes)
}

fn part<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> AppResult<Option<Vec<u8>>> {
    let mut entry = match archive.by_name(name) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(error) => return Err(AppError::new("invalid_spreadsheet", error.to_string())),
    };
    if entry.size() > MAX_PART_BYTES {
        return Err(AppError::new(
            "spreadsheet_size_limit",
            "A workbook part exceeds the 64 MiB decompression limit",
        ));
    }
    if entry.compressed_size() > 0 && entry.size() / entry.compressed_size().max(1) > MAX_RATIO {
        return Err(AppError::new(
            "unsafe_spreadsheet_entry",
            "A workbook part has a suspicious compression ratio",
        ));
    }
    let mut buffer = Vec::with_capacity(entry.size().min(MAX_PART_BYTES) as usize);
    entry
        .by_ref()
        .take(MAX_PART_BYTES)
        .read_to_end(&mut buffer)
        .map_err(|error| AppError::new("invalid_spreadsheet", error.to_string()))?;
    Ok(Some(buffer))
}

/// Resolves the nth `<sheet>` in the workbook to its part name by following the
/// relationship id, matching the sheet order calamine reports when reading.
fn locate_sheet(workbook: &[u8], relationships: &[u8], index: usize) -> AppResult<String> {
    let mut reader = Reader::from_reader(workbook);
    reader.config_mut().check_end_names = false;
    let mut buffer = Vec::new();
    let mut seen = 0usize;
    let mut relation = None;
    loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|error| AppError::new("invalid_spreadsheet", error.to_string()))?
        {
            Event::Start(element) | Event::Empty(element) => {
                if element.local_name().as_ref() == b"sheet" {
                    if seen == index {
                        relation = attribute(&element, b"id");
                        break;
                    }
                    seen += 1;
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    let relation = relation.ok_or_else(|| {
        AppError::new("sheet_not_found", "The sheet is no longer in the workbook")
    })?;

    let mut reader = Reader::from_reader(relationships);
    reader.config_mut().check_end_names = false;
    let mut buffer = Vec::new();
    loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|error| AppError::new("invalid_spreadsheet", error.to_string()))?
        {
            Event::Start(element) | Event::Empty(element) => {
                if element.local_name().as_ref() == b"Relationship"
                    && attribute(&element, b"Id").as_deref() == Some(relation.as_str())
                {
                    let target = attribute(&element, b"Target").ok_or_else(|| {
                        AppError::new("invalid_spreadsheet", "A sheet relationship has no target")
                    })?;
                    return normalise_target(&target);
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    Err(AppError::new(
        "sheet_not_found",
        "The sheet relationship could not be resolved",
    ))
}

/// Sheet targets are relative to `xl/` and must stay inside the package.
fn normalise_target(target: &str) -> AppResult<String> {
    let trimmed = target.trim_start_matches('/');
    let base = if target.starts_with('/') { "" } else { "xl/" };
    let joined = format!("{base}{trimmed}");
    let relative = security::safe_archive_path(&joined)?;
    Ok(relative
        .to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_owned())
}

/// Tells Excel to recompute formulas on open, because a literal edit can make
/// the values cached for dependent formulas stale.
fn recalculate(workbook: &[u8]) -> AppResult<Vec<u8>> {
    let mut reader = Reader::from_reader(workbook);
    reader.config_mut().check_end_names = false;
    let mut writer = Writer::new(Cursor::new(Vec::new()));
    let mut buffer = Vec::new();
    let mut written = false;
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| AppError::new("invalid_spreadsheet", error.to_string()))?;
        match event {
            Event::Empty(element) if element.local_name().as_ref() == b"calcPr" => {
                let mut replacement = BytesStart::new("calcPr");
                for attribute in element.attributes().flatten() {
                    if attribute.key.local_name().as_ref() != b"fullCalcOnLoad" {
                        replacement.push_attribute(attribute);
                    }
                }
                replacement.push_attribute(("fullCalcOnLoad", "1"));
                write(&mut writer, Event::Empty(replacement))?;
                written = true;
            }
            Event::End(element) if element.local_name().as_ref() == b"workbook" && !written => {
                let mut added = BytesStart::new("calcPr");
                added.push_attribute(("calcId", "0"));
                added.push_attribute(("fullCalcOnLoad", "1"));
                write(&mut writer, Event::Empty(added))?;
                write(&mut writer, Event::End(element))?;
                written = true;
            }
            Event::Eof => break,
            other => write(&mut writer, other)?,
        }
        buffer.clear();
    }
    Ok(writer.into_inner().into_inner())
}

fn patch_sheet(xml: &[u8], edits: &[&CellEdit]) -> AppResult<Vec<u8>> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().check_end_names = false;
    let mut writer = Writer::new(Cursor::new(Vec::new()));
    let mut buffer = Vec::new();
    let mut cursor = 0usize;
    let mut in_sheet_data = false;
    let mut in_row: Option<u32> = None;
    let mut skip_depth = 0usize;

    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| AppError::new("invalid_spreadsheet", error.to_string()))?;
        if skip_depth > 0 {
            match event {
                Event::Start(_) => skip_depth += 1,
                Event::End(_) => skip_depth -= 1,
                Event::Eof => break,
                _ => {}
            }
            buffer.clear();
            continue;
        }
        match event {
            // The cached dimension can no longer be trusted once cells move
            // outside it, and the element is optional, so drop it.
            Event::Empty(element) if element.local_name().as_ref() == b"dimension" => {}
            Event::Start(element) if element.local_name().as_ref() == b"dimension" => {
                skip_depth = 1;
            }
            Event::Start(element) if element.local_name().as_ref() == b"sheetData" => {
                in_sheet_data = true;
                write(&mut writer, Event::Start(element))?;
            }
            // A `<sheetData/>` with no rows at all still has to receive edits.
            Event::Empty(element) if element.local_name().as_ref() == b"sheetData" => {
                write(&mut writer, Event::Start(BytesStart::new("sheetData")))?;
                flush_rows(&mut writer, edits, &mut cursor, u32::MAX)?;
                write(&mut writer, Event::End(BytesEnd::new("sheetData")))?;
            }
            Event::End(element) if element.local_name().as_ref() == b"sheetData" => {
                flush_rows(&mut writer, edits, &mut cursor, u32::MAX)?;
                in_sheet_data = false;
                write(&mut writer, Event::End(element))?;
            }
            Event::Start(element) if in_sheet_data && element.local_name().as_ref() == b"row" => {
                let number = attribute(&element, b"r")
                    .and_then(|value| value.parse::<u32>().ok())
                    .unwrap_or(0);
                flush_rows(&mut writer, edits, &mut cursor, number)?;
                let mut replacement = BytesStart::new("row");
                for attribute in element.attributes().flatten() {
                    // `spans` describes the row's used columns and goes stale.
                    if attribute.key.local_name().as_ref() != b"spans" {
                        replacement.push_attribute(attribute);
                    }
                }
                write(&mut writer, Event::Start(replacement))?;
                in_row = Some(number);
            }
            Event::End(element) if in_sheet_data && element.local_name().as_ref() == b"row" => {
                if let Some(number) = in_row {
                    flush_cells(&mut writer, edits, &mut cursor, number, u32::MAX)?;
                }
                in_row = None;
                write(&mut writer, Event::End(element))?;
            }
            Event::Start(element) if in_row.is_some() && element.local_name().as_ref() == b"c" => {
                if replace_cell(&mut writer, edits, &mut cursor, in_row, &element)? {
                    // The original element's children must not be emitted.
                    skip_depth = 1;
                } else {
                    write(&mut writer, Event::Start(element))?;
                }
            }
            Event::Empty(element) if in_row.is_some() && element.local_name().as_ref() == b"c" => {
                if !replace_cell(&mut writer, edits, &mut cursor, in_row, &element)? {
                    write(&mut writer, Event::Empty(element))?;
                }
            }
            Event::Eof => break,
            other => write(&mut writer, other)?,
        }
        buffer.clear();
    }
    Ok(writer.into_inner().into_inner())
}

/// Emits any new cells that sort before this one, then replaces it if an edit
/// targets it. Returns whether the original element was superseded.
fn replace_cell<W: Write>(
    writer: &mut Writer<W>,
    edits: &[&CellEdit],
    cursor: &mut usize,
    row: Option<u32>,
    element: &BytesStart<'_>,
) -> AppResult<bool> {
    let row = row.unwrap_or(0);
    let reference = attribute(element, b"r").unwrap_or_default();
    let column = parse_reference(&reference)
        .map(|(_, column)| column)
        .unwrap_or(0);
    flush_cells(writer, edits, cursor, row, column)?;
    let matched = edits
        .get(*cursor)
        .is_some_and(|edit| edit.row + 1 == row && edit.column == column);
    if !matched {
        return Ok(false);
    }
    let style = attribute(element, b"s");
    write_cell(writer, &reference, style.as_deref(), &edits[*cursor].value)?;
    *cursor += 1;
    Ok(true)
}

/// Emits whole rows for edits that land before `limit` and have no `<row>` yet.
fn flush_rows<W: Write>(
    writer: &mut Writer<W>,
    edits: &[&CellEdit],
    cursor: &mut usize,
    limit: u32,
) -> AppResult<()> {
    while let Some(edit) = edits.get(*cursor) {
        let number = edit.row + 1;
        if number >= limit {
            break;
        }
        let mut start = BytesStart::new("row");
        start.push_attribute(("r", number.to_string().as_str()));
        write(writer, Event::Start(start))?;
        flush_cells(writer, edits, cursor, number, u32::MAX)?;
        write(writer, Event::End(BytesEnd::new("row")))?;
    }
    Ok(())
}

/// Emits new cells for `row` whose column sorts before `limit`.
fn flush_cells<W: Write>(
    writer: &mut Writer<W>,
    edits: &[&CellEdit],
    cursor: &mut usize,
    row: u32,
    limit: u32,
) -> AppResult<()> {
    while let Some(edit) = edits.get(*cursor) {
        if edit.row + 1 != row || edit.column >= limit {
            break;
        }
        let reference = format!("{}{}", column_letters(edit.column), row);
        write_cell(writer, &reference, None, &edit.value)?;
        *cursor += 1;
    }
    Ok(())
}

enum Value {
    Blank,
    Number(String),
    Boolean(bool),
    Text(String),
}

/// Mirrors how a spreadsheet interprets typed input: numbers become numbers,
/// TRUE/FALSE become booleans, and a leading apostrophe forces text.
fn classify(value: &str) -> Value {
    if let Some(text) = value.strip_prefix('\'') {
        return Value::Text(text.to_owned());
    }
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Value::Blank;
    }
    if trimmed.eq_ignore_ascii_case("true") {
        return Value::Boolean(true);
    }
    if trimmed.eq_ignore_ascii_case("false") {
        return Value::Boolean(false);
    }
    match trimmed.parse::<f64>() {
        Ok(number) if number.is_finite() => Value::Number(trimmed.to_owned()),
        _ => Value::Text(value.to_owned()),
    }
}

fn write_cell<W: Write>(
    writer: &mut Writer<W>,
    reference: &str,
    style: Option<&str>,
    value: &str,
) -> AppResult<()> {
    let classified = classify(value);
    let mut start = BytesStart::new("c");
    start.push_attribute(("r", reference));
    // Keeping `s` preserves the cell's number format, font and fill.
    if let Some(style) = style {
        start.push_attribute(("s", style));
    }
    match classified {
        Value::Blank => {
            write(writer, Event::Empty(start))?;
        }
        Value::Number(text) => {
            write(writer, Event::Start(start))?;
            write_child(writer, "v", &text)?;
            write(writer, Event::End(BytesEnd::new("c")))?;
        }
        Value::Boolean(flag) => {
            start.push_attribute(("t", "b"));
            write(writer, Event::Start(start))?;
            write_child(writer, "v", if flag { "1" } else { "0" })?;
            write(writer, Event::End(BytesEnd::new("c")))?;
        }
        Value::Text(text) => {
            // Inline strings keep the shared-string table untouched.
            start.push_attribute(("t", "inlineStr"));
            write(writer, Event::Start(start))?;
            write(writer, Event::Start(BytesStart::new("is")))?;
            let mut inner = BytesStart::new("t");
            inner.push_attribute(("xml:space", "preserve"));
            write(writer, Event::Start(inner))?;
            write(writer, Event::Text(BytesText::new(&text)))?;
            write(writer, Event::End(BytesEnd::new("t")))?;
            write(writer, Event::End(BytesEnd::new("is")))?;
            write(writer, Event::End(BytesEnd::new("c")))?;
        }
    }
    Ok(())
}

fn write_child<W: Write>(writer: &mut Writer<W>, name: &str, text: &str) -> AppResult<()> {
    write(writer, Event::Start(BytesStart::new(name)))?;
    write(writer, Event::Text(BytesText::new(text)))?;
    write(writer, Event::End(BytesEnd::new(name)))
}

fn write<W: Write>(writer: &mut Writer<W>, event: Event<'_>) -> AppResult<()> {
    writer
        .write_event(event)
        .map_err(|error| AppError::new("save_failed", error.to_string()))
}

fn attribute(element: &BytesStart<'_>, name: &[u8]) -> Option<String> {
    element.attributes().flatten().find_map(|attribute| {
        (attribute.key.local_name().as_ref() == name)
            .then(|| String::from_utf8_lossy(attribute.value.as_ref()).into_owned())
    })
}

/// `B3` becomes `(2, 1)`: a zero-based row and column.
fn parse_reference(reference: &str) -> Option<(u32, u32)> {
    let split = reference.find(|character: char| character.is_ascii_digit())?;
    let (letters, digits) = reference.split_at(split);
    if letters.is_empty() {
        return None;
    }
    let mut column = 0u32;
    for character in letters.chars() {
        let value = character.to_ascii_uppercase();
        if !value.is_ascii_uppercase() {
            return None;
        }
        column = column
            .checked_mul(26)?
            .checked_add(u32::from(value as u8 - b'A') + 1)?;
    }
    let row = digits.parse::<u32>().ok()?.checked_sub(1)?;
    Some((row, column - 1))
}

pub fn column_letters(index: u32) -> String {
    let mut letters = Vec::new();
    let mut value = index as i64;
    while value >= 0 {
        letters.push(b'A' + (value % 26) as u8);
        value = value / 26 - 1;
    }
    letters.reverse();
    String::from_utf8(letters).unwrap_or_else(|_| "A".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(row: u32, column: u32, value: &str) -> CellEdit {
        CellEdit {
            row,
            column,
            value: value.to_owned(),
        }
    }

    fn patched(xml: &[u8], edits: &[CellEdit]) -> String {
        let mut sorted: Vec<&CellEdit> = edits.iter().collect();
        sorted.sort_by_key(|edit| (edit.row, edit.column));
        String::from_utf8(patch_sheet(xml, &sorted).unwrap()).unwrap()
    }

    const SHEET: &[u8] = br#"<worksheet><dimension ref="A1:B2"/><sheetData><row r="1" spans="1:2"><c r="A1" t="s"><v>0</v></c><c r="B1" s="4"><v>12</v></c></row><row r="2"><c r="B2"><v>5</v></c></row></sheetData></worksheet>"#;

    #[test]
    fn replaces_an_existing_cell_and_keeps_its_style() {
        let output = patched(SHEET, &[edit(0, 1, "42")]);
        assert!(
            output.contains(r#"<c r="B1" s="4"><v>42</v></c>"#),
            "{output}"
        );
        assert!(!output.contains("<v>12</v>"));
    }

    #[test]
    fn a_shared_string_cell_becomes_an_inline_string() {
        let output = patched(SHEET, &[edit(0, 0, "hello & <bye>")]);
        assert!(
            output.contains(r#"<c r="A1" t="inlineStr"><is><t xml:space="preserve">hello &amp; &lt;bye&gt;</t></is></c>"#),
            "{output}"
        );
        assert!(
            !output.contains(r#"t="s""#),
            "the stale shared-string type is gone"
        );
    }

    #[test]
    fn inserts_a_missing_cell_in_column_order() {
        let output = patched(SHEET, &[edit(1, 0, "left")]);
        let a2 = output.find(r#"r="A2""#).expect("A2 was not written");
        let b2 = output.find(r#"r="B2""#).expect("B2 disappeared");
        assert!(a2 < b2, "cells must stay in column order: {output}");
    }

    #[test]
    fn inserts_missing_rows_in_row_order() {
        let output = patched(SHEET, &[edit(4, 0, "later"), edit(2, 0, "middle")]);
        let row3 = output.find(r#"<row r="3""#).expect("row 3 missing");
        let row5 = output.find(r#"<row r="5""#).expect("row 5 missing");
        let end = output.find("</sheetData>").unwrap();
        assert!(
            row3 < row5 && row5 < end,
            "rows must stay ordered: {output}"
        );
    }

    #[test]
    fn writes_into_a_sheet_that_has_no_rows() {
        let output = patched(
            br#"<worksheet><sheetData/></worksheet>"#,
            &[edit(0, 0, "x")],
        );
        assert!(
            output.contains(r#"<row r="1"><c r="A1" t="inlineStr">"#),
            "{output}"
        );
        assert!(output.contains("</sheetData>"));
    }

    #[test]
    fn types_values_the_way_a_spreadsheet_does() {
        let output = patched(
            SHEET,
            &[edit(0, 1, "TRUE"), edit(1, 1, ""), edit(2, 0, "'0042")],
        );
        assert!(
            output.contains(r#"<c r="B1" s="4" t="b"><v>1</v></c>"#),
            "{output}"
        );
        assert!(
            output.contains(r#"<c r="B2"/>"#),
            "a cleared cell keeps no value: {output}"
        );
        assert!(
            output.contains(">0042</t>"),
            "an apostrophe forces text: {output}"
        );
    }

    #[test]
    fn drops_the_stale_dimension_and_spans() {
        let output = patched(SHEET, &[edit(0, 1, "9")]);
        assert!(!output.contains("<dimension"), "{output}");
        assert!(!output.contains("spans="), "{output}");
    }

    #[test]
    fn marks_the_workbook_for_recalculation() {
        let added =
            String::from_utf8(recalculate(br#"<workbook><sheets/></workbook>"#).unwrap()).unwrap();
        assert!(added.contains(r#"fullCalcOnLoad="1""#), "{added}");

        let existing = String::from_utf8(
            recalculate(br#"<workbook><calcPr calcId="191029"/></workbook>"#).unwrap(),
        )
        .unwrap();
        assert!(
            existing.contains(r#"calcId="191029""#),
            "existing attributes survive"
        );
        assert!(existing.contains(r#"fullCalcOnLoad="1""#), "{existing}");
        assert_eq!(existing.matches("calcPr").count(), 1, "no duplicate calcPr");
    }

    #[test]
    fn resolves_sheet_parts_through_their_relationship() {
        let workbook = br#"<workbook><sheets><sheet name="One" sheetId="1" r:id="rId7"/><sheet name="Two" sheetId="2" r:id="rId9"/></sheets></workbook>"#;
        let rels = br#"<Relationships><Relationship Id="rId7" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Target="/xl/worksheets/odd.xml"/></Relationships>"#;
        assert_eq!(
            locate_sheet(workbook, rels, 0).unwrap(),
            "xl/worksheets/sheet1.xml"
        );
        assert_eq!(
            locate_sheet(workbook, rels, 1).unwrap(),
            "xl/worksheets/odd.xml"
        );
        assert_eq!(
            locate_sheet(workbook, rels, 5).unwrap_err().code,
            "sheet_not_found"
        );
    }

    #[test]
    fn rejects_relationship_targets_that_escape_the_package() {
        assert!(normalise_target("../../etc/passwd").is_err());
        assert!(normalise_target("worksheets/../../secret.xml").is_err());
    }

    #[test]
    fn converts_between_references_and_coordinates() {
        assert_eq!(parse_reference("A1"), Some((0, 0)));
        assert_eq!(parse_reference("B3"), Some((2, 1)));
        assert_eq!(parse_reference("AA10"), Some((9, 26)));
        assert_eq!(parse_reference("nonsense"), None);
        assert_eq!(column_letters(0), "A");
        assert_eq!(column_letters(26), "AA");
        assert_eq!(column_letters(701), "ZZ");
    }

    #[test]
    fn refuses_formulas_and_oversized_input() {
        let directory = assert_fs::TempDir::new().unwrap();
        let path = directory.path().join("book.xlsx");
        assert_eq!(
            apply(&path, 0, &[edit(0, 0, "=SUM(A1:A2)")])
                .unwrap_err()
                .code,
            "formula_not_supported"
        );
        assert_eq!(
            apply(&path, 0, &[edit(0, 0, &"x".repeat(MAX_VALUE_CHARS + 1))])
                .unwrap_err()
                .code,
            "cell_value_limit"
        );
        assert_eq!(apply(&path, 0, &[]).unwrap_err().code, "no_edits");
    }
}
