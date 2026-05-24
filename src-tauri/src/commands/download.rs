// Excel export and session persistence — mirrors backend/routers/download.py.
//
// download_data:
//   Execute a named query for a set of project/point IDs and write the
//   result to an xlsx datasheet in the output folder.  Returns the path
//   of the written file so the frontend can display it or open it.
//
// save_session / restore_session:
//   Persist the full application state (chart configs, filters, etc.) to a
//   named JSON snapshot file so users can pick up where they left off.
//
// Storage:
//   {output_folder}/{queryName}_{projectNo}.xlsx   — exported datasheet
//   {output_folder}/GIRTool_saved_session.json     — session snapshot

use std::path::{Path, PathBuf};

use rust_xlsxwriter::{Format, Workbook};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

use crate::state::AppState;

// ── Request types ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct DownloadQuery {
    pub project_ids: Vec<String>,
    #[serde(default)]
    pub point_ids: Vec<String>,
    pub query_name: String,
    /// Optional label used to build the output filename.
    #[serde(default)]
    pub project_no: Option<String>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn session_snapshot_path(folder: &str) -> PathBuf {
    PathBuf::from(folder).join("GIRTool_saved_session.json")
}

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
        Err(format!("Invalid ID: {s}"))
    }
}

fn safe_id_list(ids: &[String]) -> Result<String, String> {
    ids.iter()
        .map(|id| sanitise_id(id))
        .collect::<Result<Vec<_>, _>>()
        .map(|v| v.join(", "))
}

/// Build query SQL by substituting the standard placeholders.
fn build_download_sql(
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

    Ok(q.sql_script
        .replace("#DB#", "")
        .replace("#projectid#", &proj_str)
        .replace("#pointfilter#", &point_filter))
}

/// Write a Vec<Value> (row objects) to an xlsx file.
/// Returns the number of rows written.
fn write_datasheet(path: &Path, rows: &[Value]) -> Result<usize, String> {
    let mut workbook = Workbook::new();
    let bold = Format::new().set_bold();
    let ws = workbook.add_worksheet();

    if rows.is_empty() {
        workbook
            .save(path)
            .map_err(|e| format!("Failed to save xlsx: {e}"))?;
        return Ok(0);
    }

    // Derive column order from first row.
    let columns: Vec<String> = rows
        .first()
        .and_then(|r| r.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();

    // Header row.
    for (j, col) in columns.iter().enumerate() {
        ws.write_string_with_format(0, j as u16, col, &bold)
            .map_err(|e| format!("Header write error: {e}"))?;
    }

    // Data rows.
    for (i, row) in rows.iter().enumerate() {
        let row_idx = (i + 1) as u32;
        if let Some(obj) = row.as_object() {
            for (j, col) in columns.iter().enumerate() {
                write_cell(ws, row_idx, j as u16, obj.get(col.as_str()).unwrap_or(&Value::Null));
            }
        }
    }

    workbook
        .save(path)
        .map_err(|e| format!("Failed to save xlsx: {e}"))?;
    Ok(rows.len())
}

fn write_cell(ws: &mut rust_xlsxwriter::Worksheet, row: u32, col: u16, val: &Value) {
    match val {
        Value::Null => {
            let _ = ws.write_blank(row, col, &Format::default());
        }
        Value::Bool(b) => {
            let _ = ws.write_boolean(row, col, *b);
        }
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                let _ = ws.write_number(row, col, f);
            }
        }
        Value::String(s) => {
            let _ = ws.write_string(row, col, s);
        }
        other => {
            let _ = ws.write_string(row, col, &other.to_string());
        }
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Execute a query and write the result to an xlsx datasheet.
/// Returns the full path of the written file.
#[tauri::command]
pub async fn download_data(
    query: DownloadQuery,
    state: State<'_, AppState>,
) -> Result<String, String> {
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

    let sql = build_download_sql(&state, &query.query_name, &query.project_ids, &query.point_ids)?;

    // Execute the query on a blocking thread.
    let rows = tokio::task::spawn_blocking(move || crate::db::query_rows(&cfg, &sql))
        .await
        .map_err(|e| format!("internal task error: {e}"))?
        .map_err(|e| format!("{e:#}"))?;

    // Build output filename: {queryName}_{projectNo}.xlsx
    let label = query
        .project_no
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "download".to_string());
    let safe_label: String = label
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    let filename = format!("{}_{}.xlsx", query.query_name, safe_label);
    let path = PathBuf::from(&folder).join(&filename);

    tokio::task::spawn_blocking(move || write_datasheet(&path, &rows).map(|_| path))
        .await
        .map_err(|e| format!("internal task error: {e}"))?
        .map(|p| p.to_string_lossy().into_owned())
}

/// Persist the full application session state to a JSON snapshot.
#[tauri::command]
pub async fn save_session(
    session: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = session_snapshot_path(&folder);
    let json =
        serde_json::to_string_pretty(&session).map_err(|e| format!("Serialise error: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Write error: {e}"))
}

/// Load the most-recently-saved session snapshot.
/// Returns {} when no snapshot exists.
#[tauri::command]
pub async fn restore_session(state: State<'_, AppState>) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = session_snapshot_path(&folder);
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("Parse error: {e}")),
        Err(_) => Ok(json!({})),
    }
}
