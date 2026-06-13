// Address / place-name search for the maps (issues #294, #296).
//
// Forward-geocodes a free-text query, Denmark-first then global:
//   * Dataforsyningen / DAWA (no key) — the authoritative Danish source:
//       - /adresser/autocomplete  → street addresses (adresse.x=lon, .y=lat)
//       - /stednavne2             → place names (sted.visueltcenter=[lon,lat])
//   * Photon (OSM, photon.komoot.io, no key) — global fallback, queried only
//     when DAWA is sparse (an international query, or a thin Danish match) so
//     Danish results stay clean and the public instance isn't hit needlessly.
//
// Coordinates are requested/returned in WGS84 so the frontend can fly the
// Leaflet map straight to [lat, lng] regardless of the map's display grid.
// Everything is proxied through reqwest (like the WFS/WMS calls), so there are
// no webview CORS issues and only the typed query leaves the machine.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

const ADDR_URL: &str = "https://api.dataforsyningen.dk/adresser/autocomplete";
const PLACE_URL: &str = "https://api.dataforsyningen.dk/stednavne2";
const PHOTON_URL: &str = "https://photon.komoot.io/api/";

// Below this many Danish hits we treat the query as international / sparse and
// augment with the global source.
const DK_ENOUGH: usize = 6;
const MAX_HITS: usize = 10;

#[derive(Serialize)]
pub struct GeocodeHit {
    /// Human-readable label shown in the suggestion list.
    label: String,
    /// "address" | "place" — drives the suggestion icon.
    kind: String,
    lat: f64,
    lng: f64,
}

/// Autocomplete addresses + place names for `query`, Denmark-first then global.
/// Returns at most ~10 hits.  One source failing still returns the others';
/// only an all-empty result with at least one network error is an error.
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

    let mut errored = false;
    let mut out: Vec<GeocodeHit> = Vec::new();
    match addrs {
        Ok(h) => out.extend(h),
        Err(_) => errored = true,
    }
    match places {
        Ok(h) => out.extend(h),
        Err(_) => errored = true,
    }

    // Denmark is well covered by DAWA; only reach for the global source when
    // the Danish result is thin (international query or sparse match).
    if out.len() < DK_ENOUGH {
        let want = MAX_HITS.saturating_sub(out.len()).max(4);
        match fetch_photon(&client, &q, want).await {
            Ok(h) => out.extend(h),
            Err(_) => errored = true,
        }
    }

    out.truncate(MAX_HITS);
    if out.is_empty() && errored {
        return Err("Address search is unavailable (offline?).".into());
    }
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

/// Global fallback (Photon / OSM).  GeoJSON FeatureCollection: each feature has
/// `geometry.coordinates = [lon, lat]` and address `properties`.
async fn fetch_photon(client: &reqwest::Client, q: &str, limit: usize) -> Result<Vec<GeocodeHit>, String> {
    let v: Value = client
        .get(PHOTON_URL)
        .query(&[("q", q), ("limit", &limit.to_string())])
        .header("User-Agent", "GIRTool/1.0 (geotechnical desktop app)")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let mut hits = Vec::new();
    if let Some(feats) = v.get("features").and_then(|f| f.as_array()) {
        for f in feats {
            let coords = f
                .get("geometry")
                .and_then(|g| g.get("coordinates"))
                .and_then(|c| c.as_array());
            let lng = coords.and_then(|c| c.first()).and_then(|n| n.as_f64());
            let lat = coords.and_then(|c| c.get(1)).and_then(|n| n.as_f64());
            let p = f.get("properties");
            let (label, has_addr) = photon_label(p);
            if let (Some(lat), Some(lng)) = (lat, lng) {
                if !label.is_empty() {
                    hits.push(GeocodeHit {
                        label,
                        kind: if has_addr { "address" } else { "place" }.into(),
                        lat,
                        lng,
                    });
                }
            }
        }
    }
    Ok(hits)
}

fn prop(p: Option<&Value>, key: &str) -> Option<String> {
    p.and_then(|p| p.get(key))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Build a readable label from Photon address properties; the bool is whether
/// it's a precise street address (drives the address vs place icon).
fn photon_label(p: Option<&Value>) -> (String, bool) {
    let name = prop(p, "name");
    let street = prop(p, "street");
    let housenr = prop(p, "housenumber");
    let city = prop(p, "city");
    let state = prop(p, "state");
    let postcode = prop(p, "postcode");
    // Country can be multilingual ("Schweiz/Suisse/Svizzera/Svizra") — keep the
    // first segment.
    let country = prop(p, "country")
        .map(|c| c.split('/').next().unwrap_or(&c).trim().to_string())
        .filter(|s| !s.is_empty());

    let has_addr = street.is_some() && housenr.is_some();

    let primary = name
        .clone()
        .or_else(|| match (&street, &housenr) {
            (Some(s), Some(h)) => Some(format!("{s} {h}")),
            (Some(s), _) => Some(s.clone()),
            _ => None,
        })
        .or_else(|| city.clone())
        .or_else(|| state.clone())
        .unwrap_or_default();

    let locality = match &city {
        Some(c) if *c != primary => match &postcode {
            Some(pc) => format!("{pc} {c}"),
            None => c.clone(),
        },
        _ => match &state {
            Some(s) if *s != primary => s.clone(),
            _ => String::new(),
        },
    };

    let label = [primary, locality, country.unwrap_or_default()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    (label, has_addr)
}

#[cfg(test)]
mod tests {
    use super::photon_label;
    use serde_json::json;

    #[test]
    fn labels_a_street_address() {
        let p = json!({
            "street": "Bahnhofstrasse", "housenumber": "1",
            "postcode": "8001", "city": "Zürich",
            "country": "Schweiz/Suisse/Svizzera/Svizra"
        });
        let (label, addr) = photon_label(Some(&p));
        assert_eq!(label, "Bahnhofstrasse 1, 8001 Zürich, Schweiz");
        assert!(addr);
    }

    #[test]
    fn labels_a_city() {
        let p = json!({ "name": "Hamburg", "country": "Deutschland" });
        let (label, addr) = photon_label(Some(&p));
        assert_eq!(label, "Hamburg, Deutschland");
        assert!(!addr);
    }

    #[test]
    fn labels_a_named_poi() {
        let p = json!({
            "name": "Hauser & Wirth", "street": "Bahnhofstrasse", "housenumber": "1",
            "postcode": "8001", "city": "Zürich", "country": "Schweiz"
        });
        let (label, addr) = photon_label(Some(&p));
        assert_eq!(label, "Hauser & Wirth, 8001 Zürich, Schweiz");
        assert!(addr); // has street+housenumber → precise enough for the 🏠 icon
    }
}
