// Investigation point queries — mirrors backend/routers/points.py.
//
// get_points fetches all investigation points for one or more project IDs.
// Project IDs are validated as GUIDs or bare integers before interpolation
// into the SQL IN clause (same whitelist approach as the Python build).
//
// As of issue #48 this fans out across every configured database in parallel.
// Each DB runs the SQL with its own subset of project IDs and the rows come
// back with a `db_id` prefix.
//
// Accepts either:
//   project_ids: ["guid1", "guid2", …]            ← legacy, runs against every DB
//   project_ids: [{ db_id, ProjectId }, …]        ← new, routes per DB
//
// SQL source (resolved per-database based on the DB's `query_type`):
//   1. `query_configs.points_list.<query_type>` from GIRTool_settings.json
//      (overridable per database type via Settings → Query Config — issue #47).
//      The template must contain the literal `{ids}` placeholder which is
//      replaced with the sanitised project-id list.
//   2. Falls back to the hardcoded `POINTS_SQL` constant below.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;
use tauri::State;

use crate::commands::multi_db::{active_databases, fan_out_query_per_db};
use crate::commands::query_configs::{lookup_sql, SECTION_POINTS_LIST};
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

pub(crate) const POINTS_SQL: &str = r#"
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
    (#DB#[Points] A
     INNER JOIN #DB#[Projects]    B ON A.[ProjectId]  = B.[ProjectId])
     -- LEFT JOIN (not INNER): a point must never be dropped just because its
     -- EPSG has no row in this DB's [Projections] lookup, or its Projection1 is
     -- NULL.  An INNER join here silently drops all points from any database
     -- whose [Projections] table is incomplete (issue #142).  CoordinateSystem
     -- is simply NULL when unmatched; the map reprojects from Projection1.
     LEFT JOIN #DB#[Projections] C ON A.[Projection1] = C.[Epsg]
WHERE A.[ProjectId] IN ({ids})
ORDER BY A.[PointNo] ASC
"#;

/// Accept either a flat string list (legacy) or a `{db_id, ProjectId}` list
/// (issue #48).  The latter routes each project ID to its specific DB.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum ProjectIdsArg {
    Flat(Vec<String>),
    PerDb(Vec<ProjectIdEntry>),
}

#[derive(Debug, Deserialize)]
pub struct ProjectIdEntry {
    pub db_id: String,
    #[serde(rename = "ProjectId", alias = "project_id")]
    pub project_id: String,
}

// ── Points disk cache (issue #190) ────────────────────────────────────────────
//
// `{folder}/points_cache.json` = { "db_id||ProjectId": [rows…] }.  JSON (not
// CSV) so column types survive exactly.  Hydrated lazily into
// `state.points_cache`; only projects missing from the cache hit the database,
// which makes startup selection-restore and map project-adds instant across
// app restarts.  `refresh: true` re-queries the requested projects.

fn points_cache_path(folder: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(folder).join("points_cache.json")
}

fn read_points_cache(folder: &str) -> HashMap<String, Vec<Value>> {
    if folder.is_empty() {
        return HashMap::new();
    }
    std::fs::read(points_cache_path(folder))
        .ok()
        .and_then(|b| serde_json::from_slice::<HashMap<String, Vec<Value>>>(&b).ok())
        .unwrap_or_default()
}

fn write_points_cache(folder: &str, cache: &HashMap<String, Vec<Value>>) {
    if folder.is_empty() {
        return;
    }
    if let Ok(text) = serde_json::to_string(cache) {
        let _ = std::fs::write(points_cache_path(folder), text);
    }
}

fn value_str(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

#[tauri::command]
pub async fn get_points(
    project_ids: ProjectIdsArg,
    refresh: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    let force = refresh.unwrap_or(false);
    let folder = state.output_folder().unwrap_or_default();

    // ── Per-DB form: cache-aware path (issue #190) ───────────────────────────
    if let ProjectIdsArg::PerDb(entries) = &project_ids {
        if entries.is_empty() {
            return Ok(Vec::new());
        }
        // Hydrate the memory cache from disk once per session/folder.
        {
            let mut guard = state.points_cache.lock().unwrap();
            if guard.is_none() {
                *guard = Some(read_points_cache(&folder));
            }
            if force {
                if let Some(map) = guard.as_mut() {
                    for e in entries {
                        map.remove(&format!("{}||{}", e.db_id, e.project_id));
                    }
                }
            }
        }

        // Partition requested projects into cached / missing.
        let mut out: Vec<Value> = Vec::new();
        let mut missing: Vec<&ProjectIdEntry> = Vec::new();
        {
            let guard = state.points_cache.lock().unwrap();
            let map = guard.as_ref().unwrap();
            for e in entries {
                match map.get(&format!("{}||{}", e.db_id, e.project_id)) {
                    Some(rows) => out.extend(rows.iter().cloned()),
                    None => missing.push(e),
                }
            }
        }
        if missing.is_empty() {
            return Ok(out);
        }

        // Query ONLY the missing projects.
        let databases = active_databases(&state);
        if databases.is_empty() {
            // Can't fetch the missing ones — return whatever the cache had.
            if !out.is_empty() {
                return Ok(out);
            }
            return Err("No database connection configured.".into());
        }
        let mut per_db: HashMap<String, Vec<String>> = HashMap::new();
        for e in &missing {
            let safe = sanitise_id(&e.project_id)?;
            per_db.entry(e.db_id.clone()).or_default().push(safe);
        }
        let mut tasks: Vec<(crate::state::DbConfig, String)> = Vec::new();
        for db in databases {
            let id = db.effective_id();
            let Some(ids) = per_db.get(&id) else { continue };
            if ids.is_empty() { continue }
            let template = lookup_sql(&folder, SECTION_POINTS_LIST, &db.query_type)
                .unwrap_or_else(|| POINTS_SQL.to_string())
                .replace("#DB#", "");
            let sql = template.replace("{ids}", &ids.join(", "));
            tasks.push((db, sql));
        }

        let mut errors = Vec::new();
        let fresh = if tasks.is_empty() {
            Vec::new()
        } else {
            fan_out_query_per_db(tasks, &mut errors).await
        };
        for e in &errors {
            tracing::warn!("get_points: a database query failed: {e}");
        }
        if out.is_empty() && fresh.is_empty() && !errors.is_empty() {
            let first = errors.first()
                .and_then(|e| e.get("error"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| "All databases failed.".into());
            return Err(first);
        }

        // Cache the fresh results per (db, project) — but never for DBs whose
        // query failed (so they retry next time).
        let failed: std::collections::HashSet<String> = errors
            .iter()
            .filter_map(|e| e.get("db_id").and_then(|v| v.as_str()).map(str::to_string))
            .collect();
        {
            let mut grouped: HashMap<String, Vec<Value>> = HashMap::new();
            for row in &fresh {
                let key = format!(
                    "{}||{}",
                    value_str(row.get("db_id")),
                    value_str(row.get("ProjectId")),
                );
                grouped.entry(key).or_default().push(row.clone());
            }
            let mut guard = state.points_cache.lock().unwrap();
            let map = guard.as_mut().unwrap();
            for e in &missing {
                if failed.contains(&e.db_id) {
                    continue;
                }
                let key = format!("{}||{}", e.db_id, e.project_id);
                map.insert(key.clone(), grouped.remove(&key).unwrap_or_default());
            }
            // Persist the snapshot (best-effort, off the async runtime).
            let snapshot = map.clone();
            let folder_c = folder.clone();
            tokio::task::spawn_blocking(move || write_points_cache(&folder_c, &snapshot));
        }

        out.extend(fresh);
        return Ok(out);
    }

    // ── Legacy flat form: original uncached path ─────────────────────────────
    let databases = active_databases(&state);
    if databases.is_empty() {
        return Err("No database connection configured.".into());
    }

    // Build { db_id → [validated project-ID literals] }.  When the caller
    // used the legacy flat form, run the same list against every DB.
    let mut per_db: HashMap<String, Vec<String>> = HashMap::new();
    match project_ids {
        ProjectIdsArg::Flat(ids) => {
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            let safe: Vec<String> = ids
                .iter()
                .map(|i| sanitise_id(i))
                .collect::<Result<Vec<_>, _>>()?;
            for db in &databases {
                per_db.insert(db.effective_id(), safe.clone());
            }
        }
        ProjectIdsArg::PerDb(_) => unreachable!("handled above"),
    }

    // Build (DbConfig, sql) pairs — each DB resolves its own SQL template via
    // its `query_type`, then we interpolate the sanitised project-id list.
    let folder = state.output_folder().unwrap_or_default();
    let mut tasks: Vec<(crate::state::DbConfig, String)> = Vec::new();
    for db in databases {
        let id = db.effective_id();
        let Some(ids) = per_db.get(&id) else { continue };
        if ids.is_empty() { continue }
        let template = lookup_sql(&folder, SECTION_POINTS_LIST, &db.query_type)
            .unwrap_or_else(|| POINTS_SQL.to_string())
            .replace("#DB#", ""); // Issue #141: resolve the DB-prefix hook.
        let sql = template.replace("{ids}", &ids.join(", "));
        tasks.push((db, sql));
    }

    if tasks.is_empty() {
        return Ok(Vec::new());
    }

    let mut errors = Vec::new();
    let rows = fan_out_query_per_db(tasks, &mut errors).await;

    // Issue #142: don't swallow per-DB failures.  When at least one DB returns
    // rows we still return the partial result (so a working DB isn't held
    // hostage to a broken one), but log every failing DB so "missing points
    // from one database" is diagnosable from the dev console rather than silent.
    if !errors.is_empty() {
        for e in &errors {
            tracing::warn!("get_points: a database query failed: {e}");
        }
    }

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
