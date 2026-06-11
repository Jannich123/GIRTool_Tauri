// Local-file map addons (M4.5b, plan §A6 / Q-A6).
//
// Converts a local shapefile / CSV / Excel file into GeoJSON on import, cached
// under `{output_folder}/map addons/{id}.geojson`, and always loaded from there
// afterwards (the cache travels with project copies, Q-A2).
//
// Coordinates are written in the file's SOURCE coordinate system; the addon
// entry records its EPSG and the frontend reprojects via proj4 when rendering
// (the backend has no projection engine — single projection implementation).
//
// Commands:
//   pick_addon_file()            → { path }     native file dialog
//   addon_file_preview(path)     → { kind, headers, rows }   for column mapping
//   import_addon_file(req)       → addon entry  convert + write GeoJSON
//   load_addon_geojson(file)     → parsed GeoJSON Value
//   delete_addon_file(file)      → ()           remove the cached GeoJSON

use std::path::PathBuf;

use calamine::{open_workbook_auto, Data, Reader as XlsxReader};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::state::AppState;

// ── File dialog ───────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct PickedFile {
    pub path: Option<String>,
}

#[tauri::command]
pub async fn pick_addon_file(app: AppHandle) -> Result<PickedFile, String> {
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Select map data file")
            .add_filter("Map data (shp / csv / Excel)", &["shp", "csv", "xlsx", "xlsm", "xls"])
            .add_filter("Shapefile", &["shp"])
            .add_filter("CSV", &["csv"])
            .add_filter("Excel", &["xlsx", "xlsm", "xls"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?;

    let path = picked.and_then(|fp| fp.into_path().ok().map(|p| p.to_string_lossy().into_owned()));
    Ok(PickedFile { path })
}

// ── Table reading (CSV / Excel) ───────────────────────────────────────────────

fn file_ext(path: &str) -> String {
    PathBuf::from(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// Decode raw bytes: UTF-8 when valid, Windows-1252 fallback (Danish CSVs).
fn decode_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned(),
    }
}

/// Detect the CSV delimiter from the first line (Danish Excel exports use ';').
fn detect_delimiter(text: &str) -> u8 {
    let first = text.lines().next().unwrap_or("");
    let count = |c: char| first.matches(c).count();
    let (semi, comma, tab) = (count(';'), count(','), count('\t'));
    if semi >= comma && semi >= tab && semi > 0 {
        b';'
    } else if tab > comma && tab > 0 {
        b'\t'
    } else {
        b','
    }
}

/// Header row + data rows as JSON values (numbers preserved for Excel).
struct TableData {
    headers: Vec<String>,
    rows: Vec<Vec<Value>>,
}

fn read_csv_table(path: &str) -> Result<TableData, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Cannot read file: {e}"))?;
    let text = decode_bytes(&bytes);
    let delim = detect_delimiter(&text);

    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());

    let mut all: Vec<Vec<String>> = Vec::new();
    for rec in rdr.records() {
        let r = rec.map_err(|e| format!("CSV parse error: {e}"))?;
        all.push(r.iter().map(|s| s.trim().to_string()).collect());
    }
    if all.is_empty() {
        return Err("The file is empty.".into());
    }
    let headers = all.remove(0);
    let rows = all
        .into_iter()
        .map(|r| r.into_iter().map(Value::String).collect())
        .collect();
    Ok(TableData { headers, rows })
}

fn xlsx_cell_to_value(cell: &Data) -> Value {
    match cell {
        Data::String(s) => Value::String(s.trim().to_string()),
        Data::Float(f) => json!(f),
        Data::Int(i) => json!(i),
        Data::Bool(b) => Value::Bool(*b),
        Data::DateTime(d) => Value::String(d.to_string()),
        Data::Empty => Value::String(String::new()),
        other => Value::String(format!("{other}")),
    }
}

fn read_xlsx_table(path: &str) -> Result<TableData, String> {
    let mut wb = open_workbook_auto(path).map_err(|e| format!("Cannot open workbook: {e}"))?;
    let range = wb
        .worksheet_range_at(0)
        .ok_or("Workbook has no sheets.")?
        .map_err(|e| format!("Cannot read sheet: {e}"))?;

    let mut iter = range.rows();
    let headers: Vec<String> = iter
        .next()
        .ok_or("The first sheet is empty.")?
        .iter()
        .map(|c| match c {
            Data::String(s) => s.trim().to_string(),
            other => format!("{other}").trim().to_string(),
        })
        .collect();
    let rows = iter
        .map(|r| r.iter().map(xlsx_cell_to_value).collect())
        .collect();
    Ok(TableData { headers, rows })
}

/// Parse a coordinate cell: JSON number directly; strings handle the Danish
/// decimal comma (and "1.234,56" thousands form).
fn coord_from_value(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                return None;
            }
            if let Ok(f) = t.parse::<f64>() {
                return Some(f);
            }
            if t.contains(',') {
                return t.replace('.', "").replace(',', ".").parse::<f64>().ok();
            }
            None
        }
        _ => None,
    }
}

// ── Shapefile reading ─────────────────────────────────────────────────────────

fn close_ring(mut pts: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    if pts.len() >= 3 && pts.first() != pts.last() {
        if let Some(f) = pts.first().copied() {
            pts.push(f);
        }
    }
    pts
}

fn polygon_geom(rings: Vec<(bool, Vec<[f64; 2]>)>) -> Value {
    let mut polys: Vec<Vec<Vec<[f64; 2]>>> = Vec::new();
    for (outer, pts) in rings {
        let ring = close_ring(pts);
        if ring.len() < 4 {
            continue;
        }
        if outer || polys.is_empty() {
            polys.push(vec![ring]);
        } else if let Some(last) = polys.last_mut() {
            last.push(ring);
        }
    }
    if polys.len() == 1 {
        json!({ "type": "Polygon", "coordinates": polys.remove(0) })
    } else {
        json!({ "type": "MultiPolygon", "coordinates": polys })
    }
}

fn line_geom(parts: Vec<Vec<[f64; 2]>>) -> Value {
    if parts.len() == 1 {
        json!({ "type": "LineString", "coordinates": parts.into_iter().next().unwrap() })
    } else {
        json!({ "type": "MultiLineString", "coordinates": parts })
    }
}

/// Extract [x, y] pairs from a slice of shapefile points (any point type with
/// public x/y — invoked via the macro below to stay monomorphic per variant).
macro_rules! pts_xy {
    ($pts:expr) => {
        $pts.iter().map(|p| [p.x, p.y]).collect::<Vec<[f64; 2]>>()
    };
}

fn shape_to_geometry(shape: shapefile::Shape) -> Option<Value> {
    use shapefile::{PolygonRing, Shape};
    macro_rules! rings_of {
        ($p:expr) => {
            $p.rings()
                .iter()
                .map(|r| match r {
                    PolygonRing::Outer(v) => (true, pts_xy!(v)),
                    PolygonRing::Inner(v) => (false, pts_xy!(v)),
                })
                .collect::<Vec<_>>()
        };
    }
    macro_rules! parts_of {
        ($p:expr) => {
            $p.parts().iter().map(|part| pts_xy!(part)).collect::<Vec<_>>()
        };
    }
    Some(match shape {
        Shape::Point(p) => json!({ "type": "Point", "coordinates": [p.x, p.y] }),
        Shape::PointM(p) => json!({ "type": "Point", "coordinates": [p.x, p.y] }),
        Shape::PointZ(p) => json!({ "type": "Point", "coordinates": [p.x, p.y] }),
        Shape::Multipoint(p) => json!({ "type": "MultiPoint", "coordinates": pts_xy!(p.points()) }),
        Shape::MultipointM(p) => json!({ "type": "MultiPoint", "coordinates": pts_xy!(p.points()) }),
        Shape::MultipointZ(p) => json!({ "type": "MultiPoint", "coordinates": pts_xy!(p.points()) }),
        Shape::Polyline(p) => line_geom(parts_of!(p)),
        Shape::PolylineM(p) => line_geom(parts_of!(p)),
        Shape::PolylineZ(p) => line_geom(parts_of!(p)),
        Shape::Polygon(p) => polygon_geom(rings_of!(p)),
        Shape::PolygonM(p) => polygon_geom(rings_of!(p)),
        Shape::PolygonZ(p) => polygon_geom(rings_of!(p)),
        _ => return None, // NullShape / Multipatch
    })
}

fn dbase_field_to_value(fv: shapefile::dbase::FieldValue) -> Value {
    use shapefile::dbase::FieldValue as FV;
    match fv {
        FV::Character(opt) => opt.map(Value::String).unwrap_or(Value::Null),
        FV::Numeric(opt) => opt.map(|n| json!(n)).unwrap_or(Value::Null),
        FV::Logical(opt) => opt.map(Value::Bool).unwrap_or(Value::Null),
        FV::Float(opt) => opt.map(|n| json!(n)).unwrap_or(Value::Null),
        FV::Integer(i) => json!(i),
        FV::Double(d) => json!(d),
        other => Value::String(format!("{other:?}")),
    }
}

/// Shapefile → GeoJSON features (all attributes carried as properties).
fn read_shapefile_features(path: &str) -> Result<Vec<Value>, String> {
    let mut features = Vec::new();
    match shapefile::Reader::from_path(path) {
        Ok(mut reader) => {
            for sr in reader.iter_shapes_and_records() {
                let (shape, record) = sr.map_err(|e| format!("Shapefile read error: {e}"))?;
                let Some(geometry) = shape_to_geometry(shape) else { continue };
                let mut props = Map::new();
                for (name, fv) in record {
                    props.insert(name, dbase_field_to_value(fv));
                }
                features.push(json!({ "type": "Feature", "properties": props, "geometry": geometry }));
            }
        }
        Err(_) => {
            // No .dbf (or unreadable) — fall back to geometry-only.
            let mut reader = shapefile::ShapeReader::from_path(path)
                .map_err(|e| format!("Cannot open shapefile: {e}"))?;
            for s in reader.iter_shapes() {
                let shape = s.map_err(|e| format!("Shapefile read error: {e}"))?;
                let Some(geometry) = shape_to_geometry(shape) else { continue };
                features.push(json!({ "type": "Feature", "properties": {}, "geometry": geometry }));
            }
        }
    }
    Ok(features)
}

// ── Preview ───────────────────────────────────────────────────────────────────

/// Return enough of the file for the column-mapping UI: CSV/Excel → headers +
/// first 5 rows (kind "table"); shapefile → attribute field names (kind
/// "shapefile").
#[tauri::command]
pub async fn addon_file_preview(path: String) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let ext = file_ext(&path);
        match ext.as_str() {
            "csv" => {
                let t = read_csv_table(&path)?;
                let rows: Vec<Vec<String>> = t
                    .rows
                    .iter()
                    .take(5)
                    .map(|r| r.iter().map(cell_text).collect())
                    .collect();
                Ok(json!({ "kind": "table", "headers": t.headers, "rows": rows }))
            }
            "xlsx" | "xlsm" | "xls" => {
                let t = read_xlsx_table(&path)?;
                let rows: Vec<Vec<String>> = t
                    .rows
                    .iter()
                    .take(5)
                    .map(|r| r.iter().map(cell_text).collect())
                    .collect();
                Ok(json!({ "kind": "table", "headers": t.headers, "rows": rows }))
            }
            "shp" => {
                let mut headers: Vec<String> = Vec::new();
                if let Ok(mut reader) = shapefile::Reader::from_path(&path) {
                    if let Some(Ok((_, record))) = reader.iter_shapes_and_records().next() {
                        headers = record.into_iter().map(|(name, _)| name).collect();
                    }
                }
                Ok(json!({ "kind": "shapefile", "headers": headers, "rows": [] }))
            }
            other => Err(format!("Unsupported file type: .{other}")),
        }
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?
}

fn cell_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

// ── Import ────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ImportAddonRequest {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub epsg: Option<i64>,
    #[serde(default)]
    pub x_col: Option<String>,
    #[serde(default)]
    pub y_col: Option<String>,
    /// Info columns shown on hover (CSV/Excel).  Empty = all non-coordinate
    /// columns.
    #[serde(default)]
    pub info_cols: Vec<String>,
    /// { project: bool, selection: bool }
    #[serde(default)]
    pub maps: Option<Value>,
}

const ADDON_COLORS: &[&str] = &["#7c3aed", "#0891b2", "#65a30d", "#d97706", "#be185d", "#0d9488"];

/// Convert the file to GeoJSON, write it under `{output}/map addons/`, and
/// return the addon entry the frontend appends to `map_addons`.
#[tauri::command]
pub async fn import_addon_file(
    req: ImportAddonRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;

    tokio::task::spawn_blocking(move || {
        let ext = file_ext(&req.path);
        let features: Vec<Value> = match ext.as_str() {
            "shp" => read_shapefile_features(&req.path)?,
            "csv" | "xlsx" | "xlsm" | "xls" => {
                let t = if ext == "csv" { read_csv_table(&req.path)? } else { read_xlsx_table(&req.path)? };
                let x_name = req.x_col.clone().unwrap_or_default();
                let y_name = req.y_col.clone().unwrap_or_default();
                let x_idx = t.headers.iter().position(|h| h == &x_name)
                    .ok_or(format!("X column '{x_name}' not found."))?;
                let y_idx = t.headers.iter().position(|h| h == &y_name)
                    .ok_or(format!("Y column '{y_name}' not found."))?;

                // Info columns: chosen ones, or all non-coordinate columns.
                let info_idx: Vec<(usize, &String)> = t.headers.iter().enumerate()
                    .filter(|(i, h)| {
                        if *i == x_idx || *i == y_idx { return false }
                        req.info_cols.is_empty() || req.info_cols.contains(h)
                    })
                    .map(|(i, h)| (i, h))
                    .collect();

                let mut feats = Vec::new();
                for row in &t.rows {
                    let (Some(x), Some(y)) = (
                        row.get(x_idx).and_then(coord_from_value),
                        row.get(y_idx).and_then(coord_from_value),
                    ) else { continue };
                    let mut props = Map::new();
                    for (i, h) in &info_idx {
                        props.insert((*h).clone(), row.get(*i).cloned().unwrap_or(Value::Null));
                    }
                    feats.push(json!({
                        "type": "Feature",
                        "properties": props,
                        "geometry": { "type": "Point", "coordinates": [x, y] },
                    }));
                }
                feats
            }
            other => return Err(format!("Unsupported file type: .{other}")),
        };

        if features.is_empty() {
            return Err("No usable features found in the file (check the X/Y columns).".into());
        }
        let feature_count = features.len();

        // Write the GeoJSON cache.
        let dir = PathBuf::from(&folder).join("map addons");
        std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create 'map addons' dir: {e}"))?;
        let id = format!("file_{}", chrono::Utc::now().timestamp_millis());
        let rel = format!("map addons/{id}.geojson");
        let gj = json!({ "type": "FeatureCollection", "features": features });
        std::fs::write(
            dir.join(format!("{id}.geojson")),
            serde_json::to_string(&gj).map_err(|e| format!("GeoJSON serialise error: {e}"))?,
        )
        .map_err(|e| format!("Cannot write GeoJSON: {e}"))?;

        let color = ADDON_COLORS[(chrono::Utc::now().timestamp_millis() as usize) % ADDON_COLORS.len()];
        let maps = req.maps.unwrap_or(json!({ "project": true, "selection": true }));
        Ok(json!({
            "id": id,
            "name": req.name,
            "type": "geojson",
            "file": rel,
            "epsg": req.epsg.unwrap_or(25832),
            "info_cols": req.info_cols,
            "feature_count": feature_count,
            "color": color,
            "maps": maps,
            "visible": true,
            "opacity": 1.0,
        }))
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?
}

// ── Cache load / delete ───────────────────────────────────────────────────────

/// Validate an addon-relative path: must live directly under `map addons/`.
fn addon_cache_path(folder: &str, rel: &str) -> Result<PathBuf, String> {
    let norm = rel.replace('\\', "/");
    if !norm.starts_with("map addons/") || norm.contains("..") || norm.matches('/').count() != 1 {
        return Err("Invalid addon file path.".into());
    }
    Ok(PathBuf::from(folder).join(norm))
}

#[tauri::command]
pub async fn load_addon_geojson(file: String, state: State<'_, AppState>) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = addon_cache_path(&folder, &file)?;

    tokio::task::spawn_blocking(move || {
        let bytes = std::fs::read(&path)
            .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
        serde_json::from_slice::<Value>(&bytes).map_err(|e| format!("Invalid GeoJSON: {e}"))
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?
}

#[tauri::command]
pub async fn delete_addon_file(file: String, state: State<'_, AppState>) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = addon_cache_path(&folder, &file)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Cannot delete addon file: {e}"))?;
    }
    Ok(())
}
