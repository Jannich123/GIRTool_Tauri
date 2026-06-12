// Shared map geometry helpers (#262 — moved from SelectionMap so the Project
// map's grouping mode can reuse them).

// Ray-casting point-in-polygon for [lat, lng] coordinates (lng = x, lat = y).
export function pointInPolygonLatLng(ll, poly) {
  const px = ll[1], py = ll[0]
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][1], yi = poly[i][0]
    const xj = poly[j][1], yj = poly[j][0]
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}

// Outer ring of a clicked addon (sub-)polygon as unclosed [[lat, lng], …] —
// the same shape as hand-drawn vertices.  Addon GeoJSON is reprojected to
// EPSG:4326 at load time, so coordinates arrive as [lng, lat].  For a
// MultiPolygon the sub-polygon containing the click wins (fallback: the ring
// with the most vertices).
export function ringFromFeature(feature, clickLatLng) {
  const g = feature?.geometry
  if (!g) return null
  const toLatLngRing = (ring) => {
    const out = (ring || []).map(([lng, lat]) => [lat, lng])
    if (out.length > 1) {
      const [f, l] = [out[0], out[out.length - 1]]
      if (f[0] === l[0] && f[1] === l[1]) out.pop() // drop the closing vertex
    }
    return out
  }
  if (g.type === 'Polygon') {
    const r = toLatLngRing(g.coordinates?.[0])
    return r.length >= 3 ? r : null
  }
  if (g.type === 'MultiPolygon') {
    const rings = (g.coordinates || []).map(c => toLatLngRing(c?.[0])).filter(r => r.length >= 3)
    if (!rings.length) return null
    if (clickLatLng) {
      const ll = [clickLatLng.lat, clickLatLng.lng]
      const hit = rings.find(r => pointInPolygonLatLng(ll, r))
      if (hit) return hit
    }
    return rings.reduce((a, b) => (b.length > a.length ? b : a))
  }
  return null
}
