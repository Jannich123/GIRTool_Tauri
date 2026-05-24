// TODO (issue #5): Query point data from SQL Server with filters.
use tauri::State;
use crate::state::AppState;

#[tauri::command]
pub async fn get_points(_state: State<'_, AppState>, _project_ids: Vec<String>) -> Result<serde_json::Value, String> {
    Err("Not implemented yet — see issue #5".into())
}
