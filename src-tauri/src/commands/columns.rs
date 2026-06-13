// Column dictionary — mirrors backend/routers/columns.py.
//
// Returns a mapping of column header → display metadata used by the frontend
// to label chart axes and table headers.  The authoritative source is
// `GIRTool_Column_Reference.xlsx` bundled with the app under `resources/`.
//
// Sheet layout (single sheet, headers in row 0):
//   | Datasheet | Column Header | Full Name | Description | Unit |
//
// The same column header may appear on multiple rows with different datasheet
// values; in that case the datasheet names are collected into a list.
//
// Result shape (mirrors Python `backend/routers/columns.py::_load`):
//   {
//     "<Column Header>": {
//       "fullName":    "...",
//       "description": "...",
//       "unit":        "...",
//       "datasheets":  ["Points", "CPTData", ...]
//     }
//   }
//
// The parsed dictionary is cached in a `OnceLock` for the lifetime of the
// process (mirrors Python's `_cache` pattern).

use std::sync::OnceLock;

use calamine::{open_workbook_auto, Data, Reader};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

// Process-lifetime cache of the parsed dictionary.
static DICT_CACHE: OnceLock<Value> = OnceLock::new();

/// Convert a calamine `Data` cell to a trimmed `String`, or `None` if empty.
fn cell_str(cell: &Data) -> Option<String> {
    let s = match cell {
        Data::String(s)   => s.trim().to_string(),
        Data::Float(f)    => {
            if f.fract() == 0.0 { format!("{}", *f as i64) } else { f.to_string() }
        }
        Data::Int(i)      => i.to_string(),
        Data::Bool(b)     => b.to_string(),
        Data::DateTime(d) => d.to_string(),
        Data::Empty | Data::Error(_) | Data::DurationIso(_) | Data::DateTimeIso(_) => String::new(),
    };
    if s.is_empty() { None } else { Some(s) }
}

/// Parse the column reference workbook into the JSON dictionary.
fn parse_workbook(path: &std::path::Path) -> Result<Value, String> {
    let mut wb = open_workbook_auto(path)
        .map_err(|e| format!("Cannot open {}: {e}", path.display()))?;

    // Use the first sheet (named "Column Reference" in the reference file,
    // but we don't depend on the name).
    let sheet_name = wb
        .sheet_names()
        .first()
        .cloned()
        .ok_or_else(|| "Workbook has no sheets".to_string())?;
    let range = wb
        .worksheet_range(&sheet_name)
        .map_err(|e| format!("Cannot read sheet '{sheet_name}': {e}"))?;

    let mut out: Map<String, Value> = Map::new();

    // Skip row 0 (headers); iterate rows 1+.
    for row in range.rows().skip(1) {
        // Columns: 0=Datasheet, 1=Column Header, 2=Full Name, 3=Description, 4=Unit
        let ds          = row.first().and_then(cell_str);
        let header      = match row.get(1).and_then(cell_str) {
            Some(h) => h,
            None    => continue,    // skip rows without a column header
        };
        let full_name   = row.get(2).and_then(cell_str);
        let description = row.get(3).and_then(cell_str);
        let unit        = row.get(4).and_then(cell_str);

        // Create or update the entry for this header.
        let entry = out.entry(header).or_insert_with(|| {
            json!({
                "fullName":    full_name,
                "description": description,
                "unit":        unit,
                "datasheets":  Vec::<String>::new(),
            })
        });

        // Append the datasheet name (unique).
        if let (Some(ds), Some(arr)) = (
            ds,
            entry.get_mut("datasheets").and_then(|v| v.as_array_mut()),
        ) {
            let ds_val = Value::String(ds);
            if !arr.contains(&ds_val) {
                arr.push(ds_val);
            }
        }
    }

    Ok(Value::Object(out))
}

/// Return the column reference dictionary.
/// Frontend call: `invoke('get_column_dictionary')`.
///
/// On first call this reads the bundled xlsx via Tauri's resource resolver,
/// parses it with `calamine`, and caches the result for the process lifetime.
/// Subsequent calls return the cached value with no I/O.
#[tauri::command]
pub async fn get_column_dictionary(app: AppHandle) -> Result<Value, String> {
    // Fast path: cached result.
    if let Some(v) = DICT_CACHE.get() {
        return Ok(v.clone());
    }

    // Resolve the bundled resource path.
    let path = app
        .path()
        .resolve(
            "resources/GIRTool_Column_Reference.xlsx",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("Failed to resolve resource path: {e}"))?;

    if !path.exists() {
        // Graceful degrade: frontend handles {} via `setColDict(r ?? {})`.
        tracing::warn!("Column reference workbook not found at {}", path.display());
        return Ok(json!({}));
    }

    // Parse on a blocking thread.
    let parsed = tokio::task::spawn_blocking(move || parse_workbook(&path))
        .await
        .map_err(|e| format!("internal task error: {e}"))??;

    // Cache and return. `set` returns Err if already set (race with another
    // caller); in that case we just use whatever is cached.
    let cached = DICT_CACHE.get_or_init(|| parsed);
    Ok(cached.clone())
}

// ── Column reference for the AI assistant (issue #306) ──────────────────────────

static REF_CACHE: OnceLock<String> = OnceLock::new();

/// A compact, grouped reference of every datasheet column with its unit and
/// meaning, built from the same bundled workbook as the dictionary.  Injected
/// into the AI assistant's system prompt so it knows the columns + units; cached
/// for the process lifetime.  Empty string when the workbook is unavailable.
pub(crate) fn column_reference_text(app: &AppHandle) -> String {
    if let Some(s) = REF_CACHE.get() {
        return s.clone();
    }
    let text = build_reference_text(app).unwrap_or_default();
    let _ = REF_CACHE.set(text.clone());
    text
}

fn build_reference_text(app: &AppHandle) -> Option<String> {
    let path = app
        .path()
        .resolve(
            "resources/GIRTool_Column_Reference.xlsx",
            tauri::path::BaseDirectory::Resource,
        )
        .ok()?;
    if !path.exists() {
        return None;
    }
    let mut wb = open_workbook_auto(&path).ok()?;
    let sheet = wb.sheet_names().first().cloned()?;
    let range = wb.worksheet_range(&sheet).ok()?;

    // Group rows by datasheet, preserving first-seen order.
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for row in range.rows().skip(1) {
        let ds = row.first().and_then(cell_str).unwrap_or_else(|| "(other)".to_string());
        let col = match row.get(1).and_then(cell_str) {
            Some(c) => c,
            None => continue,
        };
        let full = row.get(2).and_then(cell_str).unwrap_or_default();
        let desc = row.get(3).and_then(cell_str).unwrap_or_default();
        let unit = row.get(4).and_then(cell_str).unwrap_or_default();

        let mut line = col.clone();
        if !full.is_empty() && full != col {
            line.push_str(&format!(" — {full}"));
        }
        if !unit.is_empty() {
            line.push_str(&format!(" [{unit}]"));
        }
        if !desc.is_empty() {
            line.push_str(&format!(": {desc}"));
        }

        if let Some(g) = groups.iter_mut().find(|(n, _)| n == &ds) {
            g.1.push(line);
        } else {
            groups.push((ds, vec![line]));
        }
    }
    if groups.is_empty() {
        return None;
    }

    let mut out = String::from(
        "## Datasheet columns (units and meaning)\n\nThese are the columns of GIRTool's downloaded datasheets, each with its unit of measurement. This is the source of truth — answer column/unit questions from it and never invent columns or units. Format: `Column — Full name [unit]: description`.\n",
    );
    for (ds, cols) in &groups {
        out.push_str(&format!("\n### {ds}\n"));
        for line in cols {
            out.push_str(&format!("- {line}\n"));
        }
    }
    Some(out)
}
