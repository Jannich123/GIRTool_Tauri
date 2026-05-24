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

#[derive(Debug, Default)]
pub struct AppState {
    pub db:  Mutex<Option<DbConfig>>,
    /// True once a successful connection has been established
    pub connected: Mutex<bool>,
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
