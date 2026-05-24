// Chart command implementations.
//
// Storage layout (all under {output_folder}/):
//   {projectId}_chart_config.json  — per-project chart panel configuration
//   {projectId}_statistics.xlsx    — exported statistics workbook
//
// Commands:
//   get_chart_config(project_id)          → Value (stored config or {})
//   save_chart_config(project_id, config) → ()
//   run_chart_query(project_id, query)    → { columns, rows, truncated }
//   save_statistics(project_id, stats)    → { skipped }
//   open_statistics(project_id, stats)    → ()   (save then open)
//   open_datasheet(path)                  → ()   (open existing xlsx in OS)

use std::path::{Path, PathBuf};

use rust_xlsxwriter::{Format, Workbook, Worksheet};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

// ── Helpers ───────────────────────────────────────────────────────────────────

fn chart_config_path(output_folder: &str, project_id: &str) -> PathBuf {
    PathBuf::from(output_folder).join(format!("{project_id}_chart_config.json"))
}

fn statistics_path(output_folder: &str, project_id: &str) -> PathBuf {
    PathBuf::from(output_folder).join(format!("{project_id}_statistics.xlsx"))
}

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

/// Build the SQL for a named query by substituting #projectid#, #pointid#,
/// and #DB# placeholders.  Returns the full SQL string ready to execute.
fn build_chart_sql(
    state: &AppState,
    query_name: &str,
    project_ids: &[String],
    point_ids: &[String],
) -> Result<String, String> {
    // Find the matching query definition.
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
/// `rows` is an array of row-objects keyed by column name.
#[tauri::command]
pub async fn run_chart_query(
    _project_id: String,
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

    // Build SQL on the calling thread (cheap, no I/O).
    let sql = build_chart_sql(&state, &query.query_name, &query.project_ids, &query.point_ids)?;

    // Execute on a blocking thread to avoid blocking the async runtime.
    let rows = tokio::task::spawn_blocking(move || crate::db::query_rows(&cfg, &sql))
        .await
        .map_err(|e| format!("internal task error: {e}"))?
        .map_err(|e| format!("{e:#}"))?;

    let truncated = rows.len() > MAX_CHART_ROWS;
    let rows: Vec<Value> = rows.into_iter().take(MAX_CHART_ROWS).collect();

    // Derive column list from first row (preserves DB column order if we had it;
    // serde_json::Map is insertion-ordered so this is stable).
    let columns: Vec<String> = rows
        .first()
        .and_then(|r| r.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();

    Ok(json!({
        "columns":   columns,
        "rows":      rows,
        "truncated": truncated,
    }))
}

// ── save_statistics / open_statistics ─────────────────────────────────────────

/// Write one worksheet per chart into an xlsx workbook.
/// Each chart is expected to have { name, columns: [...], rows: [...] }.
fn write_statistics_workbook(path: &Path, charts: &[Value]) -> Result<Vec<String>, String> {
    let mut workbook = Workbook::new();
    let bold = Format::new().set_bold();
    let mut skipped: Vec<String> = Vec::new();

    for chart in charts {
        let name = chart
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Chart");

        let columns = match chart.get("columns").and_then(|v| v.as_array()) {
            Some(c) => c.clone(),
            None => {
                skipped.push(name.to_string());
                continue;
            }
        };
        let rows = match chart.get("rows").and_then(|v| v.as_array()) {
            Some(r) => r.clone(),
            None => {
                skipped.push(name.to_string());
                continue;
            }
        };

        // Truncate worksheet name to Excel's 31-char limit.
        let sheet_name: String = name.chars().take(31).collect();
        let ws = workbook.add_worksheet();
        if let Err(e) = ws.set_name(&sheet_name) {
            tracing::warn!("Could not set sheet name '{sheet_name}': {e}");
        }

        // Header row.
        for (j, col) in columns.iter().enumerate() {
            let col_name = col.as_str().unwrap_or("");
            ws.write_string_with_format(0, j as u16, col_name, &bold)
                .map_err(|e| format!("Header write error: {e}"))?;
        }

        // Data rows.
        for (i, row) in rows.iter().enumerate() {
            let row_idx = (i + 1) as u32;
            write_row_to_sheet(ws, row_idx, &columns, row)?;
        }
    }

    workbook
        .save(path)
        .map_err(|e| format!("Failed to save xlsx: {e}"))?;
    Ok(skipped)
}

fn write_row_to_sheet(
    ws: &mut Worksheet,
    row_idx: u32,
    columns: &[Value],
    row: &Value,
) -> Result<(), String> {
    match row {
        // Row is an object keyed by column name.
        Value::Object(obj) => {
            for (j, col_key) in columns.iter().enumerate() {
                let key = col_key.as_str().unwrap_or("");
                write_cell(ws, row_idx, j as u16, obj.get(key).unwrap_or(&Value::Null));
            }
        }
        // Row is a positional array.
        Value::Array(cells) => {
            for (j, cell) in cells.iter().enumerate() {
                write_cell(ws, row_idx, j as u16, cell);
            }
        }
        _ => {}
    }
    Ok(())
}

fn write_cell(ws: &mut Worksheet, row: u32, col: u16, val: &Value) {
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

/// Persist statistics charts to an xlsx workbook.
/// Returns { skipped: ["chart name", ...] } for any charts that couldn't be
/// written (missing columns / rows).
#[tauri::command]
pub async fn save_statistics(
    project_id: String,
    stats: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = statistics_path(&folder, &project_id);

    let charts: Vec<Value> = stats
        .get("charts")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let skipped = tokio::task::spawn_blocking(move || {
        write_statistics_workbook(&path, &charts)
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))??;

    Ok(json!({ "skipped": skipped }))
}

/// Save statistics to xlsx then open it in the default application.
#[tauri::command]
pub async fn open_statistics(
    project_id: String,
    stats: Value,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = statistics_path(&folder, &project_id);

    let charts: Vec<Value> = stats
        .get("charts")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

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
/// `path` is either a full file-system path or, when it looks like a bare
/// query name (no path separators), we resolve it against the output folder as
/// `{output_folder}/{path}.xlsx`.
#[tauri::command]
pub async fn open_datasheet(
    path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let resolved: PathBuf = if path.contains(std::path::MAIN_SEPARATOR)
        || path.contains('/')
    {
        PathBuf::from(&path)
    } else {
        // Treat as a query name → resolve against the output folder.
        let folder = state.output_folder().ok_or("No output folder configured.")?;
        PathBuf::from(&folder).join(format!("{path}.xlsx"))
    };

    if !resolved.exists() {
        return Err(format!("Datasheet not found: {}", resolved.display()));
    }

    app.opener()
        .open_path(resolved.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| format!("Failed to open datasheet: {e}"))
}
