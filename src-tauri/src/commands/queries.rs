// TODO (issue #6): Saved query CRUD — persist to output folder as queries.json.
use tauri::State;
use crate::state::AppState;

#[tauri::command]
pub async fn list_queries(_state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Err("Not implemented yet — see issue #6".into())
}

#[tauri::command]
pub async fn save_query(_state: State<'_, AppState>, _query: serde_json::Value) -> Result<(), String> {
    Err("Not implemented yet — see issue #6".into())
}

#[tauri::command]
pub async fn delete_query(_state: State<'_, AppState>, _id: String) -> Result<(), String> {
    Err("Not implemented yet — see issue #6".into())
}
