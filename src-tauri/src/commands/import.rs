// Data import wizard (issues #278, #280): bring CSV / Excel files (or a
// folder of them) into an existing or new datasheet under
// {output}/Datasheets/.
//
// Flow (frontend Data → Import tab):
//   1. pick_import_path   — native file/folder dialog
//   2. import_preview     — list matched files + a grid of the first file
//   3. datasheet_columns  — destination column list: the existing sheet's
//                           columns, or the SELECT aliases of the datasheet
//                           query with that fname (generated-table case)
//   4. import_data        — append mapped rows, resolve the IDs, upsert
//                           points.xlsx
//
// IDs (#280): DB / ProjectId / PointId / PointNo each come from a source
// column, the file name, or custom text.  Custom text may contain a
// `{PointNo}` placeholder replaced per row.  Points policy: a PointNo not in
// points.xlsx is inserted; an existing PointNo only gets its MISSING fields
// (X1/Y1/Z1/Projection1) filled — never overwritten.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use calamine::{open_workbook_auto, Data, Reader};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::state::AppState;

use super::download::{
    datasheets_dir, parse_number_locale, persist_datasheet_meta, read_datasheet_cached,
    read_existing_datasheet, write_datasheet, write_datasheet_cache, FormulaMap,
};
use super::points_xlsx::{
    points_xlsx_path, read_rows as read_points_rows, write_workbook as write_points_workbook,
    SelectedPoint,
};

// ── File discovery ────────────────────────────────────────────────────────────

const IMPORT_EXTS: &[&str] = &["csv", "txt", "xlsx", "xlsm", "xls"];

fn file_ext(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// A file path → itself; a folder → every CSV/Excel file inside (sorted,
/// Excel lock files `~$…` skipped).  Errors on empty folders so the user
/// gets feedback instead of a silent no-op import.
fn resolve_files(path: &str) -> Result<Vec<PathBuf>, String> {
    let p = PathBuf::from(path);
    if p.is_file() {
        return Ok(vec![p]);
    }
    if !p.is_dir() {
        return Err(format!("Path not found: {path}"));
    }
    let mut files: Vec<PathBuf> = std::fs::read_dir(&p)
        .map_err(|e| format!("Cannot read folder: {e}"))?
        .flatten()
        .map(|ent| ent.path())
        .filter(|f| {
            f.is_file()
                && IMPORT_EXTS.contains(&file_ext(f).as_str())
                && !f
                    .file_name()
                    .map(|n| n.to_string_lossy().starts_with("~$"))
                    .unwrap_or(false)
        })
        .collect();
    files.sort();
    if files.is_empty() {
        return Err("No CSV or Excel files found in that folder.".into());
    }
    Ok(files)
}

// ── Parsing (mirrors map_addons.rs: UTF-8 → Windows-1252, sniffed delimiter) ──

fn decode_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned(),
    }
}

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

/// CSV cell → JSON value.  Whole-string numbers become numbers (Danish comma
/// decimals included) EXCEPT leading-zero identifiers like "007", which stay
/// strings so PointNos survive round-trips.
fn csv_value(s: &str) -> Value {
    let t = s.trim();
    if t.is_empty() {
        return Value::Null;
    }
    let keeps_leading_zero =
        t.len() > 1 && t.starts_with('0') && !t.starts_with("0.") && !t.starts_with("0,");
    if !keeps_leading_zero {
        if let Some(n) = parse_number_locale(t) {
            if let Some(num) = serde_json::Number::from_f64(n) {
                return Value::Number(num);
            }
        }
    }
    Value::String(t.to_string())
}

fn xlsx_value(cell: &Data) -> Value {
    match cell {
        Data::Empty => Value::Null,
        Data::Int(i) => json!(i),
        Data::Float(f) => json!(f),
        Data::Bool(b) => json!(b),
        Data::DateTime(dt) => dt
            .as_datetime()
            .map(|d| Value::String(d.to_string()))
            .unwrap_or_else(|| json!(dt.as_f64())),
        other => {
            let s = other.to_string();
            let t = s.trim();
            if t.is_empty() {
                Value::Null
            } else {
                Value::String(t.to_string())
            }
        }
    }
}

/// Read a whole file as a value grid: CSV via the sniffing reader, Excel via
/// calamine (first worksheet).
fn read_grid(path: &Path) -> Result<Vec<Vec<Value>>, String> {
    let name = path.display();
    match file_ext(path).as_str() {
        "csv" | "txt" => {
            let bytes = std::fs::read(path).map_err(|e| format!("Cannot read {name}: {e}"))?;
            let text = decode_bytes(&bytes);
            let delim = detect_delimiter(&text);
            let mut rdr = csv::ReaderBuilder::new()
                .delimiter(delim)
                .has_headers(false)
                .flexible(true)
                .from_reader(text.as_bytes());
            let mut grid = Vec::new();
            for rec in rdr.records() {
                let r = rec.map_err(|e| format!("CSV parse error in {name}: {e}"))?;
                grid.push(r.iter().map(csv_value).collect());
            }
            Ok(grid)
        }
        _ => {
            let mut wb =
                open_workbook_auto(path).map_err(|e| format!("Cannot open {name}: {e}"))?;
            let range = wb
                .worksheet_range_at(0)
                .ok_or_else(|| format!("{name}: no worksheets"))?
                .map_err(|e| format!("Cannot read {name}: {e}"))?;
            Ok(range
                .rows()
                .map(|row| row.iter().map(xlsx_value).collect())
                .collect())
        }
    }
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => {
            // "117.0" → "117" so numeric PointNos match Jupiter's strings.
            let s = n.to_string();
            match s.strip_suffix(".0") {
                Some(t) => t.to_string(),
                None => s,
            }
        }
        Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

fn value_to_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => parse_number_locale(s),
        _ => None,
    }
}

/// Derived Level (#284): `Z1 − Depth` when the point's Z1 is known, else
/// `−Depth` (surface treated as 0).  Rounded to 3 dp to match the
/// `round(B.[Z1] − A.[Depth], 3)` of the datasheet queries.
fn level_from(z1: Option<f64>, depth: f64) -> f64 {
    let lvl = z1.unwrap_or(0.0) - depth;
    (lvl * 1000.0).round() / 1000.0
}

// ── Destination columns from the datasheet queries (#280) ─────────────────────

/// Pull the output column names out of a datasheet query's SELECT list.
///
/// House SQL format (commands/queries.rs): one column per line, optional
/// `AS [Alias]`, brackets around identifiers, function wrapping like
/// `round(A.[X1], 2) AS [X1]`.  The scan is paren-depth aware so commas
/// inside `CAST(... AS VARCHAR(MAX))` / `round(x, 2)` don't split items.
fn parse_select_aliases(sql: &str) -> Vec<String> {
    // ASCII-only uppercase keeps byte offsets aligned with `sql` even when
    // identifiers contain æ/ø/å.
    let upper = sql.to_ascii_uppercase();
    let Some(sel) = upper.find("SELECT") else { return Vec::new() };
    let body_start = sel + "SELECT".len();

    // Matching top-level FROM.
    let bytes = upper.as_bytes();
    let mut depth = 0i32;
    let mut from_at = None;
    let mut i = body_start;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => depth -= 1,
            b'F' if depth == 0
                && upper[i..].starts_with("FROM")
                && bytes.get(i.wrapping_sub(1)).map_or(true, |c| c.is_ascii_whitespace())
                && bytes.get(i + 4).map_or(true, |c| c.is_ascii_whitespace() || *c == b'(') =>
            {
                from_at = Some(i);
                break;
            }
            _ => {}
        }
        i += 1;
    }
    let Some(from_at) = from_at else { return Vec::new() };
    let list = &sql[body_start..from_at];

    // Split on depth-0 commas.
    let mut items: Vec<String> = Vec::new();
    let mut depth = 0i32;
    let mut cur = String::new();
    for ch in list.chars() {
        match ch {
            '(' => { depth += 1; cur.push(ch); }
            ')' => { depth -= 1; cur.push(ch); }
            ',' if depth == 0 => { items.push(cur.clone()); cur.clear(); }
            _ => cur.push(ch),
        }
    }
    if !cur.trim().is_empty() {
        items.push(cur);
    }

    let strip_ident = |s: &str| -> String {
        s.trim()
            .trim_matches(|c| c == '[' || c == ']' || c == '"' || c == '\'')
            .trim()
            .to_string()
    };

    items
        .iter()
        .map(|raw| {
            let mut item = raw.trim();
            // First item may carry DISTINCT / TOP n.
            for kw in ["DISTINCT", "TOP"] {
                let up = item.to_ascii_uppercase();
                if let Some(rest) = up.strip_prefix(kw) {
                    if rest.starts_with(char::is_whitespace) {
                        item = item[kw.len()..].trim_start();
                        // TOP is followed by its count.
                        if kw == "TOP" {
                            item = item.trim_start_matches(|c: char| c.is_ascii_digit()).trim_start();
                        }
                    }
                }
            }
            // Depth-0 ` AS ` — the LAST one names the column (CAST has its
            // own AS, but only inside parens).
            let up = item.to_ascii_uppercase();
            let mut depth = 0i32;
            let mut alias_at = None;
            for (i, ch) in up.char_indices() {
                match ch {
                    '(' => depth += 1,
                    ')' => depth -= 1,
                    'A' if depth == 0 && up[i..].starts_with("AS")
                        && up[..i].ends_with(char::is_whitespace)
                        && up[i + 2..].starts_with(char::is_whitespace) =>
                    {
                        alias_at = Some(i);
                    }
                    _ => {}
                }
            }
            if let Some(a) = alias_at {
                return strip_ident(&item[a + 2..]);
            }
            // No alias: take the part after the last depth-0 '.'.
            let tail = item.rsplit('.').next().unwrap_or(item);
            strip_ident(tail)
        })
        .filter(|s| !s.is_empty())
        .collect()
}

/// Case-insensitive position of any of `names` in `cols`.
fn find_ci(cols: &[String], names: &[&str]) -> Option<usize> {
    cols.iter().position(|c| {
        let t = c.trim();
        names.iter().any(|n| t.eq_ignore_ascii_case(n))
    })
}

fn sanitize_fname(raw: &str) -> Result<String, String> {
    let fname = raw.trim().trim_end_matches(".xlsx").trim().to_string();
    if fname.is_empty() {
        return Err("Choose a datasheet name to import into.".into());
    }
    if fname.contains(['/', '\\']) {
        return Err("The datasheet name cannot contain path separators.".into());
    }
    Ok(fname)
}

/// Destination column list for the mapping UI: the existing sheet's columns
/// when the file is there, otherwise the SELECT aliases of the datasheet
/// query named `fname` (prefixed with DB — every downloaded sheet carries a
/// database tag).  Empty when neither exists.
#[tauri::command]
pub async fn datasheet_columns(fname: String, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let fname = sanitize_fname(&fname)?;
    let queries = super::queries::load_queries(&state);
    tokio::task::spawn_blocking(move || {
        // 1. Existing sheet → its real columns (cache first, then xlsx).
        if let Some(cached) = read_datasheet_cached(&folder, &fname) {
            let cols: Vec<String> = cached["columns"]
                .as_array()
                .map(|a| a.iter().map(|c| c.as_str().unwrap_or("").to_string()).collect())
                .unwrap_or_default();
            if !cols.is_empty() {
                return Ok(cols);
            }
        }
        let path = datasheets_dir(&folder).join(format!("{fname}.xlsx"));
        if path.exists() {
            if let Some((cols, _, _)) = read_existing_datasheet(&path) {
                if !cols.is_empty() {
                    return Ok(cols);
                }
            }
        }
        // 2. Generated table: SELECT aliases of the query with this fname.
        if let Some(q) = queries.iter().find(|q| q.fname.eq_ignore_ascii_case(&fname)) {
            let mut cols = parse_select_aliases(&q.sql_script);
            if !cols.is_empty() && find_ci(&cols, &["db", "db_id"]).is_none() {
                cols.insert(0, "DB".to_string());
            }
            return Ok(cols);
        }
        Ok(Vec::new())
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Native picker for the import source.  `mode` is "file" or "folder".
#[tauri::command]
pub async fn pick_import_path(app: AppHandle, mode: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let dialog = app.dialog().file();
        let picked = if mode == "folder" {
            dialog
                .set_title("Choose a folder of CSV / Excel files")
                .blocking_pick_folder()
        } else {
            dialog
                .set_title("Choose a CSV or Excel file")
                .add_filter("Data files", &["csv", "txt", "xlsx", "xlsm", "xls"])
                .blocking_pick_file()
        };
        Ok(picked.map(|p| p.to_string()))
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?
}

const PREVIEW_ROWS: usize = 30;
const PREVIEW_COLS: usize = 40;

/// List the files an import would touch and return the first file's top rows
/// so the user can point at the header / first data row.
#[tauri::command]
pub async fn import_preview(path: String) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let files = resolve_files(&path)?;
        let names: Vec<String> = files
            .iter()
            .map(|f| f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())
            .collect();
        let grid = read_grid(&files[0])?;
        let total_rows = grid.len();
        let preview: Vec<Vec<Value>> = grid
            .into_iter()
            .take(PREVIEW_ROWS)
            .map(|row| row.into_iter().take(PREVIEW_COLS).collect())
            .collect();
        Ok(json!({
            "files": names,
            "grid": preview,
            "total_rows": total_rows,
        }))
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?
}

// ── Import request (#280 shape) ───────────────────────────────────────────────

/// Where an ID value comes from: `kind` is "column" (value = 0-based source
/// column index), "filename" (the file's stem) or "text" (a literal, with an
/// optional `{PointNo}` placeholder replaced per row).
#[derive(Debug, Deserialize)]
pub struct IdSource {
    pub kind: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Deserialize)]
pub struct IdSpec {
    pub db: IdSource,
    pub project_id: IdSource,
    pub point_id: IdSource,
    pub point_no: IdSource,
}

#[derive(Debug, Deserialize)]
pub struct MapEntry {
    /// Datasheet column to write into (created when missing).
    pub target: String,
    /// Same source kinds as the IDs (#282): "column" (value = 0-based source
    /// column index), "filename", or "text" (literal with `{PointNo}`).
    pub kind: String,
    #[serde(default)]
    pub value: String,
    /// Unit-conversion multiplier (#288): each numeric value is multiplied by
    /// this to reach the destination column's unit.  1.0 / absent = no change.
    #[serde(default)]
    pub factor: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct ImportRequest {
    /// File or folder picked earlier.
    pub path: String,
    /// Target datasheet name (without .xlsx).
    pub fname: String,
    /// 1-based row where data starts in every file.
    pub data_row: usize,
    /// ID sources — all four are required (#280).
    pub ids: IdSpec,
    /// Destination column list shown in the UI — unioned into the sheet in
    /// this order so a generated table matches its query schema even where
    /// nothing is mapped.
    #[serde(default)]
    pub columns: Vec<String>,
    pub mapping: Vec<MapEntry>,
}

/// Validated form of an IdSource.
enum IdValue {
    Col(usize),
    FileStem,
    Text(String),
}

impl IdValue {
    fn parse(kind: &str, value: &str, label: &str) -> Result<IdValue, String> {
        match kind {
            "column" => value
                .trim()
                .parse::<usize>()
                .map(IdValue::Col)
                .map_err(|_| format!("{label}: pick a source column.")),
            "filename" => Ok(IdValue::FileStem),
            "text" => {
                let t = value.trim();
                if t.is_empty() {
                    Err(format!("{label}: fill in the custom text before importing."))
                } else {
                    Ok(IdValue::Text(t.to_string()))
                }
            }
            other => Err(format!("{label}: unknown source kind '{other}'.")),
        }
    }

    /// Resolve for one row.  `point_no` is the already-resolved PointNo for
    /// the `{PointNo}` placeholder (None while resolving PointNo itself).
    fn resolve(&self, row: &[Value], stem: &str, point_no: Option<&str>) -> String {
        match self {
            IdValue::Col(i) => row.get(*i).map(value_to_string).unwrap_or_default(),
            IdValue::FileStem => stem.to_string(),
            IdValue::Text(t) => match point_no {
                Some(pn) => t.replace("{PointNo}", pn),
                None => t.clone(),
            },
        }
    }

    /// Resolve for one row as a cell value (#282, regular mapped columns):
    /// column sources keep their typed value (numbers stay numbers), file
    /// stems become strings, and custom text goes through `csv_value` so a
    /// numeric constant like "5" is written as a number.
    fn resolve_value(&self, row: &[Value], stem: &str, point_no: &str) -> Value {
        match self {
            IdValue::Col(i) => row.get(*i).cloned().unwrap_or(Value::Null),
            IdValue::FileStem => Value::String(stem.to_string()),
            IdValue::Text(t) => csv_value(&t.replace("{PointNo}", point_no)),
        }
    }
}

/// Case-insensitive find-or-append of a column name; returns its index.
fn col_index(columns: &mut Vec<String>, name: &str, added: &mut Vec<String>) -> usize {
    if let Some(i) = columns
        .iter()
        .position(|c| c.trim().eq_ignore_ascii_case(name.trim()))
    {
        return i;
    }
    columns.push(name.trim().to_string());
    added.push(name.trim().to_string());
    columns.len() - 1
}

#[tauri::command]
pub async fn import_data(req: ImportRequest, state: State<'_, AppState>) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    tokio::task::spawn_blocking(move || run_import(&folder, req))
        .await
        .map_err(|e| format!("internal task error: {e}"))?
}

/// First-seen identity + coordinates per imported PointNo, feeding the
/// points.xlsx upsert.
#[derive(Default, Clone)]
struct PointSeed {
    db: String,
    project_id: String,
    point_id: String,
    x1: Option<f64>,
    y1: Option<f64>,
    z1: Option<f64>,
    projection: String,
}

fn run_import(folder: &str, req: ImportRequest) -> Result<Value, String> {
    let fname = sanitize_fname(&req.fname)?;

    let id_db = IdValue::parse(&req.ids.db.kind, &req.ids.db.value, "DB")?;
    let id_project = IdValue::parse(&req.ids.project_id.kind, &req.ids.project_id.value, "ProjectId")?;
    let id_point = IdValue::parse(&req.ids.point_id.kind, &req.ids.point_id.value, "PointId")?;
    let id_pn = IdValue::parse(&req.ids.point_no.kind, &req.ids.point_no.value, "PointNo")?;

    let files = resolve_files(&req.path)?;

    // ── Target datasheet: load existing, union columns ────────────────────
    let dir = datasheets_dir(folder);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create Datasheets dir: {e}"))?;
    let sheet_path = dir.join(format!("{fname}.xlsx"));

    let (mut columns, mut rows, formulas) = match read_existing_datasheet(&sheet_path) {
        Some((c, r, f)) => (c, r, f),
        None => (Vec::new(), Vec::new(), FormulaMap::new()),
    };

    let mut new_columns: Vec<String> = Vec::new();
    // Destination list first, in UI order, so a generated table matches its
    // query schema (unmapped columns exist but stay blank).
    for c in &req.columns {
        if !c.trim().is_empty() {
            col_index(&mut columns, c, &mut new_columns);
        }
    }
    // Database tag + PointNo always exist.  Downloaded sheets call the tag
    // `db_id` (multi-DB prepend) — reuse it instead of adding a second one.
    let db_idx = match find_ci(&columns, &["db", "db_id"]) {
        Some(i) => i,
        None => col_index(&mut columns, "DB", &mut new_columns),
    };
    let pn_idx = match find_ci(&columns, &["pointno"]) {
        Some(i) => i,
        None => col_index(&mut columns, "PointNo", &mut new_columns),
    };
    let mut map_idx: Vec<(usize, IdValue, f64)> = Vec::new();
    for m in &req.mapping {
        if m.target.trim().is_empty() {
            continue;
        }
        let src = IdValue::parse(&m.kind, &m.value, m.target.trim())?;
        let factor = m.factor.filter(|f| f.is_finite() && *f != 0.0).unwrap_or(1.0);
        map_idx.push((col_index(&mut columns, &m.target, &mut new_columns), src, factor));
    }
    // ProjectId / PointId values land in the sheet only when it has such a
    // column (most datasheet queries carry PointId).
    let prj_idx = find_ci(&columns, &["projectid"]);
    let pid_idx = find_ci(&columns, &["pointid"]);

    let width = columns.len();
    for row in rows.iter_mut() {
        row.resize(width, Value::Null);
    }

    // Column indices (case-insensitive) feeding the points.xlsx upsert.
    let (x1_idx, y1_idx, z1_idx, proj_idx) = (
        find_ci(&columns, &["x1"]),
        find_ci(&columns, &["y1"]),
        find_ci(&columns, &["z1"]),
        find_ci(&columns, &["projection1"]),
    );

    // ── Derived Level (#284) ──────────────────────────────────────────────
    // When the sheet has both Level and Depth columns, any row whose Level is
    // empty gets Level = Z1 − Depth (the datasheet-query convention), with Z1
    // looked up per point.  No Z1 match → Level = −Depth.  points.xlsx is
    // loaded here so its Z1 feeds the lookup; the upsert below reuses it.
    let level_idx = find_ci(&columns, &["level"]);
    let depth_idx = find_ci(&columns, &["depth"]);
    let compute_level = level_idx.is_some() && depth_idx.is_some();

    let pts_path = points_xlsx_path(folder);
    let mut points = if pts_path.exists() {
        read_points_rows(&pts_path)
    } else {
        Vec::new()
    };
    let mut z1_by_full: HashMap<(String, String, String), f64> = HashMap::new();
    let mut z1_by_pn: HashMap<String, f64> = HashMap::new();
    if compute_level {
        for p in &points {
            if let Some(z) = p.z1 {
                z1_by_full
                    .entry((
                        p.db_id.trim().to_string(),
                        p.project_id.trim().to_string(),
                        p.point_id.trim().to_string(),
                    ))
                    .or_insert(z);
                if !p.point_no.trim().is_empty() {
                    z1_by_pn.entry(p.point_no.trim().to_lowercase()).or_insert(z);
                }
            }
        }
    }

    // ── Append data rows from every file ──────────────────────────────────
    let start = req.data_row.max(1) - 1; // 1-based → 0-based
    let mut rows_added = 0usize;
    let mut rows_skipped = 0usize;
    let mut point_info: HashMap<String, PointSeed> = HashMap::new();
    let mut point_order: Vec<String> = Vec::new();

    for file in &files {
        let grid = read_grid(file)?;
        let stem = file
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        for src in grid.iter().skip(start) {
            // All-empty source rows are noise (trailing Excel rows etc.).
            if src.iter().all(|v| value_to_string(v).is_empty()) {
                continue;
            }
            let pn = id_pn.resolve(src, &stem, None);
            if pn.is_empty() {
                rows_skipped += 1;
                continue;
            }
            // Per-row blanks (column-sourced IDs) fall back to the import tag.
            let db = match id_db.resolve(src, &stem, Some(&pn)) {
                s if s.is_empty() => "imported".to_string(),
                s => s,
            };
            let project_id = match id_project.resolve(src, &stem, Some(&pn)) {
                s if s.is_empty() => "imported".to_string(),
                s => s,
            };
            let point_id = match id_point.resolve(src, &stem, Some(&pn)) {
                s if s.is_empty() => format!("imported_{pn}"),
                s => s,
            };

            let mut row = vec![Value::Null; width];
            for (tgt, source, factor) in &map_idx {
                let mut v = source.resolve_value(src, &stem, &pn);
                // Unit conversion (#288): scale numeric values only; text and
                // blanks pass through untouched.
                if (*factor - 1.0).abs() > f64::EPSILON {
                    if let Some(n) = value_to_f64(&v) {
                        if let Some(num) = serde_json::Number::from_f64(n * *factor) {
                            v = Value::Number(num);
                        }
                    }
                }
                row[*tgt] = v;
            }
            // IDs win over any mapping that targets the same column.
            row[db_idx] = Value::String(db.clone());
            row[pn_idx] = Value::String(pn.clone());
            if let Some(i) = prj_idx {
                row[i] = Value::String(project_id.clone());
            }
            if let Some(i) = pid_idx {
                row[i] = Value::String(point_id.clone());
            }

            // Derive Level when the file gave none for this row (#284).
            if let (Some(li), Some(di)) = (level_idx, depth_idx) {
                if value_to_string(&row[li]).is_empty() {
                    if let Some(depth) = value_to_f64(&row[di]) {
                        let z1 = z1_idx
                            .and_then(|zi| value_to_f64(&row[zi]))
                            .or_else(|| {
                                z1_by_full
                                    .get(&(
                                        db.trim().to_string(),
                                        project_id.trim().to_string(),
                                        point_id.trim().to_string(),
                                    ))
                                    .copied()
                            })
                            .or_else(|| z1_by_pn.get(&pn.to_lowercase()).copied());
                        if let Some(num) = serde_json::Number::from_f64(level_from(z1, depth)) {
                            row[li] = Value::Number(num);
                        }
                    }
                }
            }

            let seed = point_info.entry(pn.clone()).or_insert_with(|| {
                point_order.push(pn.clone());
                PointSeed {
                    db: db.clone(),
                    project_id: project_id.clone(),
                    point_id: point_id.clone(),
                    ..PointSeed::default()
                }
            });
            if seed.x1.is_none() {
                seed.x1 = x1_idx.and_then(|i| value_to_f64(&row[i]));
            }
            if seed.y1.is_none() {
                seed.y1 = y1_idx.and_then(|i| value_to_f64(&row[i]));
            }
            if seed.z1.is_none() {
                seed.z1 = z1_idx.and_then(|i| value_to_f64(&row[i]));
            }
            if seed.projection.is_empty() {
                if let Some(i) = proj_idx {
                    seed.projection = value_to_string(&row[i]);
                }
            }

            rows.push(row);
            rows_added += 1;
        }
    }

    if rows_added == 0 {
        return Err(
            "No data rows found — check the first-data-row setting and the PointNo source.".into(),
        );
    }

    // ── Write the datasheet + sidecar cache + meta ────────────────────────
    let fopt = if formulas.is_empty() { None } else { Some(&formulas) };
    write_datasheet(&sheet_path, &columns, &rows, fopt)?;
    write_datasheet_cache(folder, &fname, &columns, &rows, fopt);
    let has_strata = columns
        .iter()
        .any(|c| c.trim().eq_ignore_ascii_case("strata"));
    persist_datasheet_meta(folder, &fname, rows.len(), has_strata);

    // ── points.xlsx upsert ────────────────────────────────────────────────
    // `points` / `pts_path` were loaded above for the Level lookup.
    let mut points_added = 0usize;
    let mut points_updated = 0usize;

    for pn in &point_order {
        let seed = point_info.get(pn).cloned().unwrap_or_default();
        match points
            .iter_mut()
            .find(|p| p.point_no.trim().eq_ignore_ascii_case(pn))
        {
            Some(p) => {
                // Existing point: only fill what is missing.
                let mut changed = false;
                if p.x1.is_none() && seed.x1.is_some() {
                    p.x1 = seed.x1;
                    changed = true;
                }
                if p.y1.is_none() && seed.y1.is_some() {
                    p.y1 = seed.y1;
                    changed = true;
                }
                if p.z1.is_none() && seed.z1.is_some() {
                    p.z1 = seed.z1;
                    changed = true;
                }
                if p.projection1.trim().is_empty() && !seed.projection.is_empty() {
                    p.projection1 = seed.projection.clone();
                    changed = true;
                }
                if p.origin_x1.is_none() && seed.x1.is_some() {
                    p.origin_x1 = seed.x1;
                    changed = true;
                }
                if p.origin_y1.is_none() && seed.y1.is_some() {
                    p.origin_y1 = seed.y1;
                    changed = true;
                }
                if p.origin_z1.is_none() && seed.z1.is_some() {
                    p.origin_z1 = seed.z1;
                    changed = true;
                }
                if p.origin_projection1.trim().is_empty() && !seed.projection.is_empty() {
                    p.origin_projection1 = seed.projection.clone();
                    changed = true;
                }
                if changed {
                    points_updated += 1;
                }
            }
            None => {
                points.push(SelectedPoint {
                    db_id: seed.db,
                    project_id: seed.project_id,
                    point_id: seed.point_id,
                    point_no: pn.clone(),
                    x1: seed.x1,
                    y1: seed.y1,
                    z1: seed.z1,
                    projection1: seed.projection.clone(),
                    origin_x1: seed.x1,
                    origin_y1: seed.y1,
                    origin_z1: seed.z1,
                    origin_projection1: seed.projection,
                });
                points_added += 1;
            }
        }
    }

    if points_added > 0 || points_updated > 0 {
        write_points_workbook(&pts_path, &points)?;
    }

    Ok(json!({
        "files": files.len(),
        "rows_added": rows_added,
        "rows_skipped": rows_skipped,
        "points_added": points_added,
        "points_updated": points_updated,
        "new_columns": new_columns,
        "fname": fname,
    }))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::parse_select_aliases;

    #[test]
    fn parses_house_sql_aliases() {
        // Real builtin (commands/queries.rs POINTS_SQL) — covers CAST with an
        // inner AS, round(x, 2) commas, plain A.[Col], unbracketed A.PointType
        // and a two-word alias.
        let cols = parse_select_aliases(crate::commands::queries::POINTS_SQL);
        assert_eq!(
            cols,
            vec![
                "ProjectId", "PointId", "PointNo", "ProjectNo", "PointType",
                "X1", "Y1", "Z1", "Top", "Bottom", "Projection1",
                "Level Reference", "Coordinate System",
            ]
        );
    }

    #[test]
    fn parses_headerless_select() {
        let cols = parse_select_aliases("SELECT DISTINCT A.[Epsg], B.Name AS [CRS] FROM T");
        assert_eq!(cols, vec!["Epsg", "CRS"]);
    }

    #[test]
    fn level_from_z1_and_depth() {
        use super::level_from;
        let close = |a: f64, b: f64| (a - b).abs() < 1e-9;
        // Z1 known: Level = Z1 − Depth.
        assert!(close(level_from(Some(12.5), 0.5), 12.0));
        // No Z1 match: surface treated as 0 → Level = −Depth.
        assert!(close(level_from(None, 4.0), -4.0));
        assert!(close(level_from(None, 0.0), 0.0));
        // Rounded to 3 dp (datasheet-query convention).
        assert!(close(level_from(Some(10.0), 3.456_7), 6.543));
    }
}
