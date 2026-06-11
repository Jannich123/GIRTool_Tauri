// SQL Server connection helpers built on the odbc-api crate.
//
// odbc-api is fully synchronous; callers in async commands should wrap these
// helpers in `tokio::task::spawn_blocking`.

use std::sync::OnceLock;

use crate::state::DbConfig;
use anyhow::{Context, Result};
use odbc_api::{
    buffers::{AnySlice, BufferDesc, ColumnarAnyBuffer},
    ConnectionOptions, Cursor, DataType, Environment, ResultSetMetadata,
};
use serde_json::{Map, Value};

/// Rows fetched per ODBC round-trip (issue #194).  One driver call fills the
/// whole batch instead of one call per cell.
const BATCH_SIZE: usize = 1024;
/// Per-cell character cap for text columns whose declared size is unbounded
/// (VARCHAR(MAX)) or unknown.  Datasheet cells are far below this; a warn is
/// logged once per column if a value actually hits the cap (truncation).
const MAX_TEXT_CHARS: usize = 2048;

/// Shared ODBC environment — creating one per query is wasteful and the
/// environment is thread-safe by design.
static ENV: OnceLock<Environment> = OnceLock::new();

fn environment() -> Result<&'static Environment> {
    if let Some(e) = ENV.get() {
        return Ok(e);
    }
    let e = Environment::new().context("ODBC Environment init failed")?;
    let _ = ENV.set(e); // racing initialisers both produce valid environments
    Ok(ENV.get().expect("ODBC environment just initialised"))
}

/// Build an ODBC connection string from the stored config.
///
/// Switches on `cfg.db_type`:
///   * `"mssql"` (default / legacy) → SQL Server ODBC Driver 17
///   * `"access"`                   → Microsoft Access Driver (*.mdb, *.accdb)
pub fn connection_string(cfg: &DbConfig) -> String {
    if cfg.db_type.eq_ignore_ascii_case("access") {
        // Access uses a file path (DBQ) instead of server/database.
        return format!(
            "Driver={{Microsoft Access Driver (*.mdb, *.accdb)}};DBQ={};",
            cfg.file_path
        );
    }

    // MSSQL (default).
    let auth = if cfg.auth_method == "windows" {
        "Trusted_Connection=yes;".to_string()
    } else {
        format!("UID={};PWD={};", cfg.username, cfg.password)
    };
    format!(
        "Driver={{ODBC Driver 17 for SQL Server}};Server={};Database={};{}",
        cfg.server, cfg.database, auth
    )
}

/// Open a one-shot ODBC connection and verify it works.
///
/// For Access, when the driver is not installed the underlying ODBC error
/// surfaces as "IM002 Data source name not found and no default driver
/// specified" — the caller (e.g. `test_database`) is responsible for adding
/// a friendly hint that points the user at the Microsoft Access Database
/// Engine 2016 Redistributable when it sees that pattern.
pub fn test_connection(cfg: &DbConfig) -> Result<()> {
    let env = environment()?;
    let conn_str = connection_string(cfg);
    env.connect_with_connection_string(&conn_str, ConnectionOptions::default())
        .context("ODBC connect failed")?;
    Ok(())
}

/// How a result column is bound + converted (issue #194 bulk fetch).
#[derive(Clone, Copy, PartialEq)]
enum ColKind {
    I64,
    F64,
    Text,
}

/// Execute a SELECT and return each row as a JSON object keyed by column name.
///
/// Issue #194: fetches in 1024-row COLUMNAR batches (one ODBC round-trip per
/// batch) instead of the old one-call-per-cell loop — the difference between
/// minutes and seconds on large datasheets.  Numeric SQL types bind native
/// i64/f64 buffers (JSON numbers, no string round-trip); everything else binds
/// wide-text (UTF-16) buffers so Danish characters (æ, ø, å) stay lossless.
/// PointNo / ProjectNo / PointId / ProjectId are always returned as strings —
/// borehole labels may carry leading zeros or letters that numeric parsing
/// would corrupt.  SQL NULLs become JSON `null`.
pub fn query_rows(cfg: &DbConfig, sql: &str) -> Result<Vec<Value>> {
    let env = environment()?;
    let conn_str = connection_string(cfg);
    let conn = env
        .connect_with_connection_string(&conn_str, ConnectionOptions::default())
        .context("ODBC connect failed")?;

    let mut cursor = match conn.execute(sql, ()).context("Query execution failed")? {
        Some(c) => c,
        // Statement returned no result set (e.g. INSERT) — treat as empty.
        None => return Ok(Vec::new()),
    };

    let names: Vec<String> = cursor
        .column_names()
        .context("Failed to read column names")?
        .collect::<std::result::Result<_, _>>()
        .context("Failed to decode column name")?;
    let num_cols = names.len();

    // Per-column buffer plan.
    let mut kinds: Vec<ColKind> = Vec::with_capacity(num_cols);
    let mut caps: Vec<usize> = Vec::with_capacity(num_cols);
    let mut descs: Vec<BufferDesc> = Vec::with_capacity(num_cols);
    for i in 0..num_cols {
        let dt = cursor
            .col_data_type((i + 1) as u16)
            .with_context(|| format!("Failed to read type for column {}", names[i]))?;
        let force_string = matches!(
            names[i].to_ascii_lowercase().as_str(),
            "pointno" | "projectno" | "pointid" | "projectid"
        );
        let kind = if force_string {
            ColKind::Text
        } else {
            match dt {
                DataType::Integer | DataType::SmallInt | DataType::TinyInt | DataType::BigInt => {
                    ColKind::I64
                }
                DataType::Numeric { .. }
                | DataType::Decimal { .. }
                | DataType::Float { .. }
                | DataType::Double
                | DataType::Real => ColKind::F64,
                _ => ColKind::Text,
            }
        };
        let cap = match kind {
            ColKind::Text => dt
                .display_size()
                .map(|n| n.get())
                .unwrap_or(MAX_TEXT_CHARS)
                .clamp(1, MAX_TEXT_CHARS),
            _ => 0,
        };
        descs.push(match kind {
            ColKind::I64 => BufferDesc::I64 { nullable: true },
            ColKind::F64 => BufferDesc::F64 { nullable: true },
            ColKind::Text => BufferDesc::WText { max_str_len: cap },
        });
        kinds.push(kind);
        caps.push(cap);
    }

    let buffer = ColumnarAnyBuffer::from_descs(BATCH_SIZE, descs);
    let mut block = cursor
        .bind_buffer(buffer)
        .context("Failed to bind fetch buffers")?;

    let mut rows: Vec<Value> = Vec::new();
    let mut truncation_logged = vec![false; num_cols];

    while let Some(batch) = block
        .fetch_with_truncation_check(false)
        .context("Failed to fetch row batch")?
    {
        let n = batch.num_rows();

        // Resolve each column's view once per batch, then index per row.
        enum View<'a> {
            I64(&'a [i64], &'a [isize]),
            F64(&'a [f64], &'a [isize]),
            Text(odbc_api::buffers::TextColumnView<'a, u16>),
        }
        let mut views: Vec<View> = Vec::with_capacity(num_cols);
        for i in 0..num_cols {
            let v = match batch.column(i) {
                AnySlice::NullableI64(s) => {
                    let (vals, ind) = s.raw_values();
                    View::I64(vals, ind)
                }
                AnySlice::NullableF64(s) => {
                    let (vals, ind) = s.raw_values();
                    View::F64(vals, ind)
                }
                AnySlice::WText(t) => View::Text(t),
                _ => anyhow::bail!("unexpected buffer type for column {}", names[i]),
            };
            views.push(v);
        }

        for r in 0..n {
            let mut obj = Map::with_capacity(num_cols);
            for i in 0..num_cols {
                let val = match &views[i] {
                    View::I64(vals, ind) => {
                        if ind[r] < 0 { Value::Null } else { Value::from(vals[r]) }
                    }
                    View::F64(vals, ind) => {
                        if ind[r] < 0 {
                            Value::Null
                        } else {
                            serde_json::Number::from_f64(vals[r])
                                .map(Value::Number)
                                .unwrap_or(Value::Null)
                        }
                    }
                    View::Text(t) => match t.get(r) {
                        None => Value::Null,
                        Some(u16s) => {
                            if u16s.len() >= caps[i] && !truncation_logged[i] {
                                truncation_logged[i] = true;
                                tracing::warn!(
                                    "query_rows: column '{}' hit the {}-char cell cap — value(s) truncated",
                                    names[i], caps[i]
                                );
                            }
                            Value::String(String::from_utf16_lossy(u16s))
                        }
                    },
                };
                obj.insert(names[i].clone(), val);
            }
            rows.push(Value::Object(obj));
        }
    }

    Ok(rows)
}
