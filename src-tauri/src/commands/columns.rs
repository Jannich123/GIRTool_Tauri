// Column dictionary — mirrors backend/routers/columns.py.
//
// Returns a mapping of column name → display metadata (unit, description, …)
// used by the frontend to label chart axes and table headers.
//
// The authoritative source is GIRTool_Column_Reference.xlsx bundled with the
// app.  Until that file is wired up the command returns an empty map so the
// frontend degrades gracefully (it already handles `setColDict(r ?? {})`).
//
// TODO (issue #12): parse GIRTool_Column_Reference.xlsx from the Tauri
//                   resource directory using calamine.

use serde_json::{json, Value};

/// Return the column reference dictionary.
/// Frontend call: `invoke('get_column_dictionary')`
#[tauri::command]
pub async fn get_column_dictionary() -> Result<Value, String> {
    // Phase 1: return an empty map.  The frontend already handles this with
    // `setColDict(r ?? {})` so all columns simply display their raw DB name.
    Ok(json!({}))
}
