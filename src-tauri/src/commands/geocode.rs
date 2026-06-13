// Address / place-name search for the maps (issue #294).
//
// Forward-geocodes a free-text query through Dataforsyningen / DAWA — the
// public Danish address & place-name API (no key, CORS-free because we proxy
// it through Rust like the WFS/WMS calls).  Two sources are merged:
//   * /adresser/autocomplete — street addresses (adresse.x = lon, .y = lat)
//   * /stednavne2            — place names (sted.visueltcenter = [lon, lat])
// Coordinates are requested in WGS84 (srid=4326) so the frontend can fly the
// Leaflet map straight to [lat, lng] regardless of the map's display grid.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

const ADDR_URL: &str = "https://api.dataforsyningen.dk/adresser/autocomplete";
const PLACE_URL: &str = "https://api.dataforsyningen.dk/stednavne2";

#[derive(Serialize)]
pub struct GeocodeHit {
    /// Human-readable label shown in the suggestion list.
    label: String,
    /// "address" | "place" — drives the suggestion icon.
    kind: String,
    lat: f64,
    lng: f64,
}

/// Autocomplete addresses + place names for `query`.  Returns at most ~10
/// hits, addresses first.  Empty for very short queries; a network failure of
/// ONE source still returns the other's hits.
#[tauri::command]
pub async fn geocode_search(query: String) -> Result<Vec<GeocodeHit>, String> {
    let q = query.trim().to_string();
    if q.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let (addrs, places) = tokio::join!(
        fetch_addresses(&client, &q),
        fetch_places(&client, &q),
    );

    // Only hard-fail when BOTH sources errored (offline / API down).
    if let (Err(a), Err(_)) = (&addrs, &places) {
        return Err(format!("Address search failed: {a}"));
    }

    let mut out: Vec<GeocodeHit> = Vec::new();
    out.extend(addrs.unwrap_or_default());
    out.extend(places.unwrap_or_default());
    out.truncate(10);
    Ok(out)
}

async fn fetch_addresses(client: &reqwest::Client, q: &str) -> Result<Vec<GeocodeHit>, String> {
    let v: Value = client
        .get(ADDR_URL)
        .query(&[("q", q), ("per_side", "6"), ("srid", "4326")])
        .header("User-Agent", "GIRTool")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let mut hits = Vec::new();
    if let Some(arr) = v.as_array() {
        for it in arr {
            let label = it.get("tekst").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
            let a = it.get("adresse");
            let lng = a.and_then(|a| a.get("x")).and_then(|n| n.as_f64());
            let lat = a.and_then(|a| a.get("y")).and_then(|n| n.as_f64());
            if let (Some(lat), Some(lng)) = (lat, lng) {
                if !label.is_empty() {
                    hits.push(GeocodeHit { label, kind: "address".into(), lat, lng });
                }
            }
        }
    }
    Ok(hits)
}

async fn fetch_places(client: &reqwest::Client, q: &str) -> Result<Vec<GeocodeHit>, String> {
    let v: Value = client
        .get(PLACE_URL)
        .query(&[("q", q), ("per_side", "5"), ("srid", "4326")])
        .header("User-Agent", "GIRTool")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let mut hits = Vec::new();
    if let Some(arr) = v.as_array() {
        for it in arr {
            let navn = it.get("navn").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
            let sted = it.get("sted");
            let center = sted
                .and_then(|s| s.get("visueltcenter"))
                .and_then(|c| c.as_array());
            let lng = center.and_then(|c| c.first()).and_then(|n| n.as_f64());
            let lat = center.and_then(|c| c.get(1)).and_then(|n| n.as_f64());
            // Disambiguate same-named places by their municipality when present.
            let kommune = sted
                .and_then(|s| s.get("kommuner"))
                .and_then(|k| k.as_array())
                .and_then(|k| k.first())
                .and_then(|k| k.get("navn"))
                .and_then(|n| n.as_str());
            if let (Some(lat), Some(lng)) = (lat, lng) {
                if !navn.is_empty() {
                    let label = match kommune {
                        Some(k) if !k.is_empty() => format!("{navn}, {k}"),
                        _ => navn,
                    };
                    hits.push(GeocodeHit { label, kind: "place".into(), lat, lng });
                }
            }
        }
    }
    Ok(hits)
}
