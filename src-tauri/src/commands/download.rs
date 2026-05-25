// Excel export and session persistence — mirrors backend/routers/download.py.
//
// download_data:
//   Execute every saved query for a set of project/point IDs and write each
//   result to {output_folder}/Datasheets/{fname}.xlsx.
//   Mirrors Python `save_to_folder`: runs all queries (or a named subset),
//   applies strata-column injection when apply_strata="Yes", applies group-
//   column injection from Grouping.xlsx, and writes GIRTool_settings.json.
//
// save_session:
//   Write the app's current state (selected_projects, point_count, etc.) to
//   GIRTool_settings.json, preserving any existing "charts" key.
//
// restore_session:
//   Read and return GIRTool_settings.json (or {} if absent).
//
// Storage:
//   {output_folder}/Datasheets/{fname}.xlsx   — exported datasheets
//   {output_folder}/GIRTool_settings.json     — session / download metadata
//
// ── Strata source (issue #6) ─────────────────────────────────────────────────
//
// As of issue #6 the strata master is stored in {output_folder}/strata.xlsx
// (Strata_GIRTool template, see commands/strata.rs).  load_strata_lookup
// below reads the "Strata" sheet of that workbook.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use calamine::{open_workbook, Data, Reader, Xlsx};
use rust_xlsxwriter::{Format, Table, TableColumn, TableStyle, Workbook};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

use crate::state::AppState;

// ── Request / response types ──────────────────────────────────────────────────

/// Matches the `query` argument sent by DataPage.jsx:
///   invoke('download_data', { projectId, query: buildPayload(queryNames) })
/// The outer `projectId` JS field is unused here (project_ids is inside query).
#[derive(Debug, Deserialize)]
pub struct DownloadRequest {
    /// Primary project ID — used for strata lookup.
    pub project_id: String,
    /// All project IDs to include in the SQL IN clause.
    pub project_ids: Vec<String>,
    /// Optional point filter; empty = all points.
    #[serde(default)]
    pub point_ids: Vec<String>,
    /// Run only these query names; empty = run all.
    #[serde(default)]
    pub query_names: Vec<String>,
    /// Project metadata for session file (ProjectId, ProjectNo, Title).
    #[serde(default)]
    pub projects_meta: Vec<Value>,
    /// Point metadata for group-column injection (PointId, PointNo, …).
    /// Reserved for future use — not yet consumed server-side.
    #[serde(default)]
    #[allow(dead_code)]
    pub points_meta: Vec<Value>,
}

// ── Path helpers ──────────────────────────────────────────────────────────────

fn settings_path(folder: &str) -> PathBuf {
    PathBuf::from(folder).join("GIRTool_settings.json")
}

fn datasheets_dir(folder: &str) -> PathBuf {
    PathBuf::from(folder).join("Datasheets")
}

// ── SQL building ──────────────────────────────────────────────────────────────

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
        Err(format!("Invalid ID: {s:?}"))
    }
}

fn safe_id_list(ids: &[String]) -> Result<String, String> {
    ids.iter()
        .map(|id| sanitise_id(id))
        .collect::<Result<Vec<_>, _>>()
        .map(|v| v.join(", "))
}

fn build_sql(
    sql_template: &str,
    point_filter_template: &str,
    project_ids: &[String],
    point_ids: &[String],
) -> Result<String, String> {
    let proj_str = safe_id_list(project_ids)?;
    let point_filter = if !point_ids.is_empty() && !point_filter_template.is_empty() {
        let pts_str = safe_id_list(point_ids)?;
        format!("AND {}", point_filter_template.replace("#pointid#", &pts_str))
    } else {
        String::new()
    };

    Ok(sql_template
        .replace("#DB#", "")
        .replace("#projectid#", &proj_str)
        .replace("#pointfilter#", &point_filter))
}

// ── Strata-column injection ───────────────────────────────────────────────────

/// Load strata intervals from the Strata master sheet in
/// `{output_folder}/strata.xlsx` (see `commands/strata.rs`).
///
/// The `_project_id` argument is kept for backward compatibility with the old
/// per-project JSON store but is ignored — strata.xlsx is shared across
/// projects, matching the Python build.
///
/// Returns a map of pointId → sorted Vec<(from, to, primary, secondary)>.
/// Returns an empty map when the file is absent or has no usable rows.
pub(crate) fn load_strata_lookup(
    output_folder: &str,
    _project_id: &str,
) -> HashMap<String, Vec<(f64, f64, String, String)>> {
    use calamine::open_workbook_auto;

    let path = PathBuf::from(output_folder).join("strata.xlsx");
    if !path.exists() {
        return HashMap::new();
    }

    let mut wb = match open_workbook_auto(&path) {
        Ok(w) => w,
        Err(_) => return HashMap::new(),
    };
    let range = match wb.worksheet_range("Strata") {
        Ok(r) => r,
        Err(_) => return HashMap::new(),
    };

    let mut lookup: HashMap<String, Vec<(f64, f64, String, String)>> = HashMap::new();

    // Columns: A=ProjectId B=PointId C=PointNo D=From E=To F=Primary G=Secondary
    for row in range.rows().skip(1) {
        let pid = match row.get(1) {
            Some(Data::String(s)) if !s.is_empty() => s.clone(),
            Some(Data::Int(i))                     => i.to_string(),
            Some(Data::Float(f))                   => {
                if f.fract() == 0.0 { format!("{}", *f as i64) } else { f.to_string() }
            }
            _ => continue,
        };
        let from = match row.get(3) {
            Some(Data::Float(f)) => *f,
            Some(Data::Int(i))   => *i as f64,
            _ => continue,
        };
        let to = match row.get(4) {
            Some(Data::Float(f)) => *f,
            Some(Data::Int(i))   => *i as f64,
            _ => continue,
        };
        let primary = row
            .get(5)
            .and_then(|c| match c {
                Data::String(s) if !s.is_empty() => Some(s.clone()),
                _ => None,
            })
            .unwrap_or_else(|| "Unknown".to_string());
        let secondary = row
            .get(6)
            .and_then(|c| match c {
                Data::String(s) if !s.is_empty() => Some(s.clone()),
                _ => None,
            })
            .unwrap_or_else(|| "Unknown".to_string());

        lookup.entry(pid).or_default().push((from, to, primary, secondary));
    }

    // Sort each point's intervals by depth-from.
    for intervals in lookup.values_mut() {
        intervals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    }

    lookup
}

/// Return the strata label (primary, secondary) for a given pointId + depth.
fn strata_at(
    lookup: &HashMap<String, Vec<(f64, f64, String, String)>>,
    point_id: &str,
    depth: f64,
) -> (String, String) {
    if let Some(intervals) = lookup.get(point_id) {
        for (from, to, primary, secondary) in intervals {
            if depth >= *from && depth < *to {
                return (primary.clone(), secondary.clone());
            }
        }
    }
    ("Unknown".to_string(), "Unknown".to_string())
}

/// Extract PointId + Depth from a row-object, inject Primary/Secondary Layer columns.
pub(crate) fn apply_strata_columns(
    columns: &mut Vec<String>,
    rows: &mut Vec<Vec<Value>>,
    strata_lookup: &HashMap<String, Vec<(f64, f64, String, String)>>,
) {
    let col_lower: Vec<String> = columns.iter().map(|c| c.to_lowercase()).collect();

    let pt_idx: Option<usize> = col_lower.iter().position(|c| c == "pointid");
    let depth_idx: Option<usize> = col_lower
        .iter()
        .position(|c| c == "depth")
        .or_else(|| col_lower.iter().position(|c| c.contains("depth")));

    columns.push("Primary Layer".to_string());
    columns.push("Secondary Layer".to_string());

    for row in rows.iter_mut() {
        let result = (|| -> Option<(String, String)> {
            let pid = row.get(pt_idx?)?.as_str()?.to_string();
            let depth = match row.get(depth_idx?)? {
                Value::Number(n) => n.as_f64()?,
                _ => return None,
            };
            Some(strata_at(strata_lookup, &pid, depth))
        })();
        let (primary, secondary) = result.unwrap_or_else(|| ("Unknown".to_string(), "Unknown".to_string()));
        row.push(Value::String(primary));
        row.push(Value::String(secondary));
    }
}

// ── xlsx writing ──────────────────────────────────────────────────────────────

fn write_datasheet(
    path: &Path,
    columns: &[String],
    rows: &[Vec<Value>],
) -> Result<(), String> {
    let mut workbook = Workbook::new();
    let ws = workbook.add_worksheet();

    if rows.is_empty() {
        // Write just the header when there is no data.
        for (j, col) in columns.iter().enumerate() {
            ws.write_string(0, j as u16, col)
                .map_err(|e| format!("Write error: {e}"))?;
        }
        workbook.save(path).map_err(|e| format!("Failed to save xlsx: {e}"))?;
        return Ok(());
    }

    // Use a formatted table so columns auto-filter in Excel.
    let num_rows = rows.len() as u32;
    let num_cols = columns.len();

    // Write header + data cells.
    let bold = Format::new().set_bold();
    for (j, col) in columns.iter().enumerate() {
        ws.write_string_with_format(0, j as u16, col, &bold)
            .map_err(|e| format!("Write error: {e}"))?;
    }

    for (i, row) in rows.iter().enumerate() {
        let row_idx = (i + 1) as u32;
        for (j, val) in row.iter().enumerate() {
            write_cell(ws, row_idx, j as u16, val);
        }
    }

    // Add an Excel table over the data range for auto-filter + banding.
    if num_cols > 0 {
        let table_cols: Vec<TableColumn> = columns
            .iter()
            .map(|name| TableColumn::new().set_header(name))
            .collect();
        let table = Table::new()
            .set_columns(&table_cols)
            .set_style(TableStyle::Medium2)
            .set_total_row(false);
        ws.add_table(0, 0, num_rows, (num_cols - 1) as u16, &table)
            .map_err(|e| format!("Table error: {e}"))?;
    }

    workbook.save(path).map_err(|e| format!("Failed to save xlsx: {e}"))
}

fn write_cell(ws: &mut rust_xlsxwriter::Worksheet, row: u32, col: u16, val: &Value) {
    match val {
        Value::Null => { let _ = ws.write_blank(row, col, &Format::default()); }
        Value::Bool(b) => { let _ = ws.write_boolean(row, col, *b); }
        Value::Number(n) => {
            if let Some(f) = n.as_f64() { let _ = ws.write_number(row, col, f); }
        }
        Value::String(s) => { let _ = ws.write_string(row, col, s); }
        other => { let _ = ws.write_string(row, col, &other.to_string()); }
    }
}

// ── Conversion: Vec<Value> rows-as-objects → (columns, Vec<Vec<Value>>) ───────

pub(crate) fn objects_to_columnar(rows: Vec<Value>) -> (Vec<String>, Vec<Vec<Value>>) {
    if rows.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let columns: Vec<String> = rows
        .first()
        .and_then(|r| r.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();

    let data: Vec<Vec<Value>> = rows
        .into_iter()
        .map(|row| {
            if let Some(obj) = row.as_object() {
                columns
                    .iter()
                    .map(|k| obj.get(k).cloned().unwrap_or(Value::Null))
                    .collect()
            } else {
                vec![Value::Null; columns.len()]
            }
        })
        .collect();

    (columns, data)
}

/// Inverse of [`objects_to_columnar`].  Rebuild row-objects from a parallel
/// `columns` slice and a positional `rows` matrix.
pub(crate) fn columnar_to_objects(columns: &[String], rows: Vec<Vec<Value>>) -> Vec<Value> {
    rows.into_iter()
        .map(|r| {
            let mut obj = serde_json::Map::new();
            for (i, col) in columns.iter().enumerate() {
                obj.insert(col.clone(), r.get(i).cloned().unwrap_or(Value::Null));
            }
            Value::Object(obj)
        })
        .collect()
}

/// Convert a calamine `Data` cell to a plain `String` (or empty for null/error).
fn data_str(cell: &Data) -> String {
    match cell {
        Data::String(s)   => s.clone(),
        Data::Float(f)    => {
            if f.fract() == 0.0 { format!("{}", *f as i64) } else { f.to_string() }
        }
        Data::Int(i)      => i.to_string(),
        Data::Bool(b)     => b.to_string(),
        Data::DateTime(d) => d.to_string(),
        _                 => String::new(),
    }
}

/// Convert a calamine `Data` cell into a `serde_json::Value` (preserves type
/// where reasonable so the frontend gets numbers as numbers, not strings).
fn data_to_value(cell: &Data) -> Value {
    match cell {
        Data::String(s)   => Value::String(s.clone()),
        Data::Float(f)    => json!(f),
        Data::Int(i)      => json!(i),
        Data::Bool(b)     => Value::Bool(*b),
        Data::DateTime(d) => Value::String(d.to_string()),
        Data::Empty | Data::Error(_) | Data::DateTimeIso(_) | Data::DurationIso(_) => Value::Null,
    }
}

/// Append one column per group system to each row, matched by PointId.
///
/// Mirrors Python `_apply_group_columns` in `backend/routers/download.py`.
/// Reads `{output_folder}/Grouping.xlsx`; column headers beyond the fixed five
/// (`PointId`, `PointNo`, `ProjectNo`, `ProjectName`, `PointType`) are treated
/// as group-system names and appended to `columns`.  For each row, the value
/// for that point in that system is appended, or `"Unknown"` if the point is
/// not present in Grouping.xlsx.
///
/// No-ops silently when:
///   * Grouping.xlsx does not exist
///   * the SQL result has no `PointId` column
///   * Grouping.xlsx has no system-name columns
pub(crate) fn apply_group_columns(
    output_folder: &str,
    columns: &mut Vec<String>,
    rows: &mut Vec<Vec<Value>>,
) {
    let path = PathBuf::from(output_folder).join("Grouping.xlsx");
    if !path.exists() {
        return;
    }

    let mut wb: Xlsx<_> = match open_workbook(&path) {
        Ok(w) => w,
        Err(_) => return,
    };
    let range = match wb.worksheet_range_at(0) {
        Some(Ok(r)) => r,
        _ => return,
    };

    let mut iter = range.rows();
    let headers: Vec<String> = match iter.next() {
        Some(r) => r.iter().map(data_str).collect(),
        None => return,
    };

    let pid_idx = match headers.iter().position(|h| h == "PointId") {
        Some(i) => i,
        None => return,
    };

    // Columns beyond the fixed 5 are system-name columns.
    let skip: HashSet<&str> = ["PointId", "PointNo", "ProjectNo", "ProjectName", "PointType"]
        .into_iter()
        .collect();
    let sys_cols: Vec<(usize, String)> = headers
        .iter()
        .enumerate()
        .filter(|(_, h)| !h.is_empty() && !skip.contains(h.as_str()))
        .map(|(i, h)| (i, h.clone()))
        .collect();

    if sys_cols.is_empty() {
        return;
    }

    // Build pointId → { sys_name → value } from the xlsx data rows.
    let mut assignments: HashMap<String, HashMap<String, String>> = HashMap::new();
    for row in iter {
        let pid = match row.get(pid_idx) {
            Some(c) if !matches!(c, Data::Empty) => data_str(c),
            _ => continue,
        };
        if pid.is_empty() {
            continue;
        }
        let mut entry = HashMap::new();
        for (ci, sys_name) in &sys_cols {
            if let Some(cell) = row.get(*ci) {
                let v = data_str(cell);
                if !v.is_empty() {
                    entry.insert(sys_name.clone(), v);
                }
            }
        }
        assignments.insert(pid, entry);
    }

    // Find PointId in the SQL result (case-insensitive).
    let result_pid_idx = match columns.iter().position(|c| c.eq_ignore_ascii_case("pointid")) {
        Some(i) => i,
        None => return,
    };

    // Append system columns to the header.
    for (_, sys_name) in &sys_cols {
        columns.push(sys_name.clone());
    }

    // Append per-row values for each system column.
    for row in rows.iter_mut() {
        let pid = row
            .get(result_pid_idx)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        for (_, sys_name) in &sys_cols {
            let val = pid
                .as_ref()
                .and_then(|p| assignments.get(p))
                .and_then(|m| m.get(sys_name))
                .cloned()
                .unwrap_or_else(|| "Unknown".to_string());
            row.push(Value::String(val));
        }
    }
}

/// Merge user-added columns from a previously-saved datasheet xlsx into the
/// SQL result rows.
///
/// Mirrors Python `_merge_formula_columns` in `backend/routers/download.py`.
/// Looks for `{output_folder}/Datasheets/{query_name}.xlsx` first, then
/// `{output_folder}/{query_name}.xlsx`.  For any column header in the file
/// that is NOT in the current SQL result, its cached computed value is merged
/// into each row by matching the `PointId` column.
///
/// Calamine returns cached computed values for formula cells, which is exactly
/// what we want (equivalent to Python's `data_only=True`).
///
/// No-ops silently when the file is absent or has no extra columns.
pub(crate) fn merge_formula_columns(
    output_folder: &str,
    query_name: &str,
    columns: &mut Vec<String>,
    rows: &mut Vec<Vec<Value>>,
) {
    let target = format!("{query_name}.xlsx");
    let path = {
        let primary = PathBuf::from(output_folder).join("Datasheets").join(&target);
        if primary.exists() {
            primary
        } else {
            let fallback = PathBuf::from(output_folder).join(&target);
            if fallback.exists() {
                fallback
            } else {
                return;
            }
        }
    };

    let mut wb: Xlsx<_> = match open_workbook(&path) {
        Ok(w) => w,
        Err(_) => return,
    };
    let range = match wb.worksheet_range_at(0) {
        Some(Ok(r)) => r,
        _ => return,
    };

    let mut iter = range.rows();
    let xlsx_headers: Vec<String> = match iter.next() {
        Some(r) => r.iter().map(data_str).collect(),
        None => return,
    };

    // Determine which xlsx columns are NEW (not already in the SQL result).
    let sql_set: HashSet<String> = columns.iter().map(|s| s.to_lowercase()).collect();
    let new_cols: Vec<(usize, String)> = xlsx_headers
        .iter()
        .enumerate()
        .filter(|(_, h)| !h.is_empty() && !sql_set.contains(&h.to_lowercase()))
        .map(|(i, h)| (i, h.clone()))
        .collect();

    if new_cols.is_empty() {
        return;
    }

    let xlsx_pid_idx = match xlsx_headers
        .iter()
        .position(|h| h.eq_ignore_ascii_case("pointid"))
    {
        Some(i) => i,
        None => return,
    };

    // pointId → { col_name → value }
    let mut extra: HashMap<String, HashMap<String, Value>> = HashMap::new();
    for row in iter {
        let pid = row.get(xlsx_pid_idx).map(data_str).unwrap_or_default();
        if pid.is_empty() {
            continue;
        }
        let mut entry = HashMap::new();
        for (ci, name) in &new_cols {
            if let Some(cell) = row.get(*ci) {
                entry.insert(name.clone(), data_to_value(cell));
            }
        }
        extra.insert(pid, entry);
    }

    let result_pid_idx = match columns
        .iter()
        .position(|c| c.eq_ignore_ascii_case("pointid"))
    {
        Some(i) => i,
        None => return,
    };

    for (_, name) in &new_cols {
        columns.push(name.clone());
    }

    for row in rows.iter_mut() {
        let pid = row
            .get(result_pid_idx)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        for (_, name) in &new_cols {
            let val = pid
                .as_ref()
                .and_then(|p| extra.get(p))
                .and_then(|m| m.get(name))
                .cloned()
                .unwrap_or(Value::Null);
            row.push(val);
        }
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Execute selected queries and write each result to Datasheets/{fname}.xlsx.
///
/// JS call:  invoke('download_data', { projectId, query: buildPayload(queryNames) })
/// The `projectId` field is sent by DataPage but is not used here directly
/// (project_ids is already inside `query`).
#[tauri::command]
pub async fn download_data(
    query: DownloadRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if query.project_ids.is_empty() {
        return Err("No project IDs provided.".into());
    }

    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let cfg = state
        .db
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No database connection configured.".to_string())?;

    // Ensure Datasheets directory exists.
    let ds_dir = datasheets_dir(&folder);
    std::fs::create_dir_all(&ds_dir)
        .map_err(|e| format!("Cannot create Datasheets dir: {e}"))?;

    // Load query definitions (file or built-ins).
    let all_queries = crate::commands::queries::load_queries(&state);
    let queries_to_run: Vec<_> = if query.query_names.is_empty() {
        all_queries.iter().collect()
    } else {
        all_queries
            .iter()
            .filter(|q| query.query_names.contains(&q.fname))
            .collect()
    };

    // Load strata lookup once (used for apply_strata="Yes" queries).
    let strata_lookup = load_strata_lookup(&folder, &query.project_id);

    let mut written: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    for q in queries_to_run {
        let sql = match build_sql(
            &q.sql_script,
            &q.pointfilter,
            &query.project_ids,
            &query.point_ids,
        ) {
            Ok(s) => s,
            Err(e) => {
                errors.push(format!("{}: SQL build error — {e}", q.fname));
                continue;
            }
        };

        let cfg_clone = cfg.clone();
        let rows_result = tokio::task::spawn_blocking(move || {
            crate::db::query_rows(&cfg_clone, &sql)
        })
        .await
        .map_err(|e| format!("internal task error: {e}"))?;

        let raw_rows = match rows_result {
            Ok(r) => r,
            Err(e) => {
                errors.push(format!("{}: query failed — {e:#}", q.fname));
                continue;
            }
        };

        let (mut columns, mut rows) = objects_to_columnar(raw_rows);

        // Inject strata columns when the query definition requests it.
        if q.apply_strata.eq_ignore_ascii_case("yes") {
            apply_strata_columns(&mut columns, &mut rows, &strata_lookup);
        }

        let path = ds_dir.join(format!("{}.xlsx", q.fname));
        let cols_clone = columns.clone();
        let rows_clone = rows.clone();
        let path_clone = path.clone();
        if let Err(e) = tokio::task::spawn_blocking(move || {
            write_datasheet(&path_clone, &cols_clone, &rows_clone)
        })
        .await
        .map_err(|e| format!("internal task error: {e}"))?
        {
            errors.push(format!("{}: xlsx write failed — {e}", q.fname));
        } else {
            written.push(q.fname.clone());
        }
    }

    // Persist session metadata to GIRTool_settings.json.
    let settings_file = settings_path(&folder);
    let existing: Value = std::fs::read_to_string(&settings_file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}));

    let mut new_settings = existing.as_object().cloned().unwrap_or_default();
    new_settings.insert(
        "selected_projects".to_string(),
        Value::Array(query.projects_meta.clone()),
    );
    new_settings.insert(
        "point_count".to_string(),
        json!(query.point_ids.len()),
    );

    if let Ok(s) = serde_json::to_string_pretty(&Value::Object(new_settings)) {
        let _ = std::fs::write(&settings_file, s);
    }

    Ok(json!({
        "written": written,
        "errors":  errors,
    }))
}

/// Persist the full application session state to GIRTool_settings.json.
/// Preserves any existing "charts" key that may have been written separately.
#[tauri::command]
pub async fn save_session(
    session: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = settings_path(&folder);

    // Merge with existing file so "charts" and other keys are not lost.
    let existing: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}));

    let mut merged = existing.as_object().cloned().unwrap_or_default();
    if let Some(incoming) = session.as_object() {
        for (k, v) in incoming {
            merged.insert(k.clone(), v.clone());
        }
    }

    let json = serde_json::to_string_pretty(&Value::Object(merged))
        .map_err(|e| format!("Serialise error: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Write error: {e}"))
}

/// Load and return GIRTool_settings.json; returns {} when absent.
#[tauri::command]
pub async fn restore_session(state: State<'_, AppState>) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = settings_path(&folder);
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("Parse error: {e}")),
        Err(_) => Ok(json!({})),
    }
}
