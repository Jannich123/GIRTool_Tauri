// TODO (issue #12): Read GIRTool_Column_Reference.xlsx from the app resource dir using calamine.
use tauri::State;
use crate::state::AppState;

#[tauri::command]
pub async fn get_columns(_state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Err("Not implemented yet — see issue #12".into())
}
