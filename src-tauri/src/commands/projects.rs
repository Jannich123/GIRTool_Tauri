// Project listing — mirrors backend/routers/projects.py.
//
// Returns every project visible in the connected database, decorated with a
// PointCount derived from a single LEFT JOIN against [Points].
//
// SQL source:
//   1. `query_configs.project_list.<query_type>` from GIRTool_settings.json
//      (overridable per database type via Settings → Query Config — issue #47)
//   2. Falls back to the hardcoded `PROJECTS_SQL` constant below.

use serde_json::Value;
use tauri::State;

use crate::commands::query_configs::{current_query_type, lookup_sql, SECTION_PROJECT_LIST};
use crate::state::AppState;

const PROJECTS_SQL: &str = r#"
SELECT
    A.[ProjectId],
    A.[ProjectNo],
    A.[Title],
    ISNULL(B.[PointCount], 0) AS PointCount
FROM [Projects] A
LEFT JOIN (
    SELECT [ProjectId], COUNT([ProjectId]) AS PointCount
    FROM [Points]
    GROUP BY [ProjectId]
) B ON A.[ProjectId] = B.[ProjectId]
ORDER BY A.[ProjectNo] ASC
"#;

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let cfg = state
        .db
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No database connection configured.".to_string())?;

    // Look up user override first; fall back to the hardcoded default.
    let qt     = current_query_type(&state);
    let folder = state.output_folder().unwrap_or_default();
    let sql = lookup_sql(&folder, SECTION_PROJECT_LIST, &qt)
        .unwrap_or_else(|| PROJECTS_SQL.to_string());

    // odbc-api is sync — execute on a blocking task.
    tokio::task::spawn_blocking(move || crate::db::query_rows(&cfg, &sql))
        .await
        .map_err(|e| format!("internal task error: {e}"))?
        .map_err(|e| format!("{e:#}"))
}
