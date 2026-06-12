// Points xlsx persistence — issue #77.
//
// Persists the user's selected `(db_id, PointId)` pairs to a single workbook
// per output folder:
//
//   {output_folder}/points.xlsx
//
// Sheet schema (single sheet "Points", 12 columns):
//
//   A  db_id              (text — e.g. "DB1", "DB2")
//   B  ProjectId          (text — groups rows visually in Excel)
//   C  PointId            (text — unique within {db_id, ProjectId})
//   D  PointNo            (text — display only; re-derived from the DB on read)
//   E  X1                 (number — easting in the project's target CRS)
//   F  Y1                 (number — northing in the project's target CRS)
//   G  Z1                 (number — elevation, with the per-system offset applied)
//   H  Projection1        (text — EPSG of the X1/Y1 above, e.g. "EPSG:25832")
//   I  origin_X1          (number — raw source easting from the DB)
//   J  origin_Y1          (number — raw source northing from the DB)
//   K  origin_Z1          (number — raw source elevation from the DB)
//   L  origin_Projection1 (text — EPSG the origin_X1/Y1 are in)
//
// `db_id + PointId` remains the source of truth for the SELECTION; the
// coordinate columns (#147) are a snapshot of the converted points table so the
// file reflects the project's coordinate system.  Reading the file back only
// uses the ID columns for selection-restore — the coordinate columns are
// re-derived from the DB + the active coordinate system, never trusted on read.
//
// Workbook styling mirrors `projects_xlsx.rs` (Verdana 9, light header fill,
// comfortable column widths).
//
// Commands:
//   save_points_xlsx(selected) → path
//   load_points_xlsx()         → Vec<SelectedPoint>  (empty when missing)
//   open_points_xlsx()         → ()

use std::path::PathBuf;

use calamine::{open_workbook_auto, Data, Reader};
use rust_xlsxwriter::{Color, Format, FormatAlign, Workbook};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

// ── Styling constants ─────────────────────────────────────────────────────────

const SHEET_NAME: &str = "Points";

const FONT_NAME: &str = "Verdana";
const FONT_SIZE: f64  = 9.0;

/// Header fill — pale blue-grey to match the strata.xlsx body shading.
const HEADER_FILL_RGB: u32 = 0xD6_DE_E4;

const HEADERS: &[&str] = &[
    "db_id", "ProjectId", "PointId", "PointNo",
    "X1", "Y1", "Z1", "Projection1",
    "origin_X1", "origin_Y1", "origin_Z1", "origin_Projection1",
];

/// Column widths (Excel character units).
const COL_WIDTHS: [f64; 12] = [
    14.0, // A db_id
    38.0, // B ProjectId (GUIDs are 36 chars)
    38.0, // C PointId   (also potentially GUID-shaped)
    18.0, // D PointNo
    14.0, // E X1
    14.0, // F Y1
    12.0, // G Z1
    14.0, // H Projection1
    14.0, // I origin_X1
    14.0, // J origin_Y1
    12.0, // K origin_Z1
    16.0, // L origin_Projection1
];

// ── Paths ─────────────────────────────────────────────────────────────────────

pub(crate) fn points_xlsx_path(output_folder: &str) -> PathBuf {
    PathBuf::from(output_folder).join("points.xlsx")
}

// ── Payload type ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SelectedPoint {
    pub db_id: String,
    #[serde(rename = "ProjectId", default)]
    pub project_id: String,
    #[serde(rename = "PointId")]
    pub point_id: String,
    #[serde(rename = "PointNo", default)]
    pub point_no: String,
    // Coordinate snapshot (#147).  Optional so older callers / files (and the
    // selection-restore reader, which leaves them None) still deserialise.
    #[serde(rename = "X1", default)]
    pub x1: Option<f64>,
    #[serde(rename = "Y1", default)]
    pub y1: Option<f64>,
    #[serde(rename = "Z1", default)]
    pub z1: Option<f64>,
    #[serde(rename = "Projection1", default)]
    pub projection1: String,
    #[serde(rename = "origin_X1", default)]
    pub origin_x1: Option<f64>,
    #[serde(rename = "origin_Y1", default)]
    pub origin_y1: Option<f64>,
    #[serde(rename = "origin_Z1", default)]
    pub origin_z1: Option<f64>,
    #[serde(rename = "origin_Projection1", default)]
    pub origin_projection1: String,
}

// ── Workbook builder ──────────────────────────────────────────────────────────

pub(crate) fn write_workbook(path: &std::path::Path, rows: &[SelectedPoint]) -> Result<(), String> {
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name(SHEET_NAME)
        .map_err(|e| format!("Sheet name error: {e}"))?;

    let header_fmt = Format::new()
        .set_font_name(FONT_NAME)
        .set_font_size(FONT_SIZE)
        .set_bold()
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter)
        .set_background_color(Color::RGB(HEADER_FILL_RGB));

    let body_fmt = Format::new()
        .set_font_name(FONT_NAME)
        .set_font_size(FONT_SIZE);

    // Row 0: headers
    for (ci, h) in HEADERS.iter().enumerate() {
        ws.write_string_with_format(0, ci as u16, *h, &header_fmt)
            .map_err(|e| format!("Header write error: {e}"))?;
    }

    // Data rows
    for (ri, row) in rows.iter().enumerate() {
        let r = (ri + 1) as u32;
        ws.write_string_with_format(r, 0, &row.db_id,      &body_fmt)
            .map_err(|e| format!("db_id write error: {e}"))?;
        ws.write_string_with_format(r, 1, &row.project_id, &body_fmt)
            .map_err(|e| format!("ProjectId write error: {e}"))?;
        ws.write_string_with_format(r, 2, &row.point_id,   &body_fmt)
            .map_err(|e| format!("PointId write error: {e}"))?;
        ws.write_string_with_format(r, 3, &row.point_no,   &body_fmt)
            .map_err(|e| format!("PointNo write error: {e}"))?;

        // Coordinate snapshot (#147) — write numbers as numbers; blank when None.
        for (col, val) in [(4u16, row.x1), (5, row.y1), (6, row.z1)] {
            if let Some(n) = val {
                ws.write_number_with_format(r, col, n, &body_fmt)
                    .map_err(|e| format!("coordinate write error: {e}"))?;
            }
        }
        ws.write_string_with_format(r, 7, &row.projection1, &body_fmt)
            .map_err(|e| format!("Projection1 write error: {e}"))?;
        for (col, val) in [(8u16, row.origin_x1), (9, row.origin_y1), (10, row.origin_z1)] {
            if let Some(n) = val {
                ws.write_number_with_format(r, col, n, &body_fmt)
                    .map_err(|e| format!("origin coordinate write error: {e}"))?;
            }
        }
        ws.write_string_with_format(r, 11, &row.origin_projection1, &body_fmt)
            .map_err(|e| format!("origin_Projection1 write error: {e}"))?;
    }

    // Column widths + freeze pane
    for (ci, w) in COL_WIDTHS.iter().enumerate() {
        ws.set_column_width(ci as u16, *w)
            .map_err(|e| format!("Column width error: {e}"))?;
    }
    ws.set_freeze_panes(1, 0)
        .map_err(|e| format!("Freeze pane error: {e}"))?;

    wb.save(path)
        .map_err(|e| format!("Failed to save points.xlsx: {e}"))
}

// ── Reader ────────────────────────────────────────────────────────────────────

fn cell_to_string(cell: Option<&Data>) -> String {
    match cell {
        Some(Data::String(s))   => s.clone(),
        Some(Data::Float(f))    => {
            if f.fract() == 0.0 { format!("{}", *f as i64) } else { f.to_string() }
        }
        Some(Data::Int(i))      => i.to_string(),
        Some(Data::Bool(b))     => b.to_string(),
        Some(Data::DateTime(d)) => d.to_string(),
        _                       => String::new(),
    }
}

/// Read `Points` sheet rows.  Skips rows where both `db_id` and `PointId` are
/// blank.  Returns an empty Vec when the file or sheet is missing.
pub(crate) fn read_rows(path: &std::path::Path) -> Vec<SelectedPoint> {
    let mut out = Vec::new();
    let mut wb = match open_workbook_auto(path) {
        Ok(w)  => w,
        Err(_) => return out,
    };
    let range = match wb.worksheet_range(SHEET_NAME) {
        Ok(r) => r,
        Err(_) => return out,
    };

    for row in range.rows().skip(1) {
        let db_id      = cell_to_string(row.first());
        let project_id = cell_to_string(row.get(1));
        let point_id   = cell_to_string(row.get(2));
        let point_no   = cell_to_string(row.get(3));

        // Skip empty placeholder rows.  Source-of-truth columns are A + C.
        if db_id.trim().is_empty() && point_id.trim().is_empty() {
            continue;
        }

        // Selection-restore only uses the ID columns; coordinate columns are
        // re-derived from the DB + active coordinate system, so leave them None.
        out.push(SelectedPoint {
            db_id,
            project_id,
            point_id,
            point_no,
            ..Default::default()
        });
    }
    out
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Save the given `(db_id, ProjectId, PointId, PointNo)` rows to
/// `{output_folder}/points.xlsx`, overwriting any existing file.
///
/// Returns the absolute path of the written file.
#[tauri::command]
pub async fn save_points_xlsx(
    selected: Vec<SelectedPoint>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = points_xlsx_path(&folder);

    let path_clone = path.clone();
    tokio::task::spawn_blocking(move || write_workbook(&path_clone, &selected))
        .await
        .map_err(|e| format!("internal task error: {e}"))??;

    Ok(path.display().to_string())
}

/// Read rows from `{output_folder}/points.xlsx`.  Returns an empty Vec when
/// the file or output folder is missing — callers treat that as "no
/// persisted selection yet".
#[tauri::command]
pub async fn load_points_xlsx(
    state: State<'_, AppState>,
) -> Result<Vec<SelectedPoint>, String> {
    let folder = match state.output_folder() {
        Some(f) => f,
        None    => return Ok(Vec::new()),
    };
    let path = points_xlsx_path(&folder);
    if !path.exists() {
        return Ok(Vec::new());
    }

    let rows = tokio::task::spawn_blocking(move || read_rows(&path))
        .await
        .map_err(|e| format!("internal task error: {e}"))?;

    Ok(rows)
}

/// Open `points.xlsx` in the OS default application (e.g. Excel).
#[tauri::command]
pub async fn open_points_xlsx(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = points_xlsx_path(&folder);
    if !path.exists() {
        return Err("points.xlsx not found — save your selection first.".into());
    }
    app.opener()
        .open_path(path.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| format!("Failed to open points.xlsx: {e}"))
}
