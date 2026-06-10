import { useEffect, useMemo } from 'react'
import { MapContainer, TileLayer, CircleMarker, Popup, LayersControl, useMap } from 'react-leaflet'
import { useFilter } from '../context/FilterContext'
import { toLatLng } from '../lib/proj'

// Issue #153 (M4.1) — selection map surface.
//
// Replaces the M3 scaffold in Data Selection → Map with a real Leaflet map that
// renders the selected projects' available points (FilterContext `allPoints`),
// each projected from its own Projection1 EPSG via the shared `lib/proj` helper.
//
// Deliberately lean: base layers + circle markers + popups + fit-to-bounds.
// The distinctive selection features arrive in later M4 slices:
//   M4.2 Jupiter WFS layer · M4.3 polygon multi-EPSG load · M4.4 red-ring
//   selection + source toggles + richer hover · M4.5 Map addons.

const { BaseLayer } = LayersControl

// Fit the view to the rendered points whenever their count changes.
function FitBounds({ pts }) {
  const map = useMap()
  useEffect(() => {
    if (!pts.length) return
    const lats = pts.map(p => p.latlng[0])
    const lngs = pts.map(p => p.latlng[1])
    map.fitBounds(
      [[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]],
      { padding: [40, 40], maxZoom: 16 },
    )
  }, [pts.length]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

export default function SelectionMap() {
  const { allPoints } = useFilter()

  // Project each point from its own Projection1 to lat/lng; drop ones we can't.
  const pts = useMemo(() => {
    if (!allPoints?.length) return []
    return allPoints
      .filter(p => p.X1 != null && p.Y1 != null)
      .map(p => {
        const latlng = toLatLng(Number(p.X1), Number(p.Y1), p.Projection1 ?? p.projection1)
        if (!latlng) return null
        return { id: `${p.db_id ?? '?'}_${p.PointId}`, latlng, p }
      })
      .filter(Boolean)
  }, [allPoints])

  return (
    <div className="page page-wide" style={{ display: 'flex', flexDirection: 'column' }}>
      <h2 className="page-title">Selection map</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Points from your selected projects. Polygon-driven loading, the Jupiter reference layer,
        and red-ring selection arrive in the next M4 slices.
      </p>

      {pts.length === 0 ? (
        <p className="hint">
          No points to show yet — select projects (and points) on the <strong>Projects</strong> /
          <strong> Points</strong> subtabs.
        </p>
      ) : (
        <div
          style={{
            height: '72vh', minHeight: 400, width: '100%',
            borderRadius: 8, overflow: 'hidden',
            border: '1px solid var(--border, #e2e8f0)',
          }}
        >
          <MapContainer center={[56, 10]} zoom={7} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
            <LayersControl position="topright">
              <BaseLayer checked name="OpenStreetMap">
                <TileLayer
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  attribution="&copy; OpenStreetMap contributors"
                />
              </BaseLayer>
              <BaseLayer name="Esri World Imagery">
                <TileLayer
                  url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                  attribution="Tiles &copy; Esri"
                />
              </BaseLayer>
            </LayersControl>

            <FitBounds pts={pts} />

            {pts.map(({ id, latlng, p }) => (
              <CircleMarker
                key={id}
                center={latlng}
                radius={6}
                pathOptions={{ color: '#fff', weight: 1.5, fillColor: '#2563eb', fillOpacity: 0.9 }}
              >
                <Popup>
                  <div style={{ fontSize: '.8rem', lineHeight: 1.5 }}>
                    <strong>{p.PointNo ?? p.PointId}</strong><br />
                    {p.PointType ? <>Type: {p.PointType}<br /></> : null}
                    DB: {p.db_id ?? '?'}<br />
                    {p.ProjectNo ? <>Project: {p.ProjectNo}<br /></> : null}
                    {p.Bottom != null ? <>Depth: {p.Bottom} m</> : null}
                  </div>
                </Popup>
              </CircleMarker>
            ))}
          </MapContainer>
        </div>
      )}
    </div>
  )
}
