// SQL Server connection helpers built on the odbc-api crate.
//
// odbc-api is fully synchronous; callers in async commands should wrap these
// helpers in `tokio::task::spawn_blocking`.

use crate::state::DbConfig;
use anyhow::{Context, Result};
use odbc_api::{ConnectionOptions, Cursor, DataType, Environment, ResultSetMetadata};
use serde_json::{Map, Value};

/// Build an ODBC connection string from the stored config.
pub fn connection_string(cfg: &DbConfig) -> String {
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
pub fn test_connection(cfg: &DbConfig) -> Result<()> {
    let env = Environment::new().context("ODBC Environment init failed")?;
    let conn_str = connection_string(cfg);
    env.connect_with_connection_string(&conn_str, ConnectionOptions::default())
        .context("ODBC connect failed")?;
    Ok(())
}

/// Execute a SELECT and return each row as a JSON object keyed by column name.
///
/// Numeric columns (integer / decimal / float) are returned as JSON numbers so
/// frontend sort comparators stay numeric; everything else comes back as a
/// string. SQL NULLs become JSON `null`.
pub fn query_rows(cfg: &DbConfig, sql: &str) -> Result<Vec<Value>> {
    let env = Environment::new().context("ODBC Environment init failed")?;
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
    let num_cols = names.len() as u16;

    let mut data_types: Vec<DataType> = Vec::with_capacity(num_cols as usize);
    for i in 0..num_cols {
        data_types.push(
            cursor
                .col_data_type(i + 1)
                .with_context(|| format!("Failed to read type for column {}", names[i as usize]))?,
        );
    }

    let mut rows: Vec<Value> = Vec::new();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(mut row) = cursor.next_row().context("Failed to fetch next row")? {
        let mut obj = Map::with_capacity(num_cols as usize);
        for i in 0..num_cols {
            buf.clear();
            let not_null = row
                .get_text(i + 1, &mut buf)
                .with_context(|| format!("Failed to read column {}", names[i as usize]))?;
            let val = if !not_null {
                Value::Null
            } else {
                let s = String::from_utf8_lossy(&buf).into_owned();
                let parsed: Option<Value> = match data_types[i as usize] {
                    DataType::Integer
                    | DataType::SmallInt
                    | DataType::TinyInt
                    | DataType::BigInt => s.parse::<i64>().ok().map(Value::from),
                    DataType::Numeric { .. }
                    | DataType::Decimal { .. }
                    | DataType::Float { .. }
                    | DataType::Double
                    | DataType::Real => s
                        .parse::<f64>()
                        .ok()
                        .and_then(serde_json::Number::from_f64)
                        .map(Value::Number),
                    _ => None,
                };
                parsed.unwrap_or(Value::String(s))
            };
            obj.insert(names[i as usize].clone(), val);
        }
        rows.push(Value::Object(obj));
    }

    Ok(rows)
}
