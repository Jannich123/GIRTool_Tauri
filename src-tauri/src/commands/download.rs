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

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use calamine::{open_workbook, Data, Reader, Xlsx};
use chrono::Local;
use rust_xlsxwriter::{Format, Table, TableStyle, Workbook};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

use crate::state::AppState;

// ── Request types ─────────────────────────────────────────────────────────────

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
    #[serde(default)]
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

/// Sanitise an ID for SQL interpolation (GUID or bare integer only).
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

/// Substitute #DB#, #projectid#, and #pointfilter# placeholders.
///
/// Mirrors Python `_build_sql`.
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

    let sql = sql_template
        .replace("#DB#", "")
        .replace("#projectid#", &proj_str)
        .replace("#pointfilter#", &point_filter);
    Ok(sql)
}

// ── Strata-column injection ───────────────────────────────────────────────────

/// Read strata intervals from `{output_folder}/{project_id}_strata.json`.
///
/// Returns `{ pointId: [(from, to, primary, secondary), …] }`.
/// Returns an empty map when the file is absent or the format is unrecognised.
fn load_strata_lookup(output_folder: &str, project_id: &str) -> HashMap<String, Vec<(f64, f64, String, String)>> {
    let path = PathBuf::from(output_folder)
        .join(format!("{project_id}_strata.json"));
    let data: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}));

    let mut lookup: HashMap<String, Vec<(f64, f64, String, String)>> = HashMap::new();

    if let Some(point_layers) = data.get("point_layers").and_then(|v| v.as_object()) {
        for (pid, layers) in point_layers {
            if let Some(arr) = layers.as_array() {
                let mut intervals = Vec::new();
                for layer in arr {
                    // Support object format: { "from": f, "to": f, "primary": s, "secondary": s }
                    let from = layer.get("from").or_else(|| layer.get("depthFrom"))
                        .and_then(|v| v.as_f64());
                    let to   = layer.get("to").or_else(|| layer.get("depthTo"))
                        .and_then(|v| v.as_f64());
                    let primary = layer.get("primary")
                        .or_else(|| layer.get("layer"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown")
                        .to_string();
                    let secondary = layer.get("secondary")
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
    }
    lookup
}

/// Append "Primary Layer" and "Secondary Layer" columns to each row.
///
/// Matches on PointId + Depth (from the result columns). If strata_lookup is
/// empty, the columns are added with "Unknown" as the filler value.
fn apply_strata_columns(
    columns: &mut Vec<String>,
    rows: &mut Vec<Vec<Value>>,
    strata_lookup: &HashMap<String, Vec<(f64, f64, String, String)>>,
) {
    // Find PointId and Depth column indices BEFORE pushing new columns.
    let col_lower: Vec<String> = columns.iter()
        .map(|c| c.to_lowercase())
        .collect();

    let pt_idx: Option<usize>    = col_lower.iter().position(|c| c == "pointid");
    let depth_idx: Option<usize> = col_lower.iter()
        .position(|c| c == "depth")
        .or_else(|| col_lower.iter().position(|c| c.contains("depth")));

    // Append new column headers.
    columns.push("Primary Layer".to_string());
    columns.push("Secondary Layer".to_string());

    for row in rows.iter_mut() {
        let (primary, secondary) = (|| -> Option<(String, String)> {
            let pi = pt_idx?;
            let di = depth_idx?;
            let pid   = row.get(pi)?.as_str()?.to_string();
            let depth = match row.get(di)? {
                Value::Number(n) => n.as_f64()?,
                _                => return None,
            };
            let intervals = strata_lookup.get(&pid)?;
            for (from, to, prim, sec) in intervals {
                if *from <= depth && depth < *to {
                    return Some((prim.clone(), sec.clone()));
                }
            }
            None
        })()
        .unwrap_or_else(|| ("Unknown".to_string(), "Unknown".to_string()));

        row.push(Value::String(primary));
        row.push(Value::String(secondary));
    }
}

// ── Group-column injection ────────────────────────────────────────────────────

/// Convert a calamine Data cell to String.
fn data_str(c: &Data) -> String {
    match c {
        Data::String(s)   => s.clone(),
        Data::Float(f)    => if f.fract() == 0.0 { format!("{}", *f as i64) } else { f.to_string() },
        Data::Int(i)      => i.to_string(),
        Data::Bool(b)     => b.to_string(),
        _                 => String::new(),
    }
}

/// Read Grouping.xlsx and build `{ pointId → { sys_name: group_name } }`.
fn load_group_lookup(grouping_path: &Path) -> Option<(Vec<String>, HashMap<String, HashMap<String, String>>)> {
    if !grouping_path.exists() {
        return None;
    }
    let mut wb: Xlsx<_> = open_workbook(grouping_path).ok()?;
    let range = wb.worksheet_range_at(0)?.ok()?;

    const SKIP: &[&str] = &["PointId", "PointNo", "PointType", "ProjectNo", "ProjectName"];

    let mut rows = range.rows();
    let headers: Vec<String> = rows.next()?.iter().map(data_str).collect();
    let h_pid = headers.iter().position(|h| h == "PointId")?;

    // Collect system column names and their indices.
    let sys_cols: Vec<(usize, String)> = headers.iter().enumerate()
        .filter(|(_, h)| !SKIP.contains(&h.as_str()) && !h.is_empty())
        .map(|(i, h)| (i, h.clone()))
        .collect();

    if sys_cols.is_empty() {
        return None;
    }

    let sys_names: Vec<String> = sys_cols.iter().map(|(_, n)| n.clone()).collect();
    let mut lookup: HashMap<String, HashMap<String, String>> = HashMap::new();

    for row in rows {
        let pid = match row.get(h_pid) {
            Some(c) if !matches!(c, Data::Empty) => data_str(c),
            _                                    => continue,
        };
        if pid.is_empty() {
            continue;
        }
        let mut asgn: HashMap<String, String> = HashMap::new();
        for (ci, sys_name) in &sys_cols {
            if let Some(cell) = row.get(*ci) {
                let v = data_str(cell);
                if !v.is_empty() {
                    asgn.insert(sys_name.clone(), v);
                }
            }
        }
        if !asgn.is_empty() {
            lookup.insert(pid, asgn);
        }
    }

    Some((sys_names, lookup))
}

/// Append one column per group system to each row, matched by PointId.
fn apply_group_columns(
    columns: &mut Vec<String>,
    rows: &mut Vec<Vec<Value>>,
    grouping_path: &Path,
) {
    let pid_idx = match columns.iter().position(|c| c.to_lowercase() == "pointid") {
        Some(i) => i,
        None    => return,
    };

    let (sys_names, lookup) = match load_group_lookup(grouping_path) {
        Some(v) => v,
        None    => return,
    };

    // Append column headers.
    let start_col = columns.len();
    columns.extend(sys_names.iter().cloned());

    // Append group assignment cells to each row.
    for row in rows.iter_mut() {
        let pid = row.get(pid_idx)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let pt_asgn = lookup.get(&pid);
        for sys_name in &sys_names {
            let val = pt_asgn
                .and_then(|a| a.get(sys_name))
                .cloned()
                .unwrap_or_default();
            row.push(Value::String(val));
        }
    }
    let _ = start_col; // suppress unused warning
}

// ── xlsx writing ──────────────────────────────────────────────────────────────

/// Write a result set to an xlsx file with table style, freeze pane, and
/// auto-width columns.  Columns whose name ends in "Id" are set to 0-width
/// (hidden) to reduce clutter.
///
/// Mirrors Python `_make_workbook`.
fn write_datasheet(
    path: &Path,
    fname: &str,
    columns: &[String],
    rows: &[Vec<Value>],
) -> Result<usize, String> {
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();

    // Sheet name must be ≤ 31 chars.
    let sheet_name: String = fname.chars().take(31).collect();
    ws.set_name(&sheet_name).ok();

    let bold = Format::new().set_bold();

    if columns.is_empty() {
        ws.write_string(0, 0, "No data returned").ok();
        return wb.save(path)
            .map_err(|e| format!("Save error: {e}"))
            .map(|_| 0);
    }

    // Header row.
    for (j, col) in columns.iter().enumerate() {
        ws.write_with_format(0, j as u16, col.as_str(), &bold)
            .map_err(|e| format!("{e}"))?;
    }

    // Data rows.
    let n = rows.len();
    for (i, row) in rows.iter().enumerate() {
        let row_idx = (i + 1) as u32;
        for (j, val) in row.iter().enumerate() {
            write_cell(ws, row_idx, j as u16, val);
        }
    }

    // Table style.
    if n > 0 {
        let table = Table::new().set_style(TableStyle::Medium2);
        ws.add_table(0, 0, n as u32, (columns.len() - 1) as u16, &table)
            .map_err(|e| format!("{e}"))?;
    }

    // Freeze row 1 (header always visible).
    ws.set_freeze_panes(1, 0).map_err(|e| format!("{e}"))?;

    // Column widths: auto-width from sample (first 500 rows), max 60.
    // Columns ending in "Id" get 0 width (hidden).
    for (j, col) in columns.iter().enumerate() {
        let j = j as u16;
        if col.ends_with("Id") {
            // Hide by setting a very small width.
            ws.set_column_width(j, 0.0).ok();
        } else {
            let sample: Vec<usize> = std::iter::once(col.len())
                .chain(
                    rows.iter().take(500).filter_map(|r| {
                        r.get(j as usize).map(|v| match v {
                            Value::String(s) => s.len(),
                            Value::Null      => 0,
                            other            => other.to_string().len(),
                        })
                    })
                )
                .collect();
            let max_len = *sample.iter().max().unwrap_or(&8);
            let width = (max_len + 2).min(60) as f64;
            ws.set_column_width(j, width).ok();
        }
    }

    wb.save(path).map_err(|e| format!("Save error: {e}"))?;
    Ok(n)
}

fn write_cell(ws: &mut rust_xlsxwriter::Worksheet, row: u32, col: u16, val: &Value) {
    match val {
        Value::Null      => { let _ = ws.write_blank(row, col, &Format::default()); }
        Value::Bool(b)   => { let _ = ws.write_boolean(row, col, *b); }
        Value::Number(n) => { if let Some(f) = n.as_f64() { let _ = ws.write_number(row, col, f); } }
        Value::String(s) => { let _ = ws.write_string(row, col, s); }
        other            => { let _ = ws.write_string(row, col, &other.to_string()); }
    }
}

// ── Session helpers ───────────────────────────────────────────────────────────

/// Write GIRTool_settings.json, preserving any existing "charts" key.
///
/// Mirrors Python `_write_session`.
fn write_settings_json(
    folder: &str,
    _project_ids: &[String],
    point_count: usize,
    projects_meta: &[Value],
    state: &AppState,
) -> Result<(), String> {
    let path = settings_path(folder);

    // Preserve existing "charts" key if present.
    let preserved_charts: Option<Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("charts").cloned());

    let cfg = state.db.lock().unwrap().clone().unwrap_or_default();
    let mut session = json!({
        "saved_at":          Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
        "server":            cfg.server,
        "database":          cfg.database,
        "selected_projects": projects_meta,
        "point_count":       if point_count == 0 { Value::String("all".into()) } else { json!(point_count) },
    });

    if let Some(charts) = preserved_charts {
        session["charts"] = charts;
    }

    let json = serde_json::to_string_pretty(&session)
        .map_err(|e| format!("Serialise error: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Write error: {e}"))
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Run all saved queries (or a named subset) and write xlsx files to
/// {output_folder}/Datasheets/.  Returns a summary of saved files and errors.
#[tauri::command]
pub async fn download_data(
    req: DownloadRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if req.project_ids.is_empty() {
        return Err("No project IDs provided.".into());
    }

    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let cfg = state
        .db
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No database connection configured.".to_string())?;

    // Load queries and apply query_names filter.
    let all_queries = crate::commands::queries::load_queries(&state);
    let queries: Vec<_> = if req.query_names.is_empty() {
        all_queries.iter().collect()
    } else {
        all_queries.iter()
            .filter(|q| req.query_names.contains(&q.fname))
            .collect()
    };

    if queries.is_empty() {
        return Err("No matching queries found.".into());
    }

    // Create Datasheets subdirectory.
    let ds_dir = datasheets_dir(&folder);
    std::fs::create_dir_all(&ds_dir)
        .map_err(|e| format!("Cannot create Datasheets dir: {e}"))?;

    // Load strata lookup.
    let strata = load_strata_lookup(&folder, &req.project_id);

    // Grouping.xlsx path for group-column injection.
    let grouping_path = crate::commands::grouping::grouping_xlsx_path(&folder);

    let mut saved: Vec<Value> = Vec::new();
    let mut errors: Vec<Value> = Vec::new();

    for q in queries {
        let fname = q.fname.clone();
        let out_path = ds_dir.join(format!("{fname}.xlsx"));

        let sql = match build_sql(&q.sql_script, &q.pointfilter, &req.project_ids, &req.point_ids) {
            Ok(s)  => s,
            Err(e) => {
                errors.push(json!({ "file": format!("{fname}.xlsx"), "error": e }));
                continue;
            }
        };

        let cfg_clone = cfg.clone();
        let rows_result = tokio::task::spawn_blocking(move || {
            crate::db::query_rows(&cfg_clone, &sql)
        })
        .await
        .map_err(|e| format!("internal task error: {e}"))?;

        let rows = match rows_result {
            Ok(r) => r,
            Err(e) => {
                errors.push(json!({ "file": format!("{fname}.xlsx"), "error": format!("{e:#}") }));
                continue;
            }
        };

        // Convert Vec<Value::Object> to columnar format.
        let columns: Vec<String> = rows.first()
            .and_then(|r| r.as_object())
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();

        let mut data_rows: Vec<Vec<Value>> = rows.iter()
            .map(|row| {
                columns.iter()
                    .map(|k| row.get(k).cloned().unwrap_or(Value::Null))
                    .collect()
            })
            .collect();

        let mut col_names = columns.clone();

        // Apply group columns.
        apply_group_columns(&mut col_names, &mut data_rows, &grouping_path);

        // Apply strata columns when requested.
        if q.apply_strata == "Yes" {
            apply_strata_columns(&mut col_names, &mut data_rows, &strata);
        }

        let row_count = data_rows.len();
        let out_path_clone = out_path.clone();
        let fname_clone = fname.clone();
        let write_result = tokio::task::spawn_blocking(move || {
            write_datasheet(&out_path_clone, &fname_clone, &col_names, &data_rows)
        })
        .await
        .map_err(|e| format!("internal task error: {e}"))?;

        match write_result {
            Ok(_) => {
                saved.push(json!({
                    "file":  format!("{fname}.xlsx"),
                    "rows":  row_count,
                    "path":  out_path.to_string_lossy(),
                }));
            }
            Err(e) => {
                errors.push(json!({ "file": format!("{fname}.xlsx"), "error": e }));
            }
        }
    }

    // Write session metadata.
    let pt_count = req.point_ids.len();
    let folder_clone = folder.clone();
    let projects_meta = req.projects_meta.clone();
    let project_ids_clone = req.project_ids.clone();
    let state_ref = &*state;
    write_settings_json(&folder_clone, &project_ids_clone, pt_count, &projects_meta, state_ref).ok();

    Ok(json!({
        "success": true,
        "folder":  folder,
        "saved":   saved,
        "errors":  errors,
        "session": settings_path(&folder).to_string_lossy(),
    }))
}

/// Write the current app state to GIRTool_settings.json.
///
/// `session` should be a JSON object with the keys the frontend wants to
/// persist.  Any existing "charts" key is always preserved.
#[tauri::command]
pub async fn save_session(
    session: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = settings_path(&folder);

    // Preserve any existing "charts" key.
    let mut merged: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));

    // Shallow-merge: keys in `session` overwrite existing keys.
    if let (Some(existing), Some(patch)) = (merged.as_object_mut(), session.as_object()) {
        for (k, v) in patch {
            existing.insert(k.clone(), v.clone());
        }
    } else {
        merged = session;
    }

    let json = serde_json::to_string_pretty(&merged)
        .map_err(|e| format!("Serialise error: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Write error: {e}"))
}

/// Return GIRTool_settings.json (or `{}` when absent).
#[tauri::command]
pub async fn restore_session(state: State<'_, AppState>) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let _path = settings_path(&folder);

    // Try GIRTool_settings.json first, fall back to legacy session.json.
    for fname in &["GIRTool_settings.json", "session.json"] {
        let p = PathBuf::from(&folder).join(fname);
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                return Ok(v);
            }
        }
    }
    Ok(json!({}))
}
