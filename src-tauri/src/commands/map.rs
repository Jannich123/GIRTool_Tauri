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

use reqwest::Client;
use serde_json::Value;

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
