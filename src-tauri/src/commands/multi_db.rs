// Multi-database fan-out helpers (issue #48).
//
// All "fetch from database" commands now treat every configured database as
// part of one virtual data source.  Each query runs in parallel against every
// DB; rows from each result set get a `db_id` column prepended so the rest of
// the app can tell them apart.
//
// `AppState::databases` is the source of truth (populated via Settings →
// Database, issue #46).  When empty this falls back to a one-entry list
// built from `state.db` so single-DB users see no behavioural change.

use std::path::PathBuf;

use serde_json::{json, Map, Value};

use crate::state::{AppState, DbConfig};

/// Default `db_id` value written into legacy xlsx files that have no
/// `db_id` column.  Picked so it sorts before any user-chosen ID.
pub const LEGACY_DB_ID: &str = "_legacy";

// ── Resolve the active list of databases ─────────────────────────────────────

/// Return the list of databases to fan a query out across.
///
/// Resolution order:
///   1. `state.databases` if non-empty (populated by Settings → Database, #46)
///   2. Try `GIRTool_settings.json::databases` on disk; load + cache into state
///   3. Fall back to `[state.db.clone()]` so single-DB users still work
pub fn active_databases(state: &AppState) -> Vec<DbConfig> {
    {
        let list = state.databases.lock().unwrap();
        if !list.is_empty() {
            return list.clone();
        }
    }

    // Try to load from disk into state (cheap: one file read).
    if let Some(folder) = state.output_folder() {
        let loaded = load_databases_from_settings(&folder);
        if !loaded.is_empty() {
            *state.databases.lock().unwrap() = loaded.clone();
            return loaded;
        }
    }

    // Last resort: wrap the legacy primary DbConfig in a single-entry list.
    if let Some(mut primary) = state.db.lock().unwrap().clone() {
        if primary.id.is_empty() {
            primary.id = "primary".to_string();
        }
        if primary.query_type.is_empty() {
            // Issue #52: default flavour is now "GeoGIS" (was "default").
            primary.query_type =
                crate::commands::query_configs::DEFAULT_QUERY_TYPE.to_string();
        }
        return vec![primary];
    }
    Vec::new()
}

/// Find a database by id in the active list.
pub fn find_database_by_id(state: &AppState, db_id: &str) -> Option<DbConfig> {
    active_databases(state)
        .into_iter()
        .find(|d| d.effective_id() == db_id)
}

/// Read the `databases` array out of `{folder}/GIRTool_settings.json`,
/// auto-migrating a legacy `db` block to a single-entry array if needed.
pub fn load_databases_from_settings(folder: &str) -> Vec<DbConfig> {
    if folder.is_empty() {
        return Vec::new();
    }
    let path = PathBuf::from(folder).join("GIRTool_settings.json");
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let mut settings: Map<String, Value> = match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(m)) => m,
        _ => return Vec::new(),
    };

    // Migration: legacy `db` block → single-entry `databases` array.
    if !settings.contains_key("databases") {
        if let Some(db) = settings.get("db").and_then(|v| v.as_object()).cloned() {
            let mut entry = Map::new();
            entry.insert("id".to_string(),         json!("primary"));
            entry.insert("type".to_string(),       json!("mssql"));
            // Issue #52: default flavour is now "GeoGIS" (was "default").
            entry.insert(
                "query_type".to_string(),
                json!(crate::commands::query_configs::DEFAULT_QUERY_TYPE),
            );
            for k in ["server", "database", "auth_method", "username", "password", "output_folder"] {
                if let Some(v) = db.get(k) {
                    entry.insert(k.to_string(), v.clone());
                }
            }
            settings.insert("databases".to_string(), Value::Array(vec![Value::Object(entry)]));
        }
    }

    settings
        .get("databases")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| serde_json::from_value::<DbConfig>(v.clone()).ok())
                // Only MSSQL entries can run the SQL Server-style queries the
                // existing commands issue.  Access support is a follow-up.
                .filter(|d| d.is_mssql())
                .collect()
        })
        .unwrap_or_default()
}

// ── Row helpers: prepend `db_id` ─────────────────────────────────────────────

/// Prepend a `db_id` field to every row-object in `rows`.
///
/// `serde_json::Map` is insertion-ordered with the `preserve_order` feature so
/// `db_id` always appears as the FIRST key in the output.
pub fn prepend_db_id(rows: Vec<Value>, db_id: &str) -> Vec<Value> {
    rows.into_iter()
        .map(|row| {
            let mut new_obj = Map::new();
            new_obj.insert("db_id".to_string(), Value::String(db_id.to_string()));
            if let Value::Object(orig) = row {
                for (k, v) in orig {
                    if k == "db_id" { continue }  // never let the SQL overwrite it
                    new_obj.insert(k, v);
                }
            }
            Value::Object(new_obj)
        })
        .collect()
}

// ── Fan-out SQL against every active DB in parallel ───────────────────────────
// (The same-SQL-everywhere variant was removed in #236 — every caller routes
// per-database SQL through fan_out_query_per_db.)

/// Run per-database SQL in parallel, prepend `db_id` to every row, and
/// concatenate the results.  `databases` is `(cfg, sql)` pairs; only listed
/// DBs are queried.
///
/// Spawns one `tokio::task::spawn_blocking` per database so slow DBs don't
/// block fast ones from returning.  Per-database errors are collected into
/// `errors_out` (`{ db_id, error }`) rather than failing the whole call —
/// the user can still see whatever rows the healthy DBs returned.
pub async fn fan_out_query_per_db(
    databases: Vec<(DbConfig, String)>,
    errors_out: &mut Vec<Value>,
) -> Vec<Value> {
    if databases.is_empty() {
        return Vec::new();
    }
    let mut handles = Vec::with_capacity(databases.len());
    for (cfg, sql) in databases {
        let id = cfg.effective_id();
        handles.push(tokio::task::spawn_blocking(move || {
            let res = crate::db::query_rows(&cfg, &sql);
            (id, res)
        }));
    }

    let mut all_rows = Vec::new();
    for h in handles {
        let (db_id, res) = match h.await {
            Ok(pair) => pair,
            Err(e)   => {
                errors_out.push(json!({ "db_id": "?", "error": format!("internal task error: {e}") }));
                continue;
            }
        };
        match res {
            Ok(rows) => {
                let prefixed = prepend_db_id(rows, &db_id);
                all_rows.extend(prefixed);
            }
            Err(e) => {
                errors_out.push(json!({ "db_id": db_id, "error": format!("{e:#}") }));
            }
        }
    }
    all_rows
}
