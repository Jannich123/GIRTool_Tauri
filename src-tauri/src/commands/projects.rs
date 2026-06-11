// Project listing — mirrors backend/routers/projects.py.
//
// Returns every project visible across every configured database, decorated
// with a PointCount derived from a single LEFT JOIN against [Points].
//
// As of issue #48 this fans out across every configured database in parallel
// and concatenates the results, prepending a `db_id` column so the rest of
// the app can tell rows from different databases apart.
//
// Issue #185: the query runs ONCE per app session — the result is cached in
// memory (so reopening the Projects tab is instant) and snapshot to
// `{output_folder}/projects_list.csv`.  `refresh: true` re-queries; the CSV
// doubles as an offline fallback when every database fails.
//
// SQL source (resolved per-database based on the DB's `query_type`):
//   1. `query_configs.project_list.<query_type>` from GIRTool_settings.json
//      (overridable per database type via Settings → Query Config — issue #47)
//   2. Falls back to the hardcoded `PROJECTS_SQL` constant below.

use serde_json::{json, Value};
use tauri::State;

use crate::commands::multi_db::{active_databases, fan_out_query_per_db};
use crate::commands::query_configs::{lookup_sql, SECTION_PROJECT_LIST};
use crate::state::AppState;

pub(crate) const PROJECTS_SQL: &str = r#"
SELECT
    A.[ProjectId],
    A.[ProjectNo],
    A.[Title],
    ISNULL(B.[PointCount], 0) AS PointCount
FROM #DB#[Projects] A
LEFT JOIN (
    SELECT [ProjectId], COUNT([ProjectId]) AS PointCount
    FROM #DB#[Points]
    GROUP BY [ProjectId]
) B ON A.[ProjectId] = B.[ProjectId]
ORDER BY A.[ProjectNo] ASC
"#;

// ── Project-list CSV snapshot (issue #185) ────────────────────────────────────
//
// Semicolon-delimited with a UTF-8 BOM so Danish characters (æøå) open
// correctly in Excel.

fn projects_csv_path(folder: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(folder).join("projects_list.csv")
}

fn write_projects_csv(folder: &str, rows: &[Value]) {
    if folder.is_empty() || rows.is_empty() {
        return;
    }
    let headers: Vec<String> = match rows[0].as_object() {
        Some(o) => o.keys().cloned().collect(),
        None => return,
    };
    let mut buf: Vec<u8> = vec![0xEF, 0xBB, 0xBF]; // UTF-8 BOM
    {
        let mut w = csv::WriterBuilder::new().delimiter(b';').from_writer(&mut buf);
        if w.write_record(&headers).is_err() {
            return;
        }
        for r in rows {
            let rec: Vec<String> = headers
                .iter()
                .map(|h| match r.get(h) {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Number(n)) => n.to_string(),
                    Some(Value::Bool(b)) => b.to_string(),
                    Some(Value::Null) | None => String::new(),
                    Some(other) => other.to_string(),
                })
                .collect();
            let _ = w.write_record(&rec);
        }
        let _ = w.flush();
    }
    let _ = std::fs::write(projects_csv_path(folder), &buf);
}

fn read_projects_csv(folder: &str) -> Option<Vec<Value>> {
    if folder.is_empty() {
        return None;
    }
    let bytes = std::fs::read(projects_csv_path(folder)).ok()?;
    let owned = String::from_utf8_lossy(&bytes).into_owned();
    let text = owned.strip_prefix('\u{feff}').unwrap_or(&owned);
    let mut rdr = csv::ReaderBuilder::new().delimiter(b';').from_reader(text.as_bytes());
    let headers: Vec<String> = rdr.headers().ok()?.iter().map(|s| s.to_string()).collect();
    let mut out = Vec::new();
    for rec in rdr.records() {
        let rec = rec.ok()?;
        let mut obj = serde_json::Map::new();
        for (i, h) in headers.iter().enumerate() {
            let cell = rec.get(i).unwrap_or("");
            // Everything stays a string (the frontend treats ProjectNo etc. as
            // strings) EXCEPT PointCount, which is numeric.
            let v = if h == "PointCount" {
                cell.parse::<i64>().map(|n| json!(n)).unwrap_or(json!(0))
            } else {
                Value::String(cell.to_string())
            };
            obj.insert(h.clone(), v);
        }
        out.push(Value::Object(obj));
    }
    if out.is_empty() { None } else { Some(out) }
}

/// List every project across every configured database (cached per session —
/// issue #185).  `refresh: true` bypasses the cache and re-queries.
#[tauri::command]
pub async fn list_projects(
    refresh: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    let force = refresh.unwrap_or(false);
    if !force {
        if let Some(cached) = state.projects_cache.lock().unwrap().clone() {
            return Ok(cached);
        }
    }

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
            // Issue #141: resolve the `#DB#` table-prefix placeholder.  Each
            // multi-DB connection already targets the right database, so the
            // prefix is empty for now — the hook makes the SQL portable and
            // lets a user override use `#DB#[Points]` safely.
            let sql = lookup_sql(&folder, SECTION_PROJECT_LIST, &d.query_type)
                .unwrap_or_else(|| PROJECTS_SQL.to_string())
                .replace("#DB#", "");
            (d, sql)
        })
        .collect();

    let mut errors = Vec::new();
    let rows = fan_out_query_per_db(pairs, &mut errors).await;

    // If every database failed, serve the CSV snapshot before erroring.
    if rows.is_empty() && !errors.is_empty() {
        if let Some(csv_rows) = read_projects_csv(&folder) {
            tracing::warn!(
                "list_projects: all databases failed — serving the projects_list.csv snapshot"
            );
            *state.projects_cache.lock().unwrap() = Some(csv_rows.clone());
            return Ok(csv_rows);
        }
        let first = errors.first()
            .and_then(|e| e.get("error"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| "All databases failed.".into());
        return Err(first);
    }

    // Session cache + CSV snapshot (best-effort, off the async runtime).
    *state.projects_cache.lock().unwrap() = Some(rows.clone());
    let folder_c = folder.clone();
    let rows_c = rows.clone();
    tokio::task::spawn_blocking(move || write_projects_csv(&folder_c, &rows_c));

    Ok(rows)
}
