// Investigation point queries — mirrors backend/routers/points.py.
//
// get_points fetches all investigation points for one or more project IDs.
// Project IDs are validated as GUIDs or bare integers before interpolation
// into the SQL IN clause (same whitelist approach as the Python build).
//
// SQL source:
//   1. `query_configs.points_list.<query_type>` from GIRTool_settings.json
//      (overridable per database type via Settings → Query Config — issue #47).
//      The template must contain the literal `{ids}` placeholder which is
//      replaced with the sanitised project-id list.
//   2. Falls back to the hardcoded `POINTS_SQL` constant below.

use serde_json::Value;
use tauri::State;

use crate::commands::query_configs::{current_query_type, lookup_sql, SECTION_POINTS_LIST};
use crate::state::AppState;

// Regex-free GUID check: 8-4-4-4-12 hex groups separated by '-'.
fn is_guid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 5 {
        return false;
    }
    let expected = [8usize, 4, 4, 4, 12];
    parts
        .iter()
        .zip(expected.iter())
        .all(|(p, &len)| p.len() == len && p.chars().all(|c| c.is_ascii_hexdigit()))
}

fn is_all_digits(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

/// Sanitise a project ID for direct interpolation into SQL.
/// Returns `'<guid>'` for GUIDs or the bare integer string.
/// Rejects anything else with an error.
fn sanitise_id(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    if is_guid(s) {
        Ok(format!("'{s}'"))
    } else if is_all_digits(s) {
        Ok(s.to_string())
    } else {
        Err(format!("Invalid project ID: {s}"))
    }
}

const POINTS_SQL: &str = r#"
SELECT
    A.[ProjectId],
    A.[PointId],
    CAST(A.[PointNo] AS VARCHAR(MAX)) AS [PointNo],
    B.[ProjectNo],
    A.[PointType],
    ROUND(A.[X1], 2)      AS [X1],
    ROUND(A.[Y1], 2)      AS [Y1],
    ROUND(A.[Z1], 2)      AS [Z1],
    ROUND(A.[Top], 2)     AS [Top],
    ROUND(A.[Bottom], 2)  AS [Bottom],
    A.[Projection1],
    A.[VerticalRefId1]    AS [LevelReference],
    C.[Projection]        AS [CoordinateSystem]
FROM
    ([Points] A
     INNER JOIN [Projects]    B ON A.[ProjectId]  = B.[ProjectId])
     INNER JOIN [Projections] C ON A.[Projection1] = C.[Epsg]
WHERE A.[ProjectId] IN ({ids})
ORDER BY A.[PointNo] ASC
"#;

#[tauri::command]
pub async fn get_points(
    project_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    if project_ids.is_empty() {
        return Ok(vec![]);
    }

    let cfg = state
        .db
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No database connection configured.".to_string())?;

    // Validate every ID before building the SQL string.
    let safe_ids: Vec<String> = project_ids
        .iter()
        .map(|id| sanitise_id(id))
        .collect::<Result<Vec<_>, _>>()?;

    let ids_str = safe_ids.join(", ");

    // Look up user override first; fall back to the hardcoded default.
    let qt     = current_query_type(&state);
    let folder = state.output_folder().unwrap_or_default();
    let template = lookup_sql(&folder, SECTION_POINTS_LIST, &qt)
        .unwrap_or_else(|| POINTS_SQL.to_string());
    let sql = template.replace("{ids}", &ids_str);

    tokio::task::spawn_blocking(move || crate::db::query_rows(&cfg, &sql))
        .await
        .map_err(|e| format!("internal task error: {e}"))?
        .map_err(|e| format!("{e:#}"))
}
