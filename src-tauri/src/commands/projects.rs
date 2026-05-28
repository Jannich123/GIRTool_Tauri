// Project listing — mirrors backend/routers/projects.py.
//
// Returns every project visible across every configured database, decorated
// with a PointCount derived from a single LEFT JOIN against [Points].
//
// As of issue #48 this fans out across every configured database in parallel
// and concatenates the results, prepending a `db_id` column so the rest of
// the app can tell rows from different databases apart.
//
// SQL source (resolved per-database based on the DB's `query_type`):
//   1. `query_configs.project_list.<query_type>` from GIRTool_settings.json
//      (overridable per database type via Settings → Query Config — issue #47)
//   2. Falls back to the hardcoded `PROJECTS_SQL` constant below.

use serde_json::Value;
use tauri::State;

use crate::commands::multi_db::{active_databases, fan_out_query_per_db};
use crate::commands::query_configs::{lookup_sql, SECTION_PROJECT_LIST};
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
    let databases = active_databases(&state);
    if databases.is_empty() {
        return Err("No database connection configured.".into());
    }

    // Per-DB SQL override lookup — each DB uses its own `query_type` to
    // pick the right SQL flavour, with PROJECTS_SQL as the fallback.
    let folder = state.output_folder().unwrap_or_default();
    let pairs: Vec<_> = databases
        .into_iter()
        .map(|d| {
            let sql = lookup_sql(&folder, SECTION_PROJECT_LIST, &d.query_type)
                .unwrap_or_else(|| PROJECTS_SQL.to_string());
            (d, sql)
        })
        .collect();

    let mut errors = Vec::new();
    let rows = fan_out_query_per_db(pairs, &mut errors).await;

    // If every database failed, surface the first error so the user sees
    // *something* — otherwise return whatever succeeded.
    if rows.is_empty() && !errors.is_empty() {
        let first = errors.first()
            .and_then(|e| e.get("error"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| "All databases failed.".into());
        return Err(first);
    }
    Ok(rows)
}
