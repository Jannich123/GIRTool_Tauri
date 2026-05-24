// TODO (issue #4): Query SQL Server for project list.
use tauri::State;
use crate::state::AppState;
use serde::Serialize;

#[derive(Serialize)]
pub struct Project {
    pub id:   String,
    pub name: String,
    pub no:   String,
}

#[tauri::command]
pub async fn list_projects(_state: State<'_, AppState>) -> Result<Vec<Project>, String> {
    Err("Not implemented yet — see issue #4".into())
}
