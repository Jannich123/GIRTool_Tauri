// SQL Server connection commands.
//
// Mirrors backend/routers/database.py from the Python reference build:
//
//   * connect            — validates an ODBC connection and stores config in
//                          AppState; persists the config to
//                          %APPDATA%\GIRTool\settings.json on success.
//   * disconnect         — clears in-memory state (config + connected flag).
//   * db_status          — returns the live state for the Settings/App page.
//   * browse_folder      — opens a native OS folder picker via
//                          tauri-plugin-dialog and returns the chosen path.
//   * test_folder        — verifies a folder exists and is writable by
//                          creating + deleting a probe file.
//   * refresh_project    — placeholder hook called by the Sidebar refresh
//                          button; triggers a refreshKey bump on the frontend.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::state::{AppState, DbConfig};

// ── Request / response types ──────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ConnectArgs {
    pub server:        String,
    pub database:      String,
    #[serde(rename = "authMethod")]
    pub auth_method:   String,
    #[serde(default)]
    pub username:      Option<String>,
    #[serde(default)]
    pub password:      Option<String>,
    #[serde(rename = "outputFolder", default)]
    pub output_folder: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ConnectResult {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    pub connected:     bool,
    pub server:        String,
    pub database:      String,
    pub auth_method:   String,
    pub output_folder: String,
    pub configured:    bool,
    pub folder_valid:  bool,
}

#[derive(Debug, Serialize)]
pub struct BrowseResult {
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FolderResult {
    pub valid:   bool,
    pub message: String,
}

// ── Settings persistence (%APPDATA%\GIRTool\settings.json) ────────────────────

fn settings_dir() -> Result<PathBuf, String> {
    let appdata = std::env::var("APPDATA")
        .map_err(|_| "APPDATA environment variable is not set".to_string())?;
    let dir = PathBuf::from(appdata).join("GIRTool");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(settings_dir()?.join("settings.json"))
}

fn save_settings(cfg: &DbConfig) -> Result<(), String> {
    let path = settings_path()?;
    let json = serde_json::to_string_pretty(cfg)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn connect(
    args:  ConnectArgs,
    state: State<'_, AppState>,
) -> Result<ConnectResult, String> {
    let cfg = DbConfig {
        server:        args.server,
        database:      args.database,
        auth_method:   args.auth_method,
        username:      args.username.unwrap_or_default(),
        password:      args.password.unwrap_or_default(),
        output_folder: args.output_folder.unwrap_or_default(),
    };

    // odbc-api is sync — move it off the async runtime.
    let probe = cfg.clone();
    let probe_result = tokio::task::spawn_blocking(move || {
        crate::db::test_connection(&probe)
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?;
    probe_result.map_err(|e| format!("{e:#}"))?;

    // Persist before mutating state so a write failure doesn't leave us in a
    // half-configured state.
    save_settings(&cfg)?;

    let message = format!("Connected to {} on {}", cfg.database, cfg.server);
    *state.db.lock().unwrap()        = Some(cfg);
    *state.connected.lock().unwrap() = true;

    Ok(ConnectResult { success: true, message })
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>) -> Result<(), String> {
    *state.db.lock().unwrap()        = None;
    *state.connected.lock().unwrap() = false;
    Ok(())
}

/// Returns live connection/configuration status.
/// Frontend calls this as `db_status` (registered below under that name).
#[tauri::command]
pub async fn db_status(state: State<'_, AppState>) -> Result<StatusResult, String> {
    let connected = *state.connected.lock().unwrap();
    let cfg = state.db.lock().unwrap().clone().unwrap_or_default();

    let configured   = !cfg.server.is_empty() && !cfg.database.is_empty();
    let folder_valid = !cfg.output_folder.is_empty()
        && Path::new(&cfg.output_folder).is_dir();

    Ok(StatusResult {
        connected,
        server:        cfg.server,
        database:      cfg.database,
        auth_method:   cfg.auth_method,
        output_folder: cfg.output_folder,
        configured,
        folder_valid,
    })
}

#[tauri::command]
pub async fn browse_folder(
    app:     AppHandle,
    initial: Option<String>,
) -> Result<BrowseResult, String> {
    // Run the (potentially blocking) native dialog off the async runtime.
    let picked = tokio::task::spawn_blocking(move || {
        let mut builder = app.dialog().file().set_title("Select output folder");
        if let Some(init) = initial.filter(|s| !s.is_empty()) {
            builder = builder.set_directory(init);
        }
        builder.blocking_pick_folder()
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?;

    let path = picked.and_then(|fp| {
        fp.into_path().ok().map(|p| p.to_string_lossy().into_owned())
    });
    Ok(BrowseResult { path })
}

#[tauri::command]
pub async fn test_folder(path: String) -> Result<FolderResult, String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("No path provided.".into());
    }

    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("Folder not found: {path}"));
    }

    let probe = dir.join(".girtool_write_test");
    if let Err(e) = std::fs::write(&probe, b"ok") {
        return Err(format!("Folder exists but is not writable: {e}"));
    }
    // Best-effort cleanup — failure here doesn't invalidate the write check.
    let _ = std::fs::remove_file(&probe);

    Ok(FolderResult {
        valid:   true,
        message: format!("Folder is accessible: {path}"),
    })
}

/// Called by the Sidebar "Refresh data" button.
/// Returns Ok(()) so the frontend can bump its refreshKey.
#[tauri::command]
pub async fn refresh_project(
    _project_id: String,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    // Currently a no-op — the frontend re-fetches data on its own after
    // receiving Ok. Future: invalidate any server-side caches here.
    Ok(())
}
