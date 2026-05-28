// Projects xlsx persistence — issue #70.
//
// Persists the user's selected `(db_id, ProjectId)` pairs to a single workbook
// per output folder:
//
//   {output_folder}/projects.xlsx
//
// Sheet schema (single sheet "Projects", 4 columns):
//
//   A  db_id      (text — e.g. "primary", "geotek")
//   B  ProjectId  (text)
//   C  ProjectNo  (text — display only; re-derived from the DB on read)
//   D  Title      (text — display only; re-derived from the DB on read)
//
// `db_id + ProjectId` is the source of truth; `ProjectNo` / `Title` are
// written for the user's benefit so the file is human-readable.  Reading the
// file back returns whatever the xlsx contains — the frontend is responsible
// for cross-checking each row against the current `list_projects` result.
//
// Workbook styling mirrors the body of strata.xlsx (Verdana 9, light header
// fill, comfortable column widths).
//
// Commands:
//   save_projects_xlsx(selected) → path
//   load_projects_xlsx()         → Vec<SelectedProject>  (empty when missing)
//   open_projects_xlsx()         → ()

use std::path::PathBuf;

use calamine::{open_workbook_auto, Data, Reader};
use rust_xlsxwriter::{Color, Format, FormatAlign, Workbook};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

// ── Styling constants ─────────────────────────────────────────────────────────

const SHEET_NAME: &str = "Projects";

const FONT_NAME: &str = "Verdana";
const FONT_SIZE: f64  = 9.0;

/// Header fill — pale blue-grey to match the strata.xlsx body shading.
const HEADER_FILL_RGB: u32 = 0xD6_DE_E4;

const HEADERS: &[&str] = &["db_id", "ProjectId", "ProjectNo", "Title"];

/// Column widths (Excel character units).
const COL_WIDTHS: [f64; 4] = [
    14.0, // A db_id
    38.0, // B ProjectId (GUIDs are 36 chars)
    14.0, // C ProjectNo
    50.0, // D Title
];

// ── Paths ─────────────────────────────────────────────────────────────────────

fn projects_xlsx_path(output_folder: &str) -> PathBuf {
    PathBuf::from(output_folder).join("projects.xlsx")
}

// ── Payload type ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectedProject {
    pub db_id: String,
    #[serde(rename = "ProjectId")]
    pub project_id: String,
    #[serde(rename = "ProjectNo", default)]
    pub project_no: String,
    #[serde(rename = "Title", default)]
    pub title: String,
}

// ── Workbook builder ──────────────────────────────────────────────────────────

fn write_workbook(path: &std::path::Path, rows: &[SelectedProject]) -> Result<(), String> {
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
        ws.write_string_with_format(r, 2, &row.project_no, &body_fmt)
            .map_err(|e| format!("ProjectNo write error: {e}"))?;
        ws.write_string_with_format(r, 3, &row.title,      &body_fmt)
            .map_err(|e| format!("Title write error: {e}"))?;
    }

    // Column widths + freeze pane
    for (ci, w) in COL_WIDTHS.iter().enumerate() {
        ws.set_column_width(ci as u16, *w)
            .map_err(|e| format!("Column width error: {e}"))?;
    }
    ws.set_freeze_panes(1, 0)
        .map_err(|e| format!("Freeze pane error: {e}"))?;

    wb.save(path)
        .map_err(|e| format!("Failed to save projects.xlsx: {e}"))
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

/// Read `Projects` sheet rows.  Skips rows where both `db_id` and `ProjectId`
/// are blank.  Returns an empty Vec when the file or sheet is missing.
fn read_rows(path: &std::path::Path) -> Vec<SelectedProject> {
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
        let project_no = cell_to_string(row.get(2));
        let title      = cell_to_string(row.get(3));

        // Skip the empty placeholder row some users get when they delete
        // everything; the source-of-truth columns are A + B.
        if db_id.trim().is_empty() && project_id.trim().is_empty() {
            continue;
        }

        out.push(SelectedProject {
            db_id,
            project_id,
            project_no,
            title,
        });
    }
    out
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Save the given `(db_id, ProjectId, ProjectNo, Title)` rows to
/// `{output_folder}/projects.xlsx`, overwriting any existing file.
///
/// Returns the absolute path of the written file.
#[tauri::command]
pub async fn save_projects_xlsx(
    selected: Vec<SelectedProject>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = projects_xlsx_path(&folder);

    let path_clone = path.clone();
    tokio::task::spawn_blocking(move || write_workbook(&path_clone, &selected))
        .await
        .map_err(|e| format!("internal task error: {e}"))??;

    Ok(path.display().to_string())
}

/// Read rows from `{output_folder}/projects.xlsx`.  Returns an empty Vec when
/// the file or output folder is missing — callers treat that as "no
/// persisted selection yet".
#[tauri::command]
pub async fn load_projects_xlsx(
    state: State<'_, AppState>,
) -> Result<Vec<SelectedProject>, String> {
    let folder = match state.output_folder() {
        Some(f) => f,
        None    => return Ok(Vec::new()),
    };
    let path = projects_xlsx_path(&folder);
    if !path.exists() {
        return Ok(Vec::new());
    }

    let rows = tokio::task::spawn_blocking(move || read_rows(&path))
        .await
        .map_err(|e| format!("internal task error: {e}"))?;

    Ok(rows)
}

/// Open `projects.xlsx` in the OS default application (e.g. Excel).
#[tauri::command]
pub async fn open_projects_xlsx(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = projects_xlsx_path(&folder);
    if !path.exists() {
        return Err("projects.xlsx not found — save your selection first.".into());
    }
    app.opener()
        .open_path(path.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| format!("Failed to open projects.xlsx: {e}"))
}
