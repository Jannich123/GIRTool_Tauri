// TODO (issue #10): SharePoint integration via Microsoft Graph REST API.
//                   Device-code OAuth flow, file list, sync up/down.
//                   Use reqwest for HTTP. Persist token cache to app data dir.
use tauri::State;
use crate::state::AppState;

#[tauri::command]
pub async fn sp_status(_state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Err("Not implemented yet — see issue #10".into())
}

#[tauri::command]
pub async fn sp_initiate(_state: State<'_, AppState>, _config: serde_json::Value) -> Result<serde_json::Value, String> {
    Err("Not implemented yet — see issue #10".into())
}

#[tauri::command]
pub async fn sp_poll(_state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Err("Not implemented yet — see issue #10".into())
}

#[tauri::command]
pub async fn sp_disconnect(_state: State<'_, AppState>) -> Result<(), String> {
    Err("Not implemented yet — see issue #10".into())
}

#[tauri::command]
pub async fn sp_list(_state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Err("Not implemented yet — see issue #10".into())
}

#[tauri::command]
pub async fn sp_sync_down(_state: State<'_, AppState>) -> Result<(), String> {
    Err("Not implemented yet — see issue #10".into())
}

#[tauri::command]
pub async fn sp_sync_up(_state: State<'_, AppState>) -> Result<(), String> {
    Err("Not implemented yet — see issue #10".into())
}
