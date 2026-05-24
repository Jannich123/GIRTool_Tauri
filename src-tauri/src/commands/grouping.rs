// Grouping commands — mirrors backend/routers/groups.py (systems CRUD) and
// backend/routers/grouping.py (assignments + Grouping.xlsx).
//
// Issue #17 — JSON-only system CRUD:
//   list_group_systems(project_id)          → Vec<Value>
//   save_group_systems(project_id, systems) → ()
//
// Issue #5 — grouping assignments + xlsx:
//   get_grouping(project_id)                → { systems, assignments }
//   save_grouping(project_id, body)         → ()  (write JSON + xlsx)
//   open_grouping_excel(project_id)         → ()  (open xlsx in OS)
//   reload_from_excel(project_id)           → { systems, assignments }
//
// Storage:
//   %APPDATA%\GIRTool\projects\{project_id}\group_systems.json — systems
//   {output_folder}/{project_id}_grouping.json                 — assignments
//   {output_folder}/{project_id}_Grouping.xlsx                 — xlsx export

use std::path::{Path, PathBuf};

use rust_xlsxwriter::{Color, Format, Workbook};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

// ── Constants ─────────────────────────────────────────────────────────────────

const UNKNOWN_NAME: &str = "Unknown";

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

fn grouping_json_path(folder: &str, project_id: &str) -> PathBuf {
    PathBuf::from(folder).join(format!("{project_id}_grouping.json"))
}

fn grouping_xlsx_path(folder: &str, project_id: &str) -> PathBuf {
    PathBuf::from(folder).join(format!("{project_id}_Grouping.xlsx"))
}

// ── Business logic ────────────────────────────────────────────────────────────

/// Guarantee every system ends with a group named "Unknown".
///
/// Mirrors `_ensure_unknown_groups` from backend/routers/grouping.py:
/// * Separates "Unknown" from regular groups.
/// * If Unknown is absent, creates it with defaults.
/// * Appends Unknown last (always the catch-all, always at the end).
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

// ── xlsx helpers ──────────────────────────────────────────────────────────────

/// Parse a CSS hex colour string (#rrggbb) to a rust_xlsxwriter Color.
fn hex_to_color(hex: &str) -> Color {
    let hex = hex.trim_start_matches('#');
    if hex.len() == 6 {
        if let Ok(n) = u32::from_str_radix(hex, 16) {
            return Color::RGB(n);
        }
    }
    Color::RGB(0x808080) // fallback grey
}

/// Write a Grouping xlsx with one sheet per group system.
/// Each sheet has:
///   Row 0:  system name header
///   Row 1:  group headers (coloured cells)
///   Row 2+: one row per point, cells coloured by group assignment
fn write_grouping_xlsx(
    path: &Path,
    systems: &[Value],
    assignments: &Value,
    points: &[Value],
) -> Result<(), String> {
    let mut workbook = Workbook::new();
    let bold = Format::new().set_bold();

    for system in systems {
        let sys_id = system["id"].as_str().unwrap_or("?");
        let sys_name = system["name"].as_str().unwrap_or("System");
        let sheet_name: String = sys_name.chars().take(31).collect();

        let ws = workbook.add_worksheet();
        if let Err(e) = ws.set_name(&sheet_name) {
            tracing::warn!("Sheet name '{sheet_name}': {e}");
        }

        let empty_groups = vec![];
        let groups: &Vec<Value> = system["groups"].as_array().unwrap_or(&empty_groups);

        // Row 0 — group header cells, coloured by group color.
        for (j, group) in groups.iter().enumerate() {
            let grp_name = group["name"].as_str().unwrap_or("?");
            let color_str = group["color"].as_str().unwrap_or("#808080");
            let bg = hex_to_color(color_str);
            let fmt = Format::new().set_bold().set_background_color(bg);
            ws.write_string_with_format(0, j as u16, grp_name, &fmt)
                .ok();
        }

        // Rows 1+ — one row per point; the cell in the assigned group column
        // is coloured; others are blank.
        let assignments_obj = assignments.as_object();
        for (i, point) in points.iter().enumerate() {
            let point_id = point["PointId"].as_str().unwrap_or("");
            let point_no = point["PointNo"]
                .as_str()
                .or_else(|| point["PointNo"].as_i64().map(|_| ""))
                .unwrap_or("");

            // Label the row with the point number in column N (after all groups).
            let label_col = groups.len() as u16;
            ws.write_string_with_format((i + 1) as u32, label_col, point_no, &bold)
                .ok();

            // Find this point's assigned group in this system.
            let assigned_group_id = assignments_obj
                .and_then(|a| a.get(point_id))
                .and_then(|by_sys| by_sys.as_object())
                .and_then(|by_sys| by_sys.get(sys_id))
                .and_then(|g| g.as_str());

            if let Some(grp_id) = assigned_group_id {
                if let Some(pos) = groups.iter().position(|g| g["id"].as_str() == Some(grp_id)) {
                    let color_str = groups[pos]["color"].as_str().unwrap_or("#808080");
                    let bg = hex_to_color(color_str);
                    let fmt = Format::new().set_background_color(bg);
                    ws.write_string_with_format(
                        (i + 1) as u32,
                        pos as u16,
                        point_no,
                        &fmt,
                    )
                    .ok();
                }
            }
        }
    }

    workbook
        .save(path)
        .map_err(|e| format!("Failed to save Grouping xlsx: {e}"))
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
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Read error: {e}"))?;
    serde_json::from_str::<Vec<Value>>(&text).map_err(|e| format!("Parse error: {e}"))
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

/// Return the full grouping for a project: { systems, assignments }.
#[tauri::command]
pub async fn get_grouping(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;

    // Load systems from APPDATA store.
    let systems_path = group_systems_path(&project_id)?;
    let systems: Vec<Value> = if systems_path.exists() {
        std::fs::read_to_string(&systems_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    // Load assignments from output folder.
    let json_path = grouping_json_path(&folder, &project_id);
    let assignments: Value = std::fs::read_to_string(&json_path)
        .ok()
        .and_then(|s| {
            let v: Value = serde_json::from_str(&s).ok()?;
            v.get("assignments").cloned()
        })
        .unwrap_or_else(|| json!({}));

    Ok(json!({ "systems": systems, "assignments": assignments }))
}

/// Persist grouping (systems + assignments) to JSON and xlsx.
/// `body` contains: { systems, assignments, points }
#[tauri::command]
pub async fn save_grouping(
    project_id: String,
    body: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;

    let systems: Vec<Value> = body
        .get("systems")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let assignments = body.get("assignments").cloned().unwrap_or(json!({}));
    let points: Vec<Value> = body
        .get("points")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // Enforce Unknown groups.
    let systems = ensure_unknown_groups(systems);

    // Persist systems to APPDATA.
    let systems_path = group_systems_path(&project_id)?;
    let sys_json =
        serde_json::to_string_pretty(&systems).map_err(|e| format!("Serialise error: {e}"))?;
    std::fs::write(&systems_path, sys_json).map_err(|e| format!("Write error: {e}"))?;

    // Persist assignments to output folder JSON.
    let json_path = grouping_json_path(&folder, &project_id);
    let payload = json!({ "systems": systems, "assignments": assignments });
    let payload_json =
        serde_json::to_string_pretty(&payload).map_err(|e| format!("Serialise error: {e}"))?;
    std::fs::write(&json_path, payload_json).map_err(|e| format!("Write error: {e}"))?;

    // Write xlsx (best-effort, off the async runtime).
    let xlsx_path = grouping_xlsx_path(&folder, &project_id);
    let systems_clone = systems.clone();
    let assignments_clone = assignments.clone();
    let points_clone = points.clone();
    tokio::task::spawn_blocking(move || {
        write_grouping_xlsx(&xlsx_path, &systems_clone, &assignments_clone, &points_clone)
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))??;

    Ok(())
}

/// Open the Grouping xlsx in the OS default application.
#[tauri::command]
pub async fn open_grouping_excel(
    project_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = grouping_xlsx_path(&folder, &project_id);

    if !path.exists() {
        return Err(format!(
            "Grouping workbook not found: {}",
            path.display()
        ));
    }

    app.opener()
        .open_path(path.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| format!("Failed to open Grouping workbook: {e}"))
}

/// Reload grouping data from the xlsx file.
/// Falls back to the JSON store if xlsx is absent or unreadable.
#[tauri::command]
pub async fn reload_from_excel(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let xlsx_path = grouping_xlsx_path(&folder, &project_id);
    let json_path = grouping_json_path(&folder, &project_id);

    // If xlsx exists, load systems (sheets → system names + groups from APPDATA).
    if xlsx_path.exists() {
        // For now fall through to JSON — full xlsx colour-parse is complex.
        // The xlsx is kept as a human-editable reference; JSON is authoritative.
        tracing::info!(
            "reload_from_excel: xlsx exists at {}; returning JSON state",
            xlsx_path.display()
        );
    }

    // Read from JSON store.
    let _folder_str = folder.clone();
    let _project_str = project_id.clone();
    let data: Value = std::fs::read_to_string(&json_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({ "systems": [], "assignments": {} }));

    // Merge in systems from APPDATA if not in JSON.
    let systems = if data["systems"].as_array().map_or(true, |a| a.is_empty()) {
        let systems_path = group_systems_path(&project_id)?;
        std::fs::read_to_string(&systems_path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok())
            .map(Value::Array)
            .unwrap_or(json!([]))
    } else {
        data["systems"].clone()
    };

    Ok(json!({
        "systems":     systems,
        "assignments": data.get("assignments").cloned().unwrap_or(json!({})),
    }))
}
