// TODO (issue #7): Group systems (JSON) + point assignments (Grouping.xlsx).
//                  Read/write Grouping.xlsx using calamine (read) and rust_xlsxwriter (write).
use tauri::State;
use crate::state::AppState;

#[tauri::command]
pub async fn get_grouping(_state: State<'_, AppState>, _project_id: String) -> Result<serde_json::Value, String> {
    Err("Not implemented yet — see issue #7".into())
}

#[tauri::command]
pub async fn save_grouping(_state: State<'_, AppState>, _project_id: String, _body: serde_json::Value) -> Result<(), String> {
    Err("Not implemented yet — see issue #7".into())
}

#[tauri::command]
pub async fn open_grouping_excel(_state: State<'_, AppState>, _project_id: String) -> Result<(), String> {
    Err("Not implemented yet — see issue #7".into())
}

#[tauri::command]
pub async fn reload_from_excel(_state: State<'_, AppState>, _project_id: String) -> Result<serde_json::Value, String> {
    Err("Not implemented yet — see issue #7".into())
}
