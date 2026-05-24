// TODO (issue #9): Excel datasheet export and session save/restore.
//                  Write xlsx using rust_xlsxwriter.
use tauri::State;
use crate::state::AppState;

#[tauri::command]
pub async fn download_data(_state: State<'_, AppState>, _query: serde_json::Value) -> Result<String, String> {
    Err("Not implemented yet — see issue #9".into())
}

#[tauri::command]
pub async fn save_session(_state: State<'_, AppState>, _session: serde_json::Value) -> Result<(), String> {
    Err("Not implemented yet — see issue #9".into())
}

#[tauri::command]
pub async fn restore_session(_state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Err("Not implemented yet — see issue #9".into())
}
