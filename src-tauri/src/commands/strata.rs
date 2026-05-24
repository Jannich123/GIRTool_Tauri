// Strata interpretation commands.
//
// Strata data (layer boundaries, point-level assignments) are persisted as a
// JSON file in the output folder:
//   {output_folder}/{projectId}_strata.json
//
// The file has shape:
//   {
//     "layers":        { ... layer config ... },
//     "point_layers":  { "<pointId>": [...], ... }
//   }
//
// Commands:
//   ensure_strata_file(project_id)        → ()    create file if absent
//   load_strata(project_id)               → Value full strata object
//   update_strata(project_id, rows)       → ()    overwrite the stored object
//   get_strata_layers(project_id)         → Value layers sub-object
//   get_strata_point_layers(project_id)   → { point_layers: {...} }

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::State;

use crate::state::AppState;

// ── Helpers ───────────────────────────────────────────────────────────────────

fn strata_path(output_folder: &str, project_id: &str) -> PathBuf {
    PathBuf::from(output_folder).join(format!("{project_id}_strata.json"))
}

fn read_strata(output_folder: &str, project_id: &str) -> Value {
    let path = strata_path(output_folder, project_id);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({ "layers": {}, "point_layers": {} }))
}

fn write_strata(output_folder: &str, project_id: &str, data: &Value) -> Result<(), String> {
    let path = strata_path(output_folder, project_id);
    let json =
        serde_json::to_string_pretty(data).map_err(|e| format!("Serialise error: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Write error: {e}"))
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Ensure the strata JSON file exists (create with defaults if absent).
#[tauri::command]
pub async fn ensure_strata_file(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = strata_path(&folder, &project_id);
    if !path.exists() {
        let default = json!({ "layers": {}, "point_layers": {} });
        let json =
            serde_json::to_string_pretty(&default).map_err(|e| format!("Serialise error: {e}"))?;
        std::fs::write(&path, json).map_err(|e| format!("Write error: {e}"))?;
    }
    Ok(())
}

/// Return the full strata object for a project.
#[tauri::command]
pub async fn load_strata(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    Ok(read_strata(&folder, &project_id))
}

/// Overwrite the strata object for a project.
#[tauri::command]
pub async fn update_strata(
    project_id: String,
    rows: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    write_strata(&folder, &project_id, &rows)
}

/// Return just the `layers` sub-object (used by FilterContext on project load).
#[tauri::command]
pub async fn get_strata_layers(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let data = read_strata(&folder, &project_id);
    Ok(data
        .get("layers")
        .cloned()
        .unwrap_or_else(|| json!({})))
}

/// Return `{ point_layers: {...} }` (used by FilterContext on project load).
#[tauri::command]
pub async fn get_strata_point_layers(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let data = read_strata(&folder, &project_id);
    let point_layers = data
        .get("point_layers")
        .cloned()
        .unwrap_or_else(|| json!({}));
    Ok(json!({ "point_layers": point_layers }))
}
