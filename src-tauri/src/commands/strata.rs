// TODO (issue #8): strata.xlsx creation, load, and update using rust_xlsxwriter + calamine.
use tauri::State;
use crate::state::AppState;

#[tauri::command]
pub async fn ensure_strata_file(_state: State<'_, AppState>) -> Result<(), String> {
    Err("Not implemented yet — see issue #8".into())
}

#[tauri::command]
pub async fn load_strata(_state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Err("Not implemented yet — see issue #8".into())
}

#[tauri::command]
pub async fn update_strata(_state: State<'_, AppState>, _rows: serde_json::Value) -> Result<(), String> {
    Err("Not implemented yet — see issue #8".into())
}
