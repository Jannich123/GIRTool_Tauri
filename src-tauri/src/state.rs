// Shared application state — equivalent to backend/state.py in the original.
// Wrapped in Mutex so Tauri commands can mutate it safely across threads.

use std::sync::Mutex;
use serde::{Deserialize, Serialize};

/// One configured database connection.
///
/// Backwards-compatible with the legacy single-DB schema:
///   * `db_type` defaults to `"mssql"` (matches the legacy behaviour where every
///     entry was a SQL Server connection).
///   * `id` / `file_path` / `query_type` default to empty strings.
///   * `output_folder` stays on the struct so existing callers that read it
///     from the "primary" DbConfig continue to work; new code reads the
///     dedicated `AppState::output_folder` field instead.
#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct DbConfig {
    // ── Identity ──────────────────────────────────────────────────────────────
    /// User-editable short identifier (must match `[a-z0-9_-]`).
    /// Empty on the legacy primary DB; populated for issue #46 multi-DB lists.
    #[serde(default)]
    pub id: String,

    /// Connector type: `"mssql"` (SQL Server ODBC) or `"access"` (Access driver).
    /// Defaults to `"mssql"` so a legacy entry with no `type` field still works.
    #[serde(default = "default_db_type", rename = "type")]
    pub db_type: String,

    // ── MSSQL fields ──────────────────────────────────────────────────────────
    #[serde(default)]
    pub server:      String,
    #[serde(default)]
    pub database:    String,
    #[serde(default)]
    pub auth_method: String,   // "windows" | "sql"
    #[serde(default)]
    pub username:    String,
    #[serde(default)]
    pub password:    String,

    // ── Access fields ─────────────────────────────────────────────────────────
    /// Absolute path to an `.accdb` / `.mdb` file (only used when `db_type == "access"`).
    #[serde(default)]
    pub file_path: String,

    // ── User label ────────────────────────────────────────────────────────────
    /// User-configurable label surfaced in the Query Config tab.
    #[serde(default = "default_query_type")]
    pub query_type: String,

    // ── Workspace path (legacy; primary DB only) ──────────────────────────────
    /// Output folder kept on `DbConfig` for backwards compatibility with code
    /// that reads `state.output_folder()` via the primary `db` field.
    /// New code should set `AppState::output_folder` directly.
    #[serde(default)]
    pub output_folder: String,
}

fn default_db_type()    -> String { "mssql".to_string() }
// Issue #52: rename "default" → "GeoGIS" to match the new combined
// query-type dropdown in Settings → Query Config.  Existing settings are
// silently upgraded by the migration in `query_configs::get_query_configs`.
fn default_query_type() -> String { "GeoGIS".to_string() }

impl DbConfig {
    /// True if this entry connects to SQL Server.
    pub fn is_mssql(&self) -> bool {
        self.db_type.is_empty() || self.db_type.eq_ignore_ascii_case("mssql")
    }

    /// Return the effective `id` for this DB, falling back to `"primary"` on
    /// the legacy single-DB entry that has no explicit id.  Used as the
    /// `db_id` column prefix by the multi-DB fan-out (issue #48).
    pub fn effective_id(&self) -> String {
        if self.id.is_empty() { "primary".to_string() } else { self.id.clone() }
    }
}

// ── SharePoint state ──────────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct SpConfig {
    pub tenant_id:   String,
    pub client_id:   String,
    pub site_url:    String,
    pub folder_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpToken {
    pub access_token:  String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub expires_in:    u64,
}

#[derive(Debug, Default, Clone)]
pub enum SpPollStatus {
    #[default]
    Idle,
    Pending,
    Authenticated,
    Error(String),
}

#[derive(Debug, Default, Clone)]
pub struct SpState {
    pub config:      SpConfig,
    pub token:       Option<SpToken>,
    pub poll_status: SpPollStatus,
}

// ── App state ─────────────────────────────────────────────────────────────────

#[derive(Debug, Default)]
pub struct AppState {
    /// The "primary" / active SQL Server connection.
    /// Set by `connect` (legacy) and by `save_databases` (first MSSQL entry).
    /// Existing callers that run SQL continue to read this field.
    pub db:        Mutex<Option<DbConfig>>,

    /// Full list of configured databases (issue #46).
    /// Populated alongside `db` so list-aware code can iterate every connection.
    pub databases: Mutex<Vec<DbConfig>>,

    /// Workspace folder.  Independent of any specific DB.
    /// Falls back to `db.output_folder` for legacy data via `output_folder()`.
    pub output_folder: Mutex<String>,

    /// True once a successful connection has been established
    pub connected: Mutex<bool>,

    pub sp:        Mutex<SpState>,
}

impl AppState {
    pub fn has_output_folder(&self) -> bool {
        self.output_folder().is_some()
    }

    /// Return the configured workspace folder.
    /// Prefers the top-level field; falls back to the primary DB's
    /// `output_folder` for back-compat with legacy settings.
    pub fn output_folder(&self) -> Option<String> {
        let top = self.output_folder.lock().unwrap().clone();
        if !top.is_empty() {
            return Some(top);
        }
        self.db
            .lock()
            .unwrap()
            .as_ref()
            .map(|c| c.output_folder.clone())
            .filter(|s| !s.is_empty())
    }

    /// Find a configured database by id.  Returns the first match or `None`.
    /// Used by future cross-database query routing (issues #47 / #48).
    #[allow(dead_code)]
    pub fn find_database(&self, id: &str) -> Option<DbConfig> {
        self.databases
            .lock()
            .unwrap()
            .iter()
            .find(|c| c.id == id)
            .cloned()
    }
}
