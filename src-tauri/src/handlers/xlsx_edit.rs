//! In-place cell editing for OOXML workbooks.
//!
//! Only the worksheet part that actually changes is rewritten. Every other part
//! of the package is copied compressed-byte for compressed-byte, so charts,
//! images, pivot tables, macros, conditional formatting and styles survive an
//! edit untouched. That is why this does not go through a workbook model.

use crate::{
    domain::{AppError, AppResult, CellEdit, FormulaResult, InsertAxis, StructuralInsert},
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
const MAX_FORMULA_CHARS: usize = 8_192; // Excel's formula length limit.
const MAX_INSERTS: usize = 256;
const MAX_INSERT_COUNT: u32 = 10_000;
const MAX_ROW: u32 = 1_048_576;
const MAX_COLUMN: u32 = 16_384;

/// Parts attached to a sheet that record cell positions this module does not
/// rewrite. Inserting rows or columns would leave them pointing at the wrong
/// cells, so structural edits are refused rather than corrupting them.
const POSITIONAL_RELATIONSHIPS: &[(&str, &str)] = &[
    ("/relationships/table\"", "tables"),
    ("/relationships/pivotTable\"", "pivot tables"),
    ("/relationships/comments\"", "notes"),
    ("/relationships/threadedComment\"", "threaded comments"),
];

/// Rewrites `path` with `inserts` and then `edits` applied to the worksheet at
/// `sheet_index`. Edit coordinates are the ones after every insert.
pub fn apply(
    path: &Path,
    sheet_index: usize,
    inserts: &[StructuralInsert],
    edits: &[CellEdit],
) -> AppResult<()> {
    if edits.is_empty() && inserts.is_empty() {
        return Err(AppError::new("no_edits", "No cell changes were supplied"));
    }
    if edits.len() > MAX_EDITS {
        return Err(AppError::new(
            "edit_limit",
            format!("A single save is limited to {MAX_EDITS} cells"),
        ));
    }
    if inserts.len() > MAX_INSERTS
        || inserts
            .iter()
            .any(|insert| insert.count == 0 || insert.count > MAX_INSERT_COUNT)
    {
        return Err(AppError::new(
            "insert_limit",
            format!("A save can insert at most {MAX_INSERT_COUNT} rows or columns at a time"),
        ));
    }
    for edit in edits {
        let is_formula = formula_text(&edit.value).is_some();
        let limit = if is_formula {
            MAX_FORMULA_CHARS
        } else {
            MAX_VALUE_CHARS
        };
        if edit.value.chars().count() > limit {
            return Err(AppError::new(
                "cell_value_limit",
                if is_formula {
                    format!("A formula is limited to {MAX_FORMULA_CHARS} characters")
                } else {
                    format!("A cell is limited to {MAX_VALUE_CHARS} characters")
                },
            ));
        }
    }

    let file = std::fs::File::open(path).map_err(|error| AppError::io(error, path))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| AppError::path("invalid_spreadsheet", error.to_string(), path))?;

    let mut workbook = part(&mut archive, "xl/workbook.xml")?.ok_or_else(|| {
        AppError::path(
            "invalid_spreadsheet",
            "The file is not an Excel workbook because xl/workbook.xml is missing",
            path,
        )
    })?;
    let relationships = part(&mut archive, "xl/_rels/workbook.xml.rels")?.unwrap_or_default();
    let sheet_part = locate_sheet(&workbook, &relationships, sheet_index)?;
    let mut sheet_xml = part(&mut archive, &sheet_part)?.ok_or_else(|| {
        AppError::path(
            "invalid_spreadsheet",
            format!("The workbook is missing its {sheet_part} part"),
            path,
        )
    })?;

    let mut replacements = HashMap::new();
    if !inserts.is_empty() {
        let sheet_relationships = part(&mut archive, &relationships_part(&sheet_part))?;
        refuse_positional_parts(sheet_relationships.as_deref().unwrap_or_default())?;
        let name = sheet_name(&workbook, sheet_index)?;
        for insert in inserts {
            sheet_xml = shift_sheet(&sheet_xml, insert, &name)?;
        }

        // Other sheets, charts and defined names can point into this sheet.
        let dependents: Vec<String> = archive
            .file_names()
            .filter(|entry| {
                *entry != sheet_part
                    && entry.ends_with(".xml")
                    && (entry.starts_with("xl/worksheets/") || entry.starts_with("xl/charts/"))
            })
            .map(str::to_owned)
            .collect();
        for dependent in dependents {
            let Some(original) = part(&mut archive, &dependent)? else {
                continue;
            };
            if !might_reference(&original, &name) {
                continue;
            }
            let mut xml = original.clone();
            for insert in inserts {
                xml = shift_qualified(&xml, insert, &name, FORMULA_ELEMENTS)?;
            }
            if xml != original {
                replacements.insert(dependent, xml);
            }
        }
        if might_reference(&workbook, &name) {
            for insert in inserts {
                workbook = shift_qualified(&workbook, insert, &name, &[b"definedName"])?;
            }
        }
    }

    let mut sorted: Vec<&CellEdit> = edits.iter().collect();
    sorted.sort_by_key(|edit| (edit.row, edit.column));
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

/// The name of the nth `<sheet>`, which is how formulas elsewhere refer to it.
fn sheet_name(workbook: &[u8], index: usize) -> AppResult<String> {
    let mut reader = Reader::from_reader(workbook);
    reader.config_mut().check_end_names = false;
    let mut buffer = Vec::new();
    let mut seen = 0usize;
    loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|error| AppError::new("invalid_spreadsheet", error.to_string()))?
        {
            Event::Start(element) | Event::Empty(element)
                if element.local_name().as_ref() == b"sheet" =>
            {
                if seen == index {
                    return attribute(&element, b"name").ok_or_else(|| {
                        AppError::new("invalid_spreadsheet", "A sheet has no name")
                    });
                }
                seen += 1;
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    Err(AppError::new(
        "sheet_not_found",
        "The sheet is no longer in the workbook",
    ))
}

/// `xl/worksheets/sheet1.xml` keeps its relationships in
/// `xl/worksheets/_rels/sheet1.xml.rels`.
fn relationships_part(part: &str) -> String {
    match part.rsplit_once('/') {
        Some((folder, file)) => format!("{folder}/_rels/{file}.rels"),
        None => format!("_rels/{part}.rels"),
    }
}

fn refuse_positional_parts(relationships: &[u8]) -> AppResult<()> {
    let text = String::from_utf8_lossy(relationships);
    let found: Vec<&str> = POSITIONAL_RELATIONSHIPS
        .iter()
        .filter(|(kind, _)| text.contains(kind))
        .map(|(_, label)| *label)
        .collect();
    if found.is_empty() {
        return Ok(());
    }
    Err(AppError::new(
        "insert_not_supported",
        format!(
            "Rows and columns cannot be inserted on this sheet because it has {}. Cell edits still work.",
            found.join(" and ")
        ),
    ))
}

/// A cheap test that skips rewriting parts which cannot mention the sheet.
/// Names that XML or formulas escape are always rewritten to be safe.
fn might_reference(xml: &[u8], sheet: &str) -> bool {
    if sheet.contains(['&', '<', '>', '\'', '"']) {
        return true;
    }
    let needle = sheet.to_lowercase();
    String::from_utf8_lossy(xml)
        .to_lowercase()
        .contains(&needle)
}

/// Elements whose text is a formula, in worksheets and charts alike
/// (`xm:f` in extension lists and `c:f` in charts share the local name `f`).
const FORMULA_ELEMENTS: &[&[u8]] = &[b"f", b"formula", b"formula1", b"formula2"];

/// Attributes on worksheet elements that hold a cell reference or range list.
const REFERENCE_ATTRIBUTES: &[&[u8]] = &[b"r", b"ref", b"sqref", b"activeCell", b"topLeftCell"];

/// Moves everything on the edited sheet that sits at or after the insert:
/// rows, cells, column widths, merges, links, validation, conditional
/// formatting and every formula reference into this sheet.
fn shift_sheet(xml: &[u8], insert: &StructuralInsert, sheet: &str) -> AppResult<Vec<u8>> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().check_end_names = false;
    let mut writer = Writer::new(Cursor::new(Vec::new()));
    let mut buffer = Vec::new();
    let mut open: Vec<Vec<u8>> = Vec::new();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| AppError::new("invalid_spreadsheet", error.to_string()))?;
        match event {
            Event::Start(element) => {
                open.push(element.local_name().as_ref().to_vec());
                let shifted = shift_element(&element, insert, sheet)?;
                write(&mut writer, Event::Start(shifted))?;
            }
            Event::Empty(element) => {
                let shifted = shift_element(&element, insert, sheet)?;
                write(&mut writer, Event::Empty(shifted))?;
            }
            Event::End(element) => {
                open.pop();
                write(&mut writer, Event::End(element))?;
            }
            Event::Text(text)
                if open.last().is_some_and(|name| {
                    FORMULA_ELEMENTS.contains(&name.as_slice()) || name == b"sqref"
                }) =>
            {
                let content = text
                    .unescape()
                    .map_err(|error| AppError::new("invalid_spreadsheet", error.to_string()))?;
                let shifted = shift_references(&content, insert, sheet, true)?;
                write(&mut writer, Event::Text(BytesText::new(&shifted)))?;
            }
            Event::Eof => break,
            other => write(&mut writer, other)?,
        }
        buffer.clear();
    }
    Ok(writer.into_inner().into_inner())
}

fn shift_element(
    element: &BytesStart<'_>,
    insert: &StructuralInsert,
    sheet: &str,
) -> AppResult<BytesStart<'static>> {
    let local = element.local_name().as_ref().to_vec();
    let name = String::from_utf8_lossy(element.name().as_ref()).into_owned();
    let mut replacement = BytesStart::new(name);
    for attribute in element.attributes().flatten() {
        let key = attribute.key.local_name().as_ref().to_vec();
        let raw_key = String::from_utf8_lossy(attribute.key.as_ref()).into_owned();
        let value = attribute
            .unescape_value()
            .map_err(|error| AppError::new("invalid_spreadsheet", error.to_string()))?
            .into_owned();
        let shifted = if local == b"row" && key == b"r" {
            shift_row_number(&value, insert)?
        } else if local == b"row" && key == b"spans" {
            // Column spans go stale and are optional.
            continue;
        } else if REFERENCE_ATTRIBUTES.contains(&key.as_slice()) {
            shift_references(&value, insert, sheet, true)?
        } else {
            value
        };
        replacement.push_attribute((raw_key.as_str(), shifted.as_str()));
    }
    if local == b"col" && insert.axis == InsertAxis::Column {
        return Ok(shift_column_widths(replacement, insert));
    }
    Ok(replacement)
}

fn shift_row_number(value: &str, insert: &StructuralInsert) -> AppResult<String> {
    let Ok(number) = value.parse::<u32>() else {
        return Ok(value.to_owned());
    };
    if insert.axis != InsertAxis::Row || number == 0 || number - 1 < insert.index {
        return Ok(value.to_owned());
    }
    let moved = number + insert.count;
    if moved > MAX_ROW {
        return Err(overflow());
    }
    Ok(moved.to_string())
}

/// A `<col min max>` run after the insert moves right; one spanning it widens,
/// so the new columns take the width of the ones they were inserted among.
fn shift_column_widths(
    element: BytesStart<'static>,
    insert: &StructuralInsert,
) -> BytesStart<'static> {
    let min = attribute(&element, b"min").and_then(|value| value.parse::<u32>().ok());
    let max = attribute(&element, b"max").and_then(|value| value.parse::<u32>().ok());
    let (Some(mut min), Some(mut max)) = (min, max) else {
        return element;
    };
    let first = insert.index + 1;
    if min >= first {
        min += insert.count;
        max += insert.count;
    } else if max >= first {
        max += insert.count;
    }
    let (min, max) = (min.min(MAX_COLUMN), max.min(MAX_COLUMN));
    let mut replacement = BytesStart::new("col");
    for attribute in element.attributes().flatten() {
        match attribute.key.local_name().as_ref() {
            b"min" => replacement.push_attribute(("min", min.to_string().as_str())),
            b"max" => replacement.push_attribute(("max", max.to_string().as_str())),
            _ => replacement.push_attribute(attribute),
        }
    }
    replacement
}

/// Shifts references that name `sheet` explicitly inside the text of
/// `elements`, for parts other than the edited sheet itself.
fn shift_qualified(
    xml: &[u8],
    insert: &StructuralInsert,
    sheet: &str,
    elements: &[&[u8]],
) -> AppResult<Vec<u8>> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().check_end_names = false;
    let mut writer = Writer::new(Cursor::new(Vec::new()));
    let mut buffer = Vec::new();
    let mut open: Vec<Vec<u8>> = Vec::new();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| AppError::new("invalid_spreadsheet", error.to_string()))?;
        match event {
            Event::Start(element) => {
                open.push(element.local_name().as_ref().to_vec());
                write(&mut writer, Event::Start(element))?;
            }
            Event::End(element) => {
                open.pop();
                write(&mut writer, Event::End(element))?;
            }
            Event::Text(text)
                if open
                    .last()
                    .is_some_and(|name| elements.contains(&name.as_slice())) =>
            {
                let content = text
                    .unescape()
                    .map_err(|error| AppError::new("invalid_spreadsheet", error.to_string()))?;
                let shifted = shift_references(&content, insert, sheet, false)?;
                write(&mut writer, Event::Text(BytesText::new(&shifted)))?;
            }
            Event::Eof => break,
            other => write(&mut writer, other)?,
        }
        buffer.clear();
    }
    Ok(writer.into_inner().into_inner())
}

fn overflow() -> AppError {
    AppError::new(
        "insert_overflow",
        "Inserting here would push cells past the edge of the sheet",
    )
}

/// Rewrites the A1 references in a formula or range list for an insert.
///
/// A reference moves when it points at `sheet`: unqualified ones only when
/// `local` (the formula lives on that sheet), qualified ones when the sheet
/// name matches. String literals, function names, external workbook
/// references and structured table references are left alone. Each end of a
/// range moves independently, so a range that spans the insert grows.
fn shift_references(
    formula: &str,
    insert: &StructuralInsert,
    sheet: &str,
    local: bool,
) -> AppResult<String> {
    let mover = |axis: InsertAxis| {
        move |index: u32, _absolute: bool, applies: bool| -> AppResult<u32> {
            if !applies || insert.axis != axis || index < insert.index {
                return Ok(index);
            }
            Ok(index + insert.count)
        }
    };
    rewrite_references(
        formula,
        sheet,
        local,
        &mover(InsertAxis::Row),
        &mover(InsertAxis::Column),
    )
}

/// Moves one coordinate of a reference: given its zero-based index, whether
/// it is absolute (`$`), and whether the reference points at the target sheet.
type Mover<'a> = &'a dyn Fn(u32, bool, bool) -> AppResult<u32>;

/// Walks the references in a formula and rebuilds each row and column index
/// through `move_row` and `move_column`, keeping `$` markers. See
/// [`shift_references`] for what counts as a reference.
fn rewrite_references(
    formula: &str,
    sheet: &str,
    local: bool,
    move_row: Mover,
    move_column: Mover,
) -> AppResult<String> {
    let chars: Vec<char> = formula.chars().collect();
    let mut output = String::with_capacity(formula.len() + 8);
    let mut index = 0usize;
    // Which sheet the next reference belongs to; `None` is the formula's own.
    let mut qualifier: Option<String> = None;
    let mut external = false;
    while index < chars.len() {
        let character = chars[index];
        match character {
            '"' => {
                let end = closing_quote(&chars, index, '"');
                output.extend(&chars[index..end]);
                index = end;
                qualifier = None;
                external = false;
            }
            '\'' => {
                let end = closing_quote(&chars, index, '\'');
                output.extend(&chars[index..end]);
                if chars.get(end) == Some(&'!') {
                    let inner: String = chars[index + 1..end.saturating_sub(1).max(index + 1)]
                        .iter()
                        .collect();
                    let name = inner.replace("''", "'");
                    // `'[Book.xlsx]Sheet'!A1` points at another workbook.
                    external = name.starts_with('[');
                    qualifier = Some(name);
                    output.push('!');
                    index = end + 1;
                } else {
                    index = end;
                }
            }
            '[' => {
                // `[1]Sheet!A1` is external; `Table[Column]` is structured.
                let start = index;
                let mut depth = 0usize;
                while index < chars.len() {
                    match chars[index] {
                        '[' => depth += 1,
                        ']' => {
                            depth = depth.saturating_sub(1);
                            if depth == 0 {
                                index += 1;
                                break;
                            }
                        }
                        _ => {}
                    }
                    index += 1;
                }
                output.extend(&chars[start..index]);
                external = true;
                qualifier = None;
            }
            // The second half of `Sheet!A1:B2` belongs to the same sheet, so
            // a colon keeps the current qualifier.
            ':' => {
                output.push(':');
                index += 1;
            }
            _ if is_word(character) => {
                let start = index;
                while index < chars.len() && is_word(chars[index]) {
                    index += 1;
                }
                let word: String = chars[start..index].iter().collect();
                match chars.get(index) {
                    Some('!') => {
                        output.push_str(&word);
                        output.push('!');
                        qualifier = Some(word);
                        index += 1;
                        continue;
                    }
                    Some('(') => {
                        output.push_str(&word);
                        qualifier = None;
                        external = false;
                        continue;
                    }
                    _ => {}
                }
                let shift = !external
                    && match &qualifier {
                        None => local,
                        Some(name) => name.eq_ignore_ascii_case(sheet),
                    };
                // Whole-column (`A:C`) and whole-row (`2:5`) ranges.
                if chars.get(index) == Some(&':') {
                    let mut end = index + 1;
                    while end < chars.len() && is_word(chars[end]) {
                        end += 1;
                    }
                    let second: String = chars[index + 1..end].iter().collect();
                    if let Some(range) =
                        rewrite_line_range(&word, &second, shift, move_row, move_column)?
                    {
                        output.push_str(&range);
                        index = end;
                        qualifier = None;
                        external = false;
                        continue;
                    }
                }
                match parse_cell(&word) {
                    Some(cell) => output.push_str(&move_cell(cell, shift, move_row, move_column)?),
                    None => output.push_str(&word),
                }
                if chars.get(index) != Some(&':') {
                    qualifier = None;
                    external = false;
                }
            }
            _ => {
                output.push(character);
                index += 1;
                qualifier = None;
                external = false;
            }
        }
    }
    Ok(output)
}

fn is_word(character: char) -> bool {
    character.is_alphanumeric() || matches!(character, '_' | '.' | '$' | '\\')
}

/// The index just past a quoted run starting at `start`; doubled quotes escape.
fn closing_quote(chars: &[char], start: usize, quote: char) -> usize {
    let mut index = start + 1;
    while index < chars.len() {
        if chars[index] == quote {
            if chars.get(index + 1) == Some(&quote) {
                index += 2;
                continue;
            }
            return index + 1;
        }
        index += 1;
    }
    chars.len()
}

/// A parsed `$A$1`: zero-based column and row with their absolute markers.
#[derive(Clone, Copy)]
struct Cell {
    column: u32,
    row: u32,
    column_absolute: bool,
    row_absolute: bool,
}

fn parse_cell(word: &str) -> Option<Cell> {
    let (column_absolute, rest) = match word.strip_prefix('$') {
        Some(rest) => (true, rest),
        None => (false, word),
    };
    let letters = rest.chars().take_while(char::is_ascii_alphabetic).count();
    if letters == 0 || letters > 3 {
        return None;
    }
    let (column_text, rest) = rest.split_at(letters);
    let (row_absolute, digits) = match rest.strip_prefix('$') {
        Some(digits) => (true, digits),
        None => (false, rest),
    };
    if digits.is_empty() || !digits.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    let row = digits.parse::<u32>().ok()?;
    if row == 0 || row > MAX_ROW {
        return None;
    }
    Some(Cell {
        column: column_number(column_text)?,
        row: row - 1,
        column_absolute,
        row_absolute,
    })
}

/// `A` is 0 and `XFD` is the last column; anything past it is not a column.
fn column_number(letters: &str) -> Option<u32> {
    let mut column = 0u32;
    for character in letters.chars() {
        let value = character.to_ascii_uppercase();
        if !value.is_ascii_uppercase() {
            return None;
        }
        column = column.checked_mul(26)? + u32::from(value as u8 - b'A') + 1;
    }
    (1..=MAX_COLUMN).contains(&column).then(|| column - 1)
}

fn move_cell(cell: Cell, applies: bool, move_row: Mover, move_column: Mover) -> AppResult<String> {
    let row = move_row(cell.row, cell.row_absolute, applies)?;
    let column = move_column(cell.column, cell.column_absolute, applies)?;
    if row >= MAX_ROW || column >= MAX_COLUMN {
        return Err(overflow());
    }
    Ok(format!(
        "{}{}{}{}",
        if cell.column_absolute { "$" } else { "" },
        column_letters(column),
        if cell.row_absolute { "$" } else { "" },
        row + 1
    ))
}

/// Handles `A:C` and `2:5`. Returns `None` when the pair is not such a range.
fn rewrite_line_range(
    first: &str,
    second: &str,
    applies: bool,
    move_row: Mover,
    move_column: Mover,
) -> AppResult<Option<String>> {
    let split = |word: &str| -> (bool, String) {
        match word.strip_prefix('$') {
            Some(rest) => (true, rest.to_owned()),
            None => (false, word.to_owned()),
        }
    };
    let (first_absolute, first_body) = split(first);
    let (second_absolute, second_body) = split(second);
    let marker = |absolute: bool| if absolute { "$" } else { "" };
    let letters = |body: &str| body.len() <= 3 && body.chars().all(|c| c.is_ascii_alphabetic());
    let digits = |body: &str| body.chars().all(|c| c.is_ascii_digit());
    if first_body.is_empty() || second_body.is_empty() {
        return Ok(None);
    }

    if letters(&first_body) && letters(&second_body) {
        let (Some(start), Some(end)) = (column_number(&first_body), column_number(&second_body))
        else {
            return Ok(None);
        };
        let moved = |column: u32, absolute: bool| -> AppResult<String> {
            let column = move_column(column, absolute, applies)?;
            if column >= MAX_COLUMN {
                return Err(overflow());
            }
            Ok(column_letters(column))
        };
        return Ok(Some(format!(
            "{}{}:{}{}",
            marker(first_absolute),
            moved(start, first_absolute)?,
            marker(second_absolute),
            moved(end, second_absolute)?
        )));
    }
    if digits(&first_body) && digits(&second_body) {
        let (Ok(start), Ok(end)) = (first_body.parse::<u32>(), second_body.parse::<u32>()) else {
            return Ok(None);
        };
        if start == 0 || end == 0 || start > MAX_ROW || end > MAX_ROW {
            return Ok(None);
        }
        let moved = |row: u32, absolute: bool| -> AppResult<u32> {
            let row = move_row(row - 1, absolute, applies)?;
            if row >= MAX_ROW {
                return Err(overflow());
            }
            Ok(row + 1)
        };
        return Ok(Some(format!(
            "{}{}:{}{}",
            marker(first_absolute),
            moved(start, first_absolute)?,
            marker(second_absolute),
            moved(end, second_absolute)?
        )));
    }
    Ok(None)
}

/// Re-expresses a shared formula for a cell `rows` down and `columns` right
/// of the cell that stores it: relative references move, absolute ones stay.
fn translate_formula(formula: &str, rows: u32, columns: u32) -> AppResult<String> {
    rewrite_references(
        formula,
        "",
        true,
        &|row, absolute, _| Ok(if absolute { row } else { row + rows }),
        &|column, absolute, _| Ok(if absolute { column } else { column + columns }),
    )
}

/// A typed value starting with `=` is a formula; returns it without the `=`.
fn formula_text(value: &str) -> Option<&str> {
    value
        .strip_prefix('=')
        .map(str::trim)
        .filter(|formula| !formula.is_empty())
}

/// Functions added after Excel 2007 must be stored with the `_xlfn.` prefix,
/// or Excel shows `#NAME?` until the formula is re-entered.
const NEWER_FUNCTIONS: &[&str] = &[
    "CONCAT", "TEXTJOIN", "IFNA", "IFS", "MAXIFS", "MINIFS", "SWITCH", "XLOOKUP",
];

fn stored_formula(formula: &str) -> String {
    let chars: Vec<char> = formula.chars().collect();
    let mut output = String::with_capacity(formula.len() + 8);
    let mut index = 0usize;
    while index < chars.len() {
        let character = chars[index];
        if character == '"' || character == '\'' {
            let end = closing_quote(&chars, index, character);
            output.extend(&chars[index..end]);
            index = end;
            continue;
        }
        if is_word(character) {
            let start = index;
            while index < chars.len() && is_word(chars[index]) {
                index += 1;
            }
            let word: String = chars[start..index].iter().collect();
            if chars.get(index) == Some(&'(')
                && NEWER_FUNCTIONS.contains(&word.to_ascii_uppercase().as_str())
            {
                output.push_str("_xlfn.");
            }
            output.push_str(&word);
            continue;
        }
        output.push(character);
        index += 1;
    }
    output
}

const ERROR_VALUES: &[&str] = &[
    "#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A",
];

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

/// A shared formula whose defining cell is being overwritten: its text and
/// the zero-based (row, column) of that cell.
struct SharedFormula {
    text: String,
    row: u32,
    column: u32,
}

/// Excel stores a filled-down formula once, on the first cell of the run;
/// the rest point at it by `si`. Overwriting that first cell would orphan
/// them, so find those runs before patching.
fn orphaned_shared_formulas(
    xml: &[u8],
    edits: &[&CellEdit],
) -> AppResult<HashMap<String, SharedFormula>> {
    let edited: std::collections::HashSet<(u32, u32)> =
        edits.iter().map(|edit| (edit.row, edit.column)).collect();
    let mut found = HashMap::new();
    if edited.is_empty() {
        return Ok(found);
    }
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().check_end_names = false;
    let mut buffer = Vec::new();
    let mut cell: Option<(u32, u32)> = None;
    let mut defining: Option<String> = None;
    loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|error| AppError::new("invalid_spreadsheet", error.to_string()))?
        {
            Event::Start(element) if element.local_name().as_ref() == b"c" => {
                cell = attribute(&element, b"r").and_then(|value| parse_reference(&value));
            }
            Event::Start(element)
                if element.local_name().as_ref() == b"f"
                    && attribute(&element, b"t").as_deref() == Some("shared")
                    && attribute(&element, b"ref").is_some()
                    && cell.is_some_and(|position| edited.contains(&position)) =>
            {
                defining = attribute(&element, b"si");
            }
            Event::Text(text) => {
                if let (Some(index), Some((row, column))) = (defining.take(), cell) {
                    let text = text
                        .unescape()
                        .map_err(|error| AppError::new("invalid_spreadsheet", error.to_string()))?
                        .into_owned();
                    found.insert(index, SharedFormula { text, row, column });
                }
            }
            Event::End(element) if element.local_name().as_ref() == b"f" => defining = None,
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    Ok(found)
}

/// Writes a cell's own copy of an orphaned shared formula, when `element` is a
/// reference to one. Returns whether it did.
fn expand_shared<W: Write>(
    writer: &mut Writer<W>,
    element: &BytesStart<'_>,
    cell: Option<(u32, u32)>,
    orphaned: &HashMap<String, SharedFormula>,
) -> AppResult<bool> {
    if element.local_name().as_ref() != b"f"
        || attribute(element, b"t").as_deref() != Some("shared")
    {
        return Ok(false);
    }
    let (Some(shared), Some((row, column))) = (
        attribute(element, b"si").and_then(|index| orphaned.get(&index)),
        cell,
    ) else {
        return Ok(false);
    };
    let (Some(rows), Some(columns)) = (
        row.checked_sub(shared.row),
        column.checked_sub(shared.column),
    ) else {
        return Ok(false);
    };
    write_child(
        writer,
        "f",
        &translate_formula(&shared.text, rows, columns)?,
    )?;
    Ok(true)
}

fn patch_sheet(xml: &[u8], edits: &[&CellEdit]) -> AppResult<Vec<u8>> {
    let orphaned = orphaned_shared_formulas(xml, edits)?;
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().check_end_names = false;
    let mut writer = Writer::new(Cursor::new(Vec::new()));
    let mut buffer = Vec::new();
    let mut cursor = 0usize;
    let mut in_sheet_data = false;
    let mut in_row: Option<u32> = None;
    let mut in_cell: Option<(u32, u32)> = None;
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
                    in_cell = attribute(&element, b"r").and_then(|value| parse_reference(&value));
                    write(&mut writer, Event::Start(element))?;
                }
            }
            Event::End(element) if element.local_name().as_ref() == b"c" => {
                in_cell = None;
                write(&mut writer, Event::End(element))?;
            }
            Event::Empty(element)
                if in_cell.is_some()
                    && expand_shared(&mut writer, &element, in_cell, &orphaned)? => {}
            Event::Start(element)
                if in_cell.is_some()
                    && expand_shared(&mut writer, &element, in_cell, &orphaned)? =>
            {
                skip_depth = 1;
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
    write_cell(writer, &reference, style.as_deref(), edits[*cursor])?;
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
        write_cell(writer, &reference, None, edit)?;
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
    edit: &CellEdit,
) -> AppResult<()> {
    let mut start = BytesStart::new("c");
    start.push_attribute(("r", reference));
    // Keeping `s` preserves the cell's number format, font and fill.
    if let Some(style) = style {
        start.push_attribute(("s", style));
    }
    if let Some(formula) = formula_text(&edit.value) {
        return write_formula(writer, start, formula, edit.result.as_ref());
    }
    match classify(&edit.value) {
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

/// Writes `<f>` plus the value the viewer computed, typed so that readers which
/// never recalculate still show it. Excel recalculates on open regardless.
fn write_formula<W: Write>(
    writer: &mut Writer<W>,
    mut start: BytesStart<'_>,
    formula: &str,
    result: Option<&FormulaResult>,
) -> AppResult<()> {
    let cached: Option<(Option<&str>, String)> =
        result.and_then(|result| match result.kind.as_str() {
            "number" => {
                let text = result.text.trim();
                text.parse::<f64>()
                    .is_ok_and(f64::is_finite)
                    .then(|| (None, text.to_owned()))
            }
            "boolean" => Some((
                Some("b"),
                if result.text.eq_ignore_ascii_case("true") {
                    "1"
                } else {
                    "0"
                }
                .to_owned(),
            )),
            // An error Excel does not know would make the file fail to open.
            "error" => ERROR_VALUES
                .contains(&result.text.as_str())
                .then(|| (Some("e"), result.text.clone())),
            _ => Some((Some("str"), result.text.clone())),
        });
    if let Some((Some(kind), _)) = &cached {
        start.push_attribute(("t", *kind));
    }
    write(writer, Event::Start(start))?;
    write_child(writer, "f", &stored_formula(formula))?;
    if let Some((_, value)) = cached {
        write_child(writer, "v", &value)?;
    }
    write(writer, Event::End(BytesEnd::new("c")))
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
            result: None,
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
    fn refuses_oversized_input() {
        let directory = assert_fs::TempDir::new().unwrap();
        let path = directory.path().join("book.xlsx");
        assert_eq!(
            apply(
                &path,
                0,
                &[],
                &[edit(0, 0, &"x".repeat(MAX_VALUE_CHARS + 1))]
            )
            .unwrap_err()
            .code,
            "cell_value_limit"
        );
        assert_eq!(
            apply(
                &path,
                0,
                &[],
                &[edit(0, 0, &format!("={}", "1+".repeat(MAX_FORMULA_CHARS)))]
            )
            .unwrap_err()
            .code,
            "cell_value_limit"
        );
        assert_eq!(
            apply(&path, 0, &[rows(0, 0)], &[]).unwrap_err().code,
            "insert_limit"
        );
        assert_eq!(apply(&path, 0, &[], &[]).unwrap_err().code, "no_edits");
    }

    fn rows(index: u32, count: u32) -> StructuralInsert {
        StructuralInsert {
            axis: InsertAxis::Row,
            index,
            count,
        }
    }

    fn columns(index: u32, count: u32) -> StructuralInsert {
        StructuralInsert {
            axis: InsertAxis::Column,
            index,
            count,
        }
    }

    fn formula(value: &str, result: Option<(&str, &str)>) -> CellEdit {
        CellEdit {
            result: result.map(|(kind, text)| FormulaResult {
                kind: kind.to_owned(),
                text: text.to_owned(),
            }),
            ..edit(0, 0, value)
        }
    }

    #[test]
    fn writes_formulas_with_their_cached_result() {
        let output = patched(SHEET, &[formula("=SUM(B1:B2)", Some(("number", "17")))]);
        assert!(
            output.contains(r#"<c r="A1"><f>SUM(B1:B2)</f><v>17</v></c>"#),
            "{output}"
        );

        let text = patched(SHEET, &[formula("=A2&\"<x>\"", Some(("text", "a<x>")))]);
        assert!(
            text.contains(
                r#"<c r="A1" t="str"><f>A2&amp;&quot;&lt;x&gt;&quot;</f><v>a&lt;x&gt;</v></c>"#
            ),
            "{text}"
        );

        let unknown = patched(SHEET, &[formula("=1/0", Some(("error", "#CIRC!")))]);
        assert!(
            unknown.contains(r#"<c r="A1"><f>1/0</f></c>"#),
            "an error Excel does not define is not cached: {unknown}"
        );
    }

    #[test]
    fn expands_a_filled_down_formula_when_its_first_cell_is_overwritten() {
        let sheet = br#"<worksheet><sheetData><row r="2"><c r="C2"><f t="shared" ref="C2:C4" si="0">A2*$B$1</f><v>1</v></c></row><row r="3"><c r="C3"><f t="shared" si="0"/><v>2</v></c></row><row r="4"><c r="C4"><f t="shared" si="0"></f><v>3</v></c><c r="D4"><f t="shared" si="1"/></c></row></sheetData></worksheet>"#;
        let output = patched(sheet, &[edit(1, 2, "9")]);
        assert!(output.contains(r#"<c r="C2"><v>9</v></c>"#), "{output}");
        assert!(
            output.contains(r#"<c r="C3"><f>A3*$B$1</f><v>2</v></c>"#),
            "{output}"
        );
        assert!(
            output.contains(r#"<c r="C4"><f>A4*$B$1</f><v>3</v></c>"#),
            "{output}"
        );
        assert!(
            output.contains(r#"<f t="shared" si="1"/>"#),
            "other shared formulas are untouched: {output}"
        );

        let untouched = patched(sheet, &[edit(2, 2, "5")]);
        assert!(
            untouched.contains(r#"<f t="shared" ref="C2:C4" si="0">A2*$B$1</f>"#),
            "overwriting a follower leaves the defining cell alone: {untouched}"
        );
        assert!(
            untouched.contains(r#"<f t="shared" si="0"></f>"#),
            "{untouched}"
        );
    }

    #[test]
    fn translates_relative_references_only() {
        assert_eq!(
            translate_formula("SUM(A1:$A$3)+B$1+$C2+Other!D4+E:E+5:5", 2, 1).unwrap(),
            "SUM(B3:$A$3)+C$1+$C4+Other!E6+F:F+7:7"
        );
    }

    #[test]
    fn prefixes_functions_newer_than_excel_2007() {
        assert_eq!(
            stored_formula(r#"CONCAT(A1,"concat(")&textjoin(",",TRUE,B1:B3)&SUM(C1)"#),
            r#"_xlfn.CONCAT(A1,"concat(")&_xlfn.textjoin(",",TRUE,B1:B3)&SUM(C1)"#
        );
    }

    #[test]
    fn shifts_references_at_or_after_an_inserted_row() {
        let shift = |formula: &str| shift_references(formula, &rows(2, 2), "Data", true).unwrap();
        assert_eq!(shift("A1+A3"), "A1+A5");
        assert_eq!(
            shift("SUM($B$2:B10)"),
            "SUM($B$2:B12)",
            "a spanning range grows"
        );
        assert_eq!(shift("SUM(A:A)"), "SUM(A:A)", "whole columns stay put");
        assert_eq!(shift("SUM(3:4)"), "SUM(5:6)");
        assert_eq!(shift(r#""A5"&A5"#), r#""A5"&A7"#, "strings are left alone");
        assert_eq!(
            shift("LOG10(A3)"),
            "LOG10(A5)",
            "function names are not cells"
        );
        assert_eq!(shift("Other!A3+data!A3"), "Other!A3+data!A5");
        assert_eq!(shift("'My Data'!A3+[1]Data!A3"), "'My Data'!A3+[1]Data!A3");
        assert_eq!(
            shift("Data!A1:A3"),
            "Data!A1:A5",
            "both ends share the sheet"
        );
        assert_eq!(shift("A1:B3 D4"), "A1:B5 D6", "range lists shift too");
    }

    #[test]
    fn shifts_references_at_or_after_an_inserted_column() {
        let shift = |formula: &str| shift_references(formula, &columns(1, 1), "S", true).unwrap();
        assert_eq!(shift("A1+B1+$C$2"), "A1+C1+$D$2");
        assert_eq!(shift("SUM(A:B)"), "SUM(A:C)");
        assert_eq!(shift("SUM(1:2)"), "SUM(1:2)");
        assert_eq!(
            shift_references("'It''s'!B1", &columns(1, 1), "It's", false).unwrap(),
            "'It''s'!C1"
        );
        assert_eq!(
            shift_references("B1", &columns(1, 1), "S", false).unwrap(),
            "B1",
            "another sheet's own cells are not this sheet's"
        );
    }

    #[test]
    fn refuses_to_push_cells_off_the_sheet() {
        assert_eq!(
            shift_references("A1048576", &rows(5, 1), "S", true)
                .unwrap_err()
                .code,
            "insert_overflow"
        );
    }

    #[test]
    fn shifts_rows_cells_merges_and_widths_on_the_sheet() {
        let xml = br#"<worksheet><cols><col min="1" max="1" width="5"/><col min="2" max="4" width="9"/></cols><sheetData><row r="1" spans="1:3"><c r="A1"><v>1</v></c><c r="C1"><f>A1*2</f><v>2</v></c></row><row r="2" ht="30" customHeight="1"><c r="B2"><v>3</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A2:C2"/></mergeCells><conditionalFormatting sqref="B1:B2"><cfRule type="expression"><formula>B1&gt;2</formula></cfRule></conditionalFormatting></worksheet>"#;
        let by_row = String::from_utf8(shift_sheet(xml, &rows(1, 1), "S").unwrap()).unwrap();
        assert!(
            by_row.contains(r#"<row r="3" ht="30" customHeight="1"><c r="B3">"#),
            "{by_row}"
        );
        assert!(by_row.contains(r#"<mergeCell ref="A3:C3"/>"#), "{by_row}");
        assert!(by_row.contains(r#"sqref="B1:B3""#), "{by_row}");
        assert!(by_row.contains("<formula>B1&gt;2</formula>"), "{by_row}");
        assert!(!by_row.contains("spans="), "{by_row}");

        let by_column = String::from_utf8(shift_sheet(xml, &columns(1, 2), "S").unwrap()).unwrap();
        assert!(
            by_column.contains(r#"<c r="E1"><f>A1*2</f>"#),
            "{by_column}"
        );
        assert!(by_column.contains(r#"<c r="D2">"#), "{by_column}");
        assert!(
            by_column.contains(r#"<col min="1" max="1" width="5"/>"#),
            "{by_column}"
        );
        assert!(
            by_column.contains(r#"<col min="4" max="6" width="9"/>"#),
            "{by_column}"
        );
        assert!(
            by_column.contains(r#"<mergeCell ref="A2:E2"/>"#),
            "{by_column}"
        );
        assert!(
            by_column.contains("<formula>D1&gt;2</formula>"),
            "{by_column}"
        );
    }

    #[test]
    fn refuses_inserts_on_sheets_with_positional_parts() {
        let rels = br#"<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>"#;
        assert_eq!(
            refuse_positional_parts(rels).unwrap_err().code,
            "insert_not_supported"
        );
        let drawing = br#"<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>"#;
        assert!(refuse_positional_parts(drawing).is_ok());
        assert_eq!(
            relationships_part("xl/worksheets/sheet1.xml"),
            "xl/worksheets/_rels/sheet1.xml.rels"
        );
    }

    /// Builds a two-sheet workbook where the second sheet and a defined name
    /// both point into the first.
    fn workbook(path: &Path) {
        let parts: [(&str, &str); 5] = [
            (
                "xl/workbook.xml",
                r#"<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Report" sheetId="2" r:id="rId2"/></sheets><definedNames><definedName name="Total">Data!$B$2:$B$3</definedName></definedNames></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c></row><row r="2"><c r="B2"><v>4</v></c></row><row r="3"><c r="B3"><v>6</v></c><c r="C3"><f>SUM(B2:B3)</f><v>10</v></c></row></sheetData></worksheet>"#,
            ),
            (
                "xl/worksheets/sheet2.xml",
                r#"<worksheet><sheetData><row r="1"><c r="A1"><f>Data!B3*2</f><v>12</v></c><c r="B1"><f>B3</f><v>0</v></c></row></sheetData></worksheet>"#,
            ),
            ("docProps/app.xml", "<Properties/>"),
        ];
        let mut writer = ZipWriter::new(std::fs::File::create(path).unwrap());
        for (name, content) in parts {
            writer
                .start_file(name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
    }

    fn read_part(path: &Path, name: &str) -> String {
        let mut archive = ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
        String::from_utf8(part(&mut archive, name).unwrap().unwrap()).unwrap()
    }

    #[test]
    fn inserts_a_row_across_the_whole_workbook_then_applies_edits() {
        let directory = assert_fs::TempDir::new().unwrap();
        let path = directory.path().join("book.xlsx");
        workbook(&path);
        let new_formula = CellEdit {
            row: 1,
            column: 1,
            ..formula("=B3+B4", Some(("number", "10")))
        };
        apply(&path, 0, &[rows(1, 1)], &[edit(1, 0, "Added"), new_formula]).unwrap();

        let data = read_part(&path, "xl/worksheets/sheet1.xml");
        assert!(
            data.contains(r#"<row r="3"><c r="B3"><v>4</v></c></row>"#),
            "{data}"
        );
        assert!(data.contains(r#"<c r="C4"><f>SUM(B3:B4)</f>"#), "{data}");
        assert!(
            data.contains(r#"<row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">Added</t></is></c><c r="B2"><f>B3+B4</f><v>10</v></c></row>"#),
            "the edits land in the inserted row: {data}"
        );

        let report = read_part(&path, "xl/worksheets/sheet2.xml");
        assert!(report.contains("<f>Data!B4*2</f>"), "{report}");
        assert!(
            report.contains("<f>B3</f>"),
            "the report's own cells stay: {report}"
        );

        let book = read_part(&path, "xl/workbook.xml");
        assert!(book.contains("Data!$B$3:$B$4"), "{book}");
        assert!(book.contains(r#"fullCalcOnLoad="1""#), "{book}");
        assert_eq!(read_part(&path, "docProps/app.xml"), "<Properties/>");
    }
}
