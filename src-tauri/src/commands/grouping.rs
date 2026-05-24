// Grouping commands — mirrors backend/routers/groups.py (systems CRUD) and
// backend/routers/grouping.py (assignments + Grouping.xlsx).
//
// Issue #17 implements the JSON-only system CRUD:
//   list_group_systems(project_id)          → Vec<Value>
//   save_group_systems(project_id, systems) → ()
//
// The Excel-side commands (get_grouping, save_grouping, open_grouping_excel,
// reload_from_excel) are stubs here; they are fully implemented in Issue #5
// (Batch 3).

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::State;

use crate::state::AppState;

// ── Constants ─────────────────────────────────────────────────────────────────

const UNKNOWN_NAME: &str = "Unknown";

fn unknown_defaults(gs_id: &str) -> Value {
    let id_prefix = &gs_id[..gs_id.len().min(16)];
    json!({
        "id":            format!("grp_unknown_{id_prefix}"),
        "name":          UNKNOWN_NAME,
        "color":         "#95a5a6",
        "symbol":        "circle",
        "markerSize":    6,
        "lineType":      "solid",
        "lineThickness": 1.5,
    })
}

// ── Storage paths ─────────────────────────────────────────────────────────────

/// %APPDATA%\GIRTool\projects\{project_id}\group_systems.json
fn group_systems_path(project_id: &str) -> Result<PathBuf, String> {
    let appdata = std::env::var("APPDATA")
        .map_err(|_| "APPDATA environment variable is not set".to_string())?;
    let dir = PathBuf::from(appdata)
        .join("GIRTool")
        .join("projects")
        .join(project_id);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create dir {}: {e}", dir.display()))?;
    Ok(dir.join("group_systems.json"))
}

// ── Business logic ────────────────────────────────────────────────────────────

/// Guarantee every system ends with a group named "Unknown".
///
/// Mirrors `_ensure_unknown_groups` from backend/routers/grouping.py:
/// * Separates "Unknown" from regular groups.
/// * If Unknown is absent, creates it with defaults.
/// * Appends Unknown last (always the catch-all, always at the end).
pub fn ensure_unknown_groups(systems: Vec<Value>) -> Vec<Value> {
    systems
        .into_iter()
        .map(|gs| {
            let gs_id = gs["id"].as_str().unwrap_or("?").to_string();
            let empty = vec![];
            let groups: Vec<Value> = gs["groups"]
                .as_array()
                .unwrap_or(&empty)
                .iter()
                .cloned()
                .collect();

            let regular: Vec<Value> = groups
                .iter()
                .filter(|g| g["name"].as_str() != Some(UNKNOWN_NAME))
                .cloned()
                .collect();

            let unknown: Value = groups
                .into_iter()
                .find(|g| g["name"].as_str() == Some(UNKNOWN_NAME))
                .unwrap_or_else(|| unknown_defaults(&gs_id));

            let mut updated = gs.clone();
            let mut new_groups = regular;
            new_groups.push(unknown);
            updated["groups"] = Value::Array(new_groups);
            updated
        })
        .collect()
}

// ── Commands — Issue #17 ──────────────────────────────────────────────────────

/// Return the group systems for a project.
/// Returns an empty array when no file exists yet (fresh project).
#[tauri::command]
pub async fn list_group_systems(project_id: String) -> Result<Vec<Value>, String> {
    let path = group_systems_path(&project_id)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Read error: {e}"))?;
    serde_json::from_str::<Vec<Value>>(&text)
        .map_err(|e| format!("Parse error: {e}"))
}

/// Full-replace the group systems, enforcing Unknown group at end of each system.
#[tauri::command]
pub async fn save_group_systems(
    project_id: String,
    systems: Vec<Value>,
) -> Result<(), String> {
    let path = group_systems_path(&project_id)?;
    let enforced = ensure_unknown_groups(systems);
    let json = serde_json::to_string_pretty(&enforced)
        .map_err(|e| format!("Serialise error: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Write error: {e}"))
}

// ── Commands — Issue #5 (Batch 3, stubs) ─────────────────────────────────────

#[tauri::command]
pub async fn get_grouping(
    _project_id: String,
    _state: State<'_, AppState>,
) -> Result<Value, String> {
    Err("Not implemented yet — see issue #5".into())
}

#[tauri::command]
pub async fn save_grouping(
    _project_id: String,
    _body: Value,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    Err("Not implemented yet — see issue #5".into())
}

#[tauri::command]
pub async fn open_grouping_excel(
    _project_id: String,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    Err("Not implemented yet — see issue #5".into())
}

#[tauri::command]
pub async fn reload_from_excel(
    _project_id: String,
    _state: State<'_, AppState>,
) -> Result<Value, String> {
    Err("Not implemented yet — see issue #5".into())
}
