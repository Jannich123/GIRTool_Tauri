// Colors & Symbols commands.
//
// The Colors & Symbols workbook (Colors_Symbols.xlsx) lives in the output
// folder.  Color / symbol settings are persisted as a companion JSON file
// (colors.json in the same folder) so the frontend can round-trip them
// without needing to parse xlsx every time.
//
// Commands:
//   open_colors_excel(sheet)          → ()    open the xlsx in the OS default app
//   load_colors()                     → Value the stored color/symbol config
//   save_colors(project_id, body)     → ()    persist color/symbol config to disk

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

// ── Paths ─────────────────────────────────────────────────────────────────────

fn colors_xlsx_path(output_folder: &str) -> PathBuf {
    PathBuf::from(output_folder).join("Colors_Symbols.xlsx")
}

fn colors_json_path(output_folder: &str) -> PathBuf {
    PathBuf::from(output_folder).join("colors.json")
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Open the Colors & Symbols workbook in the OS default application.
/// `sheet` is ignored at the OS-open level but kept for API compatibility with
/// the Python build which scrolled to a named sheet.
#[tauri::command]
pub async fn open_colors_excel(
    _sheet: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = colors_xlsx_path(&folder);

    if !path.exists() {
        return Err(format!(
            "Colors & Symbols workbook not found: {}",
            path.display()
        ));
    }

    app.opener()
        .open_path(path.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| format!("Failed to open Colors & Symbols workbook: {e}"))
}

/// Return the stored color/symbol configuration.
/// Falls back to an empty object when colors.json does not exist yet.
#[tauri::command]
pub async fn load_colors(state: State<'_, AppState>) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = colors_json_path(&folder);
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("Parse error: {e}")),
        Err(_) => Ok(json!({})),
    }
}

/// Persist the color/symbol configuration sent from the frontend.
/// The payload (`body`) contains:
///   type_styles          — map of point-type → style object
///   group_systems        — group system definitions
///   strata_layer_colors  — primary / secondary strata color maps
#[tauri::command]
pub async fn save_colors(
    _project_id: String,
    body: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = colors_json_path(&folder);
    let json =
        serde_json::to_string_pretty(&body).map_err(|e| format!("Serialise error: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Write error: {e}"))
}
