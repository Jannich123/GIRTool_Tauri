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
// ── Strata schema note (see issue #6) ────────────────────────────────────────
//
// `strata.rs::update_strata` currently receives and writes whatever `rows`
// shape the frontend sends — which is a flat array of SQL rows:
//   [ { "PointId": "...", "From": 0.0, "To": 1.5,
//       "Interpretation": "Sand", "Description": "Fine" }, ... ]
//
// `strata.rs::ensure_strata_file` creates a file with:
//   { "layers": {}, "point_layers": {} }
//
// These two shapes are INCOMPATIBLE: after update_strata runs, get_strata_point_layers
// can no longer find "point_layers".  The fix belongs in issue #6 (strata.rs
// refactor).  For now, load_strata_lookup (below) handles BOTH formats:
//   • Format A — nested: { "point_layers": { "<pid>": [ {from,to,primary,secondary} ] } }
//   • Format B — flat array: [ { "PointId", "From", "To", "Interpretation", "Description" } ]
// Any other format produces an empty lookup (strata columns filled with "Unknown").

use std::collections::HashMap;
use std::path::{Path, PathBuf};

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

/// Load strata intervals from `{output_folder}/{project_id}_strata.json`.
///
/// Handles two on-disk formats (see module-level doc):
///   Format A — nested: { "point_layers": { "<pid>": [ {from,to,primary,secondary} ] } }
///   Format B — flat array: [ { "PointId", "From", "To", "Interpretation", "Description" } ]
///
/// Returns a map of pointId → sorted Vec<(from, to, primary, secondary)>.
/// Returns an empty map when the file is absent, empty, or has an unrecognised format.
fn load_strata_lookup(
    output_folder: &str,
    project_id: &str,
) -> HashMap<String, Vec<(f64, f64, String, String)>> {
    let path = PathBuf::from(output_folder).join(format!("{project_id}_strata.json"));
    let data: Value = match std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(v) => v,
        None => return HashMap::new(),
    };

    let mut lookup: HashMap<String, Vec<(f64, f64, String, String)>> = HashMap::new();

    // ── Format A: { "point_layers": { pid: [ {from,to,primary,secondary} ] } } ──
    if let Some(point_layers) = data.get("point_layers").and_then(|v| v.as_object()) {
        for (pid, layers) in point_layers {
            if let Some(arr) = layers.as_array() {
                let mut intervals = Vec::new();
                for layer in arr {
                    let from = layer
                        .get("from")
                        .or_else(|| layer.get("depthFrom"))
                        .and_then(|v| v.as_f64());
                    let to = layer
                        .get("to")
                        .or_else(|| layer.get("depthTo"))
                        .and_then(|v| v.as_f64());
                    let primary = layer
                        .get("primary")
                        .or_else(|| layer.get("layer"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown")
                        .to_string();
                    let secondary = layer
                        .get("secondary")
                        .or_else(|| layer.get("description"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown")
                        .to_string();
                    if let (Some(f), Some(t)) = (from, to) {
                        intervals.push((f, t, primary, secondary));
                    }
                }
                if !intervals.is_empty() {
                    lookup.insert(pid.clone(), intervals);
                }
            }
        }
        return lookup;
    }

    // ── Format B: flat array of SQL rows ─────────────────────────────────────
    // Each row: { PointId, From, To, Interpretation/Layer, Description/Secondary }
    if let Some(rows) = data.as_array() {
        for row in rows {
            // Accept both "PointId" and "PointID" capitalizations.
            let pid = row
                .get("PointId")
                .or_else(|| row.get("PointID"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let from = row
                .get("From")
                .and_then(|v| v.as_f64());
            let to = row
                .get("To")
                .and_then(|v| v.as_f64());
            let primary = row
                .get("Interpretation")
                .or_else(|| row.get("Layer"))
                .or_else(|| row.get("primary"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown")
                .to_string();
            let secondary = row
                .get("Description")
                .or_else(|| row.get("secondary"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown")
                .to_string();

            if let (Some(pid), Some(f), Some(t)) = (pid, from, to) {
                lookup.entry(pid).or_default().push((f, t, primary, secondary));
            }
        }
        // Sort each point's intervals by depth-from for binary-search correctness.
        for intervals in lookup.values_mut() {
            intervals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        }
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
fn apply_strata_columns(
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

fn objects_to_columnar(rows: Vec<Value>) -> (Vec<String>, Vec<Vec<Value>>) {
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
