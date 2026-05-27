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

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::state::{AppState, DbConfig};

// ── Request / response types ──────────────────────────────────────────────────

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

// ── Recent folders list (%APPDATA%\GIRTool\recent_folders.json) ───────────────
//
// A simple FIFO of the last 10 distinct `output_folder` paths the user has
// connected with.  Most recent first.  Surfaced in the Settings page as a
// quick "Recent folders" picker so users can jump between workspaces.

const MAX_RECENT_FOLDERS: usize = 10;

fn recent_folders_path() -> Result<PathBuf, String> {
    Ok(settings_dir()?.join("recent_folders.json"))
}

fn read_recent_folders() -> Vec<String> {
    let path = match recent_folders_path() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<Vec<String>>(&bytes).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn write_recent_folders(folders: &[String]) -> Result<(), String> {
    let path = recent_folders_path()?;
    let json = serde_json::to_string_pretty(folders)
        .map_err(|e| format!("Failed to serialise recent folders: {e}"))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

/// Add `folder` to the top of the recent-folders list, deduplicate (case-
/// insensitive on Windows path separators), and cap at 10.
fn record_recent_folder(folder: &str) {
    if folder.is_empty() { return }
    let norm = folder.replace('/', "\\");
    let mut list = read_recent_folders();
    // Remove any existing entries that match (case-insensitive).
    list.retain(|f| !f.replace('/', "\\").eq_ignore_ascii_case(&norm));
    list.insert(0, folder.to_string());
    if list.len() > MAX_RECENT_FOLDERS { list.truncate(MAX_RECENT_FOLDERS); }
    let _ = write_recent_folders(&list);
}

/// Return the recent-folders list (most recent first).
#[tauri::command]
pub async fn list_recent_folders() -> Result<Vec<String>, String> {
    Ok(read_recent_folders())
}

/// Remove a folder from the recent list (e.g. user clicks ✕ on a chip).
#[tauri::command]
pub async fn forget_recent_folder(path: String) -> Result<Vec<String>, String> {
    let mut list = read_recent_folders();
    let norm = path.replace('/', "\\");
    list.retain(|f| !f.replace('/', "\\").eq_ignore_ascii_case(&norm));
    write_recent_folders(&list)?;
    Ok(list)
}

// ── Per-folder DB config (in `{folder}/GIRTool_settings.json` under "db") ─────
//
// We store database credentials INSIDE the project folder so that:
//   1. Opening a folder auto-connects to the right database.
//   2. Different projects can target different SQL Servers/databases.
//   3. Sharing a folder (via OneDrive / SharePoint sync) shares the DB
//      pointer too — collaborators don't have to reconfigure.

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderDbConfig {
    pub server:        String,
    pub database:      String,
    pub auth_method:   String,
    pub username:      String,
    /// Returned in plaintext — same as the legacy `%APPDATA%\GIRTool\settings.json`
    /// — so the frontend can pre-fill the Connect form without a second prompt.
    pub password:      String,
    /// True if the folder actually contained a `db` block.
    pub found:         bool,
}

/// Read a folder's `GIRTool_settings.json` and pull out the `db` sub-object
/// (server / database / auth_method / username / password).  Returns
/// `{found: false}` with empty fields when the file or block is absent —
/// callers should treat that as "user hasn't connected from this folder yet".
#[tauri::command]
pub async fn load_folder_db_config(folder: String) -> Result<FolderDbConfig, String> {
    let path = std::path::PathBuf::from(&folder).join("GIRTool_settings.json");
    let empty = FolderDbConfig {
        server: String::new(), database: String::new(), auth_method: String::new(),
        username: String::new(), password: String::new(), found: false,
    };
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return Ok(empty),
    };
    let v: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return Ok(empty),
    };
    let db = match v.get("db").and_then(|v| v.as_object()) {
        Some(o) => o,
        None    => return Ok(empty),
    };
    let s = |k: &str| db.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    Ok(FolderDbConfig {
        server:      s("server"),
        database:    s("database"),
        auth_method: s("auth_method"),
        username:    s("username"),
        password:    s("password"),
        found:       true,
    })
}

/// Initialise the user's output folder with the expected scaffolding:
///   * `<folder>/Datasheets/`        — destination for query export xlsx files
///   * `<folder>/GIRTool_settings.json` — session state file consumed by
///     `download.rs` and `session.rs`; seeded with the active server/database
///     and an empty `sessions` map.  Existing file is preserved (we only add
///     keys that are missing) so chart/boundary state is never clobbered.
fn seed_output_folder(cfg: &DbConfig) -> Result<(), String> {
    let folder = std::path::Path::new(&cfg.output_folder);
    if !folder.is_dir() {
        return Err(format!("Output folder is not a directory: {}", cfg.output_folder));
    }

    // 1. Datasheets/ subfolder
    let datasheets = folder.join("Datasheets");
    std::fs::create_dir_all(&datasheets)
        .map_err(|e| format!("Failed to create {}: {e}", datasheets.display()))?;

    // 2. GIRTool_settings.json (preserve existing keys if file already exists)
    let settings_file = folder.join("GIRTool_settings.json");
    let mut settings: serde_json::Map<String, serde_json::Value> =
        match std::fs::read(&settings_file) {
            Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .and_then(|v| v.as_object().cloned())
                .unwrap_or_default(),
            Err(_) => serde_json::Map::new(),
        };

    settings.insert("server".into(),   serde_json::json!(cfg.server));
    settings.insert("database".into(), serde_json::json!(cfg.database));
    settings.insert("saved_at".into(), serde_json::json!(chrono::Utc::now().to_rfc3339()));
    settings.entry("sessions".to_string())
        .or_insert_with(|| serde_json::json!({}));

    // Per-folder DB config under "db" key so the next user opening this
    // folder auto-connects to the same SQL Server without having to re-enter
    // credentials.  Stored alongside the rest of the project settings.
    settings.insert("db".into(), serde_json::json!({
        "server":      cfg.server,
        "database":    cfg.database,
        "auth_method": cfg.auth_method,
        "username":    cfg.username,
        "password":    cfg.password,
    }));

    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialise settings: {e}"))?;
    std::fs::write(&settings_file, json)
        .map_err(|e| format!("Failed to write {}: {e}", settings_file.display()))
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub async fn connect(
    server:        String,
    database:      String,
    auth_method:   String,
    username:      Option<String>,
    password:      Option<String>,
    output_folder: Option<String>,
    state:         State<'_, AppState>,
) -> Result<ConnectResult, String> {
    let cfg = DbConfig {
        server,
        database,
        auth_method,
        username:      username.unwrap_or_default(),
        password:      password.unwrap_or_default(),
        output_folder: output_folder.unwrap_or_default(),
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

    // Seed the user's output folder so other commands can rely on the
    // expected layout (Datasheets/ subfolder + initial GIRTool_settings.json).
    // Soft-fail: if folder is read-only we log but don't abort the connect.
    if !cfg.output_folder.is_empty() {
        let _ = seed_output_folder(&cfg);
        // Remember this folder in the recent-folders list so the next
        // launch can offer it as a quick-pick in Settings.
        record_recent_folder(&cfg.output_folder);
    }

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
