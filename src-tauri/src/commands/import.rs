// Data import wizard (issue #278): bring CSV / Excel files (or a folder of
// them) into an existing or new datasheet under {output}/Datasheets/.
//
// Flow (frontend Data → Import tab):
//   1. pick_import_path  — native file/folder dialog
//   2. import_preview    — list matched files + a grid of the first file
//   3. import_data       — append mapped rows to the target datasheet,
//                          DB = "imported", and upsert points.xlsx
//
// Points policy (per the issue): a PointNo not present in points.xlsx is
// inserted with db_id/ProjectId "imported"; an existing PointNo only gets its
// MISSING fields (X1/Y1/Z1/Projection1) filled — never overwritten.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use calamine::{open_workbook_auto, Data, Reader};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::state::AppState;

use super::download::{
    datasheets_dir, parse_number_locale, persist_datasheet_meta, read_existing_datasheet,
    write_datasheet, write_datasheet_cache, FormulaMap,
};
use super::points_xlsx::{
    points_xlsx_path, read_rows as read_points_rows, write_workbook as write_points_workbook,
    SelectedPoint,
};

// ── File discovery ────────────────────────────────────────────────────────────

const IMPORT_EXTS: &[&str] = &["csv", "txt", "xlsx", "xlsm", "xls"];

fn file_ext(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// A file path → itself; a folder → every CSV/Excel file inside (sorted,
/// Excel lock files `~$…` skipped).  Errors on empty folders so the user
/// gets feedback instead of a silent no-op import.
fn resolve_files(path: &str) -> Result<Vec<PathBuf>, String> {
    let p = PathBuf::from(path);
    if p.is_file() {
        return Ok(vec![p]);
    }
    if !p.is_dir() {
        return Err(format!("Path not found: {path}"));
    }
    let mut files: Vec<PathBuf> = std::fs::read_dir(&p)
        .map_err(|e| format!("Cannot read folder: {e}"))?
        .flatten()
        .map(|ent| ent.path())
        .filter(|f| {
            f.is_file()
                && IMPORT_EXTS.contains(&file_ext(f).as_str())
                && !f
                    .file_name()
                    .map(|n| n.to_string_lossy().starts_with("~$"))
                    .unwrap_or(false)
        })
        .collect();
    files.sort();
    if files.is_empty() {
        return Err("No CSV or Excel files found in that folder.".into());
    }
    Ok(files)
}

// ── Parsing (mirrors map_addons.rs: UTF-8 → Windows-1252, sniffed delimiter) ──

fn decode_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned(),
    }
}

fn detect_delimiter(text: &str) -> u8 {
    let first = text.lines().next().unwrap_or("");
    let count = |c: char| first.matches(c).count();
    let (semi, comma, tab) = (count(';'), count(','), count('\t'));
    if semi >= comma && semi >= tab && semi > 0 {
        b';'
    } else if tab > comma && tab > 0 {
        b'\t'
    } else {
        b','
    }
}

/// CSV cell → JSON value.  Whole-string numbers become numbers (Danish comma
/// decimals included) EXCEPT leading-zero identifiers like "007", which stay
/// strings so PointNos survive round-trips.
fn csv_value(s: &str) -> Value {
    let t = s.trim();
    if t.is_empty() {
        return Value::Null;
    }
    let keeps_leading_zero =
        t.len() > 1 && t.starts_with('0') && !t.starts_with("0.") && !t.starts_with("0,");
    if !keeps_leading_zero {
        if let Some(n) = parse_number_locale(t) {
            if let Some(num) = serde_json::Number::from_f64(n) {
                return Value::Number(num);
            }
        }
    }
    Value::String(t.to_string())
}

fn xlsx_value(cell: &Data) -> Value {
    match cell {
        Data::Empty => Value::Null,
        Data::Int(i) => json!(i),
        Data::Float(f) => json!(f),
        Data::Bool(b) => json!(b),
        Data::DateTime(dt) => dt
            .as_datetime()
            .map(|d| Value::String(d.to_string()))
            .unwrap_or_else(|| json!(dt.as_f64())),
        other => {
            let s = other.to_string();
            let t = s.trim();
            if t.is_empty() {
                Value::Null
            } else {
                Value::String(t.to_string())
            }
        }
    }
}

/// Read a whole file as a value grid: CSV via the sniffing reader, Excel via
/// calamine (first worksheet).
fn read_grid(path: &Path) -> Result<Vec<Vec<Value>>, String> {
    let name = path.display();
    match file_ext(path).as_str() {
        "csv" | "txt" => {
            let bytes = std::fs::read(path).map_err(|e| format!("Cannot read {name}: {e}"))?;
            let text = decode_bytes(&bytes);
            let delim = detect_delimiter(&text);
            let mut rdr = csv::ReaderBuilder::new()
                .delimiter(delim)
                .has_headers(false)
                .flexible(true)
                .from_reader(text.as_bytes());
            let mut grid = Vec::new();
            for rec in rdr.records() {
                let r = rec.map_err(|e| format!("CSV parse error in {name}: {e}"))?;
                grid.push(r.iter().map(csv_value).collect());
            }
            Ok(grid)
        }
        _ => {
            let mut wb =
                open_workbook_auto(path).map_err(|e| format!("Cannot open {name}: {e}"))?;
            let range = wb
                .worksheet_range_at(0)
                .ok_or_else(|| format!("{name}: no worksheets"))?
                .map_err(|e| format!("Cannot read {name}: {e}"))?;
            Ok(range
                .rows()
                .map(|row| row.iter().map(xlsx_value).collect())
                .collect())
        }
    }
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => {
            // "117.0" → "117" so numeric PointNos match Jupiter's strings.
            let s = n.to_string();
            match s.strip_suffix(".0") {
                Some(t) => t.to_string(),
                None => s,
            }
        }
        Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

fn value_to_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => parse_number_locale(s),
        _ => None,
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Native picker for the import source.  `mode` is "file" or "folder".
#[tauri::command]
pub async fn pick_import_path(app: AppHandle, mode: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let dialog = app.dialog().file();
        let picked = if mode == "folder" {
            dialog
                .set_title("Choose a folder of CSV / Excel files")
                .blocking_pick_folder()
        } else {
            dialog
                .set_title("Choose a CSV or Excel file")
                .add_filter("Data files", &["csv", "txt", "xlsx", "xlsm", "xls"])
                .blocking_pick_file()
        };
        Ok(picked.map(|p| p.to_string()))
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?
}

const PREVIEW_ROWS: usize = 30;
const PREVIEW_COLS: usize = 40;

/// List the files an import would touch and return the first file's top rows
/// so the user can point at the header / first data row.
#[tauri::command]
pub async fn import_preview(path: String) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let files = resolve_files(&path)?;
        let names: Vec<String> = files
            .iter()
            .map(|f| f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())
            .collect();
        let grid = read_grid(&files[0])?;
        let total_rows = grid.len();
        let preview: Vec<Vec<Value>> = grid
            .into_iter()
            .take(PREVIEW_ROWS)
            .map(|row| row.into_iter().take(PREVIEW_COLS).collect())
            .collect();
        Ok(json!({
            "files": names,
            "grid": preview,
            "total_rows": total_rows,
        }))
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?
}

#[derive(Debug, Deserialize)]
pub struct MapEntry {
    /// Datasheet column to write into (created when missing).
    pub target: String,
    /// 0-based source column index in the import files.
    pub source: usize,
}

#[derive(Debug, Deserialize)]
pub struct ImportRequest {
    /// File or folder picked earlier.
    pub path: String,
    /// Target datasheet name (without .xlsx).
    pub fname: String,
    /// 1-based row where data starts in every file.
    pub data_row: usize,
    /// "filename" or "col:<0-based idx>".
    pub point_no_source: String,
    pub mapping: Vec<MapEntry>,
}

/// Case-insensitive find-or-append of a column name; returns its index.
fn col_index(columns: &mut Vec<String>, name: &str, added: &mut Vec<String>) -> usize {
    if let Some(i) = columns
        .iter()
        .position(|c| c.trim().eq_ignore_ascii_case(name.trim()))
    {
        return i;
    }
    columns.push(name.trim().to_string());
    added.push(name.trim().to_string());
    columns.len() - 1
}

#[tauri::command]
pub async fn import_data(req: ImportRequest, state: State<'_, AppState>) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    tokio::task::spawn_blocking(move || run_import(&folder, req))
        .await
        .map_err(|e| format!("internal task error: {e}"))?
}

fn run_import(folder: &str, req: ImportRequest) -> Result<Value, String> {
    let fname = req
        .fname
        .trim()
        .trim_end_matches(".xlsx")
        .trim()
        .to_string();
    if fname.is_empty() {
        return Err("Choose a datasheet name to import into.".into());
    }
    if fname.contains(['/', '\\']) {
        return Err("The datasheet name cannot contain path separators.".into());
    }
    if req.mapping.is_empty() && req.point_no_source.is_empty() {
        return Err("Map at least one column before importing.".into());
    }

    let files = resolve_files(&req.path)?;

    // PointNo source: per-row column value or the file's stem.
    let pn_col: Option<usize> = req
        .point_no_source
        .strip_prefix("col:")
        .and_then(|s| s.trim().parse::<usize>().ok());
    let pn_from_filename = req.point_no_source == "filename";
    if pn_col.is_none() && !pn_from_filename {
        return Err("Choose where the PointNo comes from (a column or the file name).".into());
    }

    // ── Target datasheet: load existing, union columns ────────────────────
    let dir = datasheets_dir(folder);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create Datasheets dir: {e}"))?;
    let sheet_path = dir.join(format!("{fname}.xlsx"));

    let (mut columns, mut rows, formulas) = match read_existing_datasheet(&sheet_path) {
        Some((c, r, f)) => (c, r, f),
        None => (Vec::new(), Vec::new(), FormulaMap::new()),
    };

    let mut new_columns: Vec<String> = Vec::new();
    let db_idx = col_index(&mut columns, "DB", &mut new_columns);
    let pn_idx = col_index(&mut columns, "PointNo", &mut new_columns);
    let map_idx: Vec<(usize, usize)> = req
        .mapping
        .iter()
        .filter(|m| !m.target.trim().is_empty())
        .map(|m| (col_index(&mut columns, &m.target, &mut new_columns), m.source))
        .collect();

    let width = columns.len();
    for row in rows.iter_mut() {
        row.resize(width, Value::Null);
    }

    // Column indices (case-insensitive) feeding the points.xlsx upsert.
    let find_col = |name: &str| {
        columns
            .iter()
            .position(|c| c.trim().eq_ignore_ascii_case(name))
    };
    let (x1_idx, y1_idx, z1_idx, proj_idx) = (
        find_col("X1"),
        find_col("Y1"),
        find_col("Z1"),
        find_col("Projection1"),
    );

    // ── Append data rows from every file ──────────────────────────────────
    let start = req.data_row.max(1) - 1; // 1-based → 0-based
    let mut rows_added = 0usize;
    let mut rows_skipped = 0usize;
    // PointNo → first non-empty coordinate values seen during this import.
    let mut point_info: HashMap<String, (Option<f64>, Option<f64>, Option<f64>, String)> =
        HashMap::new();
    let mut point_order: Vec<String> = Vec::new();

    for file in &files {
        let grid = read_grid(file)?;
        let stem = file
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        for src in grid.iter().skip(start) {
            // All-empty source rows are noise (trailing Excel rows etc.).
            if src.iter().all(|v| value_to_string(v).is_empty()) {
                continue;
            }
            let pn = match pn_col {
                Some(i) => src.get(i).map(value_to_string).unwrap_or_default(),
                None => stem.clone(),
            };
            if pn.is_empty() {
                rows_skipped += 1;
                continue;
            }

            let mut row = vec![Value::Null; width];
            row[db_idx] = Value::String("imported".into());
            row[pn_idx] = Value::String(pn.clone());
            for &(tgt, srcix) in &map_idx {
                if let Some(v) = src.get(srcix) {
                    row[tgt] = v.clone();
                }
            }

            let info = point_info.entry(pn.clone()).or_insert_with(|| {
                point_order.push(pn.clone());
                (None, None, None, String::new())
            });
            if info.0.is_none() {
                info.0 = x1_idx.and_then(|i| value_to_f64(&row[i]));
            }
            if info.1.is_none() {
                info.1 = y1_idx.and_then(|i| value_to_f64(&row[i]));
            }
            if info.2.is_none() {
                info.2 = z1_idx.and_then(|i| value_to_f64(&row[i]));
            }
            if info.3.is_empty() {
                if let Some(i) = proj_idx {
                    info.3 = value_to_string(&row[i]);
                }
            }

            rows.push(row);
            rows_added += 1;
        }
    }

    if rows_added == 0 {
        return Err("No data rows found — check the first-data-row setting and the PointNo source.".into());
    }

    // ── Write the datasheet + sidecar cache + meta ────────────────────────
    let fopt = if formulas.is_empty() { None } else { Some(&formulas) };
    write_datasheet(&sheet_path, &columns, &rows, fopt)?;
    write_datasheet_cache(folder, &fname, &columns, &rows, fopt);
    let has_strata = columns
        .iter()
        .any(|c| c.trim().eq_ignore_ascii_case("strata"));
    persist_datasheet_meta(folder, &fname, rows.len(), has_strata);

    // ── points.xlsx upsert ────────────────────────────────────────────────
    let pts_path = points_xlsx_path(folder);
    let mut points = if pts_path.exists() {
        read_points_rows(&pts_path)
    } else {
        Vec::new()
    };
    let mut points_added = 0usize;
    let mut points_updated = 0usize;

    for pn in &point_order {
        let (x1, y1, z1, proj) = point_info.get(pn).cloned().unwrap_or_default();
        match points
            .iter_mut()
            .find(|p| p.point_no.trim().eq_ignore_ascii_case(pn))
        {
            Some(p) => {
                // Existing point: only fill what is missing.
                let mut changed = false;
                if p.x1.is_none() && x1.is_some() {
                    p.x1 = x1;
                    changed = true;
                }
                if p.y1.is_none() && y1.is_some() {
                    p.y1 = y1;
                    changed = true;
                }
                if p.z1.is_none() && z1.is_some() {
                    p.z1 = z1;
                    changed = true;
                }
                if p.projection1.trim().is_empty() && !proj.is_empty() {
                    p.projection1 = proj.clone();
                    changed = true;
                }
                if p.origin_x1.is_none() && x1.is_some() {
                    p.origin_x1 = x1;
                    changed = true;
                }
                if p.origin_y1.is_none() && y1.is_some() {
                    p.origin_y1 = y1;
                    changed = true;
                }
                if p.origin_z1.is_none() && z1.is_some() {
                    p.origin_z1 = z1;
                    changed = true;
                }
                if p.origin_projection1.trim().is_empty() && !proj.is_empty() {
                    p.origin_projection1 = proj.clone();
                    changed = true;
                }
                if changed {
                    points_updated += 1;
                }
            }
            None => {
                points.push(SelectedPoint {
                    db_id: "imported".into(),
                    project_id: "imported".into(),
                    point_id: format!("imported_{pn}"),
                    point_no: pn.clone(),
                    x1,
                    y1,
                    z1,
                    projection1: proj.clone(),
                    origin_x1: x1,
                    origin_y1: y1,
                    origin_z1: z1,
                    origin_projection1: proj,
                });
                points_added += 1;
            }
        }
    }

    if points_added > 0 || points_updated > 0 {
        write_points_workbook(&pts_path, &points)?;
    }

    Ok(json!({
        "files": files.len(),
        "rows_added": rows_added,
        "rows_skipped": rows_skipped,
        "points_added": points_added,
        "points_updated": points_updated,
        "new_columns": new_columns,
        "fname": fname,
    }))
}
