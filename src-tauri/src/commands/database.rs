// TODO (issue #3): Implement SQL Server connection, settings persistence,
//                  folder browse dialog using tauri-plugin-dialog.
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct ConnectArgs {
    pub server:        String,
    pub database:      String,
    pub auth_method:   String,
    pub username:      Option<String>,
    pub password:      Option<String>,
    pub output_folder: Option<String>,
}

#[derive(Serialize)]
pub struct StatusResult {
    pub connected:     bool,
    pub server:        String,
    pub database:      String,
    pub output_folder: String,
}

#[tauri::command]
pub async fn connect(_args: ConnectArgs, _state: State<'_, AppState>) -> Result<StatusResult, String> {
    Err("Not implemented yet — see issue #3".into())
}

#[tauri::command]
pub async fn disconnect(_state: State<'_, AppState>) -> Result<(), String> {
    Err("Not implemented yet — see issue #3".into())
}

#[tauri::command]
pub async fn connection_status(_state: State<'_, AppState>) -> Result<StatusResult, String> {
    Err("Not implemented yet — see issue #3".into())
}

#[tauri::command]
pub async fn browse_folder(_initial: Option<String>) -> Result<Option<String>, String> {
    // Use tauri-plugin-dialog to open a native folder picker.
    // TODO (issue #3)
    Err("Not implemented yet — see issue #3".into())
}

#[tauri::command]
pub async fn test_folder(_path: String) -> Result<bool, String> {
    Err("Not implemented yet — see issue #3".into())
}
