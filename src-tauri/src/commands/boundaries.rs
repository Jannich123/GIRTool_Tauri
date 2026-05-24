// TODO (issue #18): Boundaries.xlsx save/load/open.
//                   One sheet per boundary + _Settings sheet for visual properties.
//                   Read with calamine, write with rust_xlsxwriter.
use tauri::State;
use crate::state::AppState;

#[tauri::command]
pub async fn save_boundaries(_state: State<'_, AppState>, _project_id: String, _boundaries: serde_json::Value) -> Result<(), String> {
    Err("Not implemented yet — see issue #18".into())
}

#[tauri::command]
pub async fn load_boundaries_from_excel(_state: State<'_, AppState>, _project_id: String) -> Result<serde_json::Value, String> {
    Err("Not implemented yet — see issue #18".into())
}

#[tauri::command]
pub async fn open_boundaries_excel(_state: State<'_, AppState>, _project_id: String) -> Result<(), String> {
    Err("Not implemented yet — see issue #18".into())
}
