// WFS proxy — forward WFS GetMap / GetFeature requests to external servers,
// bypassing WebView2 CORS restrictions.
//
// The frontend builds the full WFS URL (including all query-string parameters)
// and passes it here.  We fetch it server-side with a 30 s timeout, parse the
// response body as JSON, and return a serde_json::Value.
//
// MapPage.jsx accesses `gj.features`, `f.geometry`, `f.properties` directly on
// the returned value, so we must return a parsed object — not a raw string.
// (Tauri does not auto-parse string returns; without parsing here the frontend
// would silently see `undefined.features` and never render any points.)

use quick_xml::{events::Event, Reader};
use reqwest::Client;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// Forward a WFS request URL to the remote server and return the parsed JSON.
///
/// Sends `Accept: application/json` to match the Python backend
/// (`backend/routers/map.py`).  On a non-JSON response body the error message
/// includes the first 200 characters of the body so the user can see what the
/// server actually returned (e.g. an XML exception, an HTML error page).
#[tauri::command]
pub async fn wfs_proxy(url: String) -> Result<Value, String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client build failed: {e}"))?;

    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("WFS request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("WFS server returned HTTP {}", resp.status()));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read WFS response body: {e}"))?;

    serde_json::from_str::<Value>(&body).map_err(|e| {
        let preview: String = body.chars().take(200).collect();
        format!("WFS server returned non-JSON body ({e}): {preview}")
    })
}

/// Return the current OS user name.  Used (M4.2) to derive the COWI initials for
/// the Jupiter WMS `whoami=<initials>@cowi.com` parameter — COWI usernames are
/// the user's initials.  Best-effort: empty string if not determinable.
#[tauri::command]
pub fn os_username() -> String {
    std::env::var("USERNAME") // Windows
        .or_else(|_| std::env::var("USER")) // unix/mac
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Open an external URL in the OS default browser (M4.2: Jupiter feature's
/// `borerapport` link).  Uses the opener plugin so it opens outside the webview.
#[tauri::command]
pub async fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Failed to open URL: {e}"))
}

/// Strip any namespace prefix from a qualified XML name (`wms:Layer` → `Layer`).
fn local_name(qname: &[u8]) -> String {
    let s = String::from_utf8_lossy(qname);
    s.rsplit(':').next().unwrap_or(&s).to_string()
}

/// Parse WMS GetCapabilities XML → the requestable layers as (name, title).
/// A layer is requestable when it has a `<Name>` that's a direct child of
/// `<Layer>` (container layers without a Name are skipped).
fn parse_wms_layers(xml: &str) -> Vec<(String, String)> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut frames: Vec<(Option<String>, Option<String>)> = Vec::new();
    let mut capture: Option<u8> = None; // 1 = Name, 2 = Title
    let mut out: Vec<(String, String)> = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let n = local_name(e.name().as_ref());
                let parent_is_layer = stack.last().map(|s| s == "Layer").unwrap_or(false);
                if n == "Layer" {
                    frames.push((None, None));
                } else if n == "Name" && parent_is_layer {
                    capture = Some(1);
                } else if n == "Title" && parent_is_layer {
                    capture = Some(2);
                }
                stack.push(n);
            }
            Ok(Event::Text(t)) => {
                if let Some(which) = capture {
                    if let Some(frame) = frames.last_mut() {
                        let txt = t.unescape().unwrap_or_default().trim().to_string();
                        if which == 1 { frame.0 = Some(txt); } else { frame.1 = Some(txt); }
                    }
                }
            }
            Ok(Event::End(e)) => {
                let n = local_name(e.name().as_ref());
                stack.pop();
                if n == "Name" || n == "Title" { capture = None; }
                if n == "Layer" {
                    if let Some((Some(name), title)) = frames.pop() {
                        out.push((name, title.unwrap_or_default()));
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

/// Fetch a WMS service's GetCapabilities and return its requestable layers
/// (M4.5a) as `[{ name, title }]`, so the user can pick a layer instead of
/// typing it.  Preserves any query params already in `url`.
#[tauri::command]
pub async fn wms_capabilities(url: String) -> Result<Value, String> {
    let mut u = url.trim().to_string();
    if u.is_empty() {
        return Err("Enter a WMS service URL first.".into());
    }
    let lower = u.to_lowercase();
    let sep = if u.contains('?') { '&' } else { '?' };
    let mut extra: Vec<&str> = Vec::new();
    if !lower.contains("service=") { extra.push("SERVICE=WMS"); }
    if !lower.contains("request=") { extra.push("REQUEST=GetCapabilities"); }
    if !lower.contains("version=") { extra.push("VERSION=1.3.0"); }
    if !extra.is_empty() {
        u.push(sep);
        u.push_str(&extra.join("&"));
    }

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client build failed: {e}"))?;
    let resp = client
        .get(&u)
        .send()
        .await
        .map_err(|e| format!("WMS request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("WMS server returned HTTP {}", resp.status()));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read WMS response: {e}"))?;

    let layers = parse_wms_layers(&body);
    if layers.is_empty() {
        let preview: String = body.chars().take(160).collect();
        return Err(format!("No WMS layers found (is this a WMS endpoint?). Response began: {preview}"));
    }
    Ok(json!(layers
        .into_iter()
        .map(|(name, title)| json!({ "name": name, "title": title }))
        .collect::<Vec<_>>()))
}
