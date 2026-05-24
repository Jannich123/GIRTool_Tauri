// Session state persistence for GIRTool.
//
// Sessions are stored as JSON files in the output folder:
//   {output_folder}/GIRTool_sessions.json
//
// The file is a JSON object keyed by projectId:
//   { "<projectId>": { "charts": [...], "boundaries": [...], ... } }
//
// `get_session`   — read the session object for a project (returns {} if absent)
// `patch_session` — shallow-merge a patch into the stored session and write back

use serde_json::{json, Map, Value};
use tauri::State;

use crate::state::AppState;

// ── Helpers ───────────────────────────────────────────────────────────────────

fn sessions_path(output_folder: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(output_folder).join("GIRTool_sessions.json")
}

/// Read the sessions file, returning an empty object if absent or unreadable.
fn read_all_sessions(output_folder: &str) -> Map<String, Value> {
    let path = sessions_path(output_folder);
    let Ok(bytes) = std::fs::read(&path) else { return Map::new() };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

/// Write the sessions map back to disk.
fn write_all_sessions(output_folder: &str, sessions: &Map<String, Value>) -> Result<(), String> {
    let path = sessions_path(output_folder);
    let json = serde_json::to_string_pretty(sessions)
        .map_err(|e| format!("Failed to serialise sessions: {e}"))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_session(
    project_id: String,
    state:      State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let sessions = tokio::task::spawn_blocking(move || read_all_sessions(&folder))
        .await
        .map_err(|e| format!("internal task error: {e}"))?;
    Ok(sessions.get(&project_id).cloned().unwrap_or(json!({})))
}

#[tauri::command]
pub async fn patch_session(
    project_id: String,
    patch:      Value,
    state:      State<'_, AppState>,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    tokio::task::spawn_blocking(move || {
        let mut sessions = read_all_sessions(&folder);

        // Shallow-merge: top-level keys in `patch` overwrite those in the
        // existing session; keys absent from `patch` are preserved.
        let entry = sessions
            .entry(project_id)
            .or_insert_with(|| json!({}));

        if let (Some(existing), Some(patch_obj)) = (entry.as_object_mut(), patch.as_object()) {
            for (k, v) in patch_obj {
                existing.insert(k.clone(), v.clone());
            }
        } else {
            *entry = patch;
        }

        write_all_sessions(&folder, &sessions)
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?
}
