// Grouping commands — mirrors backend/routers/groups.py (systems CRUD) and
// backend/routers/grouping.py (assignments + Grouping.xlsx).
//
// Issue #17 — JSON-only system CRUD:
//   list_group_systems(project_id)          → Vec<Value>
//   save_group_systems(project_id, systems) → ()
//
// Issue #5 — grouping assignments + xlsx:
//   get_grouping(project_id)                → { systems, assignments }
//   save_grouping(project_id, body)         → ()  (write JSON + Grouping.xlsx)
//   open_grouping_excel(project_id)         → ()  (open xlsx in OS)
//   reload_from_excel(project_id)           → { systems, assignments }  (parse xlsx)
//
// Storage:
//   %APPDATA%\GIRTool\projects\{project_id}\group_systems.json  — systems
//   {output_folder}/Grouping.xlsx                               — assignments (tabular)
//
// Grouping.xlsx sheet "Point Groups" layout (matches Python write_points_xlsx):
//   Col A: PointId  (hidden; 36 wide)
//   Col B: PointNo  (14 wide)
//   Col C: ProjectNo   (14 wide)
//   Col D: ProjectName (28 wide)
//   Col E: PointType   (12 wide)
//   Col F+: one column per group system  (max(name+3, 12) wide)
//   Table style: TableStyleMedium2, freeze F2, sort by PointNo
//   Table displayName: PG_{project_id[:8]}  (matches Python)

use std::collections::HashMap;
use std::path::PathBuf;

use calamine::{open_workbook, Data, Reader, Xlsx};
use rust_xlsxwriter::{Format, Table, TableStyle, Workbook};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

// ── Constants ─────────────────────────────────────────────────────────────────

const UNKNOWN_NAME: &str = "Unknown";

/// Columns that are never treated as system-name columns when reading xlsx.
const SKIP_COLS: &[&str] = &["PointId", "PointNo", "PointType", "ProjectNo", "ProjectName"];

fn unknown_defaults(gs_id: &str) -> Value {
    let id_prefix = &gs_id[..gs_id.len().min(16)];
    json!({
        "id":            format!("grp_unknown_{id_prefix}"),
        "name":          UNKNOWN_NAME,
        "color":         "#95a5a6",
        "symbol":        "circle",
        "markerSize":    6,
        "lineType":      "solid",
        "lineThickness": 1.5,
    })
}

// ── Storage paths ─────────────────────────────────────────────────────────────

/// %APPDATA%\GIRTool\projects\{project_id}\group_systems.json
fn group_systems_path(project_id: &str) -> Result<PathBuf, String> {
    let appdata = std::env::var("APPDATA")
        .map_err(|_| "APPDATA environment variable is not set".to_string())?;
    let dir = PathBuf::from(appdata)
        .join("GIRTool")
        .join("projects")
        .join(project_id);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create dir {}: {e}", dir.display()))?;
    Ok(dir.join("group_systems.json"))
}

/// {output_folder}/Grouping.xlsx  (one file per output folder, matching Python)
pub fn grouping_xlsx_path(output_folder: &str) -> PathBuf {
    PathBuf::from(output_folder).join("Grouping.xlsx")
}

// ── Business logic ────────────────────────────────────────────────────────────

/// Guarantee every system ends with a group named "Unknown".
///
/// Mirrors `_ensure_unknown_groups` from backend/routers/grouping.py.
pub fn ensure_unknown_groups(systems: Vec<Value>) -> Vec<Value> {
    systems
        .into_iter()
        .map(|gs| {
            let gs_id = gs["id"].as_str().unwrap_or("?").to_string();
            let empty = vec![];
            let groups: Vec<Value> = gs["groups"]
                .as_array()
                .unwrap_or(&empty)
                .iter()
                .cloned()
                .collect();

            let regular: Vec<Value> = groups
                .iter()
                .filter(|g| g["name"].as_str() != Some(UNKNOWN_NAME))
                .cloned()
                .collect();

            let unknown: Value = groups
                .into_iter()
                .find(|g| g["name"].as_str() == Some(UNKNOWN_NAME))
                .unwrap_or_else(|| unknown_defaults(&gs_id));

            let mut updated = gs.clone();
            let mut new_groups = regular;
            new_groups.push(unknown);
            updated["groups"] = Value::Array(new_groups);
            updated
        })
        .collect()
}

// ── calamine helpers ──────────────────────────────────────────────────────────

/// Convert a calamine Data cell to a plain String.
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

// ── xlsx reading (calamine) ───────────────────────────────────────────────────

/// Fuzzy-match `val` against `candidates` using normalised Levenshtein
/// similarity (cutoff 0.6), mirroring Python's
/// `difflib.get_close_matches(word, possibilities, n=1, cutoff=0.6)`.
///
/// Returns the best match, or `None` if no candidate exceeds the cutoff.
fn fuzzy_match_group<'a>(val: &str, candidates: &'a [String]) -> Option<&'a str> {
    let lower = val.to_lowercase();
    candidates
        .iter()
        .filter(|g| g.as_str() != UNKNOWN_NAME)
        .map(|g| (g.as_str(), strsim::normalized_levenshtein(&g.to_lowercase(), &lower)))
        .filter(|(_, score)| *score >= 0.6)
        .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(g, _)| g)
}

/// Read `{ pointId → { sysId → groupName } }` from Grouping.xlsx.
///
/// Column headers beyond the fixed five are treated as system *names* and
/// mapped back to system *IDs* via the provided systems slice.
/// "Unknown" group values are never stored (they are the implicit catch-all).
pub fn read_assignments_from_xlsx(path: &PathBuf, systems: &[Value]) -> Value {
    if !path.exists() {
        return json!({});
    }

    let mut wb: Xlsx<_> = match open_workbook(path) {
        Ok(w)  => w,
        Err(_) => return json!({}),
    };
    let range = match wb.worksheet_range_at(0) {
        Some(Ok(r)) => r,
        _           => return json!({}),
    };

    // name → id  so column headers can be resolved back to system IDs
    let name_to_id: HashMap<String, String> = systems.iter()
        .filter_map(|s| {
            let name = s["name"].as_str()?.to_string();
            let id   = s["id"].as_str()?.to_string();
            Some((name, id))
        })
        .collect();

    // id → accepted group names for case-insensitive + fuzzy lookup
    let id_to_groups: HashMap<String, Vec<String>> = systems.iter()
        .filter_map(|s| {
            let id = s["id"].as_str()?.to_string();
            let groups: Vec<String> = s["groups"]
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .filter_map(|g| g["name"].as_str().map(|n| n.to_string()))
                .collect();
            Some((id, groups))
        })
        .collect();

    let mut iter = range.rows();
    let headers: Vec<String> = match iter.next() {
        Some(row) => row.iter().map(data_str).collect(),
        None      => return json!({}),
    };

    let h_pid = match headers.iter().position(|h| h == "PointId") {
        Some(i) => i,
        None    => return json!({}),
    };

    // col_index → system ID (skip the five fixed columns)
    let sys_map: Vec<(usize, String)> = headers.iter().enumerate()
        .filter(|(_, h)| !SKIP_COLS.contains(&h.as_str()) && !h.is_empty())
        .map(|(i, h)| {
            let sid = name_to_id.get(h).cloned().unwrap_or_else(|| h.clone());
            (i, sid)
        })
        .collect();

    let mut result = serde_json::Map::new();

    for row in iter {
        let pid = match row.get(h_pid) {
            Some(c) if !matches!(c, Data::Empty) => data_str(c),
            _                                    => continue,
        };
        if pid.is_empty() {
            continue;
        }

        let mut asgn = serde_json::Map::new();
        for (col_idx, sys_id) in &sys_map {
            if let Some(cell) = row.get(*col_idx) {
                let raw = data_str(cell);
                let val = raw.trim();
                if val.is_empty() || val == UNKNOWN_NAME {
                    continue;
                }
                // 1. Case-insensitive exact match.
                // 2. Fuzzy Levenshtein fallback (cutoff=0.6) — mirrors Python
                //    difflib.get_close_matches so "sand" → "Sand" etc.
                let resolved = if let Some(group_names) = id_to_groups.get(sys_id) {
                    if let Some(exact) = group_names.iter().find(|g| {
                        g.to_lowercase() == val.to_lowercase()
                            && g.as_str() != UNKNOWN_NAME
                    }) {
                        exact.clone()
                    } else if let Some(fuzzy) = fuzzy_match_group(val, group_names) {
                        fuzzy.to_string()
                    } else {
                        val.to_string()
                    }
                } else {
                    val.to_string()
                };
                asgn.insert(sys_id.clone(), Value::String(resolved));
            }
        }

        if !asgn.is_empty() {
            result.insert(pid, Value::Object(asgn));
        }
    }

    Value::Object(result)
}

// ── xlsx writing (rust_xlsxwriter) ───────────────────────────────────────────

/// Load existing rows from Grouping.xlsx so we can preserve points not in the
/// current save batch (merge semantics, same as Python _write_points_xlsx).
fn load_existing_rows(
    path: &PathBuf,
    systems: &[Value],
) -> HashMap<String, serde_json::Map<String, Value>> {
    let mut existing: HashMap<String, serde_json::Map<String, Value>> = HashMap::new();
    if !path.exists() {
        return existing;
    }

    let mut wb: Xlsx<_> = match open_workbook(path) {
        Ok(w)  => w,
        Err(_) => return existing,
    };
    let range = match wb.worksheet_range_at(0) {
        Some(Ok(r)) => r,
        _           => return existing,
    };

    let name_to_id: HashMap<String, String> = systems.iter()
        .filter_map(|s| {
            let name = s["name"].as_str()?.to_string();
            let id   = s["id"].as_str()?.to_string();
            Some((name, id))
        })
        .collect();

    let mut rows = range.rows();
    let headers: Vec<String> = match rows.next() {
        Some(r) => r.iter().map(data_str).collect(),
        None    => return existing,
    };

    let h_pid = match headers.iter().position(|h| h == "PointId") {
        Some(i) => i,
        None    => return existing,
    };
    let h_pno = headers.iter().position(|h| h == "PointNo");
    let h_pty = headers.iter().position(|h| h == "PointType");
    let h_pro = headers.iter().position(|h| h == "ProjectNo");
    let h_prn = headers.iter().position(|h| h == "ProjectName");

    let sys_map: Vec<(usize, String)> = headers.iter().enumerate()
        .filter(|(_, h)| !SKIP_COLS.contains(&h.as_str()) && !h.is_empty())
        .map(|(i, h)| (i, name_to_id.get(h).cloned().unwrap_or_else(|| h.clone())))
        .collect();

    for row in rows {
        let pid = match row.get(h_pid) {
            Some(c) if !matches!(c, Data::Empty) => data_str(c),
            _                                    => continue,
        };
        if pid.is_empty() {
            continue;
        }

        let mut data = serde_json::Map::new();
        macro_rules! copy_col {
            ($opt_idx:expr, $key:literal) => {
                if let Some(i) = $opt_idx {
                    let v = row.get(i).map(data_str).unwrap_or_default();
                    data.insert($key.to_string(), Value::String(v));
                }
            };
        }
        copy_col!(h_pno, "PointNo");
        copy_col!(h_pty, "PointType");
        copy_col!(h_pro, "ProjectNo");
        copy_col!(h_prn, "ProjectName");

        for (ci, sid) in &sys_map {
            if let Some(cell) = row.get(*ci) {
                let v = data_str(cell);
                if !v.is_empty() {
                    data.insert(sid.clone(), Value::String(v));
                }
            }
        }

        existing.insert(pid, data);
    }

    existing
}

/// Write (or overwrite) Grouping.xlsx with the Python-compatible tabular format.
///
/// Merges existing rows (to preserve points not in this save batch) with
/// the new `points` and `assignments` sent by the frontend.
///
/// `project_id` is used to set the Excel table's `displayName` to
/// `PG_{project_id[:8]}`, matching the Python reference implementation.
pub fn write_grouping_xlsx(
    path: &PathBuf,
    project_id: &str,
    systems: &[Value],
    assignments: &Value,
    points: &[Value],
) -> Result<(), String> {
    // 1. Load existing rows for merge.
    let mut existing = load_existing_rows(path, systems);

    // 2. Apply new points and their assignments.
    for pt in points {
        let pid = match pt["PointId"].as_str().filter(|s| !s.is_empty()) {
            Some(p) => p.to_string(),
            None    => continue,
        };

        let mut data = serde_json::Map::new();
        for key in &["PointNo", "PointType", "ProjectNo", "ProjectName"] {
            let prev = existing.get(&pid).and_then(|m| m.get(*key)).cloned()
                .unwrap_or_else(|| json!(""));
            let v = pt.get(*key).cloned().unwrap_or(prev);
            data.insert((*key).to_string(), v);
        }

        // Apply group assignments for this point.
        if let Some(asgn) = assignments.get(&pid).and_then(|a| a.as_object()) {
            for (sid, gname) in asgn {
                data.insert(sid.clone(), gname.clone());
            }
        }
        existing.insert(pid, data);
    }

    // #264: ALSO apply assignments to rows already in the workbook.  Callers
    // that only change assignments (map grouping mode, Colors page) pass
    // `points: []` - previously their assignment changes were silently
    // dropped because only the loop above ever wrote group columns.
    if let Some(all) = assignments.as_object() {
        for (pid, asgn) in all {
            let Some(asgn) = asgn.as_object() else { continue };
            let Some(row) = existing.get_mut(pid) else { continue };
            for (sid, gname) in asgn {
                row.insert(sid.clone(), gname.clone());
            }
        }
    }

    if existing.is_empty() {
        // Nothing to write — create an empty workbook.
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Point Groups").map_err(|e| format!("{e}"))?;
        return wb.save(path).map_err(|e| format!("Save error: {e}"));
    }

    // 3. Sort by PointNo (string sort, like Python).
    let mut sorted: Vec<(String, serde_json::Map<String, Value>)> =
        existing.into_iter().collect();
    sorted.sort_by(|a, b| {
        let pno_a = a.1.get("PointNo").and_then(|v| v.as_str()).unwrap_or("");
        let pno_b = b.1.get("PointNo").and_then(|v| v.as_str()).unwrap_or("");
        pno_a.cmp(pno_b)
    });

    // 4. Ordered list of system names and id→col offset map.
    let sys_names: Vec<String> = systems.iter()
        .filter_map(|s| s["name"].as_str().map(|n| n.to_string()))
        .collect();
    let sys_id_to_offset: HashMap<String, usize> = systems.iter().enumerate()
        .filter_map(|(i, s)| s["id"].as_str().map(|id| (id.to_string(), i)))
        .collect();

    // 5. Write workbook.
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("Point Groups").map_err(|e| format!("{e}"))?;

    let bold = Format::new().set_bold();

    // Header row (row 0).
    let fixed = ["PointId", "PointNo", "ProjectNo", "ProjectName", "PointType"];
    for (c, h) in fixed.iter().enumerate() {
        ws.write_with_format(0, c as u16, *h, &bold)
            .map_err(|e| format!("{e}"))?;
    }
    for (i, name) in sys_names.iter().enumerate() {
        ws.write_with_format(0, (fixed.len() + i) as u16, name.as_str(), &bold)
            .map_err(|e| format!("{e}"))?;
    }

    // Data rows (rows 1+).
    let n = sorted.len();
    for (r, (pid, data)) in sorted.iter().enumerate() {
        let row = (r + 1) as u32;
        ws.write(row, 0, pid.as_str()).map_err(|e| format!("{e}"))?;
        for (c, key) in ["PointNo", "ProjectNo", "ProjectName", "PointType"].iter().enumerate() {
            let v = data.get(*key).and_then(|v| v.as_str()).unwrap_or("");
            ws.write(row, (c + 1) as u16, v).map_err(|e| format!("{e}"))?;
        }
        for (sid, off) in &sys_id_to_offset {
            let val = data.get(sid).and_then(|v| v.as_str()).unwrap_or("");
            ws.write(row, (fixed.len() + off) as u16, val)
                .map_err(|e| format!("{e}"))?;
        }
    }

    // Table style + displayName (mirrors Python PG_{project_id[:8]}).
    if n > 0 {
        let total_cols = fixed.len() + sys_names.len();
        // Sanitise project_id into a valid Excel table name suffix.
        let safe_id: String = project_id.chars().take(8)
            .map(|c| if c.is_alphanumeric() { c } else { '_' })
            .collect();
        let table_name = format!("PG_{safe_id}");
        let table = Table::new()
            .set_style(TableStyle::Medium2)
            .set_name(&table_name);
        ws.add_table(0, 0, n as u32, (total_cols - 1) as u16, &table)
            .map_err(|e| format!("{e}"))?;
    }

    // Freeze F2 (first row + first 5 columns pinned).
    ws.set_freeze_panes(1, 5).map_err(|e| format!("{e}"))?;

    // Column widths: PointId=36, PointNo=14, ProjectNo=14, ProjectName=28, PointType=12
    let fixed_widths: &[(u16, f64)] =
        &[(0, 36.0), (1, 14.0), (2, 14.0), (3, 28.0), (4, 12.0)];
    for (col, w) in fixed_widths {
        ws.set_column_width(*col, *w).map_err(|e| format!("{e}"))?;
    }
    for (i, name) in sys_names.iter().enumerate() {
        let w = (name.len() as f64 + 3.0).max(12.0);
        ws.set_column_width((fixed.len() + i) as u16, w)
            .map_err(|e| format!("{e}"))?;
    }

    wb.save(path).map_err(|e| format!("Save error: {e}"))
}

// ── Commands — Issue #17 ──────────────────────────────────────────────────────

/// Return the group systems for a project.
/// Returns an empty array when no file exists yet (fresh project).
#[tauri::command]
pub async fn list_group_systems(project_id: String) -> Result<Vec<Value>, String> {
    let path = group_systems_path(&project_id)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Read error: {e}"))?;
    serde_json::from_str::<Vec<Value>>(&text)
        .map_err(|e| format!("Parse error: {e}"))
}

/// Full-replace the group systems, enforcing Unknown group at end of each system.
#[tauri::command]
pub async fn save_group_systems(
    project_id: String,
    systems: Vec<Value>,
) -> Result<(), String> {
    let path = group_systems_path(&project_id)?;
    let enforced = ensure_unknown_groups(systems);
    let json = serde_json::to_string_pretty(&enforced)
        .map_err(|e| format!("Serialise error: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Write error: {e}"))
}

// ── Commands — Issue #5 ───────────────────────────────────────────────────────

/// Return `{ systems, assignments }` for the grouping page.
///
/// `systems`     — all group systems (with Unknown enforced at end of each).
/// `assignments` — `{ pointId: { sysId: groupName } }` parsed from Grouping.xlsx.
#[tauri::command]
pub async fn get_grouping(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    // Load systems from APPDATA.
    let sys_path = group_systems_path(&project_id)?;
    let systems: Vec<Value> = if sys_path.exists() {
        std::fs::read_to_string(&sys_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let systems = ensure_unknown_groups(systems);

    // Read assignments from Grouping.xlsx on a blocking thread.
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let xlsx_path = grouping_xlsx_path(&folder);
    let sys_clone = systems.clone();
    let assignments = tokio::task::spawn_blocking(move || {
        read_assignments_from_xlsx(&xlsx_path, &sys_clone)
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?;

    Ok(json!({ "systems": systems, "assignments": assignments }))
}

/// Persist group systems + assignments to APPDATA (JSON) and Grouping.xlsx.
///
/// `body` must contain:
///   systems:     Vec<Value>  — group system definitions
///   assignments: Value       — `{ pointId: { sysId: groupName } }`
///   points:      Vec<Value>  — point metadata (PointId, PointNo, PointType, …)
#[tauri::command]
pub async fn save_grouping(
    project_id: String,
    body: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;

    let systems: Vec<Value> = body["systems"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let systems = ensure_unknown_groups(systems);
    let assignments = body["assignments"].clone();
    let points: Vec<Value> = body["points"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    // Persist systems to APPDATA.
    let sys_path = group_systems_path(&project_id)?;
    let sys_json = serde_json::to_string_pretty(&systems)
        .map_err(|e| format!("Serialise error: {e}"))?;
    std::fs::write(&sys_path, sys_json).map_err(|e| format!("Write error: {e}"))?;

    // Write Grouping.xlsx on a blocking thread.
    let xlsx_path = grouping_xlsx_path(&folder);
    let pid = project_id.clone();
    tokio::task::spawn_blocking(move || {
        write_grouping_xlsx(&xlsx_path, &pid, &systems, &assignments, &points)
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?
}

/// Open Grouping.xlsx in the OS default application (e.g. Excel).
#[tauri::command]
pub async fn open_grouping_excel(
    _project_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = grouping_xlsx_path(&folder);

    if !path.exists() {
        return Err("Grouping.xlsx not found — save grouping first.".into());
    }

    app.opener()
        .open_path(path.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| format!("Failed to open Grouping.xlsx: {e}"))
}

/// Re-read Grouping.xlsx and return the updated `{ systems, assignments }`.
///
/// This is the main "sync from Excel" operation: the user may have edited group
/// assignments directly in Excel; this command parses the file with calamine
/// and returns the reconciled state, with group names matched case-insensitively
/// (and fuzzy-matched for typos) against the known group names in the systems JSON.
#[tauri::command]
pub async fn reload_from_excel(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    // get_grouping already reads from xlsx via calamine — reuse it.
    get_grouping(project_id, state).await
}
