// TODO (issue #14): WFS proxy — forward requests to WFS servers using reqwest
//                   to bypass CORS restrictions in WebView2.
use tauri::State;
use crate::state::AppState;

#[tauri::command]
pub async fn wfs_proxy(_state: State<'_, AppState>, _url: String) -> Result<String, String> {
    Err("Not implemented yet — see issue #14".into())
}
