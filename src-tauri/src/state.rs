// Shared application state — equivalent to backend/state.py in the original.
// Wrapped in Mutex so Tauri commands can mutate it safely across threads.

use std::sync::Mutex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct DbConfig {
    pub server:      String,
    pub database:    String,
    pub auth_method: String,   // "windows" | "sql"
    pub username:    String,
    pub password:    String,
    pub output_folder: String,
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
    pub db:        Mutex<Option<DbConfig>>,
    /// True once a successful connection has been established
    pub connected: Mutex<bool>,
    pub sp:        Mutex<SpState>,
}

impl AppState {
    pub fn has_output_folder(&self) -> bool {
        self.db
            .lock()
            .unwrap()
            .as_ref()
            .map(|c| !c.output_folder.is_empty())
            .unwrap_or(false)
    }

    pub fn output_folder(&self) -> Option<String> {
        self.db
            .lock()
            .unwrap()
            .as_ref()
            .map(|c| c.output_folder.clone())
            .filter(|s| !s.is_empty())
    }
}
