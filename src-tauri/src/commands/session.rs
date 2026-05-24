// TODO (issue #19): Session state get and patch for GIRTool_settings.json.
//                   Shallow merge so chart/boundary updates don't overwrite DB config.
use tauri::State;
use crate::state::AppState;

#[tauri::command]
pub async fn get_session(_state: State<'_, AppState>, _project_id: String) -> Result<serde_json::Value, String> {
    Err("Not implemented yet — see issue #19".into())
}

#[tauri::command]
pub async fn patch_session(_state: State<'_, AppState>, _project_id: String, _patch: serde_json::Value) -> Result<(), String> {
    Err("Not implemented yet — see issue #19".into())
}
