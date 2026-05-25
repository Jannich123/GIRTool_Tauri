// Chart command implementations — mirrors backend/routers/charts.py.
//
// Storage layout (all under {output_folder}/):
//   {projectId}_chart_config.json  — per-project chart panel configuration
//   statistics.xlsx                — shared statistics workbook
//                                    (one sheet per chart; matches Python)
//
// Commands:
//   get_chart_config(project_id)          → Value (stored config or {})
//   save_chart_config(project_id, config) → ()
//   run_chart_query(project_id, query)    → { columns, rows, truncated }
//                                            rows include injected strata,
//                                            group, and formula columns
//                                            (see download.rs helpers)
//   save_statistics(project_id, stats)    → { saved, sheets, preserved }
//   open_statistics(project_id, stats)    → ()   (save then open)
//   open_datasheet(path)                  → ()   (open existing xlsx in OS)

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use calamine::{open_workbook_auto, Data, Reader};
use rust_xlsxwriter::{
    Color, Format, FormatAlign, Table, TableColumn, TableStyle, Workbook, Worksheet,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::commands::download::{
    apply_group_columns, apply_strata_columns, columnar_to_objects, load_strata_lookup,
    merge_formula_columns, objects_to_columnar,
};
use crate::state::AppState;

// ── Paths ─────────────────────────────────────────────────────────────────────

fn chart_config_path(output_folder: &str, project_id: &str) -> PathBuf {
    PathBuf::from(output_folder).join(format!("{project_id}_chart_config.json"))
}

/// Statistics workbook is shared across projects — plain `statistics.xlsx`,
/// matching Python `backend/routers/charts.py:154`.  (The previous
/// `{projectId}_statistics.xlsx` form broke cross-version compatibility.)
fn statistics_path(output_folder: &str) -> PathBuf {
    PathBuf::from(output_folder).join("statistics.xlsx")
}

// ── _STAT_HEADERS region constants (match Python) ─────────────────────────────

const STAT_HEADERS: &[&str] = &[
    "Group", "N", "Min", "Max", "Mean", "Std Dev", "Median", "P10", "P90",
];

/// Header fill colour — dark navy `#1A3A5C`, matching Python.
const HEADER_FILL_RGB: u32 = 0x1A_3A_5C;

const STAT_COL_WIDTHS: [f64; 9] = [28.0, 8.0, 12.0, 12.0, 12.0, 12.0, 12.0, 12.0, 12.0];

// ── get_chart_config / save_chart_config ──────────────────────────────────────

#[tauri::command]
pub async fn get_chart_config(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = chart_config_path(&folder, &project_id);
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("Parse error: {e}")),
        Err(_) => Ok(json!({})),
    }
}

#[tauri::command]
pub async fn save_chart_config(
    project_id: String,
    config: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = chart_config_path(&folder, &project_id);
    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Serialise error: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Write error: {e}"))
}

// ── run_chart_query ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ChartQuery {
    pub project_ids: Vec<String>,
    #[serde(default)]
    pub point_ids: Vec<String>,
    pub query_name: String,
}

/// Sanitise a single ID for interpolation into a SQL IN clause.
/// Accepts GUIDs (8-4-4-4-12 hex) or bare integers only.
fn sanitise_id(raw: &str) -> Result<String, String> {
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
        Err(format!("Invalid project/point ID: {s}"))
    }
}

fn safe_id_list(ids: &[String]) -> Result<String, String> {
    ids.iter()
        .map(|id| sanitise_id(id))
        .collect::<Result<Vec<_>, _>>()
        .map(|v| v.join(", "))
}

/// Build the SQL for a named query by substituting `#projectid#`, `#pointid#`,
/// and `#DB#` placeholders.  Returns the full SQL string ready to execute.
fn build_chart_sql(
    state: &AppState,
    query_name: &str,
    project_ids: &[String],
    point_ids: &[String],
) -> Result<String, String> {
    let queries = crate::commands::queries::load_queries(state);
    let q = queries
        .iter()
        .find(|q| q.fname == query_name)
        .ok_or_else(|| format!("Unknown query: {query_name}"))?;

    let proj_str = safe_id_list(project_ids)?;
    let point_filter = if point_ids.is_empty() {
        String::new()
    } else {
        let pts_str = safe_id_list(point_ids)?;
        format!("AND {}", q.pointfilter.replace("#pointid#", &pts_str))
    };

    let sql = q
        .sql_script
        .replace("#DB#", "")
        .replace("#projectid#", &proj_str)
        .replace("#pointfilter#", &point_filter);

    Ok(sql)
}

const MAX_CHART_ROWS: usize = 10_000;

/// Run a named query and return columnar data: { columns, rows, truncated }.
///
/// After the SQL rows come back, this command injects:
///   1. Strata columns  (`Primary Layer`, `Secondary Layer`) — always, whenever
///      strata data is available, so the "Group by Primary Layer" UI has a
///      column to key on (matches Python `charts.py:74-81`).
///   2. Group-system columns from `Grouping.xlsx`, one per system, matched by
///      `PointId` (`apply_group_columns`).
///   3. Extra user-added columns from `{output_folder}/Datasheets/{query}.xlsx`
///      if present (`merge_formula_columns`).
///
/// `rows` is returned as an array of row-objects keyed by column name so the
/// frontend can index into them directly.
#[tauri::command]
pub async fn run_chart_query(
    project_id: String,
    query: ChartQuery,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if query.project_ids.is_empty() {
        return Ok(json!({ "columns": [], "rows": [], "truncated": false }));
    }

    let cfg = state
        .db
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No database connection configured.".to_string())?;

    let sql = build_chart_sql(&state, &query.query_name, &query.project_ids, &query.point_ids)?;

    let raw_rows = tokio::task::spawn_blocking(move || crate::db::query_rows(&cfg, &sql))
        .await
        .map_err(|e| format!("internal task error: {e}"))?
        .map_err(|e| format!("{e:#}"))?;

    let truncated = raw_rows.len() > MAX_CHART_ROWS;
    let raw_rows: Vec<Value> = raw_rows.into_iter().take(MAX_CHART_ROWS).collect();

    // Convert object-rows to positional rows for the helper functions.
    let (mut columns, mut rows) = objects_to_columnar(raw_rows);

    // Apply the same column injections download_data does.  Skip silently if
    // the output folder is missing (charts can still render the raw SQL data).
    let query_name = query.query_name.clone();
    let folder_opt = state.output_folder();
    if let Some(folder) = folder_opt {
        let (cols_out, rows_out) = tokio::task::spawn_blocking(move || {
            // 1. Strata first (matches Python order).
            let lookup = load_strata_lookup(&folder, &project_id);
            if !lookup.is_empty() {
                apply_strata_columns(&mut columns, &mut rows, &lookup);
            }
            // 2. Group columns.
            apply_group_columns(&folder, &mut columns, &mut rows);
            // 3. User-added formula columns from the saved datasheet xlsx.
            merge_formula_columns(&folder, &query_name, &mut columns, &mut rows);
            (columns, rows)
        })
        .await
        .map_err(|e| format!("internal task error: {e}"))?;

        columns = cols_out;
        rows = rows_out;
    }

    // Convert back to row-objects for the frontend.
    let rows_obj = columnar_to_objects(&columns, rows);

    Ok(json!({
        "columns":   columns,
        "rows":      rows_obj,
        "truncated": truncated,
    }))
}

// ── save_statistics / open_statistics ─────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct StatRow {
    #[serde(default)]
    group:  String,
    #[serde(default)]
    n:      u64,
    #[serde(default)]
    min:    Option<f64>,
    #[serde(default)]
    max:    Option<f64>,
    #[serde(default)]
    mean:   Option<f64>,
    #[serde(default)]
    std:    Option<f64>,
    #[serde(default)]
    median: Option<f64>,
    #[serde(default)]
    p10:    Option<f64>,
    #[serde(default)]
    p90:    Option<f64>,
}

#[derive(Debug, Deserialize)]
struct ChartStats {
    name: String,
    #[serde(default)]
    axis_col: String,
    #[serde(default)]
    stats: Vec<StatRow>,
}

/// Sanitise a string for use as an Excel sheet name (max 31 chars,
/// excluding `\\/:*?"<>|[]`).  Falls back to `"Sheet"` if empty.
fn sanitize_sheet_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '[' | ']') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim();
    let truncated: String = cleaned.chars().take(31).collect();
    if truncated.is_empty() {
        "Sheet".to_string()
    } else {
        truncated
    }
}

/// Sanitise a chart name into an Excel table displayName suffix:
/// non-word characters become underscores, truncated to 36 chars.
fn sanitize_table_name(name: &str) -> String {
    let s: String = name
        .chars()
        .take(36)
        .map(|c| if c.is_alphanumeric() || c == '_' { c } else { '_' })
        .collect();
    if s.is_empty() { "stat".to_string() } else { s }
}

/// Round a numeric value to `dp` decimal places.
fn round_dp(v: f64, dp: i32) -> f64 {
    let factor = 10_f64.powi(dp);
    (v * factor).round() / factor
}

// ── Preserved-cells reader ────────────────────────────────────────────────────

/// A cell preserved from a previous statistics.xlsx.
#[derive(Debug, Clone)]
struct PreservedCell {
    row: u32,
    col: u16,
    /// Either a literal value (computed from a formula) or a formula string
    /// (starts with `=`).  We re-emit formulas as formulas so they survive
    /// the next round-trip; values are re-emitted as plain cells.
    payload: PreservedPayload,
}

#[derive(Debug, Clone)]
enum PreservedPayload {
    Formula(String),
    String(String),
    Number(f64),
    Bool(bool),
}

/// Read user-added cells (formulas + extra columns/rows) from an existing
/// statistics.xlsx so they can be re-emitted after the stats block is rewritten.
///
/// For each sheet, captures cells matching ANY of:
///   * column index >= 9 (beyond the 9 `_STAT_HEADERS` columns)
///   * row index 0 (the axis label row) where the user may have added notes
///   * any cell containing a formula
///
/// Cells inside the canonical stat block (rows 1+, cols 0-8) that are NOT
/// formulas will be overwritten by the new stat data.
///
/// `sheets_in_payload` is the set of sheet names the new payload will write;
/// sheets NOT in this set are captured in full so they can be copied verbatim.
fn read_preserved_cells(
    path: &Path,
    sheets_in_payload: &HashSet<String>,
) -> HashMap<String, Vec<PreservedCell>> {
    let mut out: HashMap<String, Vec<PreservedCell>> = HashMap::new();

    let mut wb = match open_workbook_auto(path) {
        Ok(w) => w,
        Err(_) => return out,
    };

    let sheet_names: Vec<String> = wb.sheet_names().to_vec();

    for sheet in sheet_names {
        let values = match wb.worksheet_range(&sheet) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let formulas = wb.worksheet_formula(&sheet).ok();

        let copy_entire_sheet = !sheets_in_payload.contains(&sheet);
        let mut cells: Vec<PreservedCell> = Vec::new();

        for (ri, row) in values.rows().enumerate() {
            for (ci, cell) in row.iter().enumerate() {
                // Decide whether to preserve this cell.
                let is_formula = formulas
                    .as_ref()
                    .and_then(|f| f.get((ri, ci)))
                    .map(|f| !f.is_empty())
                    .unwrap_or(false);

                let beyond_headers = ci >= STAT_HEADERS.len();
                let in_axis_row = ri == 0;
                let keep = copy_entire_sheet
                    || is_formula
                    || beyond_headers
                    || in_axis_row;

                if !keep {
                    continue;
                }

                let payload = if is_formula {
                    let formula = formulas
                        .as_ref()
                        .and_then(|f| f.get((ri, ci)))
                        .map(|s| s.clone())
                        .unwrap_or_default();
                    if formula.is_empty() {
                        continue;
                    }
                    let with_eq = if formula.starts_with('=') {
                        formula
                    } else {
                        format!("={formula}")
                    };
                    PreservedPayload::Formula(with_eq)
                } else {
                    match cell {
                        Data::String(s) if !s.is_empty() => PreservedPayload::String(s.clone()),
                        Data::Float(f)                   => PreservedPayload::Number(*f),
                        Data::Int(i)                     => PreservedPayload::Number(*i as f64),
                        Data::Bool(b)                    => PreservedPayload::Bool(*b),
                        Data::DateTime(d)                => PreservedPayload::Number(d.as_f64()),
                        _                                => continue,
                    }
                };

                cells.push(PreservedCell {
                    row: ri as u32,
                    col: ci as u16,
                    payload,
                });
            }
        }

        if !cells.is_empty() {
            out.insert(sheet, cells);
        }
    }

    out
}

/// Write one preserved cell to the worksheet.
fn write_preserved_cell(ws: &mut Worksheet, cell: &PreservedCell) -> Result<(), String> {
    match &cell.payload {
        PreservedPayload::Formula(f) => {
            ws.write_formula(cell.row, cell.col, f.as_str())
                .map_err(|e| format!("Failed to write formula: {e}"))?;
        }
        PreservedPayload::String(s) => {
            ws.write_string(cell.row, cell.col, s)
                .map_err(|e| format!("Failed to write string: {e}"))?;
        }
        PreservedPayload::Number(n) => {
            ws.write_number(cell.row, cell.col, *n)
                .map_err(|e| format!("Failed to write number: {e}"))?;
        }
        PreservedPayload::Bool(b) => {
            ws.write_boolean(cell.row, cell.col, *b)
                .map_err(|e| format!("Failed to write boolean: {e}"))?;
        }
    }
    Ok(())
}

// ── Statistics-sheet writer ───────────────────────────────────────────────────

/// Write a single chart's stat block into a worksheet.
/// Layout:
///   Row 0 : `Axis: {axis_col}`        — italic grey (#666666)
///   Row 1 : STAT_HEADERS              — bold white on dark navy (#1A3A5C)
///   Rows 2+: data rows                — group, n, min, max, mean, std, median, p10, p90
///   Freeze pane at A3 (row 2, col 0)
///   Excel Table over A2:I{N+2}, TableStyleMedium2
///   Column widths matching Python
fn write_chart_sheet(
    workbook: &mut Workbook,
    sheet_name: &str,
    chart: &ChartStats,
    preserved: Option<&Vec<PreservedCell>>,
) -> Result<(), String> {
    let ws = workbook.add_worksheet();
    ws.set_name(sheet_name)
        .map_err(|e| format!("Sheet name error: {e}"))?;

    let axis_fmt = Format::new()
        .set_italic()
        .set_font_color(Color::RGB(0x66_66_66))
        .set_font_name("Calibri")
        .set_font_size(9);
    let header_fmt = Format::new()
        .set_bold()
        .set_font_color(Color::White)
        .set_background_color(Color::RGB(HEADER_FILL_RGB))
        .set_font_name("Calibri")
        .set_font_size(10)
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter);
    let plain_fmt = Format::new().set_font_name("Calibri").set_font_size(10);

    // ── Row 0: axis label ─────────────────────────────────────────────────────
    let axis_label = if chart.axis_col.is_empty() {
        "Statistics".to_string()
    } else {
        format!("Axis: {}", chart.axis_col)
    };
    ws.write_string_with_format(0, 0, &axis_label, &axis_fmt)
        .map_err(|e| format!("Axis label write error: {e}"))?;
    ws.set_row_height(0, 14.0)
        .map_err(|e| format!("Row height error: {e}"))?;

    // ── Row 1: headers ────────────────────────────────────────────────────────
    for (j, h) in STAT_HEADERS.iter().enumerate() {
        ws.write_string_with_format(1, j as u16, *h, &header_fmt)
            .map_err(|e| format!("Header write error: {e}"))?;
    }
    ws.set_row_height(1, 18.0)
        .map_err(|e| format!("Row height error: {e}"))?;

    // ── Rows 2+: data ─────────────────────────────────────────────────────────
    // Skip cells that will be overwritten by preserved formulas (matches
    // Python "if cell.value starts with '=' continue").
    let formula_mask: HashSet<(u32, u16)> = preserved
        .map(|cells| {
            cells
                .iter()
                .filter(|c| matches!(c.payload, PreservedPayload::Formula(_)))
                .map(|c| (c.row, c.col))
                .collect()
        })
        .unwrap_or_default();

    for (i, stat) in chart.stats.iter().enumerate() {
        let row_idx = (i + 2) as u32;
        let group_label = if stat.group == "__all__" { "All" } else { &stat.group };
        let values: [Option<f64>; 7] = [
            stat.min, stat.max, stat.mean, stat.std, stat.median, stat.p10, stat.p90,
        ];

        // Column 0: group label (string)
        if !formula_mask.contains(&(row_idx, 0)) {
            ws.write_string_with_format(row_idx, 0, group_label, &plain_fmt)
                .map_err(|e| format!("Cell write error: {e}"))?;
        }
        // Column 1: N (integer)
        if !formula_mask.contains(&(row_idx, 1)) {
            ws.write_number_with_format(row_idx, 1, stat.n as f64, &plain_fmt)
                .map_err(|e| format!("Cell write error: {e}"))?;
        }
        // Columns 2..8: numeric stats, rounded to 4dp
        for (k, val) in values.iter().enumerate() {
            let col = (k + 2) as u16;
            if formula_mask.contains(&(row_idx, col)) {
                continue;
            }
            match val {
                Some(v) => {
                    ws.write_number_with_format(row_idx, col, round_dp(*v, 4), &plain_fmt)
                        .map_err(|e| format!("Cell write error: {e}"))?;
                }
                None => {
                    // Leave blank (matches Python writing None).
                }
            }
        }
    }

    // ── Excel table over A2:I{N+2}, TableStyleMedium2 ─────────────────────────
    if !chart.stats.is_empty() {
        let last_row = (chart.stats.len() + 1) as u32; // header row 1 + N data rows
        let table_cols: Vec<TableColumn> = STAT_HEADERS
            .iter()
            .map(|h| TableColumn::new().set_header(*h))
            .collect();
        let table_name = format!("T_{}", sanitize_table_name(&chart.name));
        let table = Table::new()
            .set_columns(&table_cols)
            .set_style(TableStyle::Medium2)
            .set_name(&table_name);
        ws.add_table(1, 0, last_row, (STAT_HEADERS.len() - 1) as u16, &table)
            .map_err(|e| format!("Table error: {e}"))?;
    }

    // ── Freeze pane at A3 (row index 2) ───────────────────────────────────────
    ws.set_freeze_panes(2, 0)
        .map_err(|e| format!("Freeze pane error: {e}"))?;

    // ── Column widths ─────────────────────────────────────────────────────────
    for (i, w) in STAT_COL_WIDTHS.iter().enumerate() {
        ws.set_column_width(i as u16, *w)
            .map_err(|e| format!("Column width error: {e}"))?;
    }

    // ── Re-emit preserved cells (last so they win against the stat block) ─────
    if let Some(cells) = preserved {
        for cell in cells {
            // Skip cells we've already written (header row 1 inside cols 0..8
            // would clash; preserved formulas there are already protected via
            // formula_mask, but plain text the user pasted into the header row
            // would over-write our header — so skip headers explicitly).
            if cell.row == 1 && (cell.col as usize) < STAT_HEADERS.len() {
                continue;
            }
            write_preserved_cell(ws, cell)?;
        }
    }

    Ok(())
}

/// Write a "verbatim" sheet that wasn't referenced in the new payload.
/// All preserved cells are dumped back in their original positions.
fn write_verbatim_sheet(
    workbook: &mut Workbook,
    sheet_name: &str,
    cells: &[PreservedCell],
) -> Result<(), String> {
    let ws = workbook.add_worksheet();
    ws.set_name(sheet_name)
        .map_err(|e| format!("Sheet name error: {e}"))?;

    for cell in cells {
        write_preserved_cell(ws, cell)?;
    }
    Ok(())
}

/// Write the full statistics.xlsx workbook.
fn write_statistics_workbook(
    path: &Path,
    charts: &[ChartStats],
) -> Result<usize, String> {
    // ── 1. Capture preserved cells from existing workbook (if any) ────────────
    let payload_sheets: HashSet<String> = charts
        .iter()
        .map(|c| sanitize_sheet_name(&c.name))
        .collect();
    let preserved = if path.exists() {
        read_preserved_cells(path, &payload_sheets)
    } else {
        HashMap::new()
    };

    let mut workbook = Workbook::new();
    let mut written = 0usize;
    let mut used_names: HashSet<String> = HashSet::new();

    // ── 2. Write one sheet per chart in the new payload ───────────────────────
    for chart in charts {
        let base = sanitize_sheet_name(&chart.name);
        let mut name = base.clone();
        let mut n = 1u32;
        while used_names.contains(&name) {
            let suffix = format!("_{n}");
            let cut: usize = 31usize.saturating_sub(suffix.len());
            let trimmed: String = base.chars().take(cut).collect();
            name = format!("{trimmed}{suffix}");
            n += 1;
        }
        used_names.insert(name.clone());

        let prev = preserved.get(&base);
        write_chart_sheet(&mut workbook, &name, chart, prev)?;
        written += 1;
    }

    // ── 3. Copy verbatim any preserved sheets NOT in the new payload ──────────
    for (sheet_name, cells) in &preserved {
        if payload_sheets.contains(sheet_name) {
            continue; // already handled above
        }
        if used_names.contains(sheet_name) {
            continue; // name collision; skip
        }
        write_verbatim_sheet(&mut workbook, sheet_name, cells)?;
        used_names.insert(sheet_name.clone());
        written += 1;
    }

    // ── 4. Ensure workbook has at least one sheet ─────────────────────────────
    if written == 0 {
        let ws = workbook.add_worksheet();
        let _ = ws.set_name("Statistics");
        let _ = ws.write_string(0, 0, "No chart data to summarise.");
    }

    workbook
        .save(path)
        .map_err(|e| format!("Failed to save xlsx: {e}"))?;
    Ok(written)
}

/// Persist statistics charts to `statistics.xlsx`.
///
/// Payload shape (matches Python):
/// ```json
/// {
///   "charts": [
///     {
///       "name":     "Chart 1",
///       "axis_col": "Depth",
///       "stats": [
///         { "group": "Sand", "n": 12, "min": 0.1, "max": 5.3,
///           "mean": 2.5, "std": 1.1, "median": 2.4,
///           "p10": 0.6, "p90": 4.8 }
///       ]
///     }
///   ]
/// }
/// ```
#[tauri::command]
pub async fn save_statistics(
    _project_id: String,
    stats: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let folder = match state.output_folder() {
        Some(f) => f,
        None => return Ok(json!({ "skipped": true, "reason": "No output folder configured" })),
    };
    let path = statistics_path(&folder);

    let charts: Vec<ChartStats> = serde_json::from_value(
        stats.get("charts").cloned().unwrap_or_else(|| json!([])),
    )
    .map_err(|e| format!("Invalid stats payload: {e}"))?;

    let path_str = path.display().to_string();
    let written = tokio::task::spawn_blocking(move || write_statistics_workbook(&path, &charts))
        .await
        .map_err(|e| format!("internal task error: {e}"))??;

    Ok(json!({
        "saved":  path_str,
        "sheets": written,
    }))
}

/// Save statistics to xlsx then open it in the default application.
#[tauri::command]
pub async fn open_statistics(
    _project_id: String,
    stats: Value,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = statistics_path(&folder);

    let charts: Vec<ChartStats> = serde_json::from_value(
        stats.get("charts").cloned().unwrap_or_else(|| json!([])),
    )
    .map_err(|e| format!("Invalid stats payload: {e}"))?;

    let path_clone = path.clone();
    tokio::task::spawn_blocking(move || write_statistics_workbook(&path_clone, &charts))
        .await
        .map_err(|e| format!("internal task error: {e}"))??;

    app.opener()
        .open_path(path.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| format!("Failed to open statistics file: {e}"))
}

// ── open_datasheet ────────────────────────────────────────────────────────────

/// Open an existing xlsx datasheet in the OS default application.
///
/// `path` is either:
///   • A full file-system path — used as-is.
///   • A bare query name (no path separators, e.g. `"WaterLevels"`) —
///     resolved in priority order matching Python `download.py`:
///       1. `{output_folder}/Datasheets/{name}.xlsx`
///       2. `{output_folder}/{name}.xlsx`
#[tauri::command]
pub async fn open_datasheet(
    path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let resolved: PathBuf = if path.contains(std::path::MAIN_SEPARATOR) || path.contains('/') {
        PathBuf::from(&path)
    } else {
        let folder = state.output_folder().ok_or("No output folder configured.")?;
        let primary = PathBuf::from(&folder)
            .join("Datasheets")
            .join(format!("{path}.xlsx"));
        if primary.exists() {
            primary
        } else {
            PathBuf::from(&folder).join(format!("{path}.xlsx"))
        }
    };

    if !resolved.exists() {
        return Err(format!("Datasheet not found: {}", resolved.display()));
    }

    app.opener()
        .open_path(resolved.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| format!("Failed to open datasheet: {e}"))
}
