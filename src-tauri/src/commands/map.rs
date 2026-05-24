// WFS proxy — forward WFS GetMap / GetFeature requests to external servers,
// bypassing WebView2 CORS restrictions.
//
// The frontend builds the full WFS URL (including all query-string parameters)
// and passes it here.  We fetch it server-side with a 30 s timeout and relay
// the raw response text (usually GeoJSON) back to the caller.

use reqwest::Client;

/// Forward a WFS request URL to the remote server and return the raw body.
#[tauri::command]
pub async fn wfs_proxy(url: String) -> Result<String, String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client build failed: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("WFS request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("WFS server returned HTTP {}", resp.status()));
    }

    resp.text()
        .await
        .map_err(|e| format!("Failed to read WFS response body: {e}"))
}
