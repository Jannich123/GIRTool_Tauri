// SQL Server connection helpers using the odbc-api crate.
// TODO: implement connection pool (issue #3)

use crate::state::DbConfig;
use anyhow::{Context, Result};
use odbc_api::Environment;

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
/// Returns Ok(()) or a descriptive error string.
pub fn test_connection(cfg: &DbConfig) -> Result<()> {
    let env = Environment::new().context("ODBC Environment init failed")?;
    let conn_str = connection_string(cfg);
    env.connect_with_connection_string(&conn_str, Default::default())
        .context("ODBC connect failed")?;
    Ok(())
}
