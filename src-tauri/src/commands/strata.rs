// Strata commands — mirrors backend/routers/strata.py.
//
// All strata data lives in a SINGLE xlsx workbook per output folder:
//   {output_folder}/strata.xlsx
//
// The master "Strata" sheet matches the Strata_GIRTool template exactly:
//
//   Columns (row 1, 11 wide):
//     A  ProjectID                    (text)
//     B  PointID                      (text)
//     C  PointNo                      (text)
//     D  Depth From [m]               (number)
//     E  Depth To [m]                 (number)
//     F  Primary Layer                (text — master sheet label)
//     G  Secondary Layer              (text — master sheet label)
//     H  Layer Thickness [m]          (formula =E-D)
//     I  Gap in boundary?             (formula — AND(D>prev.E, A=prev.A, B=prev.B))
//     J  Overlapping?                 (formula — AND(D<prev.E, A=prev.A, B=prev.B))
//     K  Negative thickness?          (formula =D>=E)
//
//   Header: Verdana 9, row height 30.75, wrap-text on D, E, H–K
//   Body:   Verdana 9, fill #D6DEE4
//   Conditional formatting: A2:K{last} → red (#FFC7CE) when OR(I,J,K) is TRUE
//   Table:  TableStyleMedium2, displayName "Strata_{idx}"
//   Frozen pane: A2
//
// Data sheets (one per {interpretation}_{series}) use raw DB labels
// "Layer" / "Description" in F/G instead of the master labels.
//
// Commands (all 10):
//   ensure_strata_file()            → ()  create with empty Strata sheet
//   load_strata()                   → Vec<Value>  rows from master sheet
//   update_strata(rows)             → ()  overwrite master sheet rows
//   get_strata_types(body)          → Vec<Value>  distinct interp/series combos
//   get_strata_data(body)           → Value  raw rows keyed by series||interp
//   download_strata(body)           → Value  add {interp}_{series} sheets
//   transfer_strata(body)           → Value  copy new rows into master sheet
//   open_strata()                   → ()  open xlsx in OS default app
//   get_strata_layers()             → { primary, secondary }
//   get_strata_point_layers()       → { point_layers: { pid: { primary, secondary } } }

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use calamine::{open_workbook_auto, Data, Reader};
use rust_xlsxwriter::{
    Color, ConditionalFormatFormula, Format, FormatAlign, Table, TableColumn, TableStyle,
    Workbook, Worksheet,
};

use crate::commands::query_configs::{
    current_query_type, lookup_sql, SECTION_STRATA_DOWNLOAD, SECTION_STRATA_SERIES,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

// ── Template constants ────────────────────────────────────────────────────────

const MASTER_SHEET: &str = "Strata";

const FONT_NAME: &str = "Verdana";
const FONT_SIZE: f64  = 9.0;

/// Data row fill (pale blue-grey, matches template).
const DATA_FILL_RGB: u32 = 0xD6_DE_E4;
/// Conditional formatting fill (Excel "bad" light red).
const RED_FILL_RGB: u32 = 0xFF_C7_CE;

/// Headers for the master sheet (template labels in F/G).
const MASTER_HEADERS: &[&str] = &[
    "ProjectID",
    "PointID",
    "PointNo",
    "Depth From [m]",
    "Depth To [m]",
    "Primary Layer",
    "Secondary Layer",
    "Layer Thickness [m]",
    "Gap in boundary?",
    "Overlapping?",
    "Negative thickness?",
];

/// Headers for raw download sheets (raw DB labels in F/G).
const DATA_HEADERS: &[&str] = &[
    "ProjectID",
    "PointID",
    "PointNo",
    "Depth From [m]",
    "Depth To [m]",
    "Layer",
    "Description",
    "Layer Thickness [m]",
    "Gap in boundary?",
    "Overlapping?",
    "Negative thickness?",
];

/// Column widths (Excel character units).
const COL_WIDTHS: [f64; 11] = [
    13.2, // A ProjectID
    13.2, // B PointID
    15.0, // C PointNo
    10.4, // D Depth From
    9.2,  // E Depth To
    24.4, // F Primary Layer / Layer
    24.7, // G Secondary Layer / Description
    12.5, // H Layer Thickness
    10.6, // I Gap?
    10.2, // J Overlapping?
    10.6, // K Negative?
];

/// Header columns that need `wrap_text` because they contain `[m]` etc.
const WRAP_COLS: [u16; 6] = [3, 4, 7, 8, 9, 10]; // D, E, H, I, J, K (0-indexed)

// ── Paths ─────────────────────────────────────────────────────────────────────

pub(crate) fn strata_xlsx_path(output_folder: &str) -> PathBuf {
    PathBuf::from(output_folder).join("strata.xlsx")
}

// ── SQL ───────────────────────────────────────────────────────────────────────

const TYPES_SQL: &str = r#"
SELECT
    sub.Interpretation,
    sub.series,
    sub.Description,
    COUNT(*)              AS Point_Count,
    SUM(sub.Layer_Count)  AS Layer_Count
FROM (
    SELECT DISTINCT
        A.[Interpretation],
        D.[series],
        D.[Description],
        A.[PointId],
        1 AS Layer_Count
    FROM
        (([Strata]      A
          INNER JOIN [Points]      B ON A.PointId  = B.PointId)
          INNER JOIN [Layers]      C ON A.LayerId  = C.LayerId)
          INNER JOIN [LayerSeries] D ON C.SeriesId = D.SeriesId
    WHERE B.ProjectID IN ({project_ids})
    {point_filter}
) sub
GROUP BY sub.Interpretation, sub.series, sub.Description
ORDER BY sub.series, sub.Interpretation
"#;

const DATA_SQL: &str = r#"
SELECT DISTINCT
    CAST(B.[PointNo] AS VARCHAR(MAX)) AS [PointNo],
    B.[PointId],
    B.[ProjectId],
    ROUND(A.[Depth1], 2) AS [From],
    ROUND(A.[Depth2], 2) AS [To],
    C.[Layer],
    C.[Description]
FROM
    [Strata]      A
    INNER JOIN [Points]      B ON A.PointId  = B.PointId
    INNER JOIN [Layers]      C ON A.LayerId  = C.LayerId
    INNER JOIN [LayerSeries] D ON C.SeriesId = D.SeriesId
    INNER JOIN [Projects]    E ON B.ProjectID = E.ProjectID
WHERE
    B.ProjectID IN ({project_ids})
    {point_filter}
    AND D.Series         = {series}
    AND A.Interpretation = {interpretation}
    AND A.Depth1 >= 0
ORDER BY PointNo ASC, [From] ASC
"#;

/// Sanitise a single ID for interpolation into a SQL IN clause.
/// Accepts GUIDs (8-4-4-4-12 hex) or bare integers only.
fn safe_id(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    let is_guid = {
        let parts: Vec<&str> = s.split('-').collect();
        parts.len() == 5 && {
            let lens = [8usize, 4, 4, 4, 12];
            parts.iter().zip(lens.iter()).all(|(p, &l)| {
                p.len() == l && p.chars().all(|c| c.is_ascii_hexdigit())
            })
        }
    };
    if is_guid {
        Ok(format!("'{s}'"))
    } else if !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) {
        Ok(s.to_string())
    } else {
        Err(format!("Invalid ID: {s:?}"))
    }
}

fn ids_clause(ids: &[String]) -> Result<String, String> {
    ids.iter()
        .map(|i| safe_id(i))
        .collect::<Result<Vec<_>, _>>()
        .map(|v| v.join(","))
}

fn point_filter_clause(point_ids: &[String]) -> Result<String, String> {
    if point_ids.is_empty() {
        return Ok(String::new());
    }
    Ok(format!("AND B.PointId IN ({})", ids_clause(point_ids)?))
}

/// SQL-string-literal escape: wrap in single quotes and double any inner quote.
fn safe_str(v: &str) -> String {
    let escaped = v.replace('\'', "''");
    format!("'{escaped}'")
}

// ── Pydantic-equivalent payload types ─────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct StrataSelection {
    pub interpretation: String,
    pub series: String,
}

#[derive(Debug, Deserialize)]
pub struct StrataRequest {
    #[serde(default)]
    pub project_ids: Vec<String>,
    #[serde(default)]
    pub point_ids: Vec<String>,
    #[serde(default)]
    pub selections: Vec<StrataSelection>,
}

#[derive(Debug, Deserialize, Default, Clone)]
pub struct StrataRow {
    #[serde(rename = "ProjectId", default)]
    pub project_id: Option<Value>,
    #[serde(rename = "PointId", default)]
    pub point_id: Option<Value>,
    #[serde(rename = "PointNo", default)]
    pub point_no: Option<Value>,
    #[serde(rename = "From", default)]
    pub from: Option<f64>,
    #[serde(rename = "To", default)]
    pub to: Option<f64>,
    #[serde(rename = "Layer", default)]
    pub layer: Option<String>,
    #[serde(rename = "Description", default)]
    pub description: Option<String>,
}

// ── Workbook builder ──────────────────────────────────────────────────────────

/// Write formula cells for columns H–K at worksheet row `ri` (0-indexed).
/// Mirrors Python `_write_formula_cells` (1-indexed row in the formulas).
fn write_formula_cells(ws: &mut Worksheet, ri: u32, fmt: &Format) -> Result<(), String> {
    let r = ri + 1; // Excel 1-indexed row used in formulas

    // H: =E{r}-D{r}
    ws.write_formula_with_format(ri, 7, &*format!("=E{r}-D{r}"), fmt)
        .map_err(|e| format!("Formula H write error: {e}"))?;
    // I: =AND(D>prev.E, A=prev.A, B=prev.B)
    let i_formula = format!(
        "=AND(D{r}>OFFSET(E{r},-1,0),AND(A{r}=OFFSET(A{r},-1,0),B{r}=OFFSET(B{r},-1,0)))"
    );
    ws.write_formula_with_format(ri, 8, i_formula.as_str(), fmt)
        .map_err(|e| format!("Formula I write error: {e}"))?;
    // J: =AND(D<prev.E, A=prev.A, B=prev.B)
    let j_formula = format!(
        "=AND(D{r}<OFFSET(E{r},-1,0),AND(A{r}=OFFSET(A{r},-1,0),B{r}=OFFSET(B{r},-1,0)))"
    );
    ws.write_formula_with_format(ri, 9, j_formula.as_str(), fmt)
        .map_err(|e| format!("Formula J write error: {e}"))?;
    // K: =D{r}>=E{r}
    ws.write_formula_with_format(ri, 10, &*format!("=D{r}>=E{r}"), fmt)
        .map_err(|e| format!("Formula K write error: {e}"))?;

    Ok(())
}

/// Write a value into a cell, picking the best type.
fn write_value(ws: &mut Worksheet, row: u32, col: u16, val: &Value, fmt: &Format) {
    match val {
        Value::Null => {
            let _ = ws.write_blank(row, col, fmt);
        }
        Value::Bool(b) => {
            let _ = ws.write_boolean_with_format(row, col, *b, fmt);
        }
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                let _ = ws.write_number_with_format(row, col, f, fmt);
            }
        }
        Value::String(s) => {
            let _ = ws.write_string_with_format(row, col, s, fmt);
        }
        other => {
            let _ = ws.write_string_with_format(row, col, &other.to_string(), fmt);
        }
    }
}

/// Build a styled Strata sheet (either master or data).
///
/// * `rows`        : ordered rows to write (each row is a `StrataRow`-shaped object)
/// * `tbl_idx`     : numeric suffix for the table displayName (e.g. `Strata_0`)
/// * `data_sheet`  : `true` to use raw DB headers (Layer / Description),
///                   `false` for master labels (Primary Layer / Secondary Layer)
fn build_strata_sheet(
    workbook: &mut Workbook,
    sheet_name: &str,
    rows: &[StrataRow],
    tbl_idx: u32,
    data_sheet: bool,
) -> Result<(), String> {
    let headers: &[&str] = if data_sheet { DATA_HEADERS } else { MASTER_HEADERS };

    let body_font = Format::new()
        .set_font_name(FONT_NAME)
        .set_font_size(FONT_SIZE)
        .set_background_color(Color::RGB(DATA_FILL_RGB));
    let header_font = Format::new()
        .set_font_name(FONT_NAME)
        .set_font_size(FONT_SIZE)
        .set_bold()
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter);
    let header_wrap = Format::new()
        .set_font_name(FONT_NAME)
        .set_font_size(FONT_SIZE)
        .set_bold()
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::Bottom)
        .set_text_wrap();

    let ws = workbook.add_worksheet();
    ws.set_name(sheet_name)
        .map_err(|e| format!("Sheet name '{sheet_name}' error: {e}"))?;

    // ── Row 0: headers ────────────────────────────────────────────────────────
    let wrap_set: HashSet<u16> = WRAP_COLS.iter().copied().collect();
    for (ci, h) in headers.iter().enumerate() {
        let fmt = if wrap_set.contains(&(ci as u16)) {
            &header_wrap
        } else {
            &header_font
        };
        ws.write_string_with_format(0, ci as u16, *h, fmt)
            .map_err(|e| format!("Header write error: {e}"))?;
    }
    ws.set_row_height(0, 30.75)
        .map_err(|e| format!("Header row height error: {e}"))?;

    // ── Data rows ─────────────────────────────────────────────────────────────
    for (i, row) in rows.iter().enumerate() {
        let ri = (i + 1) as u32;

        write_row_data(ws, ri, row, &body_font);
        write_formula_cells(ws, ri, &body_font)?;
    }

    // ── Empty placeholder row 1 with formulas only (matches Python) ───────────
    if rows.is_empty() {
        write_formula_cells(ws, 1, &body_font)?;
    }

    // ── Excel Table ───────────────────────────────────────────────────────────
    let max_data_row = (rows.len() as u32).max(1); // at least 1 placeholder row
    let table_name = format!("Strata_{tbl_idx}");
    let table_cols: Vec<TableColumn> = headers
        .iter()
        .map(|h| TableColumn::new().set_header(*h))
        .collect();
    let table = Table::new()
        .set_columns(&table_cols)
        .set_style(TableStyle::Medium2)
        .set_name(&table_name);
    ws.add_table(0, 0, max_data_row, (headers.len() - 1) as u16, &table)
        .map_err(|e| format!("Table error: {e}"))?;

    // ── Conditional formatting: red row when any of I, J, K is TRUE ───────────
    let red_fmt = Format::new().set_background_color(Color::RGB(RED_FILL_RGB));
    let cond = ConditionalFormatFormula::new()
        .set_rule("=OR($I2,$J2,$K2)")
        .set_format(red_fmt);
    // Apply over the visible data area + placeholder.  Use a generous max row
    // so the rule keeps working when the table auto-extends in Excel.
    ws.add_conditional_format(1, 0, 1_048_575, 10, &cond)
        .map_err(|e| format!("Conditional formatting error: {e}"))?;

    // ── Column widths + freeze pane ───────────────────────────────────────────
    for (ci, w) in COL_WIDTHS.iter().enumerate() {
        ws.set_column_width(ci as u16, *w)
            .map_err(|e| format!("Column width error: {e}"))?;
    }
    ws.set_freeze_panes(1, 0)
        .map_err(|e| format!("Freeze pane error: {e}"))?;

    Ok(())
}

/// Write columns A–G of one data row.
fn write_row_data(ws: &mut Worksheet, ri: u32, row: &StrataRow, fmt: &Format) {
    // A — ProjectID
    if let Some(v) = &row.project_id {
        write_value(ws, ri, 0, v, fmt);
    } else {
        let _ = ws.write_blank(ri, 0, fmt);
    }
    // B — PointID
    if let Some(v) = &row.point_id {
        write_value(ws, ri, 1, v, fmt);
    } else {
        let _ = ws.write_blank(ri, 1, fmt);
    }
    // C — PointNo
    if let Some(v) = &row.point_no {
        write_value(ws, ri, 2, v, fmt);
    } else {
        let _ = ws.write_blank(ri, 2, fmt);
    }
    // D — From
    if let Some(f) = row.from {
        let _ = ws.write_number_with_format(ri, 3, f, fmt);
    } else {
        let _ = ws.write_blank(ri, 3, fmt);
    }
    // E — To
    if let Some(f) = row.to {
        let _ = ws.write_number_with_format(ri, 4, f, fmt);
    } else {
        let _ = ws.write_blank(ri, 4, fmt);
    }
    // F — Layer / Primary
    if let Some(s) = &row.layer {
        let _ = ws.write_string_with_format(ri, 5, s, fmt);
    } else {
        let _ = ws.write_blank(ri, 5, fmt);
    }
    // G — Description / Secondary
    if let Some(s) = &row.description {
        let _ = ws.write_string_with_format(ri, 6, s, fmt);
    } else {
        let _ = ws.write_blank(ri, 6, fmt);
    }
}

// ── Workbook-level operations (read & rewrite) ────────────────────────────────

/// Read master sheet rows into `StrataRow` objects (A–G only).
fn read_master_rows(path: &std::path::Path) -> Vec<StrataRow> {
    let mut out = Vec::new();
    let mut wb = match open_workbook_auto(path) {
        Ok(w) => w,
        Err(_) => return out,
    };
    let range = match wb.worksheet_range(MASTER_SHEET) {
        Ok(r) => r,
        Err(_) => return out,
    };

    for row in range.rows().skip(1) {
        let proj   = cell_to_string(row.first());
        let pt_id  = cell_to_string(row.get(1));
        let pt_no  = cell_to_string(row.get(2));
        let from_v = cell_to_f64(row.get(3));
        let to_v   = cell_to_f64(row.get(4));
        let layer  = cell_to_string(row.get(5));
        let desc   = cell_to_string(row.get(6));

        // Skip fully blank rows (e.g. the placeholder row in an empty table).
        if proj.is_none()
            && pt_id.is_none()
            && pt_no.is_none()
            && from_v.is_none()
            && to_v.is_none()
            && layer.is_none()
            && desc.is_none()
        {
            continue;
        }

        out.push(StrataRow {
            project_id:  proj.map(Value::String),
            point_id:    pt_id.map(Value::String),
            point_no:    pt_no.map(Value::String),
            from:        from_v,
            to:          to_v,
            layer,
            description: desc,
        });
    }

    out
}

fn cell_to_string(cell: Option<&Data>) -> Option<String> {
    cell.and_then(|c| match c {
        Data::String(s) if !s.is_empty() => Some(s.clone()),
        Data::Float(f)                    => Some(
            if f.fract() == 0.0 { format!("{}", *f as i64) } else { f.to_string() },
        ),
        Data::Int(i)                      => Some(i.to_string()),
        Data::Bool(b)                     => Some(b.to_string()),
        Data::DateTime(d)                 => Some(d.to_string()),
        _                                 => None,
    })
}

fn cell_to_f64(cell: Option<&Data>) -> Option<f64> {
    cell.and_then(|c| match c {
        Data::Float(f)    => Some(*f),
        Data::Int(i)      => Some(*i as f64),
        Data::String(s)   => s.parse::<f64>().ok(),
        Data::DateTime(d) => Some(d.as_f64()),
        _                 => None,
    })
}

/// Read all sheet names from an existing workbook.
fn read_sheet_names(path: &std::path::Path) -> Vec<String> {
    let wb = match open_workbook_auto(path) {
        Ok(w) => w,
        Err(_) => return Vec::new(),
    };
    wb.sheet_names().to_vec()
}

/// Read all rows from a non-master data sheet into `StrataRow`s.
fn read_data_sheet(path: &std::path::Path, sheet_name: &str) -> Vec<StrataRow> {
    let mut out = Vec::new();
    let mut wb = match open_workbook_auto(path) {
        Ok(w) => w,
        Err(_) => return out,
    };
    let range = match wb.worksheet_range(sheet_name) {
        Ok(r) => r,
        Err(_) => return out,
    };

    for row in range.rows().skip(1) {
        let proj   = cell_to_string(row.first());
        let pt_id  = cell_to_string(row.get(1));
        let pt_no  = cell_to_string(row.get(2));
        let from_v = cell_to_f64(row.get(3));
        let to_v   = cell_to_f64(row.get(4));
        let layer  = cell_to_string(row.get(5));
        let desc   = cell_to_string(row.get(6));

        if from_v.is_none() && to_v.is_none() && layer.is_none() {
            continue;
        }

        out.push(StrataRow {
            project_id:  proj.map(Value::String),
            point_id:    pt_id.map(Value::String),
            point_no:    pt_no.map(Value::String),
            from:        from_v,
            to:          to_v,
            layer,
            description: desc,
        });
    }
    out
}

/// Rebuild strata.xlsx with the given master rows and (optionally) keep any
/// existing data sheets.
fn rebuild_workbook(
    path: &std::path::Path,
    master_rows: &[StrataRow],
    preserve_data_sheets: bool,
) -> Result<(), String> {
    // Capture data sheets to preserve BEFORE we overwrite.
    let preserved: Vec<(String, Vec<StrataRow>)> = if preserve_data_sheets && path.exists() {
        read_sheet_names(path)
            .into_iter()
            .filter(|n| n != MASTER_SHEET)
            .map(|n| {
                let rows = read_data_sheet(path, &n);
                (n, rows)
            })
            .collect()
    } else {
        Vec::new()
    };

    let mut wb = Workbook::new();
    build_strata_sheet(&mut wb, MASTER_SHEET, master_rows, 0, false)?;

    for (idx, (sheet, rows)) in preserved.iter().enumerate() {
        build_strata_sheet(&mut wb, sheet, rows, (idx + 1) as u32, true)?;
    }

    wb.save(path)
        .map_err(|e| format!("Failed to save strata.xlsx: {e}"))
}

/// Add a single data sheet to an existing workbook (rebuild approach since
/// rust_xlsxwriter cannot edit-in-place).
fn add_data_sheets(
    path: &std::path::Path,
    new_sheets: &[(String, Vec<StrataRow>)],
) -> Result<(), String> {
    // Capture existing state.
    let master_rows = if path.exists() {
        read_master_rows(path)
    } else {
        Vec::new()
    };
    let existing_data: Vec<(String, Vec<StrataRow>)> = if path.exists() {
        read_sheet_names(path)
            .into_iter()
            .filter(|n| n != MASTER_SHEET)
            .map(|n| {
                let rows = read_data_sheet(path, &n);
                (n, rows)
            })
            .collect()
    } else {
        Vec::new()
    };

    // Build the new workbook: master + existing data + new data sheets.
    let mut wb = Workbook::new();
    build_strata_sheet(&mut wb, MASTER_SHEET, &master_rows, 0, false)?;

    let mut tbl_idx = 1u32;
    for (sheet, rows) in &existing_data {
        build_strata_sheet(&mut wb, sheet, rows, tbl_idx, true)?;
        tbl_idx += 1;
    }
    for (sheet, rows) in new_sheets {
        build_strata_sheet(&mut wb, sheet, rows, tbl_idx, true)?;
        tbl_idx += 1;
    }

    wb.save(path)
        .map_err(|e| format!("Failed to save strata.xlsx: {e}"))
}

/// Sanitise an arbitrary string into a valid Excel sheet name (max 31 chars,
/// no `\\/:*?"<>|[]`).
fn sheet_name_for(interpretation: &str, series: &str) -> String {
    let raw = format!("{interpretation}_{series}");
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '[' | ']') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim();
    trimmed.chars().take(31).collect()
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Create strata.xlsx with an empty Strata master sheet if it doesn't exist.
#[tauri::command]
pub async fn ensure_strata_file(
    #[allow(unused_variables)] project_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = strata_xlsx_path(&folder);

    if path.exists() {
        return Ok(json!({ "path": path.display().to_string(), "created": false }));
    }

    let path_clone = path.clone();
    tokio::task::spawn_blocking(move || rebuild_workbook(&path_clone, &[], false))
        .await
        .map_err(|e| format!("internal task error: {e}"))??;

    Ok(json!({ "path": path.display().to_string(), "created": true }))
}

/// Read rows from the Strata master sheet.
#[tauri::command]
pub async fn load_strata(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = strata_xlsx_path(&folder);
    if !path.exists() {
        return Err("strata.xlsx not found. Download strata data first.".into());
    }

    let rows = tokio::task::spawn_blocking(move || read_master_rows(&path))
        .await
        .map_err(|e| format!("internal task error: {e}"))?;

    Ok(rows
        .into_iter()
        .map(|r| {
            json!({
                "ProjectId":   r.project_id,
                "PointId":     r.point_id,
                "PointNo":     r.point_no,
                "From":        r.from,
                "To":          r.to,
                "Layer":       r.layer,
                "Description": r.description,
            })
        })
        .collect())
}

/// Write corrected rows back to the Strata master sheet.
#[tauri::command]
pub async fn update_strata(
    rows: Vec<StrataRow>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = strata_xlsx_path(&folder);

    let row_count = rows.len();
    let path_clone = path.clone();
    tokio::task::spawn_blocking(move || rebuild_workbook(&path_clone, &rows, true))
        .await
        .map_err(|e| format!("internal task error: {e}"))??;

    Ok(json!({
        "path": path.display().to_string(),
        "rows": row_count,
    }))
}

/// List available strata interpretation/series combinations.
///
/// Note: the frontend currently calls this with no body, but the SQL needs
/// project_ids to scope the query.  When `body` is absent (or has no project
/// ids), an empty list is returned to avoid an expensive unfiltered scan.
#[tauri::command]
pub async fn get_strata_types(
    body: Option<StrataRequest>,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    let req = body.unwrap_or(StrataRequest {
        project_ids: Vec::new(),
        point_ids: Vec::new(),
        selections: Vec::new(),
    });
    if req.project_ids.is_empty() {
        return Ok(Vec::new());
    }

    let cfg = state
        .db
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No database connection configured.".to_string())?;

    let project_ids_sql = ids_clause(&req.project_ids)?;
    let point_filter = point_filter_clause(&req.point_ids)?;

    // SQL override lookup (Settings → Query Config, issue #47); falls back to
    // the hardcoded `TYPES_SQL` template above.
    let qt     = current_query_type(&state);
    let folder = state.output_folder().unwrap_or_default();
    let template = lookup_sql(&folder, SECTION_STRATA_SERIES, &qt)
        .unwrap_or_else(|| TYPES_SQL.to_string());
    let sql = template
        .replace("{project_ids}", &project_ids_sql)
        .replace("{point_filter}", &point_filter);

    let rows = tokio::task::spawn_blocking(move || crate::db::query_rows(&cfg, &sql))
        .await
        .map_err(|e| format!("internal task error: {e}"))?
        .map_err(|e| format!("{e:#}"))?;

    Ok(rows)
}

/// Fetch layer rows for the selected strata types.
/// Result shape: `{ "<series>||<interpretation>": [rows...], ... }`
#[tauri::command]
pub async fn get_strata_data(
    body: StrataRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if body.selections.is_empty() {
        return Err("No strata types selected.".into());
    }

    let cfg = state
        .db
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No database connection configured.".to_string())?;

    let project_ids_sql = ids_clause(&body.project_ids)?;
    let point_filter = point_filter_clause(&body.point_ids)?;

    // SQL override lookup (issue #47) — pre-resolve once so each spawn_blocking
    // task uses the same template.
    let qt     = current_query_type(&state);
    let folder = state.output_folder().unwrap_or_default();
    let template = lookup_sql(&folder, SECTION_STRATA_DOWNLOAD, &qt)
        .unwrap_or_else(|| DATA_SQL.to_string());

    let cfg_clone = cfg.clone();
    let selections = body.selections;
    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Map<String, Value>, String> {
        let mut out = serde_json::Map::new();
        for sel in &selections {
            let sql = template
                .replace("{project_ids}", &project_ids_sql)
                .replace("{point_filter}", &point_filter)
                .replace("{series}", &safe_str(&sel.series))
                .replace("{interpretation}", &safe_str(&sel.interpretation));
            let rows =
                crate::db::query_rows(&cfg_clone, &sql).map_err(|e| format!("{e:#}"))?;
            let key = format!("{}||{}", sel.series, sel.interpretation);
            out.insert(key, Value::Array(rows));
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))??;

    Ok(Value::Object(result))
}

/// Add strata data sheets to the existing strata.xlsx.
/// Returns 409-equivalent error if any target sheet name already exists.
#[tauri::command]
pub async fn download_strata(
    body: StrataRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if body.selections.is_empty() {
        return Err("No strata types selected.".into());
    }
    let cfg = state
        .db
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No database connection configured.".to_string())?;
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = strata_xlsx_path(&folder);

    // Ensure file exists (with empty master).
    if !path.exists() {
        let path_init = path.clone();
        tokio::task::spawn_blocking(move || rebuild_workbook(&path_init, &[], false))
            .await
            .map_err(|e| format!("internal task error: {e}"))??;
    }

    let desired_names: Vec<String> = body
        .selections
        .iter()
        .map(|s| sheet_name_for(&s.interpretation, &s.series))
        .collect();

    // Check for collisions.
    let existing: HashSet<String> = read_sheet_names(&path).into_iter().collect();
    let conflicts: Vec<&String> = desired_names.iter().filter(|n| existing.contains(*n)).collect();
    if !conflicts.is_empty() {
        return Err(format!(
            "Sheet(s) already exist in strata.xlsx: {}. Delete them in Excel before downloading again.",
            conflicts
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    // Build SQL clauses on the main thread (cheap, validating).
    let project_ids_sql = ids_clause(&body.project_ids)?;
    let point_filter = point_filter_clause(&body.point_ids)?;

    // SQL override lookup (issue #47).
    let qt = current_query_type(&state);
    let template = lookup_sql(&folder, SECTION_STRATA_DOWNLOAD, &qt)
        .unwrap_or_else(|| DATA_SQL.to_string());

    // Fetch rows per selection, then add sheets.
    let path_clone = path.clone();
    let names_clone = desired_names.clone();
    let cfg_clone = cfg.clone();
    let selections = body.selections;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut new_sheets: Vec<(String, Vec<StrataRow>)> = Vec::with_capacity(selections.len());
        for (i, sel) in selections.iter().enumerate() {
            let sql = template
                .replace("{project_ids}", &project_ids_sql)
                .replace("{point_filter}", &point_filter)
                .replace("{series}", &safe_str(&sel.series))
                .replace("{interpretation}", &safe_str(&sel.interpretation));
            let rows_json =
                crate::db::query_rows(&cfg_clone, &sql).map_err(|e| format!("{e:#}"))?;
            let rows: Vec<StrataRow> = rows_json
                .into_iter()
                .filter_map(|v| serde_json::from_value::<StrataRow>(v).ok())
                .collect();
            new_sheets.push((names_clone[i].clone(), rows));
        }
        add_data_sheets(&path_clone, &new_sheets)
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))??;

    Ok(json!({ "path": path.display().to_string(), "sheets": desired_names }))
}

/// Transfer selected strata from the database into the Strata master sheet,
/// skipping any (ProjectId, PointId) borehole that already exists.
#[tauri::command]
pub async fn transfer_strata(
    body: StrataRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if body.selections.is_empty() {
        return Err("No strata types selected.".into());
    }
    let cfg = state
        .db
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No database connection configured.".to_string())?;
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = strata_xlsx_path(&folder);

    if !path.exists() {
        let path_init = path.clone();
        tokio::task::spawn_blocking(move || rebuild_workbook(&path_init, &[], false))
            .await
            .map_err(|e| format!("internal task error: {e}"))??;
    }

    let project_ids_sql = ids_clause(&body.project_ids)?;
    let point_filter = point_filter_clause(&body.point_ids)?;

    // SQL override lookup (issue #47).
    let qt = current_query_type(&state);
    let template = lookup_sql(&folder, SECTION_STRATA_DOWNLOAD, &qt)
        .unwrap_or_else(|| DATA_SQL.to_string());

    let path_clone = path.clone();
    let cfg_clone = cfg.clone();
    let selections = body.selections;
    let (transferred, skipped, total) = tokio::task::spawn_blocking(
        move || -> Result<(usize, usize, usize), String> {
            // Read existing master rows + (proj, pt) pairs.
            let existing = read_master_rows(&path_clone);
            let pairs: HashSet<(String, String)> = existing
                .iter()
                .map(|r| {
                    (
                        value_to_str(&r.project_id),
                        value_to_str(&r.point_id),
                    )
                })
                .collect();

            // Fetch all new rows.
            let mut new_rows: Vec<StrataRow> = Vec::new();
            for sel in &selections {
                let sql = template
                    .replace("{project_ids}", &project_ids_sql)
                    .replace("{point_filter}", &point_filter)
                    .replace("{series}", &safe_str(&sel.series))
                    .replace("{interpretation}", &safe_str(&sel.interpretation));
                let rows_json =
                    crate::db::query_rows(&cfg_clone, &sql).map_err(|e| format!("{e:#}"))?;
                for v in rows_json {
                    if let Ok(r) = serde_json::from_value::<StrataRow>(v) {
                        new_rows.push(r);
                    }
                }
            }
            let new_count = new_rows.len();

            // Filter: skip rows whose borehole already exists.
            let filtered: Vec<StrataRow> = new_rows
                .into_iter()
                .filter(|r| {
                    let key = (
                        value_to_str(&r.project_id),
                        value_to_str(&r.point_id),
                    );
                    !pairs.contains(&key)
                })
                .collect();

            let mut combined: Vec<StrataRow> = existing;
            combined.extend(filtered.iter().cloned());

            let total = combined.len();
            let transferred = filtered.len();
            let skipped = new_count - transferred;

            rebuild_workbook(&path_clone, &combined, true)?;

            Ok((transferred, skipped, total))
        },
    )
    .await
    .map_err(|e| format!("internal task error: {e}"))??;

    Ok(json!({
        "path":        path.display().to_string(),
        "transferred": transferred,
        "skipped":     skipped,
        "total":       total,
    }))
}

fn value_to_str(v: &Option<Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b))   => b.to_string(),
        _                      => String::new(),
    }
}

/// Open strata.xlsx in the OS default application.
#[tauri::command]
pub async fn open_strata(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = strata_xlsx_path(&folder);
    if !path.exists() {
        return Err("strata.xlsx not found.".into());
    }
    app.opener()
        .open_path(path.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| format!("Failed to open strata.xlsx: {e}"))
}

/// Return sorted unique Primary Layer / Secondary Layer values from the master.
#[tauri::command]
pub async fn get_strata_layers(state: State<'_, AppState>) -> Result<Value, String> {
    let folder = match state.output_folder() {
        Some(f) => f,
        None    => return Ok(json!({ "primary": [], "secondary": [] })),
    };
    let path = strata_xlsx_path(&folder);
    if !path.exists() {
        return Ok(json!({ "primary": [], "secondary": [] }));
    }

    let rows = tokio::task::spawn_blocking(move || read_master_rows(&path))
        .await
        .map_err(|e| format!("internal task error: {e}"))?;

    let mut primary: HashSet<String> = HashSet::new();
    let mut secondary: HashSet<String> = HashSet::new();
    for r in rows {
        if let Some(s) = r.layer.filter(|s| !s.is_empty()) {
            primary.insert(s);
        }
        if let Some(s) = r.description.filter(|s| !s.is_empty()) {
            secondary.insert(s);
        }
    }
    let mut pri: Vec<String> = primary.into_iter().collect();
    let mut sec: Vec<String> = secondary.into_iter().collect();
    pri.sort();
    sec.sort();

    Ok(json!({ "primary": pri, "secondary": sec }))
}

/// Return per-point layer membership from the master sheet.
/// Shape: `{ point_layers: { pointId: { primary: [], secondary: [] } } }`.
#[tauri::command]
pub async fn get_strata_point_layers(state: State<'_, AppState>) -> Result<Value, String> {
    let folder = match state.output_folder() {
        Some(f) => f,
        None    => return Ok(json!({ "point_layers": {} })),
    };
    let path = strata_xlsx_path(&folder);
    if !path.exists() {
        return Ok(json!({ "point_layers": {} }));
    }

    let rows = tokio::task::spawn_blocking(move || read_master_rows(&path))
        .await
        .map_err(|e| format!("internal task error: {e}"))?;

    let mut map: HashMap<String, (Vec<String>, Vec<String>)> = HashMap::new();
    for r in rows {
        let pid = match r.point_id.as_ref().and_then(|v| v.as_str()).map(String::from) {
            Some(p) if !p.is_empty() => p,
            _                        => continue,
        };
        let entry = map.entry(pid).or_insert_with(|| (Vec::new(), Vec::new()));
        if let Some(s) = r.layer.filter(|s| !s.is_empty()) {
            if !entry.0.contains(&s) {
                entry.0.push(s);
            }
        }
        if let Some(s) = r.description.filter(|s| !s.is_empty()) {
            if !entry.1.contains(&s) {
                entry.1.push(s);
            }
        }
    }

    let mut out = serde_json::Map::new();
    for (pid, (pri, sec)) in map {
        out.insert(pid, json!({ "primary": pri, "secondary": sec }));
    }

    Ok(json!({ "point_layers": Value::Object(out) }))
}
