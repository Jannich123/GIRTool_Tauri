// User-overridable SQL for every "fetch from database" operation
// (issues #47, #52).
//
// Storage: `{output_folder}/GIRTool_settings.json` gains a top-level
// `query_configs` object:
//
//   {
//     "query_configs": {
//       "project_list":      { "<query_type>": "SELECT …" },
//       "points_list":       { "<query_type>": "SELECT …" },
//       "strata_series":     { "<query_type>": "SELECT …" },
//       "strata_download":   { "<query_type>": "SELECT …" },
//       "datasheet_queries": { "<query_type>": { "<query_name>": "SELECT …" } }
//     }
//   }
//
// `<query_type>` is the label attached to each database in
// `Settings → Database` (issue #46).  The default flavour is `"GeoGIS"` —
// when a command runs against a database whose `query_type` is `"GeoGIS"`,
// the backend reads `query_configs.project_list.GeoGIS` first; if absent,
// the hardcoded default in the corresponding `commands/*.rs` module is
// used instead.  (Pre-#52 the default was called `"default"`; the
// migration in `load_query_configs_with_migration` silently renames it.)
//
// Migration: on the first `get_query_configs` call:
//   1. The legacy `queries.json` (datasheet query definitions) is folded
//      into `query_configs.datasheet_queries.GeoGIS` so users don't lose
//      previous customisation.
//   2. Any bucket containing an old `"default"` key is renamed to
//      `"GeoGIS"` (only when no `"GeoGIS"` key already exists — we never
//      clobber a user's data).
//   3. Any `databases[*].query_type == "default"` is rewritten to
//      `"GeoGIS"` so the dropdown shows a single canonical flavour.
//
// New in #52 — `get_builtin_sql_templates`:
//   Returns the hardcoded SQL constants from `projects.rs`, `points.rs`,
//   and `strata.rs` as a JSON object keyed by section name.  The frontend
//   pre-fills the GeoGIS textarea with these so users can see (and tweak)
//   the SQL the backend would otherwise run silently.
//
// Commands:
//   get_query_configs()                 → Value       full object
//   save_query_configs(configs)         → ()          replace entire object
//   reset_query_config(section, qt)     → ()          drop one override
//   get_builtin_sql_templates()         → Value       4 hardcoded SQL constants

use std::path::PathBuf;

use serde_json::{json, Map, Value};
use tauri::State;

use crate::state::AppState;

// ── Section names (keep in sync with the frontend) ───────────────────────────

pub const SECTION_PROJECT_LIST:      &str = "project_list";
pub const SECTION_POINTS_LIST:       &str = "points_list";
pub const SECTION_STRATA_SERIES:     &str = "strata_series";
pub const SECTION_STRATA_DOWNLOAD:   &str = "strata_download";
pub const SECTION_DATASHEET_QUERIES: &str = "datasheet_queries";

// Issue #52: this used to be `"default"`; the migration in
// `load_query_configs_with_migration` rewrites old saved values transparently.
pub const DEFAULT_QUERY_TYPE: &str = "GeoGIS";

/// The pre-#52 query-type label.  Kept around solely so the migration can
/// detect and rename old saved entries.
const LEGACY_QUERY_TYPE: &str = "default";

// ── Path helper ───────────────────────────────────────────────────────────────

fn settings_file(output_folder: &str) -> PathBuf {
    PathBuf::from(output_folder).join("GIRTool_settings.json")
}

fn queries_json_file(output_folder: &str) -> PathBuf {
    PathBuf::from(output_folder).join("queries.json")
}

// ── Low-level read/write that preserves all other top-level keys ─────────────

/// Read the settings file as an object map.  Returns an empty map on any error.
fn read_settings(output_folder: &str) -> Map<String, Value> {
    let path = settings_file(output_folder);
    let Ok(bytes) = std::fs::read(&path) else { return Map::new() };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(m)) => m,
        _                    => Map::new(),
    }
}

fn write_settings(output_folder: &str, settings: &Map<String, Value>) -> Result<(), String> {
    let path = settings_file(output_folder);
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Serialise error: {e}"))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

// ── Migration: queries.json → query_configs.datasheet_queries.default ─────────

/// If a legacy `queries.json` exists in the output folder and the
/// `query_configs.datasheet_queries.default` map has no entry for a given
/// query yet, copy that query's SQL across.  Existing overrides are never
/// touched.  Returns whether anything was added.
fn migrate_queries_json(output_folder: &str, configs: &mut Map<String, Value>) -> bool {
    let path = queries_json_file(output_folder);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return false,
    };
    let arr = match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Array(a)) => a,
        _                   => return false,
    };
    if arr.is_empty() {
        return false;
    }

    // Walk down configs.datasheet_queries.GeoGIS, creating empty maps as needed.
    // (Pre-#52 this was the `default` bucket; the `migrate_default_to_geogis`
    // step above renames any legacy bucket before we reach here.)
    let datasheet = configs
        .entry(SECTION_DATASHEET_QUERIES.to_string())
        .or_insert_with(|| json!({}));
    let datasheet_map = match datasheet.as_object_mut() {
        Some(m) => m,
        None    => return false,
    };
    let default_entry = datasheet_map
        .entry(DEFAULT_QUERY_TYPE.to_string())
        .or_insert_with(|| json!({}));
    let default_map = match default_entry.as_object_mut() {
        Some(m) => m,
        None    => return false,
    };

    let mut added = false;
    for q in arr {
        let fname = q.get("fname").and_then(|v| v.as_str()).map(str::to_string);
        let sql   = q.get("SQLScript").and_then(|v| v.as_str()).map(str::to_string);
        let (Some(fname), Some(sql)) = (fname, sql) else { continue };
        if fname.is_empty() || sql.is_empty() {
            continue;
        }
        if !default_map.contains_key(&fname) {
            default_map.insert(fname, Value::String(sql));
            added = true;
        }
    }
    added
}

/// Issue #52 migration: walk every `query_configs.<section>` bucket and
/// rename a `"default"` key to `"GeoGIS"` IF no `"GeoGIS"` key already
/// exists in that bucket.  Buckets that already have a `"GeoGIS"` entry
/// are left alone — we never clobber a user's data.  Returns whether
/// anything was renamed.
fn migrate_default_to_geogis(configs: &mut Map<String, Value>) -> bool {
    let mut any = false;
    for (_section, bucket_val) in configs.iter_mut() {
        let Some(bucket) = bucket_val.as_object_mut() else { continue };
        if bucket.contains_key(DEFAULT_QUERY_TYPE) {
            // GeoGIS already present — leave the legacy `default` key alone
            // (we deliberately don't merge to avoid surprising the user).
            continue;
        }
        if let Some(old) = bucket.remove(LEGACY_QUERY_TYPE) {
            bucket.insert(DEFAULT_QUERY_TYPE.to_string(), old);
            any = true;
        }
    }
    any
}

/// Issue #52 migration: rewrite every `databases[*].query_type` of
/// `"default"` to `"GeoGIS"` so the new dropdown shows a single canonical
/// flavour.  Operates on the top-level settings map.
fn migrate_databases_query_type(settings: &mut Map<String, Value>) -> bool {
    let Some(arr) = settings.get_mut("databases").and_then(|v| v.as_array_mut()) else {
        return false;
    };
    let mut any = false;
    for entry in arr.iter_mut() {
        let Some(obj) = entry.as_object_mut() else { continue };
        let needs_rewrite = obj
            .get("query_type")
            .and_then(|v| v.as_str())
            .map(|s| s == LEGACY_QUERY_TYPE)
            .unwrap_or(false);
        if needs_rewrite {
            obj.insert("query_type".to_string(), Value::String(DEFAULT_QUERY_TYPE.to_string()));
            any = true;
        }
    }
    any
}

/// Build the full `query_configs` value from disk, applying the legacy
/// `queries.json` migration AND the `default → GeoGIS` rename (issue #52)
/// if appropriate.  Returns `{}` when no settings file (or no folder) is
/// available.
fn load_query_configs_with_migration(output_folder: &str) -> Value {
    if output_folder.is_empty() {
        return json!({});
    }
    let mut settings = read_settings(output_folder);
    let mut configs: Map<String, Value> = settings
        .get("query_configs")
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();

    let renamed_to_geogis = migrate_default_to_geogis(&mut configs);
    let migrated_queries  = migrate_queries_json(output_folder, &mut configs);
    let migrated_dbs      = migrate_databases_query_type(&mut settings);

    if renamed_to_geogis || migrated_queries || migrated_dbs {
        // Persist the migrated configs so subsequent reads see them.
        settings.insert(
            "query_configs".to_string(),
            Value::Object(configs.clone()),
        );
        let _ = write_settings(output_folder, &settings);
    }

    Value::Object(configs)
}

// ── pub(crate) lookup used by command modules ─────────────────────────────────

/// Return the query_type for the active primary database.
///
/// As of issue #47 every primary DB uses `DEFAULT_QUERY_TYPE` ("GeoGIS"
/// post-#52).  Issue #46 adds a per-database `query_type` field that this
/// function will read from once both PRs have landed.  Until then this
/// just returns the constant.
pub(crate) fn current_query_type(_state: &AppState) -> String {
    // Defensive: when both #46 and #47 are merged the call site will be:
    //   state.db.lock().unwrap().as_ref()
    //     .map(|c| c.query_type.clone())
    //     .filter(|s| !s.is_empty())
    //     .unwrap_or_else(|| DEFAULT_QUERY_TYPE.to_string())
    DEFAULT_QUERY_TYPE.to_string()
}

/// Look up a SQL override by `(section, query_type)`.
///
/// Returns `None` when the file, section, or per-type entry is missing —
/// callers should fall back to the hardcoded default in their own module.
pub(crate) fn lookup_sql(
    output_folder: &str,
    section: &str,
    query_type: &str,
) -> Option<String> {
    if output_folder.is_empty() {
        return None;
    }
    let settings = read_settings(output_folder);
    let s = settings.get("query_configs")?.as_object()?;
    let bucket = s.get(section)?.as_object()?;
    bucket.get(query_type)?.as_str().map(str::to_string)
}

/// Look up a datasheet-query SQL override by `(query_type, query_name)`.
pub(crate) fn lookup_datasheet_sql(
    output_folder: &str,
    query_type: &str,
    query_name: &str,
) -> Option<String> {
    if output_folder.is_empty() {
        return None;
    }
    let settings = read_settings(output_folder);
    let s = settings.get("query_configs")?.as_object()?;
    let datasheet = s.get(SECTION_DATASHEET_QUERIES)?.as_object()?;
    let bucket    = datasheet.get(query_type)?.as_object()?;
    bucket.get(query_name)?.as_str().map(str::to_string)
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Return the full `query_configs` object, applying the legacy `queries.json`
/// migration on first call.  Returns `{}` if no output folder is configured.
#[tauri::command]
pub async fn get_query_configs(state: State<'_, AppState>) -> Result<Value, String> {
    let folder = state.output_folder().unwrap_or_default();
    let res = tokio::task::spawn_blocking(move || load_query_configs_with_migration(&folder))
        .await
        .map_err(|e| format!("internal task error: {e}"))?;
    Ok(res)
}

/// Replace the entire `query_configs` object, preserving every other
/// top-level key in `GIRTool_settings.json`.
#[tauri::command]
pub async fn save_query_configs(
    configs: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let folder = state
        .output_folder()
        .ok_or("No output folder configured. Pick one in Settings → Project folder first.")?;

    // Reject anything that isn't an object — keeps the file structure clean.
    if !configs.is_object() {
        return Err("query_configs must be an object.".into());
    }

    tokio::task::spawn_blocking(move || {
        let mut settings = read_settings(&folder);
        settings.insert("query_configs".to_string(), configs);
        settings.insert(
            "saved_at".to_string(),
            json!(chrono::Utc::now().to_rfc3339()),
        );
        write_settings(&folder, &settings)
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?
}

/// Remove one override so the hardcoded backend default takes over again.
///
/// For `section == "datasheet_queries"` the `query_type` is the **inner** key
/// (i.e. the full bucket for that query type is dropped); to remove a single
/// datasheet query, edit and save through `save_query_configs` instead.
#[tauri::command]
pub async fn reset_query_config(
    section: String,
    query_type: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let folder = state
        .output_folder()
        .ok_or("No output folder configured.")?;

    tokio::task::spawn_blocking(move || {
        let mut settings = read_settings(&folder);
        let configs = match settings
            .entry("query_configs".to_string())
            .or_insert_with(|| json!({}))
            .as_object_mut()
        {
            Some(m) => m,
            None    => return Err("query_configs is not an object".to_string()),
        };
        if let Some(bucket) = configs.get_mut(&section).and_then(|v| v.as_object_mut()) {
            bucket.remove(&query_type);
        }
        settings.insert(
            "saved_at".to_string(),
            json!(chrono::Utc::now().to_rfc3339()),
        );
        write_settings(&folder, &settings)
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?
}

/// Issue #52: expose the four hardcoded SQL constants so the frontend can
/// pre-populate the GeoGIS textarea with the actual SQL the backend runs
/// by default.  The values are taken straight from the originating module
/// (no duplication) so this stays in lock-step with the running code.
///
/// Returns:
/// ```json
/// {
///   "project_list":     "<PROJECTS_SQL>",
///   "points_list":      "<POINTS_SQL>",
///   "strata_series":    "<TYPES_SQL>",
///   "strata_download":  "<DATA_SQL>"
/// }
/// ```
///
/// The `datasheet_queries` section deliberately has no entry here — its
/// baseline lives in `commands::queries::default_queries()` and is exposed
/// separately via `get_builtin_datasheet_queries`.
#[tauri::command]
pub fn get_builtin_sql_templates() -> serde_json::Value {
    serde_json::json!({
        "project_list":    crate::commands::projects::PROJECTS_SQL,
        "points_list":     crate::commands::points::POINTS_SQL,
        "strata_series":   crate::commands::strata::TYPES_SQL,
        "strata_download": crate::commands::strata::DATA_SQL,
    })
}

/// Built-in datasheet queries (issue #60).
///
/// Returns the 12 named queries hardcoded in
/// `commands/queries.rs::DEFAULT_QUERIES_JSON` as a single object keyed by
/// `fname` → `SQLScript`.  The Query Config UI uses this to pre-populate the
/// `datasheet_queries` per-query-name dropdown under GeoGIS so the user sees
/// every default name without needing a `queries.json` saved yet.
#[tauri::command]
pub fn get_builtin_datasheet_queries() -> serde_json::Value {
    let mut out = serde_json::Map::new();
    for q in crate::commands::queries::default_queries() {
        out.insert(q.fname, serde_json::Value::String(q.sql_script));
    }
    serde_json::Value::Object(out)
}
