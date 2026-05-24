// Project listing — mirrors backend/routers/projects.py.
//
// Returns every project visible in the connected database, decorated with a
// PointCount derived from a single LEFT JOIN against [Points].

use serde_json::Value;
use tauri::State;

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

    // odbc-api is sync — execute on a blocking task.
    tokio::task::spawn_blocking(move || crate::db::query_rows(&cfg, PROJECTS_SQL))
        .await
        .map_err(|e| format!("internal task error: {e}"))?
        .map_err(|e| format!("{e:#}"))
}
