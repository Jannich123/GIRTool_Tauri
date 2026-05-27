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
use rust_xlsxwriter::{Format, Table, TableColumn, TableStyle, Workbook};
use serde::Deserialize;
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
    /// All project IDs to include in the SQL IN clause.
    pub project_ids: Vec<String>,
    /// Optional point filter; empty = all points.
    #[serde(default)]
    pub point_ids: Vec<String>,
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
}

// ── Path helpers ──────────────────────────────────────────────────────────────

fn settings_path(folder: &str) -> PathBuf {
    PathBuf::from(folder).join("GIRTool_settings.json")
}

fn datasheets_dir(folder: &str) -> PathBuf {
    PathBuf::from(folder).join("Datasheets")
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
/// Returns a map of pointId → sorted Vec<(from, to, primary, secondary)>.
/// Returns an empty map when the file is absent or has no usable rows.
pub(crate) fn load_strata_lookup(
    output_folder: &str,
    _project_id: &str,
) -> HashMap<String, Vec<(f64, f64, String, String)>> {
    use calamine::open_workbook_auto;

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

    let mut lookup: HashMap<String, Vec<(f64, f64, String, String)>> = HashMap::new();

    // Columns: A=ProjectId B=PointId C=PointNo D=From E=To F=Primary G=Secondary
    for row in range.rows().skip(1) {
        let pid = match row.get(1) {
            Some(Data::String(s)) if !s.is_empty() => s.clone(),
            Some(Data::Int(i))                     => i.to_string(),
            Some(Data::Float(f))                   => {
                if f.fract() == 0.0 { format!("{}", *f as i64) } else { f.to_string() }
            }
            _ => continue,
        };
        let from = match row.get(3) {
            Some(Data::Float(f)) => *f,
            Some(Data::Int(i))   => *i as f64,
            _ => continue,
        };
        let to = match row.get(4) {
            Some(Data::Float(f)) => *f,
            Some(Data::Int(i))   => *i as f64,
            _ => continue,
        };
        let primary = row
            .get(5)
            .and_then(|c| match c {
                Data::String(s) if !s.is_empty() => Some(s.clone()),
                _ => None,
            })
            .unwrap_or_else(|| "Unknown".to_string());
        let secondary = row
            .get(6)
            .and_then(|c| match c {
                Data::String(s) if !s.is_empty() => Some(s.clone()),
                _ => None,
            })
            .unwrap_or_else(|| "Unknown".to_string());

        lookup.entry(pid).or_default().push((from, to, primary, secondary));
    }

    // Sort each point's intervals by depth-from.
    for intervals in lookup.values_mut() {
        intervals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    }

    lookup
}

/// Return the strata label (primary, secondary) for a given pointId + depth.
fn strata_at(
    lookup: &HashMap<String, Vec<(f64, f64, String, String)>>,
    point_id: &str,
    depth: f64,
) -> (String, String) {
    if let Some(intervals) = lookup.get(point_id) {
        for (from, to, primary, secondary) in intervals {
            if depth >= *from && depth < *to {
                return (primary.clone(), secondary.clone());
            }
        }
    }
    ("Unknown".to_string(), "Unknown".to_string())
}

/// Extract PointId + Depth from a row-object, inject Primary/Secondary Layer columns.
pub(crate) fn apply_strata_columns(
    columns: &mut Vec<String>,
    rows: &mut Vec<Vec<Value>>,
    strata_lookup: &HashMap<String, Vec<(f64, f64, String, String)>>,
) {
    let col_lower: Vec<String> = columns.iter().map(|c| c.to_lowercase()).collect();

    let pt_idx: Option<usize> = col_lower.iter().position(|c| c == "pointid");
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
            Some(strata_at(strata_lookup, &pid, depth))
        })();
        let (primary, secondary) = result.unwrap_or_else(|| ("Unknown".to_string(), "Unknown".to_string()));
        row.push(Value::String(primary));
        row.push(Value::String(secondary));
    }
}

// ── xlsx writing ──────────────────────────────────────────────────────────────

fn write_datasheet(
    path: &Path,
    columns: &[String],
    rows: &[Vec<Value>],
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

    // Columns beyond the fixed 5 are system-name columns.
    let skip: HashSet<&str> = ["PointId", "PointNo", "ProjectNo", "ProjectName", "PointType"]
        .into_iter()
        .collect();
    let sys_cols: Vec<(usize, String)> = headers
        .iter()
        .enumerate()
        .filter(|(_, h)| !h.is_empty() && !skip.contains(h.as_str()))
        .map(|(i, h)| (i, h.clone()))
        .collect();

    if sys_cols.is_empty() {
        return;
    }

    // Build pointId → { sys_name → value } from the xlsx data rows.
    let mut assignments: HashMap<String, HashMap<String, String>> = HashMap::new();
    for row in iter {
        let pid = match row.get(pid_idx) {
            Some(c) if !matches!(c, Data::Empty) => data_str(c),
            _ => continue,
        };
        if pid.is_empty() {
            continue;
        }
        let mut entry = HashMap::new();
        for (ci, sys_name) in &sys_cols {
            if let Some(cell) = row.get(*ci) {
                let v = data_str(cell);
                if !v.is_empty() {
                    entry.insert(sys_name.clone(), v);
                }
            }
        }
        assignments.insert(pid, entry);
    }

    // Find PointId in the SQL result (case-insensitive).
    let result_pid_idx = match columns.iter().position(|c| c.eq_ignore_ascii_case("pointid")) {
        Some(i) => i,
        None => return,
    };

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
        for (_, sys_name) in &sys_cols {
            let val = pid
                .as_ref()
                .and_then(|p| assignments.get(p))
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
    if query.project_ids.is_empty() {
        return Err("No project IDs provided.".into());
    }

    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let cfg = state
        .db
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No database connection configured.".to_string())?;

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

        let sql = match build_sql(
            &q.sql_script,
            &q.pointfilter,
            &query.project_ids,
            &query.point_ids,
        ) {
            Ok(s) => s,
            Err(e) => {
                errors.push(json!({ "file": xlsx_name, "error": format!("SQL build error — {e}") }));
                continue;
            }
        };

        let cfg_clone = cfg.clone();
        let rows_result = tokio::task::spawn_blocking(move || {
            crate::db::query_rows(&cfg_clone, &sql)
        })
        .await
        .map_err(|e| format!("internal task error: {e}"))?;

        let raw_rows = match rows_result {
            Ok(r) => r,
            Err(e) => {
                errors.push(json!({ "file": xlsx_name, "error": format!("query failed — {e:#}") }));
                continue;
            }
        };

        let row_count = raw_rows.len();
        let (mut columns, mut rows) = objects_to_columnar(raw_rows);

        // Inject strata columns when the query definition requests it.
        if q.apply_strata.eq_ignore_ascii_case("yes") {
            apply_strata_columns(&mut columns, &mut rows, &strata_lookup);
        }

        let path = ds_dir.join(&xlsx_name);
        let cols_clone = columns.clone();
        let rows_clone = rows.clone();
        let path_clone = path.clone();
        if let Err(e) = tokio::task::spawn_blocking(move || {
            write_datasheet(&path_clone, &cols_clone, &rows_clone)
        })
        .await
        .map_err(|e| format!("internal task error: {e}"))?
        {
            errors.push(json!({ "file": xlsx_name, "error": format!("xlsx write failed — {e}") }));
        } else {
            saved.push(json!({ "file": xlsx_name, "rows": row_count }));
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
    new_settings.insert(
        "point_count".to_string(),
        json!(query.point_ids.len()),
    );

    if let Ok(s) = serde_json::to_string_pretty(&Value::Object(new_settings)) {
        let _ = std::fs::write(&settings_file, s);
    }

    Ok(json!({
        "folder": ds_dir.to_string_lossy(),
        "saved":  saved,
        "errors": errors,
    }))
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
