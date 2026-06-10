import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, CircleMarker, Popup, Tooltip, LayersControl, useMap, useMapEvents } from 'react-leaflet'
import { invoke } from '../tauri-api'
import { useFilter } from '../context/FilterContext'
import { reproject, toLatLng, pointToLatLng } from '../lib/proj'

// Issue #153 (M4.1) + #155 (M4.2) — selection map.
//
// Renders the selected projects' available points (FilterContext `allPoints`)
// over the live **Jupiter** reference layer.  Jupiter is fetched as a **WFS**
// (vector features with attributes, not a WMS image) so each borehole carries
// its data — hover shows DGU nr + depth, click opens its `borerapport` (plan
// §F1; per the user it's the same feature type QGIS consumes).  DB points draw
// on top of the (non-selectable) Jupiter reference.
//
// Later M4 slices: M4.3 polygon multi-EPSG load; M4.4 red-ring selection +
// source toggles.

const { BaseLayer } = LayersControl

// GEUS Jupiter WFS — feature type jupiter_lithologi_over_10m_dybe (WFS 1.0.0,
// geojson output, EPSG:25832).  Fetched via wfs_proxy (server-side, so http vs
// https / CORS don't matter; we use https).  BBOX-bounded + capped so we never
// pull all of Denmark; only loaded once zoomed in past JUPITER_MIN_ZOOM.
const JUPITER_WFS      = 'https://data.geus.dk/geusmap/ows/25832.jsp'
const JUPITER_TYPENAME = 'jupiter_lithologi_over_10m_dybe'
const JUPITER_MAX      = 2000
const JUPITER_MIN_ZOOM = 11

// Fit the view to the rendered DB points whenever their count changes.
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

// Live Jupiter WFS reference layer: refetches the current view's boreholes on
// pan/zoom (debounced), renders them as small grey markers under the DB points.
function JupiterLayer({ whoami, enabled, onStatus }) {
  const map = useMap()
  const [features, setFeatures] = useState([])
  const timer = useRef(null)
  const reqId = useRef(0)

  const fetchForBounds = useCallback(() => {
    if (!enabled) { setFeatures([]); onStatus?.(''); return }
    if (map.getZoom() < JUPITER_MIN_ZOOM) {
      setFeatures([]); onStatus?.('zoom in to load Jupiter boreholes')
      return
    }
    const b = map.getBounds()
    // Reproject the view corners (lng/lat) → EPSG:25832 for the WFS bbox.
    const sw = reproject(b.getWest(), b.getSouth(), 'EPSG:4326', 'EPSG:25832')
    const ne = reproject(b.getEast(), b.getNorth(), 'EPSG:4326', 'EPSG:25832')
    if (!sw || !ne) return
    const minx = Math.min(sw[0], ne[0]).toFixed(1), maxx = Math.max(sw[0], ne[0]).toFixed(1)
    const miny = Math.min(sw[1], ne[1]).toFixed(1), maxy = Math.max(sw[1], ne[1]).toFixed(1)
    const who = whoami ? `&whoami=${encodeURIComponent(whoami)}` : ''
    const url =
      `${JUPITER_WFS}?mapname=jupiter${who}` +
      `&service=WFS&version=1.0.0&request=GetFeature` +
      `&typename=${JUPITER_TYPENAME}&outputformat=geojson&srsname=EPSG:25832` +
      `&maxfeatures=${JUPITER_MAX}&bbox=${minx},${miny},${maxx},${maxy}`

    const myReq = ++reqId.current
    onStatus?.('loading…')
    invoke('wfs_proxy', { url })
      .then(gj => {
        if (myReq !== reqId.current) return // a newer request superseded this one
        const feats = (gj?.features || []).map(f => {
          const c = f.geometry?.coordinates
          if (!Array.isArray(c)) return null
          const latlng = toLatLng(Number(c[0]), Number(c[1]), 'EPSG:25832')
          if (!latlng) return null
          return { id: f.properties?.id_hidden ?? `${c[0]}_${c[1]}`, latlng, props: f.properties || {} }
        }).filter(Boolean)
        setFeatures(feats)
        const capped = feats.length >= JUPITER_MAX ? '+ (zoom in for all)' : ''
        onStatus?.(`${feats.length}${capped} borehole${feats.length === 1 ? '' : 's'} in view`)
      })
      .catch(err => {
        if (myReq !== reqId.current) return
        setFeatures([]); onStatus?.(`error: ${String(err).slice(0, 80)}`)
      })
  }, [map, enabled, whoami, onStatus])

  useMapEvents({
    moveend: () => { clearTimeout(timer.current); timer.current = setTimeout(fetchForBounds, 400) },
  })

  useEffect(() => {
    fetchForBounds()
    return () => clearTimeout(timer.current)
  }, [fetchForBounds])

  if (!enabled) return null
  return features.map(f => (
    <CircleMarker
      key={`j_${f.id}`}
      center={f.latlng}
      radius={4}
      pathOptions={{ color: '#475569', weight: 1, fillColor: '#cbd5e1', fillOpacity: 0.85 }}
      eventHandlers={{
        click: () => { if (f.props.borerapport) invoke('open_url', { url: f.props.borerapport }).catch(() => {}) },
      }}
    >
      <Tooltip>
        <span style={{ fontSize: '.75rem' }}>
          DGU {f.props.dgunr || '?'}{f.props.boringsdybde ? ` · ${f.props.boringsdybde} m` : ''} · click → borerapport
        </span>
      </Tooltip>
    </CircleMarker>
  ))
}

export default function SelectionMap() {
  const { allPoints } = useFilter()
  const [initials, setInitials] = useState('')
  const [showJupiter, setShowJupiter] = useState(true)
  const [jupiterStatus, setJupiterStatus] = useState('')

  // COWI initials for Jupiter's whoami param (OS username).
  useEffect(() => {
    invoke('os_username').then(u => setInitials((u || '').trim())).catch(() => {})
  }, [])
  const whoami = initials ? `${initials}@cowi.com` : ''

  // Project each selected-project point from its own Projection1 to lat/lng,
  // mirroring the Project map (per-point CRS + Danish fallback).
  const pts = useMemo(() => {
    if (!allPoints?.length) return []
    return allPoints
      .filter(p => p.X1 != null && p.Y1 != null)
      .map(p => {
        const latlng = pointToLatLng(p)
        if (!latlng) return null
        return { id: `${p.db_id ?? '?'}_${p.PointId}`, latlng, p }
      })
      .filter(Boolean)
  }, [allPoints])

  return (
    <div className="page page-wide" style={{ display: 'flex', flexDirection: 'column' }}>
      <h2 className="page-title">Selection map</h2>

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5rem' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem', fontSize: '.85rem' }}>
          <input type="checkbox" checked={showJupiter} onChange={e => setShowJupiter(e.target.checked)} />
          Jupiter reference (GEUS boreholes &gt; 10 m)
        </label>
        <span className="hint" style={{ margin: 0 }}>
          {showJupiter ? `Jupiter: ${jupiterStatus || '…'}` : 'Jupiter: off'}
          {pts.length ? ` · ${pts.length} selected-project point${pts.length === 1 ? '' : 's'}` : ''}
        </span>
      </div>

      <div
        style={{
          height: '72vh', minHeight: 400, width: '100%',
          borderRadius: 8, overflow: 'hidden',
          border: '1px solid var(--border, #e2e8f0)',
        }}
      >
        <MapContainer center={[56, 10]} zoom={7} scrollWheelZoom preferCanvas style={{ height: '100%', width: '100%' }}>
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

          {/* Jupiter reference — rendered first so the DB points draw on top. */}
          <JupiterLayer whoami={whoami} enabled={showJupiter} onStatus={setJupiterStatus} />

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
