// Excel export and session persistence — mirrors backend/routers/download.py.
//
// download_data:
//   Execute every saved query for a set of project/point IDs and write each
//   result to {output_folder}/Datasheets/{fname}.xlsx.
//   Mirrors Python `save_to_folder`: runs all queries (or a named subset),
//   applies strata-column injection when apply_strata="Yes", applies group-
//   column injection from Grouping.xlsx, and writes GIRTool_settings.json.
//
// save_session:
//   Write the app's current state (selected_projects, point_count, etc.) to
//   GIRTool_settings.json, preserving any existing "charts" key.
//
// restore_session:
//   Read and return GIRTool_settings.json (or {} if absent).
//
// Storage:
//   {output_folder}/Datasheets/{fname}.xlsx   — exported datasheets
//   {output_folder}/GIRTool_settings.json     — session / download metadata
//
// ── Strata source (issue #6) ─────────────────────────────────────────────────
//
// As of issue #6 the strata master is stored in {output_folder}/strata.xlsx
// (Strata_GIRTool template, see commands/strata.rs).  load_strata_lookup
// below reads the "Strata" sheet of that workbook.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use calamine::{open_workbook, Data, Reader, Xlsx};
use rust_xlsxwriter::{Format, Formula, Table, TableColumn, TableStyle, Workbook};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::state::AppState;

// ── Request / response types ──────────────────────────────────────────────────

/// Matches the `query` argument sent by DataPage.jsx:
///   invoke('download_data', { projectId, query: buildPayload(queryNames) })
/// The outer `projectId` JS field is unused here (project_ids is inside query).
#[derive(Debug, Deserialize)]
pub struct DownloadRequest {
    /// Primary project ID — used for strata lookup.
    pub project_id: String,
    /// All project IDs to include in the SQL IN clause.  Issue #105:
    /// accept either the legacy flat string list OR a per-DB list of
    /// `{db_id, ProjectId}` so the backend can fan out across every
    /// configured database.
    pub project_ids: ProjectIdsArg,
    /// Optional point filter; empty = all points.  Same shape choice
    /// as `project_ids`.
    #[serde(default)]
    pub point_ids: PointIdsArg,
    /// Run only these query names; empty = run all.
    #[serde(default)]
    pub query_names: Vec<String>,
    /// Project metadata for session file (ProjectId, ProjectNo, Title).
    #[serde(default)]
    pub projects_meta: Vec<Value>,
    /// Point metadata for group-column injection (PointId, PointNo, …).
    /// Reserved for future use — not yet consumed server-side.
    #[serde(default)]
    #[allow(dead_code)]
    pub points_meta: Vec<Value>,
    /// Issue #149: per-point coordinate-system overrides, keyed by
    /// `db_id||PointId`.  Present only when the project has a coordinate system
    /// configured (the frontend computes the converted values via proj4js).
    /// Applied to each datasheet's coordinate / Level columns before writing.
    #[serde(default)]
    pub coord_overrides: std::collections::HashMap<String, CoordOverride>,
}

/// One point's coordinate-system conversion (issue #149).  X1/Y1/Z1 are the
/// already-converted target-CRS values; `zoffset` is the elevation offset to add
/// to derived `Level` columns in data datasheets.
#[derive(Debug, Clone, Deserialize)]
pub struct CoordOverride {
    #[serde(rename = "X1", default)]
    pub x1: Option<f64>,
    #[serde(rename = "Y1", default)]
    pub y1: Option<f64>,
    #[serde(rename = "Z1", default)]
    pub z1: Option<f64>,
    #[serde(rename = "Projection1", default)]
    pub projection1: String,
    #[serde(rename = "Zoffset", default)]
    pub zoffset: f64,
}

/// Either a flat list of project IDs (legacy single-DB form) or a list of
/// `{db_id, ProjectId}` entries (issue #105 multi-DB form).
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

/// Same as `ProjectIdsArg` but for points.  Defaults to an empty flat list
/// when the field is missing so existing call sites that don't filter by
/// point keep working.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum PointIdsArg {
    Flat(Vec<String>),
    PerDb(Vec<PointIdEntry>),
}

impl Default for PointIdsArg {
    fn default() -> Self { PointIdsArg::Flat(Vec::new()) }
}

#[derive(Debug, Deserialize)]
pub struct PointIdEntry {
    pub db_id: String,
    #[serde(rename = "PointId", alias = "point_id")]
    pub point_id: String,
}

// ── Path helpers ──────────────────────────────────────────────────────────────

fn settings_path(folder: &str) -> PathBuf {
    PathBuf::from(folder).join("GIRTool_settings.json")
}

pub(crate) fn datasheets_dir(folder: &str) -> PathBuf {
    PathBuf::from(folder).join("Datasheets")
}

// ── Datasheet JSON sidecar cache (issue #128) ────────────────────────────────
//
// The slow part of `read_datasheet` is unzipping + XML-parsing the xlsx and
// converting 3.2M cells into JSON.  We cache the already-converted
// `{ columns, rows }` next to the xlsx at
// `{folder}/Datasheets/.cache/{fname}.json`.
//
// AUTO-INVALIDATION: the cache is only used when its mtime is >= the xlsx
// mtime.  If the user edits the xlsx in Excel (which bumps the xlsx mtime),
// the next read sees the cache is older, falls through to the slow path, and
// rewrites a fresh cache.  So edits are always picked up — at the cost of one
// slow read after each edit.

fn datasheet_cache_dir(folder: &str) -> PathBuf {
    datasheets_dir(folder).join(".cache")
}

fn datasheet_cache_path(folder: &str, fname: &str) -> PathBuf {
    datasheet_cache_dir(folder).join(format!("{fname}.json"))
}

/// Sparse map of user-authored formulas in a datasheet (issue #176, M5):
/// `(data_row_index, column_index) → formula string` — data rows are 0-based
/// and EXCLUDE the header row.  Captured on read, re-emitted on write so user
/// formulas survive Append / Re-add Strata round-trips (plan Q-F3 option c).
pub(crate) type FormulaMap = HashMap<(usize, usize), String>;

/// Write the parsed `{columns, rows}` to the sidecar.  Best-effort — any
/// failure is swallowed (the next read just takes the slow path again).
/// Formulas (when present) are stored sparsely as `"row,col" → "=…"`; values
/// in `rows` stay the cached results, so previews/charts read values as before.
pub(crate) fn write_datasheet_cache(
    folder: &str,
    fname: &str,
    columns: &[String],
    rows: &[Vec<Value>],
    formulas: Option<&FormulaMap>,
) {
    let _ = std::fs::create_dir_all(datasheet_cache_dir(folder));
    let path = datasheet_cache_path(folder, fname);
    let mut obj = json!({ "columns": columns, "rows": rows });
    if let Some(fm) = formulas {
        if !fm.is_empty() {
            let sparse: serde_json::Map<String, Value> = fm
                .iter()
                .map(|((r, c), f)| (format!("{r},{c}"), Value::String(f.clone())))
                .collect();
            obj["formulas"] = Value::Object(sparse);
        }
    }
    if let Ok(text) = serde_json::to_string(&obj) {
        let _ = std::fs::write(&path, text);
    }
}

/// Try to satisfy a read from the sidecar.  Returns `Some(value)` only when
/// the cache exists AND is at least as new as the source xlsx.  Returns
/// `None` (caller falls through to the slow xlsx parse) when the cache is
/// missing, stale, or unparseable.
fn read_datasheet_cached(folder: &str, fname: &str) -> Option<Value> {
    let xlsx  = datasheets_dir(folder).join(format!("{fname}.xlsx"));
    let cache = datasheet_cache_path(folder, fname);
    let xlsx_mtime  = xlsx.metadata().ok()?.modified().ok()?;
    let cache_mtime = cache.metadata().ok()?.modified().ok()?;
    if cache_mtime < xlsx_mtime {
        return None; // xlsx edited since the cache was written — stale.
    }
    let text = std::fs::read_to_string(&cache).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

/// Issue #117: persist per-datasheet metadata to GIRTool_settings.json so
/// `list_datasheets` can return instantly without opening every xlsx.
/// Settings shape:
///   "datasheets": { "CPTData": { "row_count": 1247, "has_strata": true }, ... }
pub(crate) fn persist_datasheet_meta(folder: &str, fname: &str, row_count: usize, has_strata: bool) {
    let path = settings_path(folder);
    let existing: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}));
    let mut obj = existing.as_object().cloned().unwrap_or_default();
    let mut sheets = obj.get("datasheets").and_then(|v| v.as_object()).cloned().unwrap_or_default();
    sheets.insert(fname.to_string(), json!({
        "row_count": row_count,
        "has_strata": has_strata,
    }));
    obj.insert("datasheets".to_string(), Value::Object(sheets));
    if let Ok(s) = serde_json::to_string_pretty(&Value::Object(obj)) {
        let _ = std::fs::write(&path, s);
    }
}

// ── SQL building ──────────────────────────────────────────────────────────────

fn sanitise_id(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    let is_guid = {
        let parts: Vec<&str> = s.split('-').collect();
        parts.len() == 5 && {
            let lens = [8usize, 4, 4, 4, 12];
            parts.iter().zip(lens.iter()).all(|(p, &l)| {
                p.len() == l && p.chars().all(|c| c.is_ascii_hexdigit())
            })
        }
    };
    if is_guid {
        Ok(format!("'{s}'"))
    } else if !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) {
        Ok(s.to_string())
    } else {
        Err(format!("Invalid ID: {s:?}"))
    }
}

fn safe_id_list(ids: &[String]) -> Result<String, String> {
    ids.iter()
        .map(|id| sanitise_id(id))
        .collect::<Result<Vec<_>, _>>()
        .map(|v| v.join(", "))
}

fn build_sql(
    sql_template: &str,
    point_filter_template: &str,
    project_ids: &[String],
    point_ids: &[String],
) -> Result<String, String> {
    let proj_str = safe_id_list(project_ids)?;
    let point_filter = if !point_ids.is_empty() && !point_filter_template.is_empty() {
        let pts_str = safe_id_list(point_ids)?;
        format!("AND {}", point_filter_template.replace("#pointid#", &pts_str))
    } else {
        String::new()
    };

    Ok(sql_template
        .replace("#DB#", "")
        .replace("#projectid#", &proj_str)
        .replace("#pointfilter#", &point_filter))
}

// ── Strata-column injection ───────────────────────────────────────────────────

/// Load strata intervals from the Strata master sheet in
/// `{output_folder}/strata.xlsx` (see `commands/strata.rs`).
///
/// The `_project_id` argument is kept for backward compatibility with the old
/// per-project JSON store but is ignored — strata.xlsx is shared across
/// projects, matching the Python build.
///
/// Returns a map of `(db_id, point_id)` → sorted `Vec<(from, to, primary, secondary)>`.
///
/// As of issue #48 the lookup key is a compound `(db_id, point_id)` pair so
/// that two GUIDs from different databases never collide.  The function
/// accepts BOTH on-disk schemas:
///   * Legacy 11-column: `ProjectId | PointId | PointNo | From | To | Primary | Secondary | ...`
///     — every row is keyed as `(LEGACY_DB_ID, point_id)` so existing files
///     keep working.
///   * New 12-column: `db_id | ProjectId | PointId | PointNo | From | To | Primary | Secondary | ...`
///     — each row is keyed as `(<db_id>, point_id)`.
/// Detection is done by reading the header row of the "Strata" sheet.
///
/// Returns an empty map when the file is absent or has no usable rows.
pub(crate) fn load_strata_lookup(
    output_folder: &str,
    _project_id: &str,
) -> HashMap<(String, String, String), Vec<(f64, f64, String, String)>> {
    use calamine::open_workbook_auto;
    use crate::commands::multi_db::LEGACY_DB_ID;

    let path = PathBuf::from(output_folder).join("strata.xlsx");
    if !path.exists() {
        return HashMap::new();
    }

    let mut wb = match open_workbook_auto(&path) {
        Ok(w) => w,
        Err(_) => return HashMap::new(),
    };
    let range = match wb.worksheet_range("Strata") {
        Ok(r) => r,
        Err(_) => return HashMap::new(),
    };

    // Detect schema by looking at the first header.  When it equals "db_id"
    // (case-insensitive) the file uses the new 12-column layout, so all
    // downstream column indices shift right by one.
    let mut rows_iter = range.rows();
    let has_db_id_col = rows_iter
        .next()
        .and_then(|hdr| hdr.first())
        .map(|cell| match cell {
            Data::String(s) => s.eq_ignore_ascii_case("db_id"),
            _ => false,
        })
        .unwrap_or(false);
    let off: usize = if has_db_id_col { 1 } else { 0 };

    // Issue #101: lookup key is now (db_id, project_id, point_id) — adds
    // project_id to defend against same-PointID collisions across projects.
    let mut lookup: HashMap<(String, String, String), Vec<(f64, f64, String, String)>> = HashMap::new();

    fn cell_to_string(cell: Option<&Data>) -> Option<String> {
        cell.and_then(|c| match c {
            Data::String(s) if !s.is_empty() => Some(s.clone()),
            Data::Int(i)                     => Some(i.to_string()),
            Data::Float(f)                   => Some(
                if f.fract() == 0.0 { format!("{}", *f as i64) } else { f.to_string() },
            ),
            _ => None,
        })
    }

    for row in rows_iter {
        let db_id = if has_db_id_col {
            cell_to_string(row.first()).unwrap_or_else(|| LEGACY_DB_ID.to_string())
        } else {
            LEGACY_DB_ID.to_string()
        };
        // ProjectID is column A in the 11-column legacy schema and column B
        // in the 12-column schema — i.e. `row.get(0 + off)`.
        let project_id = cell_to_string(row.get(off)).unwrap_or_default();
        let pid = match cell_to_string(row.get(1 + off)) {
            Some(s) => s,
            None    => continue,
        };
        let from = match row.get(3 + off) {
            Some(Data::Float(f)) => *f,
            Some(Data::Int(i))   => *i as f64,
            _ => continue,
        };
        let to = match row.get(4 + off) {
            Some(Data::Float(f)) => *f,
            Some(Data::Int(i))   => *i as f64,
            _ => continue,
        };
        let primary = row
            .get(5 + off)
            .and_then(|c| match c {
                Data::String(s) if !s.is_empty() => Some(s.clone()),
                _ => None,
            })
            .unwrap_or_else(|| "Unknown".to_string());
        let secondary = row
            .get(6 + off)
            .and_then(|c| match c {
                Data::String(s) if !s.is_empty() => Some(s.clone()),
                _ => None,
            })
            .unwrap_or_else(|| "Unknown".to_string());

        lookup
            .entry((db_id, project_id, pid))
            .or_default()
            .push((from, to, primary, secondary));
    }

    // Sort each (db_id, project_id, point_id) bucket by depth-from.
    for intervals in lookup.values_mut() {
        intervals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    }

    lookup
}

/// Return the strata label `(primary, secondary)` for a given
/// `(db_id, project_id, point_id, depth)`.
///
/// Issue #101: project_id is now part of the lookup key so the same PointId
/// reused across two projects within one DB never grabs the wrong layer.
///
/// The lookup falls back to `LEGACY_DB_ID` for db_id and an empty project_id
/// matches `load_strata_lookup`'s default for rows missing those values.
fn strata_at(
    lookup: &HashMap<(String, String, String), Vec<(f64, f64, String, String)>>,
    db_id: &str,
    project_id: &str,
    point_id: &str,
    depth: f64,
) -> (String, String) {
    use crate::commands::multi_db::LEGACY_DB_ID;
    let key_primary = (db_id.to_string(), project_id.to_string(), point_id.to_string());
    let intervals = lookup
        .get(&key_primary)
        .or_else(|| {
            // Legacy single-DB fallback — when the row's db_id is unknown to
            // the lookup, try the LEGACY_DB_ID bucket instead.
            let key_legacy = (LEGACY_DB_ID.to_string(), project_id.to_string(), point_id.to_string());
            lookup.get(&key_legacy)
        })
        .or_else(|| {
            // Last-resort fallback — when project_id is missing or doesn't
            // match (e.g. the data row doesn't have a ProjectID column),
            // fall back to db_id + point_id only by scanning the lookup for
            // any (db_id, *, point_id) match.
            lookup.iter()
                .find(|((d, _p, pt), _)| d == db_id && pt == point_id)
                .map(|(_, v)| v)
        });
    if let Some(intervals) = intervals {
        for (from, to, primary, secondary) in intervals {
            if depth >= *from && depth < *to {
                return (primary.clone(), secondary.clone());
            }
        }
    }
    ("Unknown".to_string(), "Unknown".to_string())
}

/// Extract PointId + ProjectId + Depth from a row-object, inject
/// Primary/Secondary Layer columns.
///
/// As of issue #101 the strata lookup is keyed by
/// `(db_id, project_id, point_id)`.  Each row's `db_id` and `ProjectId` are
/// taken from the matching column (case-insensitive); rows without `db_id`
/// fall back to `LEGACY_DB_ID`, and rows without `ProjectId` use the empty
/// string (`strata_at` handles that case via its scan fallback).
pub(crate) fn apply_strata_columns(
    columns: &mut Vec<String>,
    rows: &mut Vec<Vec<Value>>,
    strata_lookup: &HashMap<(String, String, String), Vec<(f64, f64, String, String)>>,
) {
    use crate::commands::multi_db::LEGACY_DB_ID;
    let col_lower: Vec<String> = columns.iter().map(|c| c.to_lowercase()).collect();

    let db_idx: Option<usize>    = col_lower.iter().position(|c| c == "db_id");
    let proj_idx: Option<usize>  = col_lower.iter().position(|c| c == "projectid");
    let pt_idx: Option<usize>    = col_lower.iter().position(|c| c == "pointid");
    let depth_idx: Option<usize> = col_lower
        .iter()
        .position(|c| c == "depth")
        .or_else(|| col_lower.iter().position(|c| c.contains("depth")));

    columns.push("Primary Layer".to_string());
    columns.push("Secondary Layer".to_string());

    for row in rows.iter_mut() {
        let result = (|| -> Option<(String, String)> {
            let pid = row.get(pt_idx?)?.as_str()?.to_string();
            let depth = match row.get(depth_idx?)? {
                Value::Number(n) => n.as_f64()?,
                _ => return None,
            };
            let db_id = db_idx
                .and_then(|i| row.get(i).and_then(|v| v.as_str()).map(str::to_string))
                .unwrap_or_else(|| LEGACY_DB_ID.to_string());
            let project_id = proj_idx
                .and_then(|i| row.get(i).and_then(|v| v.as_str()).map(str::to_string))
                .unwrap_or_default();
            Some(strata_at(strata_lookup, &db_id, &project_id, &pid, depth))
        })();
        let (primary, secondary) = result.unwrap_or_else(|| ("Unknown".to_string(), "Unknown".to_string()));
        row.push(Value::String(primary));
        row.push(Value::String(secondary));
    }
}

/// Issue #111: like `apply_strata_columns`, but detects existing
/// "Primary Layer" / "Secondary Layer" columns and **overwrites their
/// values in place** instead of always pushing new columns at the end.
/// Used by `readd_strata` to re-apply strata to already-downloaded
/// datasheets without changing the column order.
pub(crate) fn upsert_strata_columns(
    columns: &mut Vec<String>,
    rows: &mut Vec<Vec<Value>>,
    strata_lookup: &std::collections::HashMap<(String, String, String), Vec<(f64, f64, String, String)>>,
) {
    use crate::commands::multi_db::LEGACY_DB_ID;
    let col_lower: Vec<String> = columns.iter().map(|c| c.to_lowercase()).collect();

    let db_idx: Option<usize>    = col_lower.iter().position(|c| c == "db_id");
    let proj_idx: Option<usize>  = col_lower.iter().position(|c| c == "projectid");
    let pt_idx: Option<usize>    = col_lower.iter().position(|c| c == "pointid");
    let depth_idx: Option<usize> = col_lower
        .iter()
        .position(|c| c == "depth")
        .or_else(|| col_lower.iter().position(|c| c.contains("depth")));

    // Locate or append the Primary Layer / Secondary Layer columns.
    let pri_idx = match col_lower.iter().position(|c| c == "primary layer") {
        Some(i) => i,
        None    => { columns.push("Primary Layer".to_string()); columns.len() - 1 }
    };
    let sec_idx = match columns.iter().position(|c| c.eq_ignore_ascii_case("secondary layer")) {
        Some(i) => i,
        None    => { columns.push("Secondary Layer".to_string()); columns.len() - 1 }
    };

    let need_len = pri_idx.max(sec_idx) + 1;
    for row in rows.iter_mut() {
        let result = (|| -> Option<(String, String)> {
            let pid = row.get(pt_idx?)?.as_str()?.to_string();
            let depth = match row.get(depth_idx?)? {
                Value::Number(n) => n.as_f64()?,
                _ => return None,
            };
            let db_id = db_idx
                .and_then(|i| row.get(i).and_then(|v| v.as_str()).map(str::to_string))
                .unwrap_or_else(|| LEGACY_DB_ID.to_string());
            let project_id = proj_idx
                .and_then(|i| row.get(i).and_then(|v| v.as_str()).map(str::to_string))
                .unwrap_or_default();
            Some(strata_at(strata_lookup, &db_id, &project_id, &pid, depth))
        })();
        let (primary, secondary) = result.unwrap_or_else(|| ("Unknown".to_string(), "Unknown".to_string()));
        // Pad row so the indices we computed are in-bounds.
        while row.len() < need_len {
            row.push(Value::Null);
        }
        row[pri_idx] = Value::String(primary);
        row[sec_idx] = Value::String(secondary);
    }
}

// ── Coordinate-system conversion (issue #149) ──────────────────────────────────

/// Apply the project's coordinate-system conversion to a datasheet's columnar
/// data, in place.  Matches each row to a point by `db_id||PointId`, then:
///   • overwrites X1/Y1/Z1/Projection1 columns (the Points datasheet) with the
///     converted target-CRS values, and
///   • shifts every exact `Level` column (data datasheets) by the point's
///     elevation offset.
/// No-op when `overrides` is empty, the key columns are missing, or the
/// datasheet has no convertible columns.  `Level Reference` is NOT treated as a
/// `Level` column (exact, case-insensitive match only).
fn apply_coord_conversion(
    columns: &[String],
    rows: &mut [Vec<Value>],
    overrides: &std::collections::HashMap<String, CoordOverride>,
) {
    if overrides.is_empty() {
        return;
    }

    let find = |name: &str| columns.iter().position(|c| c.eq_ignore_ascii_case(name));
    let (Some(db_idx), Some(pid_idx)) = (find("db_id"), find("PointId")) else {
        return;
    };

    let x_idx = find("X1");
    let y_idx = find("Y1");
    let z_idx = find("Z1");
    let proj_idx = find("Projection1");
    let level_idxs: Vec<usize> = columns
        .iter()
        .enumerate()
        .filter(|(_, c)| c.eq_ignore_ascii_case("Level"))
        .map(|(i, _)| i)
        .collect();

    // Nothing in this datasheet to convert.
    if x_idx.is_none() && y_idx.is_none() && z_idx.is_none() && level_idxs.is_empty() {
        return;
    }

    let round3 = |n: f64| (n * 1000.0).round() / 1000.0;

    for row in rows.iter_mut() {
        let db = row.get(db_idx).and_then(|v| v.as_str()).unwrap_or("");
        let pid = match row.get(pid_idx) {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            _ => String::new(),
        };
        if pid.is_empty() {
            continue;
        }
        let key = format!("{db}||{pid}");
        let Some(ov) = overrides.get(&key) else { continue };

        if let (Some(i), Some(x)) = (x_idx, ov.x1) { row[i] = json!(x); }
        if let (Some(i), Some(y)) = (y_idx, ov.y1) { row[i] = json!(y); }
        if let (Some(i), Some(z)) = (z_idx, ov.z1) { row[i] = json!(z); }
        if let Some(i) = proj_idx {
            if !ov.projection1.is_empty() {
                row[i] = json!(ov.projection1.clone());
            }
        }
        if ov.zoffset != 0.0 {
            for &li in &level_idxs {
                if let Some(n) = row.get(li).and_then(|v| v.as_f64()) {
                    row[li] = json!(round3(n + ov.zoffset));
                }
            }
        }
    }
}

// ── xlsx writing ──────────────────────────────────────────────────────────────

pub(crate) fn write_datasheet(
    path: &Path,
    columns: &[String],
    rows: &[Vec<Value>],
    // Issue #176 (M5): user-authored formulas to re-emit as live formulas.
    // None / empty = plain value write (fresh downloads).
    formulas: Option<&FormulaMap>,
) -> Result<(), String> {
    let mut workbook = Workbook::new();
    let ws = workbook.add_worksheet();

    if rows.is_empty() {
        // Write just the header when there is no data.
        for (j, col) in columns.iter().enumerate() {
            ws.write_string(0, j as u16, col)
                .map_err(|e| format!("Write error: {e}"))?;
        }
        workbook.save(path).map_err(|e| format!("Failed to save xlsx: {e}"))?;
        return Ok(());
    }

    // Use a formatted table so columns auto-filter in Excel.
    let num_rows = rows.len() as u32;
    let num_cols = columns.len();

    // Write header + data cells.
    let bold = Format::new().set_bold();
    for (j, col) in columns.iter().enumerate() {
        ws.write_string_with_format(0, j as u16, col, &bold)
            .map_err(|e| format!("Write error: {e}"))?;
    }

    for (i, row) in rows.iter().enumerate() {
        let row_idx = (i + 1) as u32;
        for (j, val) in row.iter().enumerate() {
            // Issue #176: a cell that was a user formula on read is written
            // back as a live formula, with its cached value as the stored
            // result so it displays correctly until Excel recalculates.
            if let Some(f) = formulas.and_then(|m| m.get(&(i, j))) {
                let mut formula = Formula::new(f.as_str());
                let cached = match val {
                    Value::Number(n) => Some(n.to_string()),
                    Value::String(s) => Some(s.clone()),
                    Value::Bool(b)   => Some(b.to_string()),
                    _                => None,
                };
                if let Some(c) = cached {
                    formula = formula.set_result(&c);
                }
                let _ = ws.write_formula(row_idx, j as u16, formula);
                continue;
            }
            write_cell(ws, row_idx, j as u16, val);
        }
    }

    // Add an Excel table over the data range for auto-filter + banding.
    if num_cols > 0 {
        let table_cols: Vec<TableColumn> = columns
            .iter()
            .map(|name| TableColumn::new().set_header(name))
            .collect();
        let table = Table::new()
            .set_columns(&table_cols)
            .set_style(TableStyle::Medium2)
            .set_total_row(false);
        ws.add_table(0, 0, num_rows, (num_cols - 1) as u16, &table)
            .map_err(|e| format!("Table error: {e}"))?;
    }

    // Hide ID columns (mirrors Python `_hide_id_columns` in download.py).
    // The data is kept in the file — only the column visibility flag is set so
    // the cluttered GUIDs don't show by default.  Users can unhide via Excel's
    // column-header context menu if they need them.
    for (j, col) in columns.iter().enumerate() {
        if is_id_column(col) {
            ws.set_column_hidden(j as u16)
                .map_err(|e| format!("Hide error: {e}"))?;
        }
    }

    workbook.save(path).map_err(|e| format!("Failed to save xlsx: {e}"))
}

/// A column is considered an "ID column" — and therefore hidden by default in
/// exported datasheets — when its header ends with exactly `Id` (case sensitive).
/// This catches `ProjectId`, `PointId`, `SampleId`, `TestId`, etc. while
/// preserving `PointNo`, `ProjectNo`, `PointType`, `ProjectName`, etc.
/// Mirrors the Python rule in `backend/routers/download.py::_hide_id_columns`.
fn is_id_column(name: &str) -> bool {
    name.ends_with("Id")
}

/// Issue #109: dedup-key helper.  A column qualifies for the composite key
/// when its name is `db_id` (case-insensitive) OR ends in `Id` / `ID`.
/// Typical members for an SPTData sheet: db_id, ProjectId, PointId, TestId,
/// SampleId, DataSourceId.
fn is_dedup_id_column(name: &str) -> bool {
    let lc = name.to_ascii_lowercase();
    lc == "db_id" || lc.ends_with("id")
}

fn id_key_indices(columns: &[String]) -> Vec<usize> {
    columns.iter().enumerate()
        .filter(|(_, c)| is_dedup_id_column(c))
        .map(|(i, _)| i)
        .collect()
}

fn row_id_key(row: &[Value], indices: &[usize]) -> Vec<String> {
    indices.iter()
        .map(|&i| match row.get(i) {
            Some(Value::Null)      => String::new(),
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            Some(Value::Bool(b))   => b.to_string(),
            Some(other)            => other.to_string(),
            None                   => String::new(),
        })
        .collect()
}

/// Read an existing datasheet xlsx back into `(columns, rows, formulas)`
/// format compatible with `write_datasheet`.  Returns `None` if the file is
/// missing or unreadable; returns an empty rows vec if the sheet only has
/// the header row.  `formulas` (issue #176) maps `(data_row, col)` to the
/// user-authored formula string for cells that carry one — aligned through
/// the blank-row skipping below so positions match the returned `rows`.
pub(crate) fn read_existing_datasheet(path: &Path) -> Option<(Vec<String>, Vec<Vec<Value>>, FormulaMap)> {
    use calamine::{open_workbook_auto, Reader, Data};
    if !path.exists() {
        return None;
    }
    let mut wb = open_workbook_auto(path).ok()?;
    let sheet_name = wb.sheet_names().first().cloned()?;
    // Formula range first (separate lookup; same absolute sheet coordinates
    // convention as merge_formula_columns: header at sheet row 0).
    let formula_range = wb.worksheet_formula(&sheet_name).ok();
    let range = wb.worksheet_range(&sheet_name).ok()?;
    let mut rows_iter = range.rows();

    let header = rows_iter.next()?;
    let columns: Vec<String> = header.iter()
        .map(|c| match c {
            Data::String(s)   => s.clone(),
            Data::Int(i)      => i.to_string(),
            Data::Float(f)    => f.to_string(),
            Data::Bool(b)     => b.to_string(),
            Data::DateTime(d) => d.to_string(),
            _                  => String::new(),
        })
        .collect();
    if columns.is_empty() {
        return None;
    }

    let n_cols = columns.len();
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut formulas: FormulaMap = HashMap::new();
    // data_idx = position within the SHEET's data rows (header = sheet row 0,
    // first data row = sheet row 1); rows.len() = output index after skipping
    // blank rows — the formula lookup below keys on the OUTPUT index.
    for (data_idx, row) in rows_iter.enumerate() {
        let mut out = Vec::with_capacity(n_cols);
        for c in row.iter().take(n_cols) {
            let v = match c {
                Data::Empty | Data::Error(_) => Value::Null,
                Data::Bool(b)                => Value::Bool(*b),
                Data::Int(i)                 => Value::Number((*i).into()),
                Data::Float(f) => {
                    if f.fract() == 0.0 && f.is_finite() && (*f as i64) as f64 == *f {
                        Value::Number((*f as i64).into())
                    } else if let Some(n) = serde_json::Number::from_f64(*f) {
                        Value::Number(n)
                    } else {
                        Value::Null
                    }
                }
                Data::String(s)              => Value::String(s.clone()),
                Data::DateTime(d)            => Value::String(d.to_string()),
                _                            => Value::Null,
            };
            out.push(v);
        }
        // Pad short rows so every row has exactly n_cols entries.
        while out.len() < n_cols {
            out.push(Value::Null);
        }
        // A row counts as blank only when it ALSO has no formulas — a row of
        // formulas whose cached values are empty must survive the round-trip.
        let sheet_row = data_idx + 1; // header occupies sheet row 0
        let mut row_formulas: Vec<(usize, String)> = Vec::new();
        if let Some(fr) = formula_range.as_ref() {
            for j in 0..n_cols {
                if let Some(f) = fr.get((sheet_row, j)) {
                    if !f.is_empty() {
                        row_formulas.push((j, f.clone()));
                    }
                }
            }
        }
        let all_blank = row_formulas.is_empty() && out.iter().all(|v| match v {
            Value::Null               => true,
            Value::String(s) if s.is_empty() => true,
            _                          => false,
        });
        if all_blank {
            continue;
        }
        let out_idx = rows.len();
        for (j, f) in row_formulas {
            formulas.insert((out_idx, j), f);
        }
        rows.push(out);
    }
    Some((columns, rows, formulas))
}

fn write_cell(ws: &mut rust_xlsxwriter::Worksheet, row: u32, col: u16, val: &Value) {
    match val {
        Value::Null => { let _ = ws.write_blank(row, col, &Format::default()); }
        Value::Bool(b) => { let _ = ws.write_boolean(row, col, *b); }
        Value::Number(n) => {
            if let Some(f) = n.as_f64() { let _ = ws.write_number(row, col, f); }
        }
        Value::String(s) => { let _ = ws.write_string(row, col, s); }
        other => { let _ = ws.write_string(row, col, &other.to_string()); }
    }
}

// ── Conversion: Vec<Value> rows-as-objects → (columns, Vec<Vec<Value>>) ───────

pub(crate) fn objects_to_columnar(rows: Vec<Value>) -> (Vec<String>, Vec<Vec<Value>>) {
    if rows.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let columns: Vec<String> = rows
        .first()
        .and_then(|r| r.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();

    let data: Vec<Vec<Value>> = rows
        .into_iter()
        .map(|row| {
            if let Some(obj) = row.as_object() {
                columns
                    .iter()
                    .map(|k| obj.get(k).cloned().unwrap_or(Value::Null))
                    .collect()
            } else {
                vec![Value::Null; columns.len()]
            }
        })
        .collect();

    (columns, data)
}

/// Inverse of [`objects_to_columnar`].  Rebuild row-objects from a parallel
/// `columns` slice and a positional `rows` matrix.
pub(crate) fn columnar_to_objects(columns: &[String], rows: Vec<Vec<Value>>) -> Vec<Value> {
    rows.into_iter()
        .map(|r| {
            let mut obj = serde_json::Map::new();
            for (i, col) in columns.iter().enumerate() {
                obj.insert(col.clone(), r.get(i).cloned().unwrap_or(Value::Null));
            }
            Value::Object(obj)
        })
        .collect()
}

/// Convert a calamine `Data` cell to a plain `String` (or empty for null/error).
fn data_str(cell: &Data) -> String {
    match cell {
        Data::String(s)   => s.clone(),
        Data::Float(f)    => {
            if f.fract() == 0.0 { format!("{}", *f as i64) } else { f.to_string() }
        }
        Data::Int(i)      => i.to_string(),
        Data::Bool(b)     => b.to_string(),
        Data::DateTime(d) => d.to_string(),
        _                 => String::new(),
    }
}

/// Convert a calamine `Data` cell into a `serde_json::Value` (preserves type
/// where reasonable so the frontend gets numbers as numbers, not strings).
///
/// Strings that look like locale-formatted numbers (`"1,5"`, `"1.234,56"`, …)
/// are parsed via `parse_number_locale` so chart axes treat them as numeric.
fn data_to_value(cell: &Data) -> Value {
    match cell {
        Data::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                Value::Null
            } else if let Some(n) = parse_number_locale(trimmed) {
                json!(n)
            } else {
                Value::String(s.clone())
            }
        }
        Data::Float(f)    => json!(f),
        Data::Int(i)      => json!(i),
        Data::Bool(b)     => Value::Bool(*b),
        Data::DateTime(d) => Value::String(d.to_string()),
        Data::Empty | Data::Error(_) | Data::DateTimeIso(_) | Data::DurationIso(_) => Value::Null,
    }
}

// ── Tiny formula evaluator (for user-added formula columns in datasheets) ─────
//
// Calamine returns the *cached* value of formula cells.  rust_xlsxwriter
// doesn't write cached values, and Excel only caches them when the user
// edits + saves. If the user adds a formula column and we read the file
// before Excel has written cached values, we get empty cells.
//
// This evaluator handles the common case so the chart renders something
// useful instead of nothing.  Supports:
//   * Literal numbers (1.5, -3, 42)
//   * Cell references (e.g. B2, AC10) — relative to the current row only
//   * Operators: + - * /, with standard precedence
//   * Parentheses
//   * Negative-number prefix (e.g. `=-B2*2`)
//
// Anything more complex (functions, ranges, multi-row references, text
// concat, IF) returns None and the cell stays empty — same as before.

/// Convert column letters (A, B, ..., Z, AA, AB, ...) to 0-based index.
fn col_letters_to_idx(s: &str) -> Option<usize> {
    if s.is_empty() { return None; }
    let mut idx: usize = 0;
    for c in s.chars() {
        if !c.is_ascii_uppercase() { return None; }
        idx = idx.checked_mul(26)?.checked_add((c as usize) - ('A' as usize) + 1)?;
    }
    Some(idx - 1)
}

/// Convert a calamine cell to f64 for arithmetic.  Returns None for non-numeric.
fn cell_to_f64(cell: &Data) -> Option<f64> {
    match cell {
        Data::Float(f) => Some(*f),
        Data::Int(i)   => Some(*i as f64),
        Data::Bool(b)  => Some(if *b { 1.0 } else { 0.0 }),
        Data::String(s) => parse_number_locale(s),
        _ => None,
    }
}

/// Parse a numeric string supporting both English (`1,234.56`) and European
/// (`1.234,56`) locale formats.  Many Danish-locale Excel files store numbers
/// as text in the form `"1,5"` (one and a half) which a naive parser turns
/// into `15`.  This function picks the correct interpretation:
///
///   * `1.5`         → 1.5    (invariant — period decimal, no comma)
///   * `1,5`         → 1.5    (European decimal)
///   * `1,234.56`    → 1234.56 (English: comma thousands, period decimal)
///   * `1.234,56`    → 1234.56 (European: period thousands, comma decimal)
///   * `1234`        → 1234
///   * empty / non-numeric → None
///
/// Disambiguates `1,234` (could be 1.234 European or 1234 English) by
/// looking at *where* the comma is relative to the period.  When only a
/// comma is present, defaults to the European interpretation because the
/// frontend running this code is built for Danish geotech data.
pub(crate) fn parse_number_locale(raw: &str) -> Option<f64> {
    let s = raw.trim();
    if s.is_empty() { return None; }

    // Strip leading +/- so we don't get confused by signed numbers.
    let (sign, body) = if let Some(rest) = s.strip_prefix('-') {
        (-1.0_f64, rest)
    } else if let Some(rest) = s.strip_prefix('+') {
        (1.0, rest)
    } else {
        (1.0, s)
    };

    // Fast path: invariant format (no comma).  Handles "1.5", "1234", "1e-3".
    if !body.contains(',') {
        return body.parse::<f64>().ok().map(|n| sign * n);
    }

    let has_period = body.contains('.');
    let last_comma  = body.rfind(',').unwrap_or(0);
    let last_period = body.rfind('.').unwrap_or(0);

    let normalised = if has_period {
        // Both separators present — the *last* one wins as the decimal mark.
        if last_comma > last_period {
            // European: 1.234,56  →  strip dots, swap comma for dot.
            body.replace('.', "").replace(',', ".")
        } else {
            // English: 1,234.56   →  strip commas.
            body.replace(',', "")
        }
    } else {
        // Only commas, no period.
        // Default to European decimal: 1,5 → 1.5, 1.234,56 → 1234.56, etc.
        body.replace(',', ".")
    };

    normalised.parse::<f64>().ok().map(|n| sign * n)
}

/// Evaluate an Excel formula referencing cells in the same row.
///
/// Supports arithmetic (+ - * / ^), comparison operators (= <> < > <= >=),
/// parentheses, unary +/-, text concatenation (&), and these common functions:
///   IF / IFERROR / IFS
///   AND / OR / NOT / TRUE / FALSE
///   MIN / MAX / SUM / AVERAGE / COUNT
///   ABS / ROUND / ROUNDUP / ROUNDDOWN / INT / TRUNC / SIGN / SQRT
///   POWER / MOD / EXP / LN / LOG / LOG10 / PI
///
/// Returns Some(f64) only when the formula evaluates to a number.  Returns
/// None for text-only results, errors, or formulas that reference cells in
/// other rows.  The caller treats None as N/A.
fn eval_simple_formula(
    formula:            &str,
    current_row_1based: u32,
    row_data:           &[Data],
) -> Option<f64> {
    let src = formula.trim();
    let src = src.strip_prefix('=').unwrap_or(src).trim();
    if src.is_empty() { return None; }

    let ctx = EvalCtx { row_1based: current_row_1based, row: row_data };
    let mut p = Parser::new(src, &ctx);
    let v = p.parse_expression()?;
    if !p.at_end() { return None; }
    match v {
        Val::Num(n)  => Some(n),
        Val::Bool(b) => Some(if b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

// ── Evaluator types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
enum Val {
    Num(f64),
    Bool(bool),
    Text(String),
    Empty,
}

impl Val {
    fn to_num(&self) -> Option<f64> {
        match self {
            Val::Num(n)  => Some(*n),
            Val::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            Val::Empty   => Some(0.0),
            Val::Text(s) => parse_number_locale(s),
        }
    }
    fn to_bool(&self) -> Option<bool> {
        match self {
            Val::Bool(b) => Some(*b),
            Val::Num(n)  => Some(*n != 0.0),
            Val::Empty   => Some(false),
            Val::Text(s) => match s.to_ascii_uppercase().as_str() {
                "TRUE"  => Some(true),
                "FALSE" => Some(false),
                _ => parse_number_locale(s).map(|n| n != 0.0),
            },
        }
    }
    fn to_text(&self) -> String {
        match self {
            Val::Num(n)  => {
                if n.fract() == 0.0 && n.abs() < 1e15 {
                    format!("{}", *n as i64)
                } else {
                    format!("{n}")
                }
            }
            Val::Bool(b) => (if *b { "TRUE" } else { "FALSE" }).to_string(),
            Val::Text(s) => s.clone(),
            Val::Empty   => String::new(),
        }
    }
    fn is_empty_text(&self) -> bool {
        matches!(self, Val::Empty) || matches!(self, Val::Text(s) if s.is_empty())
    }
}

struct EvalCtx<'a> {
    row_1based: u32,
    row:        &'a [Data],
}

impl EvalCtx<'_> {
    /// Read the value of `<col_letters><row_num>` for the current row only.
    /// Refs to other rows return None.
    fn resolve_cell(&self, col_letters: &str, row_num: u32) -> Option<Val> {
        if row_num != self.row_1based { return None; }
        let col_idx = col_letters_to_idx(col_letters)?;
        let cell = self.row.get(col_idx)?;
        Some(match cell {
            Data::Float(f)  => Val::Num(*f),
            Data::Int(i)    => Val::Num(*i as f64),
            Data::Bool(b)   => Val::Bool(*b),
            Data::String(s) => {
                let t = s.trim();
                if t.is_empty() { Val::Empty }
                else if let Some(n) = parse_number_locale(t) { Val::Num(n) }
                else { Val::Text(s.clone()) }
            }
            _ => Val::Empty,
        })
    }
}

// ── Recursive-descent parser ─────────────────────────────────────────────────
//
// Grammar (highest precedence at bottom):
//   expr        := concat
//   concat      := comparison ( "&" comparison )*                  (string concat)
//   comparison  := additive ( ( "=" | "<>" | "<" | ">" | "<=" | ">=" ) additive )?
//   additive    := multiplicative ( ( "+" | "-" ) multiplicative )*
//   multiplicative := power ( ( "*" | "/" ) power )*
//   power       := unary ( "^" power )?                            (right-assoc)
//   unary       := ( "+" | "-" ) unary | primary
//   primary     := NUMBER | STRING | TRUE | FALSE | "(" expr ")"
//                | cell_ref
//                | FUNC_NAME "(" arglist ")"
//   cell_ref    := [$]?[A-Z]+[$]?[0-9]+
//   arglist     := expr ( "," expr )*

struct Parser<'a> {
    src: &'a str,
    pos: usize,
    ctx: &'a EvalCtx<'a>,
}

impl<'a> Parser<'a> {
    fn new(src: &'a str, ctx: &'a EvalCtx<'a>) -> Self {
        Self { src, pos: 0, ctx }
    }

    fn at_end(&mut self) -> bool { self.skip_ws(); self.pos >= self.src.len() }
    fn peek(&self) -> Option<char> { self.src[self.pos..].chars().next() }

    fn skip_ws(&mut self) {
        while let Some(c) = self.peek() {
            if c.is_whitespace() { self.pos += c.len_utf8(); } else { break; }
        }
    }

    fn consume(&mut self, lit: &str) -> bool {
        self.skip_ws();
        if self.src[self.pos..].starts_with(lit) { self.pos += lit.len(); true } else { false }
    }

    // ── Grammar productions ─────────────────────────────────────────────────

    fn parse_expression(&mut self) -> Option<Val> { self.parse_concat() }

    fn parse_concat(&mut self) -> Option<Val> {
        let mut left = self.parse_comparison()?;
        loop {
            self.skip_ws();
            if self.consume("&") {
                let right = self.parse_comparison()?;
                left = Val::Text(format!("{}{}", left.to_text(), right.to_text()));
            } else { break; }
        }
        Some(left)
    }

    fn parse_comparison(&mut self) -> Option<Val> {
        let left = self.parse_additive()?;
        self.skip_ws();
        // Order matters: try 2-char before 1-char.
        for (op, _) in [("<>", 0), ("<=", 0), (">=", 0)] {
            if self.consume(op) {
                let right = self.parse_additive()?;
                return Some(Val::Bool(compare(&left, &right, op)));
            }
        }
        for op in ["=", "<", ">"] {
            if self.consume(op) {
                let right = self.parse_additive()?;
                return Some(Val::Bool(compare(&left, &right, op)));
            }
        }
        Some(left)
    }

    fn parse_additive(&mut self) -> Option<Val> {
        let mut left = self.parse_multiplicative()?;
        loop {
            self.skip_ws();
            if self.consume("+") {
                let r = self.parse_multiplicative()?;
                left = Val::Num(left.to_num()? + r.to_num()?);
            } else if self.consume("-") {
                let r = self.parse_multiplicative()?;
                left = Val::Num(left.to_num()? - r.to_num()?);
            } else { break; }
        }
        Some(left)
    }

    fn parse_multiplicative(&mut self) -> Option<Val> {
        let mut left = self.parse_power()?;
        loop {
            self.skip_ws();
            if self.consume("*") {
                let r = self.parse_power()?;
                left = Val::Num(left.to_num()? * r.to_num()?);
            } else if self.consume("/") {
                let r = self.parse_power()?;
                let rn = r.to_num()?;
                if rn == 0.0 { return None; }
                left = Val::Num(left.to_num()? / rn);
            } else { break; }
        }
        Some(left)
    }

    fn parse_power(&mut self) -> Option<Val> {
        let base = self.parse_unary()?;
        self.skip_ws();
        if self.consume("^") {
            let exp = self.parse_power()?;
            return Some(Val::Num(base.to_num()?.powf(exp.to_num()?)));
        }
        Some(base)
    }

    fn parse_unary(&mut self) -> Option<Val> {
        self.skip_ws();
        if self.consume("-") {
            let v = self.parse_unary()?;
            return Some(Val::Num(-v.to_num()?));
        }
        if self.consume("+") {
            return self.parse_unary();
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Option<Val> {
        self.skip_ws();
        let c = self.peek()?;

        // Parenthesised sub-expression
        if c == '(' {
            self.pos += 1;
            let v = self.parse_expression()?;
            if !self.consume(")") { return None; }
            return Some(v);
        }

        // String literal
        if c == '"' {
            self.pos += 1;
            let mut s = String::new();
            while let Some(ch) = self.peek() {
                if ch == '"' {
                    self.pos += 1;
                    // Excel doubles `""` for escaping a quote inside a string.
                    if self.peek() == Some('"') {
                        s.push('"');
                        self.pos += 1;
                        continue;
                    }
                    return Some(Val::Text(s));
                }
                s.push(ch);
                self.pos += ch.len_utf8();
            }
            return None; // unterminated string
        }

        // Number literal
        if c.is_ascii_digit() || c == '.' {
            return self.parse_number_literal();
        }

        // Identifier — could be TRUE, FALSE, function call, or cell ref
        if c == '$' || c.is_ascii_alphabetic() {
            return self.parse_identifier_like();
        }

        None
    }

    fn parse_number_literal(&mut self) -> Option<Val> {
        let start = self.pos;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() || c == '.' || c == 'e' || c == 'E' {
                self.pos += c.len_utf8();
            } else if (c == '+' || c == '-')
                && self.src.as_bytes().get(self.pos.wrapping_sub(1))
                       .map(|&b| b == b'e' || b == b'E').unwrap_or(false)
            {
                // exponent sign
                self.pos += 1;
            } else { break; }
        }
        self.src[start..self.pos].parse::<f64>().ok().map(Val::Num)
    }

    /// Parse an identifier: function name, TRUE/FALSE, or cell reference.
    fn parse_identifier_like(&mut self) -> Option<Val> {
        let start = self.pos;
        // Optional leading $
        if self.peek() == Some('$') { self.pos += 1; }
        // Read letters
        let letters_start = self.pos;
        while let Some(c) = self.peek() {
            if c.is_ascii_alphabetic() || c == '_' || c == '.' { self.pos += c.len_utf8(); }
            else { break; }
        }
        let letters_end = self.pos;
        let letters = &self.src[letters_start..letters_end].to_ascii_uppercase();
        if letters.is_empty() { return None; }

        // Boolean literals
        if letters == "TRUE"  { return Some(Val::Bool(true)); }
        if letters == "FALSE" { return Some(Val::Bool(false)); }
        if letters == "PI"    && self.peek() != Some('(') {
            return Some(Val::Num(std::f64::consts::PI));
        }

        // Function call?
        self.skip_ws();
        if self.peek() == Some('(') {
            self.pos += 1;
            let mut args: Vec<Val> = Vec::new();
            self.skip_ws();
            if self.peek() != Some(')') {
                loop {
                    let v = self.parse_expression()?;
                    args.push(v);
                    self.skip_ws();
                    if self.consume(",") { continue; }
                    if self.consume(")") { return call_func(letters, args); }
                    return None;
                }
            }
            self.pos += 1; // ')'
            return call_func(letters, args);
        }

        // Cell reference: optional $ then digits.
        if self.peek() == Some('$') { self.pos += 1; }
        let digits_start = self.pos;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() { self.pos += 1; } else { break; }
        }
        if self.pos == digits_start { return None; }
        let row_num: u32 = self.src[digits_start..self.pos].parse().ok()?;
        // Pure-letters portion of the identifier (after stripping any $).
        let only_letters: String = letters.chars().filter(|c| c.is_ascii_uppercase()).collect();
        let v = self.ctx.resolve_cell(&only_letters, row_num)?;
        // Silence unused
        let _ = start;
        Some(v)
    }
}

fn compare(a: &Val, b: &Val, op: &str) -> bool {
    // Both sides numeric → numeric compare.  Otherwise text compare.
    if let (Some(an), Some(bn)) = (a.to_num(), b.to_num()) {
        return match op {
            "="  => an == bn,
            "<>" => an != bn,
            "<"  => an <  bn,
            ">"  => an >  bn,
            "<=" => an <= bn,
            ">=" => an >= bn,
            _    => false,
        };
    }
    let at = a.to_text();
    let bt = b.to_text();
    match op {
        "="  => at == bt,
        "<>" => at != bt,
        "<"  => at <  bt,
        ">"  => at >  bt,
        "<=" => at <= bt,
        ">=" => at >= bt,
        _    => false,
    }
}

/// Dispatch a function call (`name` already upper-cased).
fn call_func(name: &str, args: Vec<Val>) -> Option<Val> {
    fn num(a: &Val) -> Option<f64> { a.to_num() }
    fn all_nums(args: &[Val]) -> Vec<f64> {
        args.iter().filter_map(|v| v.to_num()).collect()
    }

    match name {
        "IF" => {
            // IF(condition, value_if_true [, value_if_false])
            if args.len() < 2 || args.len() > 3 { return None; }
            let cond = args[0].to_bool()?;
            if cond { Some(args[1].clone()) }
            else if args.len() == 3 { Some(args[2].clone()) }
            else { Some(Val::Bool(false)) }
        }
        "IFERROR" => {
            // We have no "error" type — formulas that fail evaluation already
            // return None.  Best-effort: if arg[0] is an empty text or empty,
            // use arg[1].
            if args.is_empty() { return None; }
            if args.len() >= 2 && args[0].is_empty_text() {
                Some(args[1].clone())
            } else {
                Some(args[0].clone())
            }
        }
        "IFS" => {
            // IFS(cond1, val1, cond2, val2, ...)
            if args.len() < 2 || args.len() % 2 != 0 { return None; }
            for pair in args.chunks(2) {
                if pair[0].to_bool().unwrap_or(false) {
                    return Some(pair[1].clone());
                }
            }
            None
        }
        "AND" => {
            for a in &args { if !a.to_bool()? { return Some(Val::Bool(false)); } }
            Some(Val::Bool(!args.is_empty()))
        }
        "OR" => {
            for a in &args { if a.to_bool()? { return Some(Val::Bool(true)); } }
            Some(Val::Bool(false))
        }
        "NOT" => {
            if args.len() != 1 { return None; }
            Some(Val::Bool(!args[0].to_bool()?))
        }
        "MIN" => {
            let ns = all_nums(&args);
            ns.into_iter().reduce(f64::min).map(Val::Num)
        }
        "MAX" => {
            let ns = all_nums(&args);
            ns.into_iter().reduce(f64::max).map(Val::Num)
        }
        "SUM" => Some(Val::Num(all_nums(&args).iter().sum::<f64>())),
        "AVERAGE" | "AVG" => {
            let ns = all_nums(&args);
            if ns.is_empty() { None } else { Some(Val::Num(ns.iter().sum::<f64>() / ns.len() as f64)) }
        }
        "COUNT" => {
            // Count of numeric arguments.
            Some(Val::Num(all_nums(&args).len() as f64))
        }
        "ABS"  => Some(Val::Num(num(args.first()?)?.abs())),
        "SIGN" => {
            let n = num(args.first()?)?;
            Some(Val::Num(if n > 0.0 { 1.0 } else if n < 0.0 { -1.0 } else { 0.0 }))
        }
        "SQRT" => Some(Val::Num(num(args.first()?)?.sqrt())),
        "EXP"  => Some(Val::Num(num(args.first()?)?.exp())),
        "LN"   => Some(Val::Num(num(args.first()?)?.ln())),
        "LOG"  => {
            // LOG(number, [base])  — Excel default base = 10
            let n = num(args.first()?)?;
            let base = args.get(1).and_then(num).unwrap_or(10.0);
            Some(Val::Num(n.log(base)))
        }
        "LOG10" => Some(Val::Num(num(args.first()?)?.log10())),
        "POWER" => {
            let base = num(args.first()?)?;
            let exp  = num(args.get(1)?)?;
            Some(Val::Num(base.powf(exp)))
        }
        "MOD" => {
            let a = num(args.first()?)?;
            let b = num(args.get(1)?)?;
            if b == 0.0 { None } else { Some(Val::Num(a - b * (a / b).floor())) }
        }
        "INT"   => Some(Val::Num(num(args.first()?)?.floor())),
        "TRUNC" => {
            let n = num(args.first()?)?;
            let d = args.get(1).and_then(num).unwrap_or(0.0);
            let f = 10f64.powi(d as i32);
            Some(Val::Num((n * f).trunc() / f))
        }
        "ROUND" => {
            let n = num(args.first()?)?;
            let d = num(args.get(1)?)?;
            let f = 10f64.powi(d as i32);
            Some(Val::Num((n * f).round() / f))
        }
        "ROUNDUP" => {
            let n = num(args.first()?)?;
            let d = num(args.get(1)?)?;
            let f = 10f64.powi(d as i32);
            Some(Val::Num((n * f).abs().ceil() * n.signum() / f))
        }
        "ROUNDDOWN" => {
            let n = num(args.first()?)?;
            let d = num(args.get(1)?)?;
            let f = 10f64.powi(d as i32);
            Some(Val::Num((n * f).abs().floor() * n.signum() / f))
        }
        "CEILING" => {
            let n   = num(args.first()?)?;
            let sig = args.get(1).and_then(num).unwrap_or(1.0);
            if sig == 0.0 { return None; }
            Some(Val::Num((n / sig).ceil() * sig))
        }
        "FLOOR" => {
            let n   = num(args.first()?)?;
            let sig = args.get(1).and_then(num).unwrap_or(1.0);
            if sig == 0.0 { return None; }
            Some(Val::Num((n / sig).floor() * sig))
        }
        "PI" => Some(Val::Num(std::f64::consts::PI)),
        _ => None, // unknown function — return None so caller falls back to N/A
    }
}

/// Append one column per group system to each row, matched by PointId.
///
/// Mirrors Python `_apply_group_columns` in `backend/routers/download.py`.
/// Reads `{output_folder}/Grouping.xlsx`; column headers beyond the fixed five
/// (`PointId`, `PointNo`, `ProjectNo`, `ProjectName`, `PointType`) are treated
/// as group-system names and appended to `columns`.  For each row, the value
/// for that point in that system is appended, or `"Unknown"` if the point is
/// not present in Grouping.xlsx.
///
/// No-ops silently when:
///   * Grouping.xlsx does not exist
///   * the SQL result has no `PointId` column
///   * Grouping.xlsx has no system-name columns
pub(crate) fn apply_group_columns(
    output_folder: &str,
    columns: &mut Vec<String>,
    rows: &mut Vec<Vec<Value>>,
) {
    use crate::commands::multi_db::LEGACY_DB_ID;

    let path = PathBuf::from(output_folder).join("Grouping.xlsx");
    if !path.exists() {
        return;
    }

    let mut wb: Xlsx<_> = match open_workbook(&path) {
        Ok(w) => w,
        Err(_) => return,
    };
    let range = match wb.worksheet_range_at(0) {
        Some(Ok(r)) => r,
        _ => return,
    };

    let mut iter = range.rows();
    let headers: Vec<String> = match iter.next() {
        Some(r) => r.iter().map(data_str).collect(),
        None => return,
    };

    let pid_idx = match headers.iter().position(|h| h == "PointId") {
        Some(i) => i,
        None => return,
    };

    // Optional `db_id` column (issue #48).  When present, point assignments
    // are keyed by `(db_id, point_id)` so the same PointId from different
    // databases doesn't collide.  Legacy 5-fixed-cols files use LEGACY_DB_ID.
    let db_idx = headers
        .iter()
        .position(|h| h.eq_ignore_ascii_case("db_id"));

    // Columns beyond the fixed five (plus optional db_id) are system-name columns.
    let mut skip: HashSet<&str> =
        ["PointId", "PointNo", "ProjectNo", "ProjectName", "PointType"].into_iter().collect();
    skip.insert("db_id");
    let sys_cols: Vec<(usize, String)> = headers
        .iter()
        .enumerate()
        .filter(|(_, h)| !h.is_empty() && !skip.contains(h.as_str()))
        .map(|(i, h)| (i, h.clone()))
        .collect();

    if sys_cols.is_empty() {
        return;
    }

    // Build (db_id, pointId) → { sys_name → value } from the xlsx data rows.
    let mut assignments: HashMap<(String, String), HashMap<String, String>> = HashMap::new();
    for row in iter {
        let pid = match row.get(pid_idx) {
            Some(c) if !matches!(c, Data::Empty) => data_str(c),
            _ => continue,
        };
        if pid.is_empty() {
            continue;
        }
        let db_id = db_idx
            .and_then(|i| row.get(i))
            .map(data_str)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| LEGACY_DB_ID.to_string());

        let mut entry = HashMap::new();
        for (ci, sys_name) in &sys_cols {
            if let Some(cell) = row.get(*ci) {
                let v = data_str(cell);
                if !v.is_empty() {
                    entry.insert(sys_name.clone(), v);
                }
            }
        }
        assignments.insert((db_id, pid), entry);
    }

    // Find PointId in the SQL result (case-insensitive).
    let result_pid_idx = match columns.iter().position(|c| c.eq_ignore_ascii_case("pointid")) {
        Some(i) => i,
        None => return,
    };
    // Optional db_id column in the SQL result (added by multi_db fan-out).
    let result_db_idx = columns.iter().position(|c| c.eq_ignore_ascii_case("db_id"));

    // Append system columns to the header.
    for (_, sys_name) in &sys_cols {
        columns.push(sys_name.clone());
    }

    // Append per-row values for each system column.
    for row in rows.iter_mut() {
        let pid = row
            .get(result_pid_idx)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let db_id = result_db_idx
            .and_then(|i| row.get(i).and_then(|v| v.as_str()).map(str::to_string))
            .unwrap_or_else(|| LEGACY_DB_ID.to_string());

        for (_, sys_name) in &sys_cols {
            // Prefer exact (db_id, pid) match; fall back to (LEGACY, pid) so
            // rows from a single-DB user with no db_id column still resolve.
            let val = pid
                .as_ref()
                .and_then(|p| {
                    assignments
                        .get(&(db_id.clone(), p.clone()))
                        .or_else(|| assignments.get(&(LEGACY_DB_ID.to_string(), p.clone())))
                })
                .and_then(|m| m.get(sys_name))
                .cloned()
                .unwrap_or_else(|| "Unknown".to_string());
            row.push(Value::String(val));
        }
    }
}

/// Merge user-added columns from a previously-saved datasheet xlsx into the
/// SQL result rows.
///
/// Mirrors Python `_merge_formula_columns` in `backend/routers/download.py`.
/// Looks for `{output_folder}/Datasheets/{query_name}.xlsx` first, then
/// `{output_folder}/{query_name}.xlsx`.  For any column header in the file
/// that is NOT in the current SQL result, its cached computed value is merged
/// into each row by matching the `PointId` column.
///
/// Calamine returns cached computed values for formula cells, which is exactly
/// what we want (equivalent to Python's `data_only=True`).
///
/// No-ops silently when the file is absent or has no extra columns.
// ── LibreOffice headless formula recalculation ───────────────────────────────
//
// Mirrors `scripts/recalc.py` from the Python backend.  When the user has
// added formulas to the datasheet xlsx but Excel hasn't cached the computed
// values (e.g. the file was written by rust_xlsxwriter and never opened in
// Excel), we shell out to LibreOffice to re-save the file with all formulas
// recalculated and cached.  The recalculated copy is written to a temp dir;
// the caller cleans up the parent directory.

const LIBREOFFICE_CANDIDATES: &[&str] = &[
    "soffice",
    "libreoffice",
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    "/usr/bin/libreoffice",
    "/usr/bin/soffice",
    "/usr/local/bin/libreoffice",
    "/usr/local/bin/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
];

/// Probe each candidate path; return the first one that responds to --version.
fn find_libreoffice() -> Option<String> {
    use std::process::Command;
    for exe in LIBREOFFICE_CANDIDATES {
        if let Ok(out) = Command::new(exe).arg("--version").output() {
            if out.status.success() {
                return Some((*exe).to_string());
            }
        }
    }
    None
}

/// Copy `path` to a fresh temp dir, run LibreOffice headless to recalculate
/// all formulas into the copy, and return the path to the recalculated file.
/// Returns None if LibreOffice is unavailable or the conversion fails.
/// On success, the caller is responsible for cleaning up
/// `result.parent()` (e.g. via `std::fs::remove_dir_all`).
fn recalc_to_temp(path: &std::path::Path) -> Option<PathBuf> {
    use std::process::Command;

    let lo = find_libreoffice()?;

    // Unique temp dir — multiple charts may recalc concurrently.
    let tmp_dir = std::env::temp_dir().join(format!(
        "girtool_recalc_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    ));
    std::fs::create_dir_all(&tmp_dir).ok()?;

    // Convert xlsx → xlsx into tmp_dir; LibreOffice opens, recalculates,
    // and writes <basename>.xlsx into the output directory.
    let result = Command::new(&lo)
        .args(["--headless", "--convert-to", "xlsx", "--outdir"])
        .arg(&tmp_dir)
        .arg(path)
        .output();

    let ok = match result {
        Ok(out) => out.status.success(),
        Err(_)  => false,
    };
    if !ok {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return None;
    }

    let out_path = tmp_dir.join(path.file_name()?);
    if !out_path.exists() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return None;
    }
    Some(out_path)
}

/// Choose the best column to use as the join key between the xlsx file's
/// extra formula columns and the SQL result rows.
///
/// Strategy (mirrors Python `_merge_formula_columns._best_id_idx`):
///   1. Prefer a row-unique `*Id` column other than `PointId` / `ProjectId`
///      (e.g. `UWId`, `CPTId`, `SampleId`, `LayerId`).  These uniquely
///      identify ONE row each so formula values stay attached to the
///      correct measurement.
///   2. Otherwise fall back to any `*Id` column or `PointNo`.
/// The chosen column must exist in BOTH the xlsx headers and the SQL result
/// columns (otherwise we can't actually match rows back to formula values).
///
/// Returns `(xlsx_col_idx, sql_col_idx, header_name)` for the chosen key.
fn find_match_key(
    xlsx_headers: &[String],
    sql_columns:  &[String],
) -> Option<(usize, usize, String)> {
    const BROAD: &[&str] = &["pointid", "projectid"];

    // Pass 1: unique IDs (not in BROAD).
    for (xi, h) in xlsx_headers.iter().enumerate() {
        let hl = h.to_lowercase();
        if hl.ends_with("id") && !BROAD.contains(&hl.as_str()) {
            if let Some(si) = sql_columns.iter().position(|c| c.eq_ignore_ascii_case(h)) {
                return Some((xi, si, h.clone()));
            }
        }
    }

    // Pass 2: any *Id or PointNo (broad fallback — may cluster on shared IDs).
    for (xi, h) in xlsx_headers.iter().enumerate() {
        let hl = h.to_lowercase();
        if hl.ends_with("id") || hl == "pointno" {
            if let Some(si) = sql_columns.iter().position(|c| c.eq_ignore_ascii_case(h)) {
                return Some((xi, si, h.clone()));
            }
        }
    }
    None
}

pub(crate) fn merge_formula_columns(
    output_folder: &str,
    query_name: &str,
    columns: &mut Vec<String>,
    rows: &mut Vec<Vec<Value>>,
) {
    let target = format!("{query_name}.xlsx");
    let original_path = {
        let primary = PathBuf::from(output_folder).join("Datasheets").join(&target);
        if primary.exists() {
            primary
        } else {
            let fallback = PathBuf::from(output_folder).join(&target);
            if fallback.exists() {
                fallback
            } else {
                return;
            }
        }
    };

    // === LibreOffice recalc decision ========================================
    // Mirrors `_recalc_to_temp` in the Python backend.  If the user added
    // formulas to extra columns but Excel hasn't cached the computed values
    // (e.g. the file was written by rust_xlsxwriter and never opened in
    // Excel), we ask LibreOffice headless to re-save the file with formulas
    // recalculated.  This gives us 100% Excel-formula compatibility without
    // reimplementing the formula engine in Rust.
    //
    // The decision is cheap: open the file, scan extra columns, abort if no
    // missing-value-with-formula combo exists.  If a recalc is performed,
    // the result lives in a temp dir that we clean up at function exit.
    let recalc_dir_to_cleanup: Option<PathBuf> = (|| -> Option<PathBuf> {
        let mut wb: Xlsx<_> = open_workbook(&original_path).ok()?;
        let range = wb.worksheet_range_at(0)?.ok()?;
        let formulas = wb.sheet_names().first().cloned()
            .and_then(|n| wb.worksheet_formula(&n).ok())?;

        let mut iter = range.rows();
        let headers: Vec<String> = iter.next()?.iter().map(data_str).collect();
        let sql_set: HashSet<String> = columns.iter().map(|s| s.to_lowercase()).collect();
        let extra_idx: Vec<usize> = headers.iter().enumerate()
            .filter(|(_, h)| !h.is_empty() && !sql_set.contains(&h.to_lowercase()))
            .map(|(i, _)| i)
            .collect();
        if extra_idx.is_empty() { return None; }

        // Is there at least one extra-column cell whose VALUE is empty but
        // whose FORMULA is non-empty?  That's the recalc trigger.
        let mut needs_recalc = false;
        for (data_idx, row) in iter.enumerate() {
            for &ci in &extra_idx {
                let val_empty = matches!(row.get(ci), Some(Data::Empty) | None);
                if val_empty {
                    let frow = data_idx + 1; // header at row 0, first data at 1
                    if let Some(f) = formulas.get((frow, ci)) {
                        if !f.is_empty() { needs_recalc = true; break; }
                    }
                }
            }
            if needs_recalc { break; }
        }
        if !needs_recalc { return None; }

        tracing::info!(
            "merge_formula_columns: recalculating {} via LibreOffice (formula cells lack cached values)",
            original_path.display()
        );
        let recalc_path = recalc_to_temp(&original_path)?;
        // We want to return the PARENT of the recalc path so the cleanup
        // removes the entire temp dir (xlsx + any lockfile LibreOffice left).
        recalc_path.parent().map(|p| p.to_path_buf())
    })();

    // Use the recalculated copy if one was produced; otherwise use original.
    let path = match recalc_dir_to_cleanup.as_ref() {
        Some(dir) => dir.join(original_path.file_name().unwrap()),
        None      => original_path.clone(),
    };

    let mut wb: Xlsx<_> = match open_workbook(&path) {
        Ok(w) => w,
        Err(_) => return,
    };
    let range = match wb.worksheet_range_at(0) {
        Some(Ok(r)) => r,
        _ => return,
    };

    // Also pull the formula strings so we can evaluate cells whose value
    // wasn't pre-computed (i.e. xlsx files written by rust_xlsxwriter that
    // the user has edited in Excel but where Excel hasn't recalculated, or
    // user-added columns where the cached <v> field is missing).
    let formula_range = wb
        .sheet_names()
        .first()
        .cloned()
        .and_then(|name| wb.worksheet_formula(&name).ok());

    let mut iter = range.rows();
    let xlsx_headers: Vec<String> = match iter.next() {
        Some(r) => r.iter().map(data_str).collect(),
        None => return,
    };

    // Determine which xlsx columns are NEW (not already in the SQL result).
    let sql_set: HashSet<String> = columns.iter().map(|s| s.to_lowercase()).collect();
    let new_cols: Vec<(usize, String)> = xlsx_headers
        .iter()
        .enumerate()
        .filter(|(_, h)| !h.is_empty() && !sql_set.contains(&h.to_lowercase()))
        .map(|(i, h)| (i, h.clone()))
        .collect();

    if new_cols.is_empty() {
        return;
    }

    // Pick the BEST match-key column from the xlsx headers.  Prefer a
    // row-unique ID (e.g. UWId, CPTId, SampleId, LayerId) over broad IDs
    // (PointId, ProjectId) that are shared by every row of the same borehole.
    //
    // Using a broad key like PointId is catastrophic for charts: all 50
    // measurements of borehole B1 share the same PointId, so when we insert
    // into the HashMap keyed by PointId, only the last row's formula values
    // survive — every row then plots at those single values, producing the
    // "vertical line / clusters" artefact in scatter charts.
    //
    // The SQL result must also contain the same column for the lookup to
    // work — if not, we fall back through the preference list.
    let (xlsx_id_idx, result_pid_idx, _key_name) = match find_match_key(&xlsx_headers, columns) {
        Some(triple) => triple,
        None => return,
    };
    let xlsx_pid_idx = xlsx_id_idx;

    // pointId → { col_name → value }
    let mut extra: HashMap<String, HashMap<String, Value>> = HashMap::new();
    // Header row in the xlsx is index 0; data starts at xlsx row 2 (1-based).
    for (data_idx, row) in iter.enumerate() {
        let pid = row.get(xlsx_pid_idx).map(data_str).unwrap_or_default();
        if pid.is_empty() {
            continue;
        }
        // 1-based xlsx row number for this data row (header is row 1, so the
        // first data row is xlsx row 2 — Excel's own row numbering).
        let xlsx_row_1based = (data_idx as u32) + 2;
        let mut entry = HashMap::new();
        for (ci, name) in &new_cols {
            let cell  = row.get(*ci);
            // Helper closure to evaluate the cell's formula (from the
            // formula range) for this row.
            let try_formula = || -> Option<f64> {
                formula_range.as_ref().and_then(|fr| {
                    let formula_row_idx = data_idx + 1;
                    fr.get((formula_row_idx, *ci))
                        .filter(|s| !s.is_empty())
                        .and_then(|f| eval_simple_formula(f, xlsx_row_1based, row))
                })
            };

            // Decide what value to store, in priority order:
            //   1. A numeric cached value Excel wrote (Float/Int).  Always preferred.
            //   2. A boolean / datetime cached value (rare for formula columns).
            //   3. A numeric string ("123.5") — parse + use.
            //   4. A formula string ("=B2*0.5") sitting in the value cell
            //      because no cached value was written — evaluate it.
            //   5. The formula from the separate formula range — evaluate it.
            //   6. Null (truly empty cell with no formula).
            let final_val: Value = match cell {
                Some(Data::Float(f))    => json!(f),
                Some(Data::Int(i))      => json!(i),
                Some(Data::Bool(b))     => Value::Bool(*b),
                Some(Data::DateTime(d)) => Value::String(d.to_string()),
                Some(Data::String(s)) => {
                    let trimmed = s.trim();
                    if trimmed.starts_with('=') {
                        // The cell value IS the formula text (unevaluated) —
                        // try to evaluate it ourselves.
                        eval_simple_formula(trimmed, xlsx_row_1based, row)
                            .map(|n| json!(n))
                            .or_else(|| try_formula().map(|n| json!(n)))
                            .unwrap_or(Value::Null)
                    } else if trimmed.is_empty() {
                        // Excel evaluated the formula and got an empty
                        // string — the common `=IF(cond, value, "")` idiom
                        // for "not applicable".  Treat as N/A.
                        Value::Null
                    } else if let Some(n) = parse_number_locale(trimmed) {
                        // Numeric string — handles both `1,234.56` (English)
                        // and `1,5` / `1.234,56` (European / Danish locale).
                        json!(n)
                    } else {
                        // Non-empty, non-numeric text in a formula column.
                        // We return Null (N/A) so the column stays cleanly
                        // numeric for Plotly — if even one row in a column
                        // is a string, Plotly switches the whole axis to a
                        // discrete/category mode and the scatter clusters
                        // at integer category positions instead of plotting
                        // by value.  N/A is the correct interpretation of
                        // text in what's meant to be a numeric formula column.
                        Value::Null
                    }
                }
                Some(Data::Empty)
                | Some(Data::Error(_))
                | Some(Data::DateTimeIso(_))
                | Some(Data::DurationIso(_))
                | None => try_formula().map(|n| json!(n)).unwrap_or(Value::Null),
            };
            entry.insert(name.clone(), final_val);
        }
        extra.insert(pid, entry);
    }

    // (result_pid_idx already chosen above by find_match_key.)

    for (_, name) in &new_cols {
        columns.push(name.clone());
    }

    for row in rows.iter_mut() {
        let pid = row
            .get(result_pid_idx)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        for (_, name) in &new_cols {
            let val = pid
                .as_ref()
                .and_then(|p| extra.get(p))
                .and_then(|m| m.get(name))
                .cloned()
                .unwrap_or(Value::Null);
            row.push(val);
        }
    }

    // Release the workbook handle BEFORE deleting the temp dir on Windows.
    drop(wb);

    // Clean up the LibreOffice temp dir if we recalculated.
    if let Some(dir) = recalc_dir_to_cleanup {
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Execute selected queries and write each result to Datasheets/{fname}.xlsx.
///
/// JS call:  invoke('download_data', { projectId, query: buildPayload(queryNames) })
/// The `projectId` field is sent by DataPage but is not used here directly
/// (project_ids is already inside `query`).
#[tauri::command]
pub async fn download_data(
    query: DownloadRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;

    // Issue #105: fan out across every active DB.  active_databases reads
    // from in-memory state, falling back to GIRTool_settings.json + the
    // legacy state.db single DB.
    let databases = crate::commands::multi_db::active_databases(&state);
    if databases.is_empty() {
        return Err("No database connection configured.".into());
    }

    // Group the request's project_ids / point_ids by db_id.  Legacy flat
    // lists are duplicated to every active DB (same posture as the
    // get_points fallback in points.rs).
    use std::collections::HashMap;
    let mut per_db_projects: HashMap<String, Vec<String>> = HashMap::new();
    match &query.project_ids {
        ProjectIdsArg::Flat(ids) => {
            if ids.is_empty() {
                return Err("No project IDs provided.".into());
            }
            for db in &databases {
                per_db_projects.insert(db.effective_id(), ids.clone());
            }
        }
        ProjectIdsArg::PerDb(entries) => {
            if entries.is_empty() {
                return Err("No project IDs provided.".into());
            }
            for e in entries {
                per_db_projects.entry(e.db_id.clone()).or_default().push(e.project_id.clone());
            }
        }
    }
    let mut per_db_points: HashMap<String, Vec<String>> = HashMap::new();
    match &query.point_ids {
        PointIdsArg::Flat(ids) => {
            for db in &databases {
                per_db_points.insert(db.effective_id(), ids.clone());
            }
        }
        PointIdsArg::PerDb(entries) => {
            for e in entries {
                per_db_points.entry(e.db_id.clone()).or_default().push(e.point_id.clone());
            }
        }
    }

    // Ensure Datasheets directory exists.
    let ds_dir = datasheets_dir(&folder);
    std::fs::create_dir_all(&ds_dir)
        .map_err(|e| format!("Cannot create Datasheets dir: {e}"))?;

    // Load query definitions (file or built-ins).
    let all_queries = crate::commands::queries::load_queries(&state);
    let queries_to_run: Vec<_> = if query.query_names.is_empty() {
        all_queries.iter().collect()
    } else {
        all_queries
            .iter()
            .filter(|q| query.query_names.contains(&q.fname))
            .collect()
    };

    // Load strata lookup once (used for apply_strata="Yes" queries).
    let strata_lookup = load_strata_lookup(&folder, &query.project_id);

    // Per-file results, structured to match the frontend's expected shape:
    //   { folder, saved: [{file, rows}], errors: [{file, error}] }
    let mut saved:  Vec<Value> = Vec::new();
    let mut errors: Vec<Value> = Vec::new();

    for q in queries_to_run {
        let xlsx_name = format!("{}.xlsx", q.fname);

        // Build per-DB (cfg, sql) pairs.  Each DB resolves its own SQL
        // template via `query_type` (issue #47), falling back to the SQL
        // stored in queries.json.
        let mut pairs: Vec<(crate::state::DbConfig, String)> = Vec::new();
        let mut build_error: Option<String> = None;
        for db in databases.iter() {
            let id = db.effective_id();
            let Some(proj_ids) = per_db_projects.get(&id) else { continue };
            if proj_ids.is_empty() { continue }
            let empty_pts: Vec<String> = Vec::new();
            let pt_ids = per_db_points.get(&id).unwrap_or(&empty_pts);

            let raw_sql = crate::commands::query_configs::lookup_datasheet_sql(
                &folder, &db.query_type, &q.fname,
            ).unwrap_or_else(|| q.sql_script.clone());

            match build_sql(&raw_sql, &q.pointfilter, proj_ids, pt_ids) {
                Ok(sql) => pairs.push((db.clone(), sql)),
                Err(e)  => { build_error = Some(format!("SQL build error — {e}")); break }
            }
        }
        if let Some(e) = build_error {
            errors.push(json!({ "file": xlsx_name, "error": e }));
            continue;
        }
        if pairs.is_empty() {
            errors.push(json!({
                "file":  xlsx_name,
                "error": "No configured database has any of the selected project IDs.",
            }));
            continue;
        }

        // Fan out — rows come back with `db_id` prepended (issue #51).
        let mut fan_errors = Vec::new();
        let raw_rows = crate::commands::multi_db::fan_out_query_per_db(pairs, &mut fan_errors).await;

        if raw_rows.is_empty() && !fan_errors.is_empty() {
            let first = fan_errors.first()
                .and_then(|e| e.get("error"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| "All databases failed.".into());
            errors.push(json!({ "file": xlsx_name, "error": format!("query failed — {first}") }));
            continue;
        }

        let row_count = raw_rows.len();
        let (mut columns, mut rows) = objects_to_columnar(raw_rows);

        // Issue #149: convert coordinate / Level columns into the project's
        // target system before strata injection + writing.
        apply_coord_conversion(&columns, &mut rows, &query.coord_overrides);

        // Inject strata columns when the query definition requests it.
        if q.apply_strata.eq_ignore_ascii_case("yes") {
            apply_strata_columns(&mut columns, &mut rows, &strata_lookup);
        }

        let path = ds_dir.join(&xlsx_name);
        let cols_clone = columns.clone();
        let rows_clone = rows.clone();
        let path_clone = path.clone();
        if let Err(e) = tokio::task::spawn_blocking(move || {
            // Fresh export rebuilt from the DB — no user formulas to carry.
            write_datasheet(&path_clone, &cols_clone, &rows_clone, None)
        })
        .await
        .map_err(|e| format!("internal task error: {e}"))?
        {
            errors.push(json!({ "file": xlsx_name, "error": format!("xlsx write failed — {e}") }));
        } else {
            saved.push(json!({ "file": xlsx_name, "rows": row_count }));
            // Issue #117: persist row_count + has_strata so list_datasheets
            // can answer without re-opening the xlsx.
            persist_datasheet_meta(
                &folder,
                &q.fname,
                row_count,
                q.apply_strata.eq_ignore_ascii_case("yes"),
            );
            // Issue #128: write the JSON sidecar from the in-memory data so
            // the very first read_datasheet is already fast (no xlsx parse).
            // Written AFTER write_datasheet so the cache mtime >= xlsx mtime.
            write_datasheet_cache(&folder, &q.fname, &columns, &rows, None);
        }
    }

    // Persist session metadata to GIRTool_settings.json.
    let settings_file = settings_path(&folder);
    let existing: Value = std::fs::read_to_string(&settings_file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}));

    let mut new_settings = existing.as_object().cloned().unwrap_or_default();
    new_settings.insert(
        "selected_projects".to_string(),
        Value::Array(query.projects_meta.clone()),
    );
    // Issue #105: PointIdsArg is an enum now — match to count entries.
    let point_count = match &query.point_ids {
        PointIdsArg::Flat(v)  => v.len(),
        PointIdsArg::PerDb(v) => v.len(),
    };
    new_settings.insert("point_count".to_string(), json!(point_count));

    if let Ok(s) = serde_json::to_string_pretty(&Value::Object(new_settings)) {
        let _ = std::fs::write(&settings_file, s);
    }

    Ok(json!({
        "folder": ds_dir.to_string_lossy(),
        "saved":  saved,
        "errors": errors,
    }))
}

/// Issue #109: like `download_data`, but the per-file save step opens any
/// existing datasheet xlsx, builds a composite ID dedup key from each row
/// (db_id + every column ending in Id/ID), and appends only the rows whose
/// key isn't already present.  When the file doesn't exist, behaves the
/// same as `download_data` (writes fresh).
#[tauri::command]
pub async fn append_data(
    query: DownloadRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;

    let databases = crate::commands::multi_db::active_databases(&state);
    if databases.is_empty() {
        return Err("No database connection configured.".into());
    }

    use std::collections::{HashMap, HashSet};
    let mut per_db_projects: HashMap<String, Vec<String>> = HashMap::new();
    match &query.project_ids {
        ProjectIdsArg::Flat(ids) => {
            if ids.is_empty() {
                return Err("No project IDs provided.".into());
            }
            for db in &databases {
                per_db_projects.insert(db.effective_id(), ids.clone());
            }
        }
        ProjectIdsArg::PerDb(entries) => {
            if entries.is_empty() {
                return Err("No project IDs provided.".into());
            }
            for e in entries {
                per_db_projects.entry(e.db_id.clone()).or_default().push(e.project_id.clone());
            }
        }
    }
    let mut per_db_points: HashMap<String, Vec<String>> = HashMap::new();
    match &query.point_ids {
        PointIdsArg::Flat(ids) => {
            for db in &databases {
                per_db_points.insert(db.effective_id(), ids.clone());
            }
        }
        PointIdsArg::PerDb(entries) => {
            for e in entries {
                per_db_points.entry(e.db_id.clone()).or_default().push(e.point_id.clone());
            }
        }
    }

    let ds_dir = datasheets_dir(&folder);
    std::fs::create_dir_all(&ds_dir)
        .map_err(|e| format!("Cannot create Datasheets dir: {e}"))?;

    let all_queries = crate::commands::queries::load_queries(&state);
    let queries_to_run: Vec<_> = if query.query_names.is_empty() {
        all_queries.iter().collect()
    } else {
        all_queries.iter().filter(|q| query.query_names.contains(&q.fname)).collect()
    };

    let strata_lookup = load_strata_lookup(&folder, &query.project_id);

    let mut saved:  Vec<Value> = Vec::new();
    let mut errors: Vec<Value> = Vec::new();

    for q in queries_to_run {
        let xlsx_name = format!("{}.xlsx", q.fname);

        // Same fan-out as download_data.
        let mut pairs: Vec<(crate::state::DbConfig, String)> = Vec::new();
        let mut build_error: Option<String> = None;
        for db in databases.iter() {
            let id = db.effective_id();
            let Some(proj_ids) = per_db_projects.get(&id) else { continue };
            if proj_ids.is_empty() { continue }
            let empty_pts: Vec<String> = Vec::new();
            let pt_ids = per_db_points.get(&id).unwrap_or(&empty_pts);

            let raw_sql = crate::commands::query_configs::lookup_datasheet_sql(
                &folder, &db.query_type, &q.fname,
            ).unwrap_or_else(|| q.sql_script.clone());

            match build_sql(&raw_sql, &q.pointfilter, proj_ids, pt_ids) {
                Ok(sql) => pairs.push((db.clone(), sql)),
                Err(e)  => { build_error = Some(format!("SQL build error — {e}")); break }
            }
        }
        if let Some(e) = build_error {
            errors.push(json!({ "file": xlsx_name, "error": e }));
            continue;
        }
        if pairs.is_empty() {
            errors.push(json!({
                "file":  xlsx_name,
                "error": "No configured database has any of the selected project IDs.",
            }));
            continue;
        }

        let mut fan_errors = Vec::new();
        let raw_rows = crate::commands::multi_db::fan_out_query_per_db(pairs, &mut fan_errors).await;

        if raw_rows.is_empty() && !fan_errors.is_empty() {
            let first = fan_errors.first()
                .and_then(|e| e.get("error"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| "All databases failed.".into());
            errors.push(json!({ "file": xlsx_name, "error": format!("query failed — {first}") }));
            continue;
        }

        let (mut columns, mut new_rows) = objects_to_columnar(raw_rows);

        // Issue #149: convert the newly-fetched rows before merge so appended
        // rows carry the project's target-CRS coordinates / shifted Level.
        apply_coord_conversion(&columns, &mut new_rows, &query.coord_overrides);

        if q.apply_strata.eq_ignore_ascii_case("yes") {
            apply_strata_columns(&mut columns, &mut new_rows, &strata_lookup);
        }

        // ── Dedup-append (#109) ──────────────────────────────────────────────
        let path = ds_dir.join(&xlsx_name);
        let path_clone = path.clone();
        let existing = tokio::task::spawn_blocking(move || read_existing_datasheet(&path_clone))
            .await
            .map_err(|e| format!("internal task error: {e}"))?;

        let new_row_count = new_rows.len();
        let (final_columns, final_rows, final_formulas, appended) = match existing {
            Some((existing_columns, existing_rows, existing_formulas)) => {
                if existing_columns != columns {
                    errors.push(json!({
                        "file":  xlsx_name,
                        "error": format!(
                            "Schema mismatch — existing file has {} columns, new data has {}. Use Download to overwrite, or delete the existing file first.",
                            existing_columns.len(), columns.len(),
                        ),
                    }));
                    continue;
                }
                let indices = id_key_indices(&columns);
                let existing_keys: HashSet<Vec<String>> = existing_rows.iter()
                    .map(|r| row_id_key(r, &indices))
                    .collect();
                // Existing rows keep their positions (new rows append below),
                // so their formula map carries over unchanged (issue #176).
                let mut kept: Vec<Vec<Value>> = existing_rows;
                let mut new_appended = 0usize;
                for r in new_rows {
                    let k = row_id_key(&r, &indices);
                    if !existing_keys.contains(&k) {
                        kept.push(r);
                        new_appended += 1;
                    }
                }
                (columns, kept, existing_formulas, new_appended)
            }
            None => {
                // File didn't exist — write everything (same as Download).
                (columns, new_rows, FormulaMap::new(), new_row_count)
            }
        };
        let skipped = new_row_count.saturating_sub(appended);

        // Write the combined sheet (user formulas re-emitted as formulas).
        let cols_clone = final_columns.clone();
        let rows_clone = final_rows.clone();
        let formulas_clone = final_formulas.clone();
        let path_clone = path.clone();
        if let Err(e) = tokio::task::spawn_blocking(move || {
            write_datasheet(&path_clone, &cols_clone, &rows_clone, Some(&formulas_clone))
        })
        .await
        .map_err(|e| format!("internal task error: {e}"))?
        {
            errors.push(json!({ "file": xlsx_name, "error": format!("xlsx write failed — {e}") }));
        } else {
            saved.push(json!({
                "file":     xlsx_name,
                "rows":     final_rows.len(),
                "appended": appended,
                "skipped":  skipped,
            }));
            // Issue #117: persist updated row count so list_datasheets stays cheap.
            persist_datasheet_meta(
                &folder,
                &q.fname,
                final_rows.len(),
                q.apply_strata.eq_ignore_ascii_case("yes"),
            );
            // Issue #128: refresh the JSON sidecar from the combined data so
            // the next read_datasheet is fast.  Written after write_datasheet
            // so cache mtime >= xlsx mtime.
            write_datasheet_cache(&folder, &q.fname, &final_columns, &final_rows, Some(&final_formulas));
        }
    }

    Ok(json!({
        "folder": ds_dir.to_string_lossy(),
        "saved":  saved,
        "errors": errors,
    }))
}

/// Issue #111: walk every previously-downloaded \"apply_strata: Yes\" datasheet
/// in `{output_folder}/Datasheets/`, re-apply the strata lookup from the
/// current `strata.xlsx` master, and write the file back.  Upserts the
/// `Primary Layer` / `Secondary Layer` columns — overwrites in place when
/// they exist, appends them when they don't.
///
/// Files for queries with `apply_strata: \"No\"` are skipped.  Files missing
/// from disk are silently skipped (nothing to re-apply).
#[tauri::command]
pub async fn readd_strata(
    query: DownloadRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let ds_dir = datasheets_dir(&folder);
    if !ds_dir.exists() {
        return Err("No Datasheets folder yet — download some files first.".into());
    }

    let strata_lookup = load_strata_lookup(&folder, &query.project_id);

    let all_queries = crate::commands::queries::load_queries(&state);
    let queries_to_check: Vec<_> = if query.query_names.is_empty() {
        all_queries.iter().collect()
    } else {
        all_queries.iter().filter(|q| query.query_names.contains(&q.fname)).collect()
    };

    let mut updated: Vec<Value> = Vec::new();
    let mut errors:  Vec<Value> = Vec::new();

    for q in queries_to_check {
        if !q.apply_strata.eq_ignore_ascii_case("yes") {
            continue;
        }
        let xlsx_name = format!("{}.xlsx", q.fname);
        let path = ds_dir.join(&xlsx_name);
        if !path.exists() {
            continue;
        }

        let read_path = path.clone();
        let existing = tokio::task::spawn_blocking(move || read_existing_datasheet(&read_path))
            .await
            .map_err(|e| format!("internal task error: {e}"))?;

        let Some((mut columns, mut rows, mut formulas)) = existing else {
            errors.push(json!({ "file": xlsx_name, "error": "Failed to read existing datasheet." }));
            continue;
        };

        let row_count = rows.len();
        upsert_strata_columns(&mut columns, &mut rows, &strata_lookup);

        // Issue #176: the strata columns were just overwritten with values —
        // drop any user formulas that pointed at those cells; all other
        // formulas survive the rewrite.
        let strata_idx: Vec<usize> = columns.iter().enumerate()
            .filter(|(_, c)| c.eq_ignore_ascii_case("primary layer") || c.eq_ignore_ascii_case("secondary layer"))
            .map(|(i, _)| i)
            .collect();
        formulas.retain(|(_, col), _| !strata_idx.contains(col));

        let cols_clone = columns.clone();
        let rows_clone = rows.clone();
        let formulas_clone = formulas.clone();
        let write_path = path.clone();
        if let Err(e) = tokio::task::spawn_blocking(move || {
            write_datasheet(&write_path, &cols_clone, &rows_clone, Some(&formulas_clone))
        })
        .await
        .map_err(|e| format!("internal task error: {e}"))?
        {
            errors.push(json!({ "file": xlsx_name, "error": format!("xlsx write failed — {e}") }));
        } else {
            updated.push(json!({ "file": xlsx_name, "rows": row_count }));
        }
    }

    Ok(json!({
        "folder":  ds_dir.to_string_lossy(),
        "updated": updated,
        "errors":  errors,
    }))
}

// ── CPT data reduction (issue #180, M7 / plan §D1, Q-D1..D4) ─────────────────

fn value_key_str(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b))   => b.to_string(),
        _                      => String::new(),
    }
}

fn median_of(nums: &mut [f64]) -> f64 {
    nums.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = nums.len();
    if n % 2 == 1 { nums[n / 2] } else { (nums[n / 2 - 1] + nums[n / 2]) / 2.0 }
}

/// Reduce a CPT datasheet IN PLACE (Q-D1): per borehole, bucket the rows into
/// fixed `window_cm` depth windows starting from depth 0 (Q-D2, on the `Depth`
/// column per Q-D4) and emit one aggregated row per non-empty window — moving
/// average or median of every numeric column incl. Depth (Q-D3); non-numeric
/// columns keep the window's first value.  Strata columns are re-applied
/// afterwards from strata.xlsx.  Windows without rows produce no row (no
/// interpolation).  User formulas do not survive (rows are aggregated away).
#[tauri::command]
pub async fn reduce_cpt_data(
    fname: String,
    window_cm: f64,
    method: String, // "average" | "median"
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = datasheets_dir(&folder).join(format!("{fname}.xlsx"));
    if !path.exists() {
        return Err(format!("Datasheet not found: {fname}.xlsx"));
    }
    if !window_cm.is_finite() || window_cm <= 0.0 {
        return Err("Window size must be a positive number of centimetres.".into());
    }
    let median = method.eq_ignore_ascii_case("median");
    let strata_lookup = load_strata_lookup(&folder, "");

    let fname_c = fname.clone();
    let folder_c = folder.clone();
    tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let Some((mut columns, rows, _formulas)) = read_existing_datasheet(&path) else {
            return Err("Failed to read the datasheet.".into());
        };
        let n_before = rows.len();

        let depth_idx = columns
            .iter()
            .position(|c| c.eq_ignore_ascii_case("depth"))
            .ok_or("No 'Depth' column found — is this a CPT datasheet?")?;
        let key_cols: Vec<usize> = ["db_id", "PointNo", "TestId", "PointId"]
            .iter()
            .filter_map(|n| columns.iter().position(|c| c.eq_ignore_ascii_case(n)))
            .collect();
        if key_cols.is_empty() {
            return Err("No borehole identity columns (PointNo/TestId/PointId) found.".into());
        }

        let window_m = window_cm / 100.0;

        // Group rows per borehole, preserving first-appearance order.
        let mut order: Vec<String> = Vec::new();
        let mut groups: HashMap<String, Vec<&Vec<Value>>> = HashMap::new();
        for r in &rows {
            let k = key_cols
                .iter()
                .map(|&i| value_key_str(r.get(i)))
                .collect::<Vec<_>>()
                .join("||");
            if !groups.contains_key(&k) {
                order.push(k.clone());
            }
            groups.entry(k).or_default().push(r);
        }

        let mut out_rows: Vec<Vec<Value>> = Vec::new();
        for k in &order {
            let g = &groups[k];
            // Bucket by floor(Depth / window) — windows count from depth 0
            // (Q-D2); rows without a numeric Depth are dropped.
            let mut buckets: std::collections::BTreeMap<i64, Vec<&Vec<Value>>> =
                std::collections::BTreeMap::new();
            for r in g {
                let Some(d) = r.get(depth_idx).and_then(|v| v.as_f64()) else { continue };
                buckets.entry((d / window_m).floor() as i64).or_default().push(r);
            }
            for (_b, wrows) in buckets {
                let mut out = Vec::with_capacity(columns.len());
                for ci in 0..columns.len() {
                    let mut nums: Vec<f64> = Vec::new();
                    let mut all_numeric = true;
                    let mut first_nonnull: Option<Value> = None;
                    for r in &wrows {
                        match r.get(ci) {
                            Some(Value::Null) | None => {}
                            Some(v @ Value::Number(_)) => {
                                if first_nonnull.is_none() { first_nonnull = Some(v.clone()); }
                                if let Some(f) = v.as_f64() { nums.push(f); }
                            }
                            Some(other) => {
                                if first_nonnull.is_none() { first_nonnull = Some(other.clone()); }
                                all_numeric = false;
                            }
                        }
                    }
                    let v = if all_numeric && !nums.is_empty() {
                        let agg = if median {
                            median_of(&mut nums)
                        } else {
                            nums.iter().sum::<f64>() / nums.len() as f64
                        };
                        let r4 = (agg * 10000.0).round() / 10000.0;
                        serde_json::Number::from_f64(r4).map(Value::Number).unwrap_or(Value::Null)
                    } else {
                        first_nonnull.unwrap_or(Value::Null)
                    };
                    out.push(v);
                }
                out_rows.push(out);
            }
        }

        // Q-D3: re-apply strata to the reduced rows (fresh Primary/Secondary
        // Layer via the same (db_id, ProjectId, PointId, depth) lookup).
        upsert_strata_columns(&mut columns, &mut out_rows, &strata_lookup);
        let has_strata = columns.iter().any(|c| c.eq_ignore_ascii_case("primary layer"));

        let n_after = out_rows.len();
        write_datasheet(&path, &columns, &out_rows, None)?;
        write_datasheet_cache(&folder_c, &fname_c, &columns, &out_rows, None);
        persist_datasheet_meta(&folder_c, &fname_c, n_after, has_strata);
        Ok(json!({
            "file": format!("{fname_c}.xlsx"),
            "rows_before": n_before,
            "rows_after": n_after,
        }))
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?
}

/// Persist the full application session state to GIRTool_settings.json.
/// Preserves any existing "charts" key that may have been written separately.
#[tauri::command]
pub async fn save_session(
    session: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = settings_path(&folder);

    // Merge with existing file so "charts" and other keys are not lost.
    let existing: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}));

    let mut merged = existing.as_object().cloned().unwrap_or_default();
    if let Some(incoming) = session.as_object() {
        for (k, v) in incoming {
            merged.insert(k.clone(), v.clone());
        }
    }

    let json = serde_json::to_string_pretty(&Value::Object(merged))
        .map_err(|e| format!("Serialise error: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Write error: {e}"))
}

/// Load and return GIRTool_settings.json; returns {} when absent.
#[tauri::command]
pub async fn restore_session(state: State<'_, AppState>) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = settings_path(&folder);
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("Parse error: {e}")),
        Err(_) => Ok(json!({})),
    }
}

// ── Issue #113: Data-tab subtab listing + preview ────────────────────────────

/// One entry per `.xlsx` file in `{output_folder}/Datasheets/`.
/// Used by the Data tab to render the subtab pills.
#[derive(Debug, Serialize)]
pub struct DatasheetEntry {
    /// File name without extension (e.g. `"CPTData"`).
    pub fname:      String,
    /// Row count excluding the header row.  Computed via a cheap header-only
    /// pass over the first sheet.
    pub row_count:  usize,
    /// Whether a `Primary Layer` column is present in the header (case-insensitive).
    pub has_strata: bool,
}

/// Scan `{output_folder}/Datasheets/` and return one [`DatasheetEntry`] per
/// `.xlsx` file.  Returns an empty Vec when the folder doesn't exist (the
/// user simply hasn't downloaded anything yet).
///
/// All disk I/O runs on a blocking task so the Tokio runtime isn't stalled.
/// Entries are returned sorted by `fname` so the frontend gets a stable
/// pill order.
#[tauri::command]
pub async fn list_datasheets(
    state: State<'_, AppState>,
) -> Result<Vec<DatasheetEntry>, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let ds_dir = datasheets_dir(&folder);

    // Issue #117: fast path — settings.json carries persisted row counts and
    // strata flags after every download / append.  Fall through to the disk
    // scan only when the entry is missing (first run, manual edits, etc.).
    let folder_clone = folder.clone();
    let from_settings: Option<Vec<DatasheetEntry>> = tokio::task::spawn_blocking(move || -> Option<Vec<DatasheetEntry>> {
        let path = settings_path(&folder_clone);
        let raw  = std::fs::read_to_string(&path).ok()?;
        let v: Value = serde_json::from_str(&raw).ok()?;
        let map = v.get("datasheets")?.as_object()?;
        if map.is_empty() { return None; }
        let mut entries: Vec<DatasheetEntry> = map.iter().filter_map(|(fname, val)| {
            let obj = val.as_object()?;
            let row_count = obj.get("row_count")?.as_u64()? as usize;
            let has_strata = obj.get("has_strata")?.as_bool()?;
            // Drop entries whose file no longer exists on disk.  Cheap is_file
            // check per entry; far cheaper than opening every xlsx.
            let ds_dir = datasheets_dir(&folder_clone);
            let p = ds_dir.join(format!("{fname}.xlsx"));
            if !p.is_file() { return None; }
            Some(DatasheetEntry { fname: fname.clone(), row_count, has_strata })
        }).collect();
        entries.sort_by(|a, b| a.fname.cmp(&b.fname));
        Some(entries)
    }).await.map_err(|e| format!("internal task error: {e}"))?;

    if let Some(entries) = from_settings {
        return Ok(entries);
    }

    tokio::task::spawn_blocking(move || -> Vec<DatasheetEntry> {
        use calamine::{open_workbook_auto, Reader, Data};

        if !ds_dir.exists() {
            return Vec::new();
        }
        let read_dir = match std::fs::read_dir(&ds_dir) {
            Ok(r)  => r,
            Err(_) => return Vec::new(),
        };

        let mut entries: Vec<DatasheetEntry> = Vec::new();
        for ent in read_dir.flatten() {
            let path = ent.path();
            if !path.is_file() { continue; }
            if path.extension().and_then(|e| e.to_str()).map(|e| !e.eq_ignore_ascii_case("xlsx")).unwrap_or(true) {
                continue;
            }
            let fname = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None    => continue,
            };

            // Open + cheap header-only read of the first sheet.
            let mut wb = match open_workbook_auto(&path) {
                Ok(w)  => w,
                Err(_) => continue,
            };
            let sheet_name = match wb.sheet_names().first().cloned() {
                Some(n) => n,
                None    => continue,
            };
            let range = match wb.worksheet_range(&sheet_name) {
                Ok(r)  => r,
                Err(_) => continue,
            };

            // Calamine's `range.height()` includes the header; row_count is
            // height - 1, saturating to 0 for empty / header-only files.
            let row_count = range.height().saturating_sub(1);

            // Scan the first row for a `Primary Layer` column (case-insensitive).
            let has_strata = range
                .rows()
                .next()
                .map(|hdr| hdr.iter().any(|cell| matches!(cell, Data::String(s) if s.eq_ignore_ascii_case("primary layer"))))
                .unwrap_or(false);

            entries.push(DatasheetEntry { fname, row_count, has_strata });
        }

        entries.sort_by(|a, b| a.fname.cmp(&b.fname));
        entries
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))
}

/// Read a single datasheet `.xlsx` and return its contents as
/// `{ columns: [...], rows: [[...], ...] }` for the Data tab preview.
///
/// `fname` is the file stem (no extension), restricted to `[A-Za-z0-9_-]` to
/// rule out path traversal.  Path separators are rejected outright.
#[tauri::command]
pub async fn read_datasheet(
    fname: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    // Validate fname: bare file stem only, no separators, no traversal.
    if fname.is_empty() {
        return Err("Empty datasheet name.".into());
    }
    if fname.contains('/') || fname.contains('\\') || fname.contains("..") {
        return Err("Invalid datasheet name.".into());
    }
    if !fname.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("Invalid datasheet name — only letters, digits, underscore and hyphen allowed.".into());
    }

    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = datasheets_dir(&folder).join(format!("{fname}.xlsx"));

    // Issue #128: fast path — return the JSON sidecar when it's fresh
    // (mtime >= the xlsx).  All cache + parse I/O runs on a blocking task.
    let folder_c = folder.clone();
    let fname_c  = fname.clone();
    let path_c   = path.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        // 1. Try the cache.
        if let Some(cached) = read_datasheet_cached(&folder_c, &fname_c) {
            return Ok(cached);
        }
        // 2. Slow path — parse the xlsx, then write a fresh cache.
        match read_existing_datasheet(&path_c) {
            Some((columns, rows, formulas)) => {
                write_datasheet_cache(&folder_c, &fname_c, &columns, &rows, Some(&formulas));
                Ok(json!({ "columns": columns, "rows": rows }))
            }
            None => Err(format!("Datasheet not found: {}", path_c.display())),
        }
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?;

    result
}
