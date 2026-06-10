import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, WMSTileLayer, CircleMarker, Popup, LayersControl, useMap } from 'react-leaflet'
import { invoke } from '../tauri-api'
import { useFilter } from '../context/FilterContext'
import { pointToLatLng } from '../lib/proj'

// Issue #153 (M4.1) + #155 (M4.2) — selection map.
//
// Renders the selected projects' available points (FilterContext `allPoints`),
// each projected from its own Projection1 EPSG, over the live **Jupiter**
// reference layer (GEUS WMS).  The map always renders (Jupiter shows even with
// no selection — plan §F1); DB points draw on top of Jupiter (Leaflet pane
// z-order: markers > tile overlays).
//
// Later M4 slices: M4.2b Jupiter click → borerapport (WMS GetFeatureInfo);
// M4.3 polygon multi-EPSG load; M4.4 red-ring selection + source toggles.

const { BaseLayer, Overlay } = LayersControl

// Verified endpoint: ows/3857.jsp serves the jupiter map in EPSG:3857 (Leaflet
// CRS); GetMap of this layer returns image/png.  HTTPS is required — the webview
// runs in a secure context and blocks http tiles as mixed content.
// `whoami=<initials>@cowi.com` follows the COWI convention (initials = OS user).
const JUPITER_BASE  = 'https://data.geus.dk/geusmap/ows/3857.jsp'
const JUPITER_LAYER = 'jupiter_lithologi_over_10m_dybe'

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
  const [initials, setInitials] = useState('')

  // COWI initials for Jupiter's whoami param (OS username).
  useEffect(() => {
    invoke('os_username').then(u => setInitials((u || '').trim())).catch(() => {})
  }, [])

  const jupiterUrl = useMemo(() => {
    const who = initials ? `&whoami=${encodeURIComponent(`${initials}@cowi.com`)}` : ''
    return `${JUPITER_BASE}?mapname=jupiter${who}`
  }, [initials])

  // Project each point from its own Projection1 to lat/lng; drop ones we can't.
  const pts = useMemo(() => {
    if (!allPoints?.length) return []
    return allPoints
      .filter(p => p.X1 != null && p.Y1 != null)
      .map(p => {
        // Same projection path as the Project map: per-point Projection1 with a
        // Danish-default fallback so points are never silently dropped.
        const latlng = pointToLatLng(p)
        if (!latlng) return null
        return { id: `${p.db_id ?? '?'}_${p.PointId}`, latlng, p }
      })
      .filter(Boolean)
  }, [allPoints])

  return (
    <div className="page page-wide" style={{ display: 'flex', flexDirection: 'column' }}>
      <h2 className="page-title">Selection map</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        {pts.length
          ? `Showing ${pts.length} point${pts.length === 1 ? '' : 's'} from your selected projects, over the live Jupiter reference layer.`
          : 'Jupiter reference layer shown. Select projects on the Projects subtab to plot their points; polygon loading and click-through arrive in the next M4 slices.'}
      </p>

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

            <Overlay checked name="Jupiter (GEUS boreholes > 10 m)">
              <WMSTileLayer
                url={jupiterUrl}
                layers={JUPITER_LAYER}
                format="image/png"
                transparent
                version="1.3.0"
                attribution="Jupiter &copy; GEUS"
              />
            </Overlay>
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
    </div>
  )
}
