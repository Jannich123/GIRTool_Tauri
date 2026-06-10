import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, CircleMarker, Polygon, Polyline, Popup, Tooltip, LayersControl, useMap, useMapEvents } from 'react-leaflet'
import { invoke } from '../tauri-api'
import { useFilter } from '../context/FilterContext'
import { reproject, toLatLng, pointToLatLng } from '../lib/proj'

// Issue #153 (M4.1) + #155 (M4.2) + #159 (M4.3) — selection map.
//
// Renders the selected projects' available points over the live Jupiter WFS
// reference layer, and (M4.3) loads *available* DB points inside the current
// view via a multi-EPSG spatial query — the first step of the polygon-driven
// loading (the polygon draw UI is M4.3b).
//
// Later: M4.3b polygon draw; M4.4 red-ring selection (click a loaded point →
// add it + its parent project to the Projects/Points subtabs).

const { BaseLayer } = LayersControl

// GEUS Jupiter WFS — feature type jupiter_lithologi_over_10m_dybe (WFS 1.0.0,
// geojson, EPSG:25832).  Fetched via wfs_proxy; bbox-bounded + capped; only at
// zoom ≥ JUPITER_MIN_ZOOM so it never pulls all of Denmark.
const JUPITER_WFS      = 'https://data.geus.dk/geusmap/ows/25832.jsp'
const JUPITER_TYPENAME = 'jupiter_lithologi_over_10m_dybe'
const JUPITER_MAX      = 2000
const JUPITER_MIN_ZOOM = 11

// Distinct colours for data sources (databases).  Assigned by the sorted db_id
// set so DB1/DB2/… stay consistent across renders.  Jupiter is grey.
const SOURCE_PALETTE = ['#2563eb', '#16a34a', '#db2777', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#dc2626']
const JUPITER_COLOR  = '#cbd5e1'

// Session-scoped memory of the selection map so leaving Data Selection (or its
// Map subtab) and returning restores the last view, loaded points, and toggles.
const mapStore = { view: null, loaded: [], showJupiter: true, loadStatus: '' }

// Fit the view to the rendered DB points whenever their count changes.
function FitBounds({ pts }) {
  const map = useMap()
  useEffect(() => {
    // Skip auto-fit once we have a remembered view — restore it instead.
    if (!pts.length || mapStore.view) return
    const lats = pts.map(p => p.latlng[0])
    const lngs = pts.map(p => p.latlng[1])
    map.fitBounds(
      [[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]],
      { padding: [40, 40], maxZoom: 16 },
    )
  }, [pts.length]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

// Capture the Leaflet map instance so the toolbar (outside MapContainer) can
// read the current bounds for the "load in view" query.
function MapRef({ onMap }) {
  const map = useMap()
  useEffect(() => { onMap(map) }, [map]) // eslint-disable-line react-hooks/exhaustive-deps
  // Remember the view so returning to the map restores the last zoom/centre.
  useMapEvents({
    moveend: () => {
      const c = map.getCenter()
      mapStore.view = { lat: c.lat, lng: c.lng, zoom: map.getZoom() }
    },
  })
  return null
}

// Polygon draw (M4.3b): while active, each map click drops a vertex.  Panning
// (drag) and scroll-zoom are unaffected — Leaflet only fires `click` on a plain
// click, so the in-progress polygon survives zoom/pan (plan Q-B1).
function DrawHandler({ active, onVertex }) {
  useMapEvents({
    click: (e) => { if (active) onVertex([e.latlng.lat, e.latlng.lng]) },
  })
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
        if (myReq !== reqId.current) return
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
  const [showJupiter, setShowJupiter] = useState(() => mapStore.showJupiter)
  const [jupiterStatus, setJupiterStatus] = useState('')

  // M4.3 — available points loaded inside the current view via the spatial query.
  const [map, setMap] = useState(null)
  const [loaded, setLoaded] = useState(() => mapStore.loaded)
  const [loadStatus, setLoadStatus] = useState(() => mapStore.loadStatus)
  const [loading, setLoading] = useState(false)

  // Polygon draw (M4.3b) — transient (not persisted).
  const [drawing, setDrawing] = useState(false)
  const [vertices, setVertices] = useState([]) // [[lat, lng], …]

  // Persist across unmount so returning to Data Selection restores this state.
  useEffect(() => { mapStore.showJupiter = showJupiter }, [showJupiter])
  useEffect(() => { mapStore.loaded = loaded }, [loaded])
  useEffect(() => { mapStore.loadStatus = loadStatus }, [loadStatus])

  useEffect(() => {
    invoke('os_username').then(u => setInitials((u || '').trim())).catch(() => {})
  }, [])
  const whoami = initials ? `${initials}@cowi.com` : ''

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

  // Assign each database (data source) a stable colour from the palette,
  // drawn from whatever db_ids are present across selected + loaded points.
  const dbColors = useMemo(() => {
    const ids = new Set()
    pts.forEach(f => { if (f.p.db_id) ids.add(f.p.db_id) })
    loaded.forEach(f => { if (f.p.db_id) ids.add(f.p.db_id) })
    const m = {}
    ;[...ids].sort().forEach((id, i) => { m[id] = SOURCE_PALETTE[i % SOURCE_PALETTE.length] })
    return m
  }, [pts, loaded])
  const colorFor = (dbId) => dbColors[dbId] || SOURCE_PALETTE[0]

  // Shared loader (M4.3a pipeline): given polygon vertices as [lng, lat] in
  // EPSG:4326, find each DB's coordinate systems, reproject the polygon into
  // each, run the spatial-intersect query, and render the results.  `merge`
  // adds to the loaded set (polygon "Add points"); otherwise it replaces it
  // (quick "Load in view").
  async function loadFromLngLat(points, { merge = false } = {}) {
    if (!points || points.length < 3) { setLoadStatus('need at least 3 points'); return }
    setLoading(true); setLoadStatus('finding coordinate systems…')
    try {
      const groups = await invoke('map_distinct_epsgs') // [{ db_id, epsgs }]
      const requests = []
      let skipped = 0
      for (const g of (groups || [])) {
        for (const epsg of (g.epsgs || [])) {
          const proj = points.map(([lng, lat]) => reproject(lng, lat, 'EPSG:4326', `EPSG:${epsg}`))
          if (proj.some(p => !p)) { skipped++; continue } // EPSG unknown to proj4
          const ring = proj.map(p => `${p[0]} ${p[1]}`).join(', ')
          const wkt = `POLYGON((${ring}, ${proj[0][0]} ${proj[0][1]}))`
          requests.push({ db_id: g.db_id, epsg, wkt })
        }
      }
      if (!requests.length) {
        setLoadStatus('no usable coordinate systems found in the configured databases')
        return
      }
      setLoadStatus('querying databases…')
      const rows = await invoke('map_polygon_points', { requests })
      const feats = (rows || []).map(p => {
        const latlng = toLatLng(Number(p.X1), Number(p.Y1), p.Projection1)
        if (!latlng) return null
        return { id: `${p.db_id ?? '?'}_${p.PointId}`, latlng, p }
      }).filter(Boolean)
      setLoaded(prev => {
        if (!merge) return feats
        const seen = new Set(prev.map(f => f.id))
        return [...prev, ...feats.filter(f => !seen.has(f.id))]
      })
      const skip = skipped ? ` · ${skipped} EPSG(s) skipped` : ''
      setLoadStatus(`${feats.length} available point${feats.length === 1 ? '' : 's'} found${skip}`)
    } catch (e) {
      setLoadStatus(`error: ${String(e).slice(0, 140)}`)
    } finally {
      setLoading(false)
    }
  }

  // Quick load: the current view rectangle (replaces the loaded set).
  function loadInView() {
    if (!map) return
    const b = map.getBounds()
    loadFromLngLat([
      [b.getWest(), b.getSouth()],
      [b.getEast(), b.getSouth()],
      [b.getEast(), b.getNorth()],
      [b.getWest(), b.getNorth()],
    ], { merge: false })
  }

  // Finish the drawn polygon: load points inside it, merged into the set.
  function finishPolygon() {
    if (vertices.length < 3) return
    const ring4326 = vertices.map(([lat, lng]) => [lng, lat]) // [lat,lng] → [lng,lat]
    setDrawing(false)
    setVertices([])
    loadFromLngLat(ring4326, { merge: true })
  }

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

      <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5rem' }}>
        {!drawing ? (
          <>
            <button className="btn-secondary" onClick={() => { setVertices([]); setDrawing(true) }} disabled={!map || loading}>
              ✏️ Draw polygon
            </button>
            <button className="btn-secondary" onClick={loadInView} disabled={!map || loading}>
              {loading ? 'Loading…' : '⬇ Load in view'}
            </button>
            {loaded.length > 0 && (
              <button className="btn-secondary" onClick={() => { setLoaded([]); setLoadStatus('') }} disabled={loading}>
                Clear loaded
              </button>
            )}
            {loadStatus && <span className="hint" style={{ margin: 0 }}>{loadStatus}</span>}
          </>
        ) : (
          <>
            <button className="btn-primary" onClick={finishPolygon} disabled={vertices.length < 3 || loading}>
              ✔ Add points{vertices.length ? ` (${vertices.length})` : ''}
            </button>
            <button className="btn-secondary" onClick={() => { setDrawing(false); setVertices([]) }} disabled={loading}>
              ✖ Cancel
            </button>
            <span className="hint" style={{ margin: 0 }}>
              Click the map to drop polygon vertices (zoom/pan freely) · <strong>Add points</strong> finishes &amp; loads inside it
            </span>
          </>
        )}
      </div>

      <div
        style={{
          position: 'relative',
          height: '70vh', minHeight: 400, width: '100%',
          borderRadius: 8, overflow: 'hidden',
          border: '1px solid var(--border, #e2e8f0)',
        }}
      >
        <MapContainer
          center={mapStore.view ? [mapStore.view.lat, mapStore.view.lng] : [56, 10]}
          zoom={mapStore.view ? mapStore.view.zoom : 7}
          scrollWheelZoom preferCanvas style={{ height: '100%', width: '100%' }}
        >
          <MapRef onMap={setMap} />
          <DrawHandler active={drawing} onVertex={(v) => setVertices(prev => [...prev, v])} />

          {/* In-progress draw polygon (M4.3b). */}
          {drawing && vertices.length >= 3 && (
            <Polygon positions={vertices} pathOptions={{ color: '#dc2626', weight: 2, dashArray: '5,5', fillColor: '#dc2626', fillOpacity: 0.08 }} />
          )}
          {drawing && vertices.length === 2 && (
            <Polyline positions={vertices} pathOptions={{ color: '#dc2626', weight: 2, dashArray: '5,5' }} />
          )}
          {drawing && vertices.map((v, i) => (
            <CircleMarker key={`v${i}`} center={v} radius={3} pathOptions={{ color: '#dc2626', weight: 2, fillColor: '#fff', fillOpacity: 1 }} />
          ))}

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

          {/* Jupiter reference — drawn first (under everything). */}
          <JupiterLayer whoami={whoami} enabled={showJupiter} onStatus={setJupiterStatus} />

          {/* M4.3 available points loaded in view — orange (not selectable yet). */}
          {loaded.map(({ id, latlng, p }) => (
            <CircleMarker
              key={`avail_${id}`}
              center={latlng}
              radius={5}
              // Available = hollow ring in the source colour (vs solid = selected).
              pathOptions={{ color: colorFor(p.db_id), weight: 2, fillColor: colorFor(p.db_id), fillOpacity: 0.2 }}
            >
              <Popup>
                <div style={{ fontSize: '.8rem', lineHeight: 1.5 }}>
                  <strong>{p.PointNo ?? p.PointId}</strong> <span className="hint">(available)</span><br />
                  {p.PointType ? <>Type: {p.PointType}<br /></> : null}
                  DB: {p.db_id ?? '?'} · EPSG {p.Projection1}
                </div>
              </Popup>
            </CircleMarker>
          ))}

          <FitBounds pts={pts} />

          {/* Selected-project points — blue, on top. */}
          {pts.map(({ id, latlng, p }) => (
            <CircleMarker
              key={id}
              center={latlng}
              radius={6}
              // Selected = solid fill in the source colour.
              pathOptions={{ color: '#fff', weight: 1.5, fillColor: colorFor(p.db_id), fillOpacity: 0.95 }}
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

        {(Object.keys(dbColors).length > 0 || showJupiter) && (
          <div
            style={{
              position: 'absolute', bottom: 12, left: 12, zIndex: 1000,
              background: 'rgba(255,255,255,0.94)', borderRadius: 6,
              padding: '.5rem .65rem', boxShadow: '0 1px 4px rgba(0,0,0,.25)',
              fontSize: '.75rem', lineHeight: 1.7, maxWidth: 220,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: '.15rem' }}>Data sources</div>
            {Object.entries(dbColors).map(([id, c]) => (
              <div key={id} style={{ display: 'flex', alignItems: 'center', gap: '.45rem' }}>
                <span style={{ width: 11, height: 11, borderRadius: '50%', background: c, boxShadow: '0 0 0 1px #fff, 0 0 0 2px #94a3b8', flex: '0 0 auto' }} />
                {id}
              </div>
            ))}
            {showJupiter && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '.45rem' }}>
                <span style={{ width: 11, height: 11, borderRadius: '50%', background: JUPITER_COLOR, boxShadow: '0 0 0 1px #fff, 0 0 0 2px #475569', flex: '0 0 auto' }} />
                Jupiter (GEUS)
              </div>
            )}
            {(pts.length > 0 || loaded.length > 0) && (
              <div className="hint" style={{ marginTop: '.3rem' }}>● selected · ○ available</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
