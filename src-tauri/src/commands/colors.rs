// Colors & Symbols persistence — mirrors backend/routers/colors.py.
//
// All settings live in a SINGLE workbook in the output folder:
//   {output_folder}/Colors_&_Symbols.xlsx       (note the literal "&")
//
// Sheet order matches the Python build (and the UI tab order):
//   1. "Primary Layer"     — Name | Color | Symbol | Marker Size | Line Type | Thickness
//   2. "Secondary Layer"   — same
//   3. "Point Types"       — Name | Color | Symbol
//   4. <one per group system> — same as Primary/Secondary
//
// The Color column has no text; the cell background fill IS the color (so the
// user can edit it directly in Excel and round-trip back via load_colors).
//
// Validation (enforced on save):
//   Symbol     ∈ { circle, square, diamond, cross, x, triangleUp, triangleDown,
//                  star, hexagram, pentagon }
//   Line type  ∈ { solid, dash, dot, dashdot }
//
// Commands:
//   save_colors(project_id, body)   → ()     write Colors_&_Symbols.xlsx
//   load_colors()                   → Value  read Colors_&_Symbols.xlsx
//   open_colors_excel(sheet)        → ()     open xlsx in OS default app

use std::collections::HashSet;
use std::path::PathBuf;

use calamine::{open_workbook_auto, Data, Reader};
use rust_xlsxwriter::{
    Color, Format, FormatAlign, Table, TableColumn, TableStyle, Workbook, Worksheet,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

// ── Constants ────────────────────────────────────────────────────────────────

const FILE_NAME: &str = "Colors_&_Symbols.xlsx";

const SYMBOLS: &[&str] = &[
    "circle",
    "square",
    "diamond",
    "cross",
    "x",
    "triangleUp",
    "triangleDown",
    "star",
    "hexagram",
    "pentagon",
];
const LINE_TYPES: &[&str] = &["solid", "dash", "dot", "dashdot"];

const DEFAULT_SYMBOL:    &str = "circle";
const DEFAULT_LINE_TYPE: &str = "solid";
const DEFAULT_SIZE:      f64  = 6.0;
const DEFAULT_THICKNESS: f64  = 1.5;
const DEFAULT_COLOR:     &str = "#2980b9";

// ── Paths ────────────────────────────────────────────────────────────────────

fn colors_xlsx_path(output_folder: &str) -> PathBuf {
    PathBuf::from(output_folder).join(FILE_NAME)
}

// ── Payload types ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Clone)]
pub struct StyleEntry {
    pub name: String,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default = "default_symbol")]
    pub symbol: String,
    #[serde(default = "default_size", rename = "markerSize")]
    pub marker_size: f64,
    #[serde(default = "default_line", rename = "lineType")]
    pub line_type: String,
    #[serde(default = "default_thickness", rename = "lineThickness")]
    pub line_thickness: f64,
}

#[derive(Debug, Deserialize, Clone)]
pub struct PointTypeStyle {
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub symbol: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GroupSystemPayload {
    /// System ID — accepted for forward compatibility with the Python schema,
    /// but the xlsx format uses the system *name* for sheet titles.
    #[serde(default)]
    #[allow(dead_code)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub groups: Vec<StyleEntry>,
}

/// Strata-layer styles are sent as `{ layer_name: { color, symbol, … } }`.
/// We normalise them into `StyleEntry` rows for writing.
#[derive(Debug, Deserialize, Clone, Default)]
pub struct StrataStyle {
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default = "default_symbol")]
    pub symbol: String,
    #[serde(default = "default_size", rename = "markerSize")]
    pub marker_size: f64,
    #[serde(default = "default_line", rename = "lineType")]
    pub line_type: String,
    #[serde(default = "default_thickness", rename = "lineThickness")]
    pub line_thickness: f64,
}

#[derive(Debug, Deserialize, Default)]
pub struct StrataLayerColors {
    #[serde(default)]
    pub primary: std::collections::HashMap<String, StrataStyle>,
    #[serde(default)]
    pub secondary: std::collections::HashMap<String, StrataStyle>,
}

#[derive(Debug, Deserialize)]
pub struct SaveColorsBody {
    #[serde(default)]
    pub type_styles: std::collections::HashMap<String, PointTypeStyle>,
    #[serde(default)]
    pub group_systems: Vec<GroupSystemPayload>,
    #[serde(default)]
    pub strata_layer_colors: StrataLayerColors,
}

fn default_color()     -> String { DEFAULT_COLOR.to_string() }
fn default_symbol()    -> String { DEFAULT_SYMBOL.to_string() }
fn default_size()      -> f64    { DEFAULT_SIZE }
fn default_line()      -> String { DEFAULT_LINE_TYPE.to_string() }
fn default_thickness() -> f64    { DEFAULT_THICKNESS }

// ── Validation ───────────────────────────────────────────────────────────────

fn validate_symbol(s: &str) -> Result<(), String> {
    if SYMBOLS.contains(&s) {
        Ok(())
    } else {
        Err(format!(
            "Invalid symbol: {s:?}. Must be one of: {}",
            SYMBOLS.join(", ")
        ))
    }
}

fn validate_line_type(s: &str) -> Result<(), String> {
    if LINE_TYPES.contains(&s) {
        Ok(())
    } else {
        Err(format!(
            "Invalid line type: {s:?}. Must be one of: {}",
            LINE_TYPES.join(", ")
        ))
    }
}

fn validate_style(entry: &StyleEntry) -> Result<(), String> {
    validate_symbol(&entry.symbol)?;
    validate_line_type(&entry.line_type)?;
    Ok(())
}

// ── Hex / color helpers ───────────────────────────────────────────────────────

/// Parse `#RRGGBB` (or `RRGGBB`) into an integer suitable for `Color::RGB`.
/// Returns `0xCCCCCC` on any parse failure.
fn parse_hex(s: &str) -> u32 {
    let trimmed = s.trim_start_matches('#');
    if trimmed.len() == 6 {
        u32::from_str_radix(trimmed, 16).unwrap_or(0xCCCCCC)
    } else if trimmed.len() == 3 {
        // Expand "abc" → "aabbcc"
        let mut expanded = String::with_capacity(6);
        for c in trimmed.chars() {
            expanded.push(c);
            expanded.push(c);
        }
        u32::from_str_radix(&expanded, 16).unwrap_or(0xCCCCCC)
    } else {
        0xCCCCCC
    }
}

// ── Sheet writers ────────────────────────────────────────────────────────────

fn header_format() -> Format {
    Format::new()
        .set_bold()
        .set_font_name("Calibri")
        .set_font_size(10)
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter)
}

fn plain_format() -> Format {
    Format::new().set_font_name("Calibri").set_font_size(10)
}

fn sanitize_table_name(name: &str) -> String {
    let s: String = name
        .chars()
        .take(36)
        .map(|c| if c.is_alphanumeric() || c == '_' { c } else { '_' })
        .collect();
    if s.is_empty() { "tbl".to_string() } else { s }
}

fn sanitize_sheet_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '[' | ']') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().chars().take(31).collect::<String>();
    if trimmed.is_empty() { "Sheet".to_string() } else { trimmed }
}

/// Write a generic style sheet (Primary Layer / Secondary Layer / group system).
/// Headers: Name | Color | Symbol | Marker Size | Line Type | Thickness
fn write_style_sheet(
    workbook: &mut Workbook,
    sheet_name: &str,
    table_tag: &str,
    rows: &[StyleEntry],
) -> Result<(), String> {
    let ws = workbook.add_worksheet();
    ws.set_name(sheet_name)
        .map_err(|e| format!("Sheet name error: {e}"))?;

    let header = header_format();
    let plain = plain_format();
    let headers = ["Name", "Color", "Symbol", "Marker Size", "Line Type", "Thickness"];

    // Header row.
    for (j, h) in headers.iter().enumerate() {
        ws.write_string_with_format(0, j as u16, *h, &header)
            .map_err(|e| format!("Header write error: {e}"))?;
    }
    ws.set_row_height(0, 18.0)
        .map_err(|e| format!("Row height error: {e}"))?;

    // Data rows.
    for (i, r) in rows.iter().enumerate() {
        let ri = (i + 1) as u32;

        ws.write_string_with_format(ri, 0, &r.name, &plain)
            .map_err(|e| format!("Write error: {e}"))?;

        // Color column: cell background ONLY (no text — fill is the source of truth).
        let color_fmt = Format::new()
            .set_font_name("Calibri")
            .set_font_size(10)
            .set_background_color(Color::RGB(parse_hex(&r.color)));
        ws.write_blank(ri, 1, &color_fmt)
            .map_err(|e| format!("Color cell error: {e}"))?;

        ws.write_string_with_format(ri, 2, &r.symbol, &plain)
            .map_err(|e| format!("Write error: {e}"))?;
        ws.write_number_with_format(ri, 3, r.marker_size, &plain)
            .map_err(|e| format!("Write error: {e}"))?;
        ws.write_string_with_format(ri, 4, &r.line_type, &plain)
            .map_err(|e| format!("Write error: {e}"))?;
        ws.write_number_with_format(ri, 5, r.line_thickness, &plain)
            .map_err(|e| format!("Write error: {e}"))?;
    }

    // Excel table over the data range (TableStyleMedium2).
    if !rows.is_empty() {
        let last_row = rows.len() as u32;
        let table_cols: Vec<TableColumn> = headers
            .iter()
            .map(|h| TableColumn::new().set_header(*h))
            .collect();
        let table_name = format!("T_{}", sanitize_table_name(table_tag));
        let table = Table::new()
            .set_columns(&table_cols)
            .set_style(TableStyle::Medium2)
            .set_name(&table_name);
        ws.add_table(0, 0, last_row, 5, &table)
            .map_err(|e| format!("Table error: {e}"))?;
    }

    set_style_col_widths(ws)?;
    ws.set_freeze_panes(1, 0)
        .map_err(|e| format!("Freeze pane error: {e}"))?;
    Ok(())
}

/// Write the "Point Types" sheet (Name | Color | Symbol only).
fn write_point_types_sheet(
    workbook: &mut Workbook,
    sheet_name: &str,
    type_styles: &std::collections::HashMap<String, PointTypeStyle>,
) -> Result<(), String> {
    let ws = workbook.add_worksheet();
    ws.set_name(sheet_name)
        .map_err(|e| format!("Sheet name error: {e}"))?;

    let header = header_format();
    let plain = plain_format();
    let headers = ["Name", "Color", "Symbol"];

    for (j, h) in headers.iter().enumerate() {
        ws.write_string_with_format(0, j as u16, *h, &header)
            .map_err(|e| format!("Header write error: {e}"))?;
    }
    ws.set_row_height(0, 18.0)
        .map_err(|e| format!("Row height error: {e}"))?;

    // Canonical order, then anything else the frontend supplied.
    let canonical = ["CPT", "BH", "TP", "Other"];
    let mut written: HashSet<&str> = HashSet::new();
    let mut rows_written = 0u32;

    for name in canonical {
        let style = type_styles.get(name);
        write_point_type_row(ws, rows_written + 1, name, style, &plain)?;
        written.insert(name);
        rows_written += 1;
    }
    for (name, style) in type_styles {
        if written.contains(name.as_str()) {
            continue;
        }
        write_point_type_row(ws, rows_written + 1, name, Some(style), &plain)?;
        rows_written += 1;
    }

    if rows_written > 0 {
        let table_cols: Vec<TableColumn> = headers
            .iter()
            .map(|h| TableColumn::new().set_header(*h))
            .collect();
        let table = Table::new()
            .set_columns(&table_cols)
            .set_style(TableStyle::Medium2)
            .set_name("T_PointTypes");
        ws.add_table(0, 0, rows_written, 2, &table)
            .map_err(|e| format!("Table error: {e}"))?;
    }

    // Narrower widths for Point Types sheet.
    ws.set_column_width(0, 16.0).ok();
    ws.set_column_width(1, 14.0).ok();
    ws.set_column_width(2, 16.0).ok();
    ws.set_freeze_panes(1, 0)
        .map_err(|e| format!("Freeze pane error: {e}"))?;
    Ok(())
}

fn write_point_type_row(
    ws: &mut Worksheet,
    ri: u32,
    name: &str,
    style: Option<&PointTypeStyle>,
    plain: &Format,
) -> Result<(), String> {
    let color = style
        .and_then(|s| s.color.clone())
        .unwrap_or_else(|| "#7f8c8d".to_string());
    let symbol = style
        .and_then(|s| s.symbol.clone())
        .unwrap_or_else(|| DEFAULT_SYMBOL.to_string());
    // Validate (best-effort — point types are display-only, but we keep parity
    // with the style sheets).
    validate_symbol(&symbol)?;

    ws.write_string_with_format(ri, 0, name, plain)
        .map_err(|e| format!("Write error: {e}"))?;
    let color_fmt = Format::new()
        .set_font_name("Calibri")
        .set_font_size(10)
        .set_background_color(Color::RGB(parse_hex(&color)));
    ws.write_blank(ri, 1, &color_fmt)
        .map_err(|e| format!("Color cell error: {e}"))?;
    ws.write_string_with_format(ri, 2, &symbol, plain)
        .map_err(|e| format!("Write error: {e}"))?;
    Ok(())
}

fn set_style_col_widths(ws: &mut Worksheet) -> Result<(), String> {
    // A=28 (name), B=14 (color), C=14 (symbol), D=14, E=14, F=14
    let widths = [28.0, 14.0, 14.0, 14.0, 14.0, 14.0];
    for (i, w) in widths.iter().enumerate() {
        ws.set_column_width(i as u16, *w)
            .map_err(|e| format!("Column width error: {e}"))?;
    }
    Ok(())
}

// ── Top-level writer ─────────────────────────────────────────────────────────

fn strata_map_to_rows(
    map: &std::collections::HashMap<String, StrataStyle>,
) -> Vec<StyleEntry> {
    let mut rows: Vec<StyleEntry> = map
        .iter()
        .map(|(name, s)| StyleEntry {
            name:           name.clone(),
            color:          s.color.clone(),
            symbol:         s.symbol.clone(),
            marker_size:    s.marker_size,
            line_type:      s.line_type.clone(),
            line_thickness: s.line_thickness,
        })
        .collect();
    rows.sort_by(|a, b| a.name.cmp(&b.name));
    rows
}

fn write_colors_workbook(path: &std::path::Path, body: &SaveColorsBody) -> Result<(), String> {
    // ── Validation pass ───────────────────────────────────────────────────────
    // Validate ALL incoming style entries up-front so we never write a partial
    // workbook with bad values.
    for gs in &body.group_systems {
        for g in &gs.groups {
            validate_style(g).map_err(|e| format!("{}: {e}", gs.name))?;
        }
    }
    let primary_rows  = strata_map_to_rows(&body.strata_layer_colors.primary);
    let secondary_rows = strata_map_to_rows(&body.strata_layer_colors.secondary);
    for r in primary_rows.iter().chain(secondary_rows.iter()) {
        validate_style(r).map_err(|e| format!("strata_layer_colors: {e}"))?;
    }

    let mut wb = Workbook::new();
    let mut used: HashSet<String> = HashSet::new();

    // Sheet-name uniqueness helper.  Walks suffix _1, _2, … if the desired name
    // collides with one already written.
    fn unique_name(base: &str, used: &mut HashSet<String>) -> String {
        let base_s = sanitize_sheet_name(base);
        if !used.contains(&base_s) {
            used.insert(base_s.clone());
            return base_s;
        }
        let mut n = 1u32;
        loop {
            let suffix = format!("_{n}");
            let cut = 31usize.saturating_sub(suffix.len());
            let candidate = format!(
                "{}{}",
                base_s.chars().take(cut).collect::<String>(),
                suffix
            );
            if !used.contains(&candidate) {
                used.insert(candidate.clone());
                return candidate;
            }
            n += 1;
        }
    }

    // 1. Primary Layer
    if !primary_rows.is_empty() {
        let name = unique_name("Primary Layer", &mut used);
        write_style_sheet(&mut wb, &name, "PrimaryLayer", &primary_rows)?;
    }

    // 2. Secondary Layer
    if !secondary_rows.is_empty() {
        let name = unique_name("Secondary Layer", &mut used);
        write_style_sheet(&mut wb, &name, "SecondaryLayer", &secondary_rows)?;
    }

    // 3. Point Types (always present)
    let pt_name = unique_name("Point Types", &mut used);
    write_point_types_sheet(&mut wb, &pt_name, &body.type_styles)?;

    // 4. Group systems — one sheet each, in order
    for gs in &body.group_systems {
        let name = unique_name(&gs.name, &mut used);
        let tag = sanitize_table_name(&gs.name);
        write_style_sheet(&mut wb, &name, &tag, &gs.groups)?;
    }

    // Workbook must have at least one sheet.
    if used.is_empty() {
        let ws = wb.add_worksheet();
        let _ = ws.set_name("Colors");
        let _ = ws.write_string(0, 0, "No colour data to write.");
    }

    wb.save(path)
        .map_err(|e| format!("Failed to save xlsx: {e}"))
}

// ── Reader ───────────────────────────────────────────────────────────────────

fn cell_to_string(cell: Option<&Data>) -> Option<String> {
    cell.and_then(|c| match c {
        Data::String(s) if !s.is_empty() => Some(s.clone()),
        Data::Float(f)                    => Some(
            if f.fract() == 0.0 { format!("{}", *f as i64) } else { f.to_string() },
        ),
        Data::Int(i)                      => Some(i.to_string()),
        Data::Bool(b)                     => Some(b.to_string()),
        _                                 => None,
    })
}

fn cell_to_f64(cell: Option<&Data>, default: f64) -> f64 {
    cell.and_then(|c| match c {
        Data::Float(f)  => Some(*f),
        Data::Int(i)    => Some(*i as f64),
        Data::String(s) => s.parse::<f64>().ok(),
        _               => None,
    })
    .unwrap_or(default)
}

/// Coerce a string to a known symbol, falling back to the default.
fn coerce_symbol(s: Option<String>) -> String {
    s.filter(|v| SYMBOLS.contains(&v.as_str()))
        .unwrap_or_else(|| DEFAULT_SYMBOL.to_string())
}

fn coerce_line(s: Option<String>) -> String {
    s.filter(|v| LINE_TYPES.contains(&v.as_str()))
        .unwrap_or_else(|| DEFAULT_LINE_TYPE.to_string())
}

/// Extract a color string from a row's `Color` cell.
///
/// **Limitation**: `calamine` does not expose cell background fill colours, so
/// the cell **text value** is the only source of truth on read.  Files written
/// by this module store the hex in the cell text (in addition to the fill); a
/// legacy Python file with fill-only colour will lose its colour data on
/// round-trip — re-save it in the Tauri app, or re-enter the hex in column B.
/// This is a documented calamine limitation, not a bug here.
fn resolve_color(cell: Option<&Data>, default: &str) -> String {
    cell.and_then(|c| match c {
        Data::String(s) if !s.is_empty() => {
            let trimmed = s.trim();
            if trimmed.starts_with('#') && (trimmed.len() == 4 || trimmed.len() == 7) {
                Some(trimmed.to_string())
            } else if trimmed.len() == 6
                && trimmed.chars().all(|c| c.is_ascii_hexdigit())
            {
                Some(format!("#{trimmed}"))
            } else {
                None
            }
        }
        _ => None,
    })
    .unwrap_or_else(|| default.to_string())
}

/// Read a "Name | Color | Symbol | Marker Size | Line Type | Thickness" sheet.
fn read_style_sheet(
    wb: &mut calamine::Sheets<std::io::BufReader<std::fs::File>>,
    sheet_name: &str,
) -> Vec<StyleEntry> {
    let range = match wb.worksheet_range(sheet_name) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for row in range.rows().skip(1) {
        let name = match cell_to_string(row.first()) {
            Some(n) => n,
            None    => continue,
        };
        let color  = resolve_color(row.get(1), DEFAULT_COLOR);
        let symbol = coerce_symbol(cell_to_string(row.get(2)));
        let size   = cell_to_f64(row.get(3), DEFAULT_SIZE).clamp(1.0, 30.0);
        let line   = coerce_line(cell_to_string(row.get(4)));
        let thick  = cell_to_f64(row.get(5), DEFAULT_THICKNESS).clamp(0.5, 10.0);
        out.push(StyleEntry {
            name,
            color,
            symbol,
            marker_size: size,
            line_type: line,
            line_thickness: thick,
        });
    }
    out
}

fn read_point_types(
    wb: &mut calamine::Sheets<std::io::BufReader<std::fs::File>>,
    sheet_name: &str,
) -> Map<String, Value> {
    let range = match wb.worksheet_range(sheet_name) {
        Ok(r) => r,
        Err(_) => return Map::new(),
    };
    let mut out = Map::new();
    for row in range.rows().skip(1) {
        let name = match cell_to_string(row.first()) {
            Some(n) => n,
            None    => continue,
        };
        let color = resolve_color(row.get(1), "#7f8c8d");
        let symbol = coerce_symbol(cell_to_string(row.get(2)));
        out.insert(name, json!({ "color": color, "symbol": symbol }));
    }
    out
}

fn style_entry_to_value(s: &StyleEntry) -> Value {
    json!({
        "color":         s.color,
        "symbol":        s.symbol,
        "markerSize":    s.marker_size,
        "lineType":      s.line_type,
        "lineThickness": s.line_thickness,
    })
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Persist Colors & Symbols settings to Colors_&_Symbols.xlsx.
#[tauri::command]
pub async fn save_colors(
    _project_id: Option<String>,
    body: SaveColorsBody,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = colors_xlsx_path(&folder);

    let path_clone = path.clone();
    tokio::task::spawn_blocking(move || write_colors_workbook(&path_clone, &body))
        .await
        .map_err(|e| format!("internal task error: {e}"))??;

    Ok(json!({ "saved": path.display().to_string() }))
}

/// Read Colors_&_Symbols.xlsx and return the same shape `save_colors` expects.
#[tauri::command]
pub async fn load_colors(state: State<'_, AppState>) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = colors_xlsx_path(&folder);

    if !path.exists() {
        return Ok(json!({
            "type_styles":         {},
            "group_systems":       [],
            "strata_layer_colors": { "primary": {}, "secondary": {} },
        }));
    }

    let parsed = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let mut wb = open_workbook_auto(&path)
            .map_err(|e| format!("Failed to open Colors_&_Symbols.xlsx: {e}"))?;
        let sheet_names: Vec<String> = wb.sheet_names().to_vec();

        let mut type_styles    = Map::new();
        let mut group_systems  = Vec::new();
        let mut strata_primary = Map::new();
        let mut strata_secondary = Map::new();

        for sheet in sheet_names {
            match sheet.as_str() {
                "Point Types" => {
                    type_styles = read_point_types(&mut wb, &sheet);
                }
                "Primary Layer" => {
                    for s in read_style_sheet(&mut wb, &sheet) {
                        strata_primary
                            .insert(s.name.clone(), style_entry_to_value(&s));
                    }
                }
                "Secondary Layer" => {
                    for s in read_style_sheet(&mut wb, &sheet) {
                        strata_secondary
                            .insert(s.name.clone(), style_entry_to_value(&s));
                    }
                }
                _ => {
                    let entries = read_style_sheet(&mut wb, &sheet);
                    if !entries.is_empty() {
                        let groups: Vec<Value> = entries
                            .iter()
                            .map(|s| {
                                json!({
                                    "name":          s.name,
                                    "color":         s.color,
                                    "symbol":        s.symbol,
                                    "markerSize":    s.marker_size,
                                    "lineType":      s.line_type,
                                    "lineThickness": s.line_thickness,
                                })
                            })
                            .collect();
                        group_systems.push(json!({ "name": sheet, "groups": groups }));
                    }
                }
            }
        }

        Ok(json!({
            "type_styles":   Value::Object(type_styles),
            "group_systems": Value::Array(group_systems),
            "strata_layer_colors": {
                "primary":   Value::Object(strata_primary),
                "secondary": Value::Object(strata_secondary),
            },
        }))
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))??;

    Ok(parsed)
}

/// Open Colors_&_Symbols.xlsx in the OS default application.
///
/// The `sheet` hint is best-effort: Windows cannot reliably open Excel at a
/// specific tab via shell, so we just log it and proceed.  Excel will land on
/// whichever tab was active when the file was last saved.
#[tauri::command]
pub async fn open_colors_excel(
    sheet: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = colors_xlsx_path(&folder);

    if !path.exists() {
        return Err(format!(
            "Colors & Symbols workbook not found: {}. Save it first.",
            path.display()
        ));
    }

    if let Some(s) = sheet {
        if !s.is_empty() {
            tracing::info!("open_colors_excel: sheet hint '{s}' ignored (Windows shell limitation)");
        }
    }

    app.opener()
        .open_path(path.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| format!("Failed to open Colors & Symbols workbook: {e}"))
}
