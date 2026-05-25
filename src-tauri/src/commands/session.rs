// Session state persistence — mirrors backend/routers/session.py.
//
// Storage: {output_folder}/GIRTool_settings.json  (same file as download_data)
//
//   GIRTool_settings.json is a flat JSON object.  Top-level keys written by
//   download_data (selected_projects, point_count, …) are never overwritten
//   here.  Per-project session data lives under a "sessions" sub-object:
//
//     {
//       "selected_projects": [...],     ← written by download_data
//       "sessions": {                   ← written by patch_session
//         "<projectId>": {
//           "charts":           {...},
//           "boundaries":       [...],
//           "selected_projects": [...],
//         }
//       }
//     }
//
// Commands:
//   get_session(project_id)           → session object for the project (or {})
//   patch_session(project_id, patch)  → ()  shallow-merge allowed keys only

use serde_json::{json, Map, Value};
use tauri::State;

use crate::state::AppState;

// Keys that patch_session is allowed to write into the per-project session.
// Mirrors Python ALLOWED_PATCH_KEYS = {"charts", "boundaries"}.
// selected_projects added per issue #19 acceptance criteria.
const PATCHABLE_KEYS: &[&str] = &[
    "charts",
    "boundaries",
    "filters",
    "strata",
    "selected_projects",
];

// ── Path helper ───────────────────────────────────────────────────────────────

fn settings_path(output_folder: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(output_folder).join("GIRTool_settings.json")
}

// ── Low-level I/O ─────────────────────────────────────────────────────────────

/// Read GIRTool_settings.json as a JSON object; returns an empty map on error.
fn read_settings(output_folder: &str) -> Map<String, Value> {
    let path = settings_path(output_folder);
    let Ok(bytes) = std::fs::read(&path) else { return Map::new() };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

/// Write the settings map back to GIRTool_settings.json.
fn write_settings(output_folder: &str, settings: &Map<String, Value>) -> Result<(), String> {
    let path = settings_path(output_folder);
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialise settings: {e}"))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Return the session object for a project from GIRTool_settings.json.
///
/// Returns `{}` when the file is absent or no session has been saved yet.
#[tauri::command]
pub async fn get_session(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;

    let session = tokio::task::spawn_blocking(move || {
        let settings = read_settings(&folder);
        // Per-project session stored under settings["sessions"]["<projectId>"].
        settings
            .get("sessions")
            .and_then(|v| v.as_object())
            .and_then(|m| m.get(&project_id))
            .cloned()
            .unwrap_or(json!({}))
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?;

    Ok(session)
}

/// Shallow-merge allowed keys from `patch` into the per-project session inside
/// GIRTool_settings.json.
///
/// Only keys in `PATCHABLE_KEYS` are written.  All other top-level keys in
/// GIRTool_settings.json (selected_projects, point_count, server, database, …)
/// are preserved unchanged — this mirrors Python's restricted PATCH behaviour.
#[tauri::command]
pub async fn patch_session(
    project_id: String,
    patch: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;

    tokio::task::spawn_blocking(move || {
        let mut settings = read_settings(&folder);

        // Ensure settings["sessions"] exists as an object.
        let sessions_val = settings
            .entry("sessions".to_string())
            .or_insert_with(|| json!({}));
        let sessions_map = match sessions_val.as_object_mut() {
            Some(m) => m,
            None => return Err("settings[\"sessions\"] is not an object".to_string()),
        };

        // Ensure the per-project entry exists.
        let entry = sessions_map
            .entry(project_id)
            .or_insert_with(|| json!({}));

        if let (Some(existing), Some(patch_obj)) =
            (entry.as_object_mut(), patch.as_object())
        {
            for key in PATCHABLE_KEYS {
                if let Some(v) = patch_obj.get(*key) {
                    existing.insert((*key).to_string(), v.clone());
                }
            }
        }

        write_settings(&folder, &settings)
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?
}
