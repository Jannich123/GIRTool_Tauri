// TODO (issue #11): Open Colors_&_Symbols.xlsx in default app using tauri-plugin-opener.
use tauri::State;
use crate::state::AppState;

#[tauri::command]
pub async fn open_colors_excel(_state: State<'_, AppState>, _sheet: Option<String>) -> Result<(), String> {
    Err("Not implemented yet — see issue #11".into())
}
