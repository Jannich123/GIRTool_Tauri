// TODO (issue #13): Chart config persistence — save/load JSON from output folder.
use tauri::State;
use crate::state::AppState;

#[tauri::command]
pub async fn get_chart_config(_state: State<'_, AppState>, _project_id: String) -> Result<serde_json::Value, String> {
    Err("Not implemented yet — see issue #13".into())
}

#[tauri::command]
pub async fn save_chart_config(_state: State<'_, AppState>, _project_id: String, _config: serde_json::Value) -> Result<(), String> {
    Err("Not implemented yet — see issue #13".into())
}
