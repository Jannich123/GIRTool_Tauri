// Session state persistence — mirrors backend/routers/session.py.
//
// The Python build stores a flat GIRTool_settings.json per output folder and
// restricts PATCH to the `charts` and `boundaries` keys only.
//
// Rust design: per-project keyed JSON (GIRTool_sessions.json) so multiple
// projects in the same output folder each have isolated session state.
//
//   get_session(project_id)         → project's session object (or {})
//   patch_session(project_id, patch) → ()  shallow-merge; only chart/boundary
//                                         keys are accepted (matching Python)
//
// Storage:
//   {output_folder}/GIRTool_sessions.json
//     Structure: { "<projectId>": { "charts": …, "boundaries": …, … } }
//
// Fall-back: if GIRTool_sessions.json is absent but GIRTool_settings.json
// exists (written by download_data), the latter is read and its "charts" key
// is surfaced under the given project_id so the session page loads correctly
// on first use after a download.

use serde_json::{json, Map, Value};
use tauri::State;

use crate::state::AppState;

// Keys that patch_session is allowed to overwrite.
// Mirrors Python ALLOWED_PATCH_KEYS = {"charts", "boundaries"}.
const PATCHABLE_KEYS: &[&str] = &["charts", "boundaries", "filters", "strata"];

// ── Helpers ───────────────────────────────────────────────────────────────────

fn sessions_path(output_folder: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(output_folder).join("GIRTool_sessions.json")
}

fn settings_path(output_folder: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(output_folder).join("GIRTool_settings.json")
}

/// Read the per-project sessions map.  Returns an empty map on any I/O error.
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

/// Try to read the "charts" key from GIRTool_settings.json (written by
/// download_data) so first-time users see their chart config without an
/// explicit session save.
fn charts_from_settings(output_folder: &str) -> Option<Value> {
    let path = settings_path(output_folder);
    let s = std::fs::read_to_string(&path).ok()?;
    let v: Value = serde_json::from_str(&s).ok()?;
    v.get("charts").cloned()
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Return the session object for a project.
///
/// Falls back to reading `charts` from GIRTool_settings.json when no
/// per-project session has been saved yet (e.g. after a fresh download).
#[tauri::command]
pub async fn get_session(
    project_id: String,
    state:      State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;

    let folder_clone = folder.clone();
    let pid_clone    = project_id.clone();
    let (mut session, charts_fallback) = tokio::task::spawn_blocking(move || {
        let sessions = read_all_sessions(&folder_clone);
        let has_entry = sessions.contains_key(&pid_clone);
        let sess = sessions
            .get(&pid_clone)
            .cloned()
            .unwrap_or_else(|| json!({}));
        let fallback = if !has_entry {
            charts_from_settings(&folder_clone)
        } else {
            None
        };
        (sess, fallback)
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?;

    // If session has no "charts" key yet, seed it from GIRTool_settings.json.
    if session.get("charts").is_none() {
        if let Some(charts) = charts_fallback {
            session["charts"] = charts;
        }
    }

    Ok(session)
}

/// Shallow-merge allowed keys from `patch` into the stored session.
///
/// Only keys in `PATCHABLE_KEYS` are written.  All other top-level keys in
/// the stored session (e.g. metadata written by download_data) are preserved.
/// This mirrors Python's restricted PATCH behaviour.
#[tauri::command]
pub async fn patch_session(
    project_id: String,
    patch:      Value,
    state:      State<'_, AppState>,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;

    tokio::task::spawn_blocking(move || {
        let mut sessions = read_all_sessions(&folder);

        let entry = sessions
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

        write_all_sessions(&folder, &sessions)
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?
}
