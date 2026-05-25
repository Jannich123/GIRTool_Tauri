// Boundaries persistence — mirrors backend/routers/boundaries.py.
//
// Boundary polygons (map overlays) are stored in two places:
//   1. {output_folder}/{projectId}_boundaries.json  — canonical JSON store
//   2. {output_folder}/{projectId}_Boundaries.xlsx  — Excel export / import
//
// The JSON file is the primary store.  The xlsx file is written on every
// save so users can edit boundaries in Excel and re-import them.
//
// Commands:
//   get_boundaries(project_id)                   → Vec<Value>  read JSON store
//   save_boundaries(project_id, boundaries)      → ()   write JSON + xlsx
//   load_boundaries_from_excel(project_id)       → Vec<Value>  read xlsx
//   open_boundaries_excel(project_id)            → ()   open xlsx in OS

use std::path::{Path, PathBuf};

use calamine::{open_workbook_auto, DataType, Reader};
use rust_xlsxwriter::{Format, Workbook};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

// ── Paths ─────────────────────────────────────────────────────────────────────

fn boundaries_json_path(folder: &str, project_id: &str) -> PathBuf {
    PathBuf::from(folder).join(format!("{project_id}_boundaries.json"))
}

fn boundaries_xlsx_path(folder: &str, project_id: &str) -> PathBuf {
    PathBuf::from(folder).join(format!("{project_id}_Boundaries.xlsx"))
}

// ── Excel helpers ─────────────────────────────────────────────────────────────

/// Write boundaries to an xlsx workbook.
/// Phase 1: "_Settings" sheet with metadata (one row per boundary).
/// Phase 2: one coordinate sheet per boundary.
fn write_boundaries_xlsx(path: &Path, boundaries: &[Value]) -> Result<(), String> {
    let mut workbook = Workbook::new();
    let bold = Format::new().set_bold();

    // ── Phase 1: _Settings sheet ──────────────────────────────────────────────
    {
        let settings = workbook.add_worksheet();
        settings
            .set_name("_Settings")
            .map_err(|e| format!("Sheet name error: {e}"))?;

        let headers = ["name", "color", "lineWidth", "fillOpacity", "visible"];
        for (j, h) in headers.iter().enumerate() {
            settings
                .write_string_with_format(0, j as u16, *h, &bold)
                .map_err(|e| format!("Write error: {e}"))?;
        }

        for (i, boundary) in boundaries.iter().enumerate() {
            let row = (i + 1) as u32;
            let name = boundary.get("name").and_then(|v| v.as_str()).unwrap_or("Boundary");
            let color = boundary.get("color").and_then(|v| v.as_str()).unwrap_or("#3388ff");
            let line_width = boundary.get("lineWidth").and_then(|v| v.as_f64()).unwrap_or(2.0);
            let fill_opacity = boundary.get("fillOpacity").and_then(|v| v.as_f64()).unwrap_or(0.3);
            let visible = boundary.get("visible").and_then(|v| v.as_bool()).unwrap_or(true);

            settings.write_string(row, 0, name).ok();
            settings.write_string(row, 1, color).ok();
            settings.write_number(row, 2, line_width).ok();
            settings.write_number(row, 3, fill_opacity).ok();
            settings.write_boolean(row, 4, visible).ok();
        }
    } // settings borrow released here

    // ── Phase 2: per-boundary coordinate sheets ───────────────────────────────
    for boundary in boundaries {
        let name = boundary.get("name").and_then(|v| v.as_str()).unwrap_or("Boundary");
        let sheet_name: String = name.chars().take(31).collect();

        let ws = workbook.add_worksheet();
        if let Err(e) = ws.set_name(&sheet_name) {
            tracing::warn!("Could not set sheet name '{sheet_name}': {e}");
        }

        ws.write_string_with_format(0, 0, "longitude", &bold).ok();
        ws.write_string_with_format(0, 1, "latitude", &bold).ok();

        let empty = vec![];
        let coords = boundary
            .get("coordinates")
            .and_then(|v| v.as_array())
            .unwrap_or(&empty);

        for (r, point) in coords.iter().enumerate() {
            let row_idx = (r + 1) as u32;
            // Accept both [lon, lat] arrays and { lng/lon, lat } objects.
            match point {
                Value::Array(arr) => {
                    if let Some(lon_f) = arr.first().and_then(|v| v.as_f64()) {
                        ws.write_number(row_idx, 0, lon_f).ok();
                    }
                    if let Some(lat_f) = arr.get(1).and_then(|v| v.as_f64()) {
                        ws.write_number(row_idx, 1, lat_f).ok();
                    }
                }
                Value::Object(obj) => {
                    let lon = obj
                        .get("lng")
                        .or_else(|| obj.get("lon"))
                        .or_else(|| obj.get("longitude"))
                        .and_then(|v| v.as_f64());
                    let lat = obj
                        .get("lat")
                        .or_else(|| obj.get("latitude"))
                        .and_then(|v| v.as_f64());
                    if let Some(f) = lon { ws.write_number(row_idx, 0, f).ok(); }
                    if let Some(f) = lat { ws.write_number(row_idx, 1, f).ok(); }
                }
                _ => {}
            }
        }
    }

    workbook
        .save(path)
        .map_err(|e| format!("Failed to save boundaries xlsx: {e}"))
}

/// Read boundaries back from the xlsx exported by write_boundaries_xlsx.
fn read_boundaries_xlsx(path: &Path) -> Result<Vec<Value>, String> {
    let mut wb = open_workbook_auto(path)
        .map_err(|e| format!("Failed to open boundaries xlsx: {e}"))?;

    // Get the _Settings sheet for metadata.
    let settings_data = match wb.worksheet_range("_Settings") {
        Ok(range) => range,
        Err(_) => return Ok(Vec::new()),
    };

    let sheet_names: Vec<String> = wb.sheet_names().to_vec();

    let mut boundaries: Vec<Value> = Vec::new();

    // Row 0 is headers; rows 1+ are boundary metadata.
    for (i, settings_row) in settings_data.rows().skip(1).enumerate() {
        let get_str = |idx: usize| -> String {
            settings_row.get(idx).map(|c| c.to_string()).unwrap_or_default()
        };
        let get_f64 = |idx: usize| -> f64 {
            settings_row
                .get(idx)
                .and_then(|c| c.get_float())
                .unwrap_or(0.0)
        };
        let get_bool = |idx: usize| -> bool {
            settings_row
                .get(idx)
                .and_then(|c| c.get_bool())
                .unwrap_or(true)
        };

        let name = get_str(0);
        let color = get_str(1);
        let line_width = get_f64(2);
        let fill_opacity = get_f64(3);
        let visible = get_bool(4);

        // Load coordinates from the matching sheet (index + 1 because _Settings is index 0).
        let coord_sheet: String = sheet_names
            .get(i + 1)
            .map(|s| s.to_string())
            .unwrap_or_default();

        let coordinates: Vec<Value> = match wb.worksheet_range(&coord_sheet) {
            Ok(coord_range) => coord_range
                .rows()
                .skip(1) // skip header row
                .filter_map(|row| {
                    let lon = row.first()?.get_float()?;
                    let lat = row.get(1)?.get_float()?;
                    Some(json!([lon, lat]))
                })
                .collect(),
            Err(_) => Vec::new(),
        };

        boundaries.push(json!({
            "name":        name,
            "color":       color,
            "lineWidth":   line_width,
            "fillOpacity": fill_opacity,
            "visible":     visible,
            "coordinates": coordinates,
        }));
    }

    Ok(boundaries)
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Fast read of boundaries from the canonical JSON store.
///
/// Returns an empty array when the file does not exist yet.  This is the
/// preferred hot-path used by the UI on project load; `load_boundaries_from_excel`
/// is reserved for the "import from Excel" workflow.
#[tauri::command]
pub async fn get_boundaries(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let json_path = boundaries_json_path(&folder, &project_id);
    match std::fs::read_to_string(&json_path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("Parse error: {e}")),
        Err(_) => Ok(json!([])),
    }
}

/// Persist boundaries to JSON and xlsx.
#[tauri::command]
pub async fn save_boundaries(
    project_id: String,
    boundaries: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;

    let list: Vec<Value> = match &boundaries {
        Value::Array(a) => a.clone(),
        _ => return Err("boundaries must be an array".into()),
    };

    // Write JSON (primary store).
    let json_path = boundaries_json_path(&folder, &project_id);
    let json =
        serde_json::to_string_pretty(&list).map_err(|e| format!("Serialise error: {e}"))?;
    std::fs::write(&json_path, json).map_err(|e| format!("Write error: {e}"))?;

    // Write xlsx (secondary store, best-effort).
    let xlsx_path = boundaries_xlsx_path(&folder, &project_id);
    let list_clone = list.clone();
    tokio::task::spawn_blocking(move || write_boundaries_xlsx(&xlsx_path, &list_clone))
        .await
        .map_err(|e| format!("internal task error: {e}"))??;

    Ok(())
}

/// Load boundaries from the xlsx export file.
/// Falls back to the JSON store if xlsx is absent.
#[tauri::command]
pub async fn load_boundaries_from_excel(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let xlsx_path = boundaries_xlsx_path(&folder, &project_id);
    let json_path = boundaries_json_path(&folder, &project_id);

    if xlsx_path.exists() {
        let result = tokio::task::spawn_blocking(move || read_boundaries_xlsx(&xlsx_path))
            .await
            .map_err(|e| format!("internal task error: {e}"))?;
        match result {
            Ok(boundaries) => return Ok(Value::Array(boundaries)),
            Err(e) => tracing::warn!("Failed to read boundaries xlsx: {e}; falling back to JSON"),
        }
    }

    // JSON fallback.
    match std::fs::read_to_string(&json_path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("Parse error: {e}")),
        Err(_) => Ok(json!([])),
    }
}

/// Open the boundaries xlsx in the OS default application.
#[tauri::command]
pub async fn open_boundaries_excel(
    project_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = boundaries_xlsx_path(&folder, &project_id);

    if !path.exists() {
        return Err(format!(
            "Boundaries workbook not found: {}",
            path.display()
        ));
    }

    app.opener()
        .open_path(path.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| format!("Failed to open boundaries workbook: {e}"))
}
