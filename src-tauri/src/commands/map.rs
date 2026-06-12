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

/// Cyklogram summary (#174).  GEUS's get_cyklogram.jsp redirects to the retired
/// Google Image Charts API (dead — 404s for everyone), so the image itself can
/// never load.  The redirect URL still carries the lithology data (`chd`
/// percentages + `chl` labels), so we fetch WITHOUT following the redirect,
/// read the Location header, and return the parsed groups/labels for a text
/// rendering in the tooltip.
#[tauri::command]
pub async fn cyklogram_summary(url: String) -> Result<Value, String> {
    let lower = url.to_lowercase();
    if !lower.starts_with("https://data.geus.dk/") && !lower.starts_with("http://data.geus.dk/") {
        return Err("Not a GEUS cyklogram URL.".into());
    }
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP client build failed: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Cyklogram request failed: {e}"))?;

    let Some(loc) = resp
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
    else {
        return Ok(json!({ "none": true }));
    };
    let Ok(parsed) = reqwest::Url::parse(&loc) else {
        return Ok(json!({ "none": true }));
    };

    let mut chd: Option<String> = None;
    let mut chl: Option<String> = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "chd" => chd = Some(v.into_owned()),
            "chl" => chl = Some(v.into_owned()),
            _ => {}
        }
    }
    let (Some(chd), Some(chl)) = (chd, chl) else {
        return Ok(json!({ "none": true }));
    };

    // chd = "t:100|96.8,3,.2,0|17.2,…" → groups of slice percentages;
    // chl = "||sand|tørv|…" → labels assigned to slices in order (Google
    // semantics: left-aligned across all series; unlabeled slices are filler).
    let groups: Vec<Vec<f64>> = chd
        .trim_start_matches("t:")
        .split('|')
        .map(|g| g.split(',').filter_map(|s| s.trim().parse::<f64>().ok()).collect())
        .collect();
    let labels: Vec<String> = chl.split('|').map(|s| s.trim().to_string()).collect();
    Ok(json!({ "groups": groups, "labels": labels }))
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

// ── WMTS capabilities (#230) ─────────────────────────────────────────────────

#[derive(Default)]
struct WmtsLayerInfo {
    id:      Option<String>,
    title:   Option<String>,
    formats: Vec<String>,
    styles:  Vec<String>,
    tms:     Vec<String>,
}

/// Parse a WMTS 1.0.0 GetCapabilities: per-layer identifier/title/formats/
/// styles/matrix-set links, plus the Contents-level TileMatrixSet definitions
/// with their CRS (needed to find a web-mercator grid).  Namespace prefixes
/// (ows:) are stripped by `local_name`.
fn parse_wmts_capabilities(xml: &str) -> (Vec<WmtsLayerInfo>, Vec<(String, String)>) {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut layers: Vec<WmtsLayerInfo> = Vec::new();
    let mut in_layer = false;
    // Contents-level TileMatrixSet definition currently open: (id, crs).
    let mut tms_frame: Option<(Option<String>, Option<String>)> = None;
    let mut sets: Vec<(String, String)> = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let n = local_name(e.name().as_ref());
                let parent = stack.last().map(String::as_str).unwrap_or("");
                if n == "Layer" && parent == "Contents" {
                    layers.push(WmtsLayerInfo::default());
                    in_layer = true;
                } else if n == "TileMatrixSet" && parent == "Contents" {
                    tms_frame = Some((None, None));
                }
                stack.push(n);
            }
            Ok(Event::Text(t)) => {
                let txt = t.unescape().unwrap_or_default().trim().to_string();
                if txt.is_empty() {
                    buf.clear();
                    continue;
                }
                let len = stack.len();
                let tail = stack.last().map(String::as_str).unwrap_or("");
                let parent = if len >= 2 { stack[len - 2].as_str() } else { "" };
                let grand = if len >= 3 { stack[len - 3].as_str() } else { "" };
                if in_layer {
                    if let Some(layer) = layers.last_mut() {
                        match (tail, parent, grand) {
                            ("Identifier", "Layer", _) => layer.id = Some(txt),
                            ("Title", "Layer", _) => layer.title = Some(txt),
                            ("Format", "Layer", _) => layer.formats.push(txt),
                            ("Identifier", "Style", "Layer") => layer.styles.push(txt),
                            ("TileMatrixSet", "TileMatrixSetLink", _) => layer.tms.push(txt),
                            _ => {}
                        }
                    }
                } else if let Some(frame) = tms_frame.as_mut() {
                    // Direct children of the Contents-level TileMatrixSet only —
                    // TileMatrix children carry their own Identifier (zoom level).
                    match (tail, parent) {
                        ("Identifier", "TileMatrixSet") => frame.0 = Some(txt),
                        ("SupportedCRS", "TileMatrixSet") => frame.1 = Some(txt),
                        _ => {}
                    }
                }
            }
            Ok(Event::End(e)) => {
                let n = local_name(e.name().as_ref());
                stack.pop();
                let parent = stack.last().map(String::as_str).unwrap_or("");
                if n == "Layer" && parent == "Contents" {
                    in_layer = false;
                } else if n == "TileMatrixSet" && parent == "Contents" {
                    if let Some((Some(id), crs)) = tms_frame.take() {
                        sets.push((id, crs.unwrap_or_default()));
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    layers.retain(|l| l.id.is_some());
    (layers, sets)
}

/// #230: fetch a WMTS GetCapabilities and return its layers (identifier,
/// title, formats, styles, matrix-set links) plus every TileMatrixSet with
/// its CRS — the Settings tab uses the CRS to pick a web-mercator grid (and
/// to refuse clearly when none exists, e.g. the EPSG:25832-only Danish
/// services).
#[tauri::command]
pub async fn wmts_capabilities(url: String) -> Result<Value, String> {
    let mut u = url.trim().to_string();
    if u.is_empty() {
        return Err("Enter a WMTS service URL first.".into());
    }
    let lower = u.to_lowercase();
    let sep = if u.contains('?') { '&' } else { '?' };
    let mut extra: Vec<&str> = Vec::new();
    if !lower.contains("service=") { extra.push("SERVICE=WMTS"); }
    if !lower.contains("request=") { extra.push("REQUEST=GetCapabilities"); }
    if !lower.contains("version=") { extra.push("VERSION=1.0.0"); }
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
        .map_err(|e| format!("WMTS request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("WMTS server returned HTTP {}", resp.status()));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read WMTS response: {e}"))?;

    let (layers, sets) = parse_wmts_capabilities(&body);
    if layers.is_empty() {
        let preview: String = body.chars().take(160).collect();
        return Err(format!("No WMTS layers found (is this a WMTS endpoint?). Response began: {preview}"));
    }
    Ok(json!({
        "layers": layers.into_iter().map(|l| json!({
            "name":    l.id.unwrap_or_default(),
            "title":   l.title.unwrap_or_default(),
            "formats": l.formats,
            "styles":  l.styles,
            "tms":     l.tms,
        })).collect::<Vec<_>>(),
        "matrix_sets": sets.into_iter().map(|(id, crs)| json!({ "id": id, "crs": crs })).collect::<Vec<_>>(),
    }))
}
