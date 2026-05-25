// SharePoint integration via Microsoft Graph device-code OAuth flow.
// Mirrors backend/routers/sharepoint.py (raw reqwest — no MSAL library).
//
// Auth flow:
//   1. sp_initiate(config) → POST /oauth2/v2.0/devicecode
//                            Returns user_code + verification_uri to show in UI.
//                            Background tokio task polls /oauth2/v2.0/token until
//                            granted or expired.
//   2. sp_poll()           → { status: "pending" | "authenticated" | "error" }
//   3. sp_disconnect()     → clears token from memory and disk.
//
// Graph API commands:
//   sp_status()    → current auth + config
//   sp_list()      → list xlsx/csv/xls files in configured SP folder
//   sp_sync_down() → download those files to local output folder
//   sp_sync_up()   → upload xlsx/csv files from output folder to SP
//
// Persistence:
//   %APPDATA%\GIRTool\sharepoint_config.json — tenant/client/site/folder
//   %APPDATA%\GIRTool\sharepoint_token.json  — access + refresh tokens

use std::path::PathBuf;

use reqwest::Client;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::state::{AppState, SpConfig, SpPollStatus, SpState, SpToken};

// ── Constants ─────────────────────────────────────────────────────────────────

const SCOPES: &str = "https://graph.microsoft.com/Files.ReadWrite \
                       https://graph.microsoft.com/Sites.ReadWrite.All \
                       offline_access";
const GRAPH: &str = "https://graph.microsoft.com/v1.0";

// ── Persistence helpers ───────────────────────────────────────────────────────

fn data_dir() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("GIRTool")
}

fn config_path() -> PathBuf { data_dir().join("sharepoint_config.json") }
fn token_path()  -> PathBuf { data_dir().join("sharepoint_token.json") }

fn save_config(cfg: &SpConfig) {
    let path = config_path();
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
    if let Ok(s) = serde_json::to_string_pretty(cfg) {
        let _ = std::fs::write(&path, s);
    }
}

fn load_config() -> Option<SpConfig> {
    let s = std::fs::read_to_string(config_path()).ok()?;
    serde_json::from_str(&s).ok()
}

fn save_token(tok: &SpToken) {
    let path = token_path();
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
    if let Ok(s) = serde_json::to_string_pretty(tok) {
        let _ = std::fs::write(&path, s);
    }
}

fn load_token() -> Option<SpToken> {
    let s = std::fs::read_to_string(token_path()).ok()?;
    serde_json::from_str(&s).ok()
}

fn delete_token() {
    let _ = std::fs::remove_file(token_path());
}

// ── Startup init ──────────────────────────────────────────────────────────────

/// Restore persisted config + token into AppState on first sp_status call.
/// Returns true if state was already initialised (config non-empty).
fn maybe_load_persisted(sp: &mut SpState) {
    if !sp.config.tenant_id.is_empty() {
        return; // already loaded
    }
    if let Some(cfg) = load_config() {
        sp.config = cfg;
    }
    if let Some(tok) = load_token() {
        sp.poll_status = SpPollStatus::Authenticated;
        sp.token = Some(tok);
    }
}

// ── Graph helpers ─────────────────────────────────────────────────────────────

async fn graph_get(client: &Client, access_token: &str, path: &str) -> Result<Value, String> {
    let url = format!("{GRAPH}{path}");
    let resp = client
        .get(&url)
        .bearer_auth(access_token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("HTTP error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body   = resp.text().await.unwrap_or_default();
        return Err(format!("Graph {status}: {}", &body[..body.len().min(300)]));
    }
    resp.json::<Value>().await.map_err(|e| format!("JSON parse error: {e}"))
}

async fn graph_put(
    client:       &Client,
    access_token: &str,
    path:         &str,
    data:         Vec<u8>,
) -> Result<Value, String> {
    let url = format!("{GRAPH}{path}");
    let resp = client
        .put(&url)
        .bearer_auth(access_token)
        .header("Content-Type", "application/octet-stream")
        .body(data)
        .send()
        .await
        .map_err(|e| format!("HTTP error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body   = resp.text().await.unwrap_or_default();
        return Err(format!("Graph PUT {status}: {}", &body[..body.len().min(300)]));
    }
    resp.json::<Value>().await.map_err(|e| format!("JSON parse error: {e}"))
}

/// Resolve a SharePoint site URL to a Graph site ID.
///
/// For `https://tenant.sharepoint.com/sites/mysite` calls
/// `GET /sites/tenant.sharepoint.com:/sites/mysite`.
async fn resolve_site_id(client: &Client, access_token: &str, site_url: &str) -> Result<String, String> {
    let url = site_url.trim_end_matches('/');
    let without_scheme = url
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let (host, path) = without_scheme
        .split_once('/')
        .unwrap_or((without_scheme, ""));

    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    let site_rel = if parts.len() >= 2 && matches!(parts[0], "sites" | "teams" | "personal") {
        format!("/{}/{}", parts[0], parts[1])
    } else {
        "/".to_string()
    };

    let graph_path = format!("/sites/{host}:{site_rel}");
    let resp = graph_get(client, access_token, &graph_path).await?;
    resp.get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Graph response missing 'id' field".to_string())
}

/// Return the items inside the configured SP folder (or drive root).
async fn folder_items(
    client:       &Client,
    access_token: &str,
    site_id:      &str,
    folder_path:  &str,
) -> Result<Vec<Value>, String> {
    let folder = folder_path.trim_matches('/');
    let ep = if folder.is_empty() {
        format!("/sites/{site_id}/drive/root/children")
    } else {
        format!("/sites/{site_id}/drive/root:/{folder}:/children")
    };
    Ok(graph_get(client, access_token, &ep)
        .await?
        .get("value")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default())
}

// ── Silent token refresh ──────────────────────────────────────────────────────

async fn try_refresh(client: &Client, cfg: &SpConfig, refresh_tok: &str) -> Option<SpToken> {
    let url = format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
        cfg.tenant_id
    );
    let params = [
        ("grant_type",    "refresh_token"),
        ("client_id",     cfg.client_id.as_str()),
        ("refresh_token", refresh_tok),
        ("scope",         SCOPES),
    ];
    let body: Value = client.post(&url).form(&params).send().await.ok()?.json().await.ok()?;
    body.get("access_token")?;
    Some(SpToken {
        access_token:  body["access_token"].as_str().unwrap_or("").to_string(),
        refresh_token: body.get("refresh_token")
            .and_then(|v| v.as_str())
            .unwrap_or(refresh_tok)
            .to_string(),
        expires_in:    body.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600),
    })
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Return current authentication state and SP config.
///
/// On first call after a process restart the persisted config and token are
/// lazy-loaded from disk so the UI immediately reflects prior authentication.
#[tauri::command]
pub async fn sp_status(state: State<'_, AppState>) -> Result<Value, String> {
    let mut sp = state.sp.lock().unwrap();
    maybe_load_persisted(&mut sp);
    Ok(json!({
        "authenticated": sp.token.is_some(),
        "tenant_id":     sp.config.tenant_id,
        "client_id":     sp.config.client_id,
        "site_url":      sp.config.site_url,
        "folder_path":   sp.config.folder_path,
        "poll_status":   match &sp.poll_status {
            SpPollStatus::Idle          => "idle",
            SpPollStatus::Pending       => "pending",
            SpPollStatus::Authenticated => "authenticated",
            SpPollStatus::Error(_)      => "error",
        },
    }))
}

/// Save SP config, attempt silent token refresh, or start the device-code flow.
///
/// Returns `{ user_code, verification_uri, message, expires_in, silent }`.
/// When `silent == true` the token was refreshed from cache — no user action needed.
/// When `silent == false` the user must visit `verification_uri` and enter `user_code`.
#[tauri::command]
pub async fn sp_initiate(
    config: Value,
    state:  State<'_, AppState>,
    app:    AppHandle,
) -> Result<Value, String> {
    // Build + validate config.
    let sp_config = SpConfig {
        tenant_id:   config["tenant_id"].as_str().unwrap_or("").trim().to_string(),
        client_id:   config["client_id"].as_str().unwrap_or("").trim().to_string(),
        site_url:    config["site_url"].as_str().unwrap_or("").trim().trim_end_matches('/').to_string(),
        folder_path: config["folder_path"].as_str().unwrap_or("").trim().to_string(),
    };
    if sp_config.tenant_id.is_empty() { return Err("tenant_id is required".into()); }
    if sp_config.client_id.is_empty()  { return Err("client_id is required".into()); }
    if sp_config.site_url.is_empty()   { return Err("site_url is required".into()); }

    save_config(&sp_config);

    // Reset in-memory state.
    {
        let mut sp = state.sp.lock().unwrap();
        sp.config      = sp_config.clone();
        sp.token       = None;
        sp.poll_status = SpPollStatus::Idle;
    }

    // Try silent refresh via cached refresh token.
    let existing_rt = load_token().map(|t| t.refresh_token).unwrap_or_default();
    if !existing_rt.is_empty() {
        let client = Client::new();
        if let Some(new_token) = try_refresh(&client, &sp_config, &existing_rt).await {
            save_token(&new_token);
            let mut sp = state.sp.lock().unwrap();
            sp.token       = Some(new_token);
            sp.poll_status = SpPollStatus::Authenticated;
            return Ok(json!({
                "user_code":        "",
                "verification_uri": "",
                "message":          "Silently re-authenticated from cached token.",
                "expires_in":       0,
                "silent":           true,
            }));
        }
    }

    // Initiate device-code flow.
    let device_url = format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/devicecode",
        sp_config.tenant_id
    );
    let client = Client::new();
    let resp = client
        .post(&device_url)
        .form(&[("client_id", sp_config.client_id.as_str()), ("scope", SCOPES)])
        .send()
        .await
        .map_err(|e| format!("Device-code request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Device-code error: {body}"));
    }
    let flow: Value = resp.json().await.map_err(|e| format!("Parse error: {e}"))?;

    let device_code      = flow["device_code"].as_str().unwrap_or("").to_string();
    let user_code        = flow["user_code"].as_str().unwrap_or("").to_string();
    let verification_uri = flow["verification_uri"].as_str()
        .unwrap_or("https://microsoft.com/devicelogin")
        .to_string();
    let message          = flow.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let expires_in       = flow.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(900);
    let interval         = flow.get("interval").and_then(|v| v.as_u64()).unwrap_or(5);

    {
        let mut sp = state.sp.lock().unwrap();
        sp.poll_status = SpPollStatus::Pending;
    }

    // Background task: poll token endpoint until granted or expired.
    let cfg_bg  = sp_config.clone();
    let dc_bg   = device_code.clone();
    tokio::spawn(async move {
        let client    = Client::new();
        let token_url = format!(
            "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
            cfg_bg.tenant_id
        );
        let deadline = tokio::time::Instant::now()
            + tokio::time::Duration::from_secs(expires_in + 10);

        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(interval)).await;

            if tokio::time::Instant::now() > deadline {
                let sp_state = app.state::<AppState>();
                let mut sp = sp_state.sp.lock().unwrap();
                sp.poll_status = SpPollStatus::Error("Device-code flow expired".to_string());
                break;
            }

            let params = [
                ("grant_type",   "urn:ietf:params:oauth:grant-type:device_code"),
                ("client_id",    cfg_bg.client_id.as_str()),
                ("device_code",  dc_bg.as_str()),
            ];
            let Ok(resp) = client.post(&token_url).form(&params).send().await else { continue };
            let Ok(body) = resp.json::<Value>().await else { continue };

            if let Some(access) = body.get("access_token").and_then(|v| v.as_str()) {
                let token = SpToken {
                    access_token:  access.to_string(),
                    refresh_token: body.get("refresh_token")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    expires_in:    body.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600),
                };
                save_token(&token);
                let sp_state = app.state::<AppState>();
                let mut sp = sp_state.sp.lock().unwrap();
                sp.token       = Some(token);
                sp.poll_status = SpPollStatus::Authenticated;
                tracing::info!("SharePoint: device-code auth succeeded");
                break;
            }

            // Handle polling errors.
            if let Some(err) = body.get("error").and_then(|v| v.as_str()) {
                match err {
                    "authorization_pending" => {} // keep polling
                    "slow_down" => {
                        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    }
                    _ => {
                        let desc = body.get("error_description")
                            .and_then(|v| v.as_str())
                            .unwrap_or(err)
                            .to_string();
                        let sp_state = app.state::<AppState>();
                        let mut sp = sp_state.sp.lock().unwrap();
                        sp.poll_status = SpPollStatus::Error(desc);
                        tracing::warn!("SharePoint: auth failed — {err}");
                        break;
                    }
                }
            }
        }
    });

    Ok(json!({
        "user_code":        user_code,
        "verification_uri": verification_uri,
        "message":          message,
        "expires_in":       expires_in,
        "silent":           false,
    }))
}

/// Check whether the background auth task has completed.
#[tauri::command]
pub async fn sp_poll(state: State<'_, AppState>) -> Result<Value, String> {
    let sp = state.sp.lock().unwrap();
    Ok(match &sp.poll_status {
        SpPollStatus::Authenticated => json!({ "status": "authenticated" }),
        SpPollStatus::Error(msg)    => json!({ "status": "error", "message": msg }),
        SpPollStatus::Pending       => json!({ "status": "pending" }),
        SpPollStatus::Idle          => json!({ "status": "idle" }),
    })
}

/// Clear token from memory and disk; reset poll status.
#[tauri::command]
pub async fn sp_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut sp = state.sp.lock().unwrap();
        sp.token       = None;
        sp.poll_status = SpPollStatus::Idle;
    }
    delete_token();
    tracing::info!("SharePoint: disconnected");
    Ok(())
}

/// List xlsx / xls / csv files in the configured SharePoint folder.
#[tauri::command]
pub async fn sp_list(state: State<'_, AppState>) -> Result<Value, String> {
    let (config, token) = {
        let mut sp = state.sp.lock().unwrap();
        maybe_load_persisted(&mut sp);
        let tok = sp.token.clone().ok_or("Not authenticated — complete the login flow first.")?;
        (sp.config.clone(), tok)
    };

    let client  = Client::new();
    let site_id = resolve_site_id(&client, &token.access_token, &config.site_url).await?;
    let items   = folder_items(&client, &token.access_token, &site_id, &config.folder_path).await?;

    let files: Vec<Value> = items
        .iter()
        .filter(|item| {
            item.get("file").is_some()
                && item.get("name")
                    .and_then(|v| v.as_str())
                    .map(|n| n.ends_with(".xlsx") || n.ends_with(".xls") || n.ends_with(".csv"))
                    .unwrap_or(false)
        })
        .map(|item| json!({
            "name":         item.get("name").and_then(|v| v.as_str()).unwrap_or(""),
            "size":         item.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
            "modified":     item.get("lastModifiedDateTime").and_then(|v| v.as_str()).unwrap_or(""),
            "download_url": item.get("@microsoft.graph.downloadUrl").and_then(|v| v.as_str()).unwrap_or(""),
        }))
        .collect();

    let count = files.len();
    Ok(json!({ "files": files, "count": count }))
}

/// Download xlsx / xls / csv files from SharePoint to the local output folder.
#[tauri::command]
pub async fn sp_sync_down(state: State<'_, AppState>) -> Result<Value, String> {
    let (config, token) = {
        let mut sp = state.sp.lock().unwrap();
        maybe_load_persisted(&mut sp);
        let tok = sp.token.clone().ok_or("Not authenticated.")?;
        (sp.config.clone(), tok)
    };
    let folder = state.output_folder().ok_or("No output folder configured. Set one in Settings first.")?;

    let client  = Client::new();
    let site_id = resolve_site_id(&client, &token.access_token, &config.site_url).await?;
    let items   = folder_items(&client, &token.access_token, &site_id, &config.folder_path).await?;

    let mut synced: Vec<String> = Vec::new();
    let mut errors: Vec<Value>  = Vec::new();

    for item in &items {
        if item.get("file").is_none() { continue; }
        let name = match item.get("name").and_then(|v| v.as_str()) {
            Some(n) if n.ends_with(".xlsx") || n.ends_with(".xls") || n.ends_with(".csv") => n.to_string(),
            _ => continue,
        };
        let url = match item.get("@microsoft.graph.downloadUrl").and_then(|v| v.as_str()) {
            Some(u) => u.to_string(),
            None    => { errors.push(json!({ "name": name, "error": "no download URL" })); continue; }
        };

        match client.get(&url).send().await {
            Ok(resp) => match resp.bytes().await {
                Ok(bytes) => {
                    let dest = PathBuf::from(&folder).join(&name);
                    if std::fs::write(&dest, &bytes).is_ok() {
                        synced.push(name);
                    } else {
                        errors.push(json!({ "name": name, "error": "write failed" }));
                    }
                }
                Err(e) => errors.push(json!({ "name": name, "error": e.to_string() })),
            },
            Err(e) => errors.push(json!({ "name": name, "error": e.to_string() })),
        }
    }

    Ok(json!({ "synced": synced, "errors": errors }))
}

/// Upload xlsx / csv files from the local output folder to SharePoint.
#[tauri::command]
pub async fn sp_sync_up(state: State<'_, AppState>) -> Result<Value, String> {
    let (config, token) = {
        let mut sp = state.sp.lock().unwrap();
        maybe_load_persisted(&mut sp);
        let tok = sp.token.clone().ok_or("Not authenticated.")?;
        (sp.config.clone(), tok)
    };
    let out_folder = state.output_folder().ok_or("No output folder configured.")?;

    let client   = Client::new();
    let site_id  = resolve_site_id(&client, &token.access_token, &config.site_url).await?;
    let sp_folder = config.folder_path.trim_matches('/').to_string();

    let mut uploaded: Vec<String> = Vec::new();
    let mut errors:   Vec<Value>  = Vec::new();

    let entries = std::fs::read_dir(&out_folder)
        .map_err(|e| format!("Read dir error: {e}"))?;

    for entry in entries.flatten() {
        let fname = entry.file_name().to_string_lossy().to_string();
        if !fname.ends_with(".xlsx") && !fname.ends_with(".csv") { continue; }

        let data = match std::fs::read(entry.path()) {
            Ok(d)  => d,
            Err(e) => { errors.push(json!({ "name": fname, "error": e.to_string() })); continue; }
        };

        let dest       = if sp_folder.is_empty() { format!("/{fname}") } else { format!("/{sp_folder}/{fname}") };
        let graph_path = format!("/sites/{site_id}/drive/root:{dest}:/content");

        match graph_put(&client, &token.access_token, &graph_path, data).await {
            Ok(_)  => uploaded.push(fname),
            Err(e) => errors.push(json!({ "name": fname, "error": e })),
        }
    }

    Ok(json!({ "uploaded": uploaded, "errors": errors }))
}
