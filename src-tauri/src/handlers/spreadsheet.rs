use crate::{
    domain::{
        AppError, AppResult, SpreadsheetCell, SpreadsheetEdit, SpreadsheetEditRequest,
        SpreadsheetSheet, WorkbookView,
    },
    file_detection,
    handlers::xlsx_edit,
    security,
};
use calamine::{open_workbook_auto, Data, Reader, SheetType, SheetVisible};
use std::time::UNIX_EPOCH;

pub const MAX_FILE_BYTES: u64 = 48 * 1024 * 1024;
const MAX_ROWS: usize = 50_000;
const MAX_COLUMNS: usize = 256;
const MAX_CELLS: usize = 500_000;

/// Cell editing rewrites the OOXML package in place. The legacy and
/// OpenDocument formats are read-only because writing them would mean
/// regenerating the file and discarding everything this app does not model.
const EDITABLE_EXTENSIONS: &[&str] = &["xlsx", "xlsm"];

pub fn edit(request: &SpreadsheetEditRequest) -> AppResult<SpreadsheetEdit> {
    let canonical = security::canonical_file(&request.path)?;
    let extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if !extension
        .as_deref()
        .is_some_and(|value| EDITABLE_EXTENSIONS.contains(&value))
    {
        return Err(AppError::path(
            "spreadsheet_not_editable",
            "OneOpen can only edit .xlsx and .xlsm workbooks. Save this file as .xlsx first.",
            &canonical,
        ));
    }
    if let Some(expected) = request.expected_modified_ms {
        let current = std::fs::metadata(&canonical)
            .and_then(|value| value.modified())
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis() as u64);
        if current != Some(expected) {
            return Err(AppError::path(
                "external_modification",
                "The workbook changed outside OneOpen",
                &canonical,
            ));
        }
    }
    xlsx_edit::apply(
        &canonical,
        request.sheet_index,
        &request.inserts,
        &request.edits,
    )?;
    Ok(SpreadsheetEdit {
        file: file_detection::detect(&canonical)?,
        view: read(&canonical.to_string_lossy(), Some(request.sheet_index))?,
    })
}

pub fn read(path: &str, sheet_index: Option<usize>) -> AppResult<WorkbookView> {
    let canonical = security::canonical_file(path)?;
    let size = std::fs::metadata(&canonical)
        .map_err(|error| AppError::io(error, &canonical))?
        .len();
    if size > MAX_FILE_BYTES {
        return Err(AppError::path(
            "spreadsheet_size_limit",
            "Workbook exceeds the 48 MiB preview limit",
            &canonical,
        ));
    }
    let mut workbook = open_workbook_auto(&canonical)
        .map_err(|error| AppError::path("invalid_spreadsheet", error.to_string(), &canonical))?;
    let metadata = workbook.sheets_metadata().to_vec();
    let names = workbook.sheet_names();
    if names.is_empty() {
        return Err(AppError::path(
            "empty_workbook",
            "The workbook contains no sheets",
            &canonical,
        ));
    }
    let sheets: Vec<SpreadsheetSheet> = names
        .iter()
        .enumerate()
        .map(|(index, name)| {
            let entry = metadata.iter().find(|sheet| &sheet.name == name);
            SpreadsheetSheet {
                index,
                name: name.clone(),
                hidden: entry.is_some_and(|sheet| sheet.visible != SheetVisible::Visible),
                selectable: entry.map_or(true, |sheet| sheet.typ == SheetType::WorkSheet),
            }
        })
        .collect();

    let active = match sheet_index {
        Some(index) if index >= names.len() => {
            return Err(AppError::new(
                "sheet_not_found",
                "The sheet no longer exists",
            ))
        }
        Some(index) => index,
        None => sheets
            .iter()
            .position(|sheet| sheet.selectable && !sheet.hidden)
            .or_else(|| sheets.iter().position(|sheet| sheet.selectable))
            .unwrap_or(0),
    };

    let range = workbook
        .worksheet_range(&names[active])
        .map_err(|error| AppError::path("invalid_spreadsheet", error.to_string(), &canonical))?;
    let (total_rows, total_columns) = range.get_size();
    let (start_row, start_column) = range.start().unwrap_or((0, 0));
    let columns = total_columns.min(MAX_COLUMNS);
    let rows = total_rows.min(MAX_ROWS).min(MAX_CELLS / columns.max(1));
    let mut grid = Vec::with_capacity(rows);
    for row in range.rows().take(rows) {
        let mut cells: Vec<SpreadsheetCell> = row.iter().take(columns).map(convert).collect();
        while cells.last().is_some_and(|cell| cell.kind == "empty") {
            cells.pop();
        }
        grid.push(cells);
    }
    // Legacy and OpenDocument readers may not expose formulas; values still show.
    if let Ok(formulas) = workbook.worksheet_formula(&names[active]) {
        attach_formulas(&mut grid, &formulas, (start_row, start_column), columns);
    }

    Ok(WorkbookView {
        sheets,
        active_index: active,
        rows: grid,
        start_row: start_row as usize,
        start_column: start_column as usize,
        total_rows,
        total_columns,
        truncated: rows < total_rows || columns < total_columns,
    })
}

fn convert(value: &Data) -> SpreadsheetCell {
    let (text, kind) = match value {
        Data::Empty => (String::new(), "empty"),
        Data::String(text) => (text.clone(), "text"),
        Data::Int(value) => (value.to_string(), "number"),
        Data::Float(value) => (format_number(*value), "number"),
        Data::Bool(value) => (
            (if *value { "TRUE" } else { "FALSE" }).to_owned(),
            "boolean",
        ),
        Data::Error(error) => (error.to_string(), "error"),
        Data::DateTimeIso(text) => (text.clone(), "date"),
        Data::DurationIso(text) => (text.clone(), "duration"),
        Data::DateTime(value) if value.is_duration() => {
            (format_duration(value.as_f64()), "duration")
        }
        Data::DateTime(value) => (
            format_datetime(value.to_ymd_hms_milli(), value.as_f64()),
            "date",
        ),
    };
    SpreadsheetCell {
        text,
        kind,
        formula: None,
    }
}

/// Places each formula on its cell in the grid, which starts at `origin`.
fn attach_formulas(
    grid: &mut [Vec<SpreadsheetCell>],
    formulas: &calamine::Range<String>,
    origin: (u32, u32),
    columns: usize,
) {
    let Some((formula_row, formula_column)) = formulas.start() else {
        return;
    };
    for (row, column, formula) in formulas.used_cells() {
        if formula.is_empty() {
            continue;
        }
        let absolute_row = formula_row as usize + row;
        let absolute_column = formula_column as usize + column;
        let (Some(row), Some(column)) = (
            absolute_row.checked_sub(origin.0 as usize),
            absolute_column.checked_sub(origin.1 as usize),
        ) else {
            continue;
        };
        if column >= columns {
            continue;
        }
        let Some(cells) = grid.get_mut(row) else {
            continue;
        };
        // Trailing blanks were trimmed, but a formula can evaluate to "".
        while cells.len() <= column {
            cells.push(convert(&Data::Empty));
        }
        cells[column].formula = Some(format!("={}", display_formula(formula)));
    }
}

/// Newer functions are stored with a `_xlfn.` prefix that people never type.
fn display_formula(formula: &str) -> String {
    formula.replace("_xlfn._xlws.", "").replace("_xlfn.", "")
}

/// Formats a float the way a spreadsheet would: no binary-representation noise
/// and no exponent for values people actually read.
fn format_number(value: f64) -> String {
    if !value.is_finite() {
        return String::new();
    }
    if value == value.trunc() && value.abs() < 1e15 {
        return format!("{}", value as i64);
    }
    let exponent = value.abs().log10().floor() as i32;
    if !(-5..15).contains(&exponent) {
        return format!("{value:e}");
    }
    let decimals = (14 - exponent).clamp(0, 17) as usize;
    let text = format!("{value:.decimals$}");
    if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.').to_owned()
    } else {
        text
    }
}

fn format_datetime(parts: (u16, u8, u8, u8, u8, u8, u16), serial: f64) -> String {
    let (year, month, day, hour, minute, second, _) = parts;
    if serial < 1.0 {
        return format!("{hour:02}:{minute:02}:{second:02}");
    }
    if serial.fract() == 0.0 {
        return format!("{year:04}-{month:02}-{day:02}");
    }
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}")
}

fn format_duration(days: f64) -> String {
    let total = (days * 86_400.0).round().max(0.0) as u64;
    format!(
        "{}:{:02}:{:02}",
        total / 3600,
        (total % 3600) / 60,
        total % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::CellEdit;

    #[test]
    fn formats_numbers_without_binary_noise() {
        assert_eq!(format_number(0.1 + 0.2), "0.3");
        assert_eq!(format_number(42.0), "42");
        assert_eq!(format_number(-1234.5), "-1234.5");
        assert_eq!(format_number(f64::NAN), "");
    }

    #[test]
    fn formats_dates_times_and_durations() {
        assert_eq!(
            format_datetime((2026, 9, 2, 0, 0, 0, 0), 46266.0),
            "2026-09-02"
        );
        assert_eq!(
            format_datetime((2026, 9, 2, 13, 45, 30, 0), 46266.5),
            "2026-09-02 13:45:30"
        );
        assert_eq!(
            format_datetime((1899, 12, 30, 6, 30, 0, 0), 0.27),
            "06:30:00"
        );
        assert_eq!(format_duration(1.5), "36:00:00");
    }

    #[test]
    fn converts_every_cell_kind() {
        assert_eq!(convert(&Data::Empty).kind, "empty");
        assert_eq!(convert(&Data::Bool(true)).text, "TRUE");
        assert_eq!(convert(&Data::Int(7)).text, "7");
        assert_eq!(convert(&Data::String("a".into())).kind, "text");
    }

    #[test]
    fn attaches_formulas_relative_to_the_used_range() {
        let mut grid = vec![vec![convert(&Data::Int(1))], vec![convert(&Data::Int(2))]];
        let mut formulas = calamine::Range::new((3, 5), (4, 6));
        formulas.set_value((4, 6), "_xlfn.CONCAT(F4,\"x\")".to_owned());
        attach_formulas(&mut grid, &formulas, (3, 5), 10);
        assert_eq!(
            grid[1].len(),
            2,
            "the trimmed row grows to reach the formula"
        );
        assert_eq!(grid[1][1].formula.as_deref(), Some("=CONCAT(F4,\"x\")"));
        assert!(grid[0][0].formula.is_none());
    }

    #[test]
    fn only_ooxml_workbooks_accept_cell_edits() {
        let directory = assert_fs::TempDir::new().unwrap();
        let request = |name: &str| SpreadsheetEditRequest {
            path: directory.path().join(name).to_string_lossy().into_owned(),
            sheet_index: 0,
            edits: vec![CellEdit {
                row: 0,
                column: 0,
                value: "x".into(),
                result: None,
            }],
            inserts: Vec::new(),
            expected_modified_ms: None,
        };
        for name in ["legacy.xls", "open.ods", "binary.xlsb", "notes.txt"] {
            std::fs::write(directory.path().join(name), b"placeholder").unwrap();
            assert_eq!(
                edit(&request(name)).unwrap_err().code,
                "spreadsheet_not_editable",
                "{name} must stay read-only"
            );
        }
        assert_eq!(
            edit(&request("missing.xlsx")).unwrap_err().code,
            "file_not_found"
        );
    }

    #[test]
    fn rejects_missing_and_invalid_workbooks() {
        assert_eq!(
            read("missing-oneopen-workbook.xlsx", None)
                .unwrap_err()
                .code,
            "file_not_found"
        );
    }
}
