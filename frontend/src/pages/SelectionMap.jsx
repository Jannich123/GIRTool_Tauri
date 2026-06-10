import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, CircleMarker, Polygon, Polyline, Tooltip, LayersControl, useMap, useMapEvents } from 'react-leaflet'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'
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
const mapStore = { view: null, loaded: [], showJupiter: true, loadStatus: '', hiddenDbs: [] }

// Ray-casting point-in-polygon for [lat, lng] coordinates (lng = x, lat = y).
function pointInPolygonLatLng(ll, poly) {
  const px = ll[1], py = ll[0]
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][1], yi = poly[i][0]
    const xj = poly[j][1], yj = poly[j][0]
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}

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
  const map = useMap()
  useMapEvents({
    click: (e) => { if (active) onVertex([e.latlng.lat, e.latlng.lng]) },
  })
  // While drawing, make existing markers/paths non-interactive (overlay pane
  // pointer-events off) so a click only drops a vertex — never opens a popup or
  // a Jupiter borerapport — and show a crosshair cursor.
  useEffect(() => {
    const pane = map.getPane('overlayPane')
    const container = map.getContainer()
    if (pane) pane.style.pointerEvents = active ? 'none' : ''
    if (container) container.style.cursor = active ? 'crosshair' : ''
    return () => {
      if (pane) pane.style.pointerEvents = ''
      if (container) container.style.cursor = ''
    }
  }, [active, map])
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
  const { selectedPoints, setSelectedPoints, selectedProjects, setSelectedProjects } = useApp()
  const [initials, setInitials] = useState('')
  const [showJupiter, setShowJupiter] = useState(() => mapStore.showJupiter)
  const [jupiterStatus, setJupiterStatus] = useState('')

  // M4.3 — available points loaded inside the current view via the spatial query.
  const [map, setMap] = useState(null)
  const [loaded, setLoaded] = useState(() => mapStore.loaded)
  const [loadStatus, setLoadStatus] = useState(() => mapStore.loadStatus)
  const [loading, setLoading] = useState(false)

  // Hidden data sources (M4.4b) — db_ids whose points are toggled off.
  const [hiddenDbs, setHiddenDbs] = useState(() => new Set(mapStore.hiddenDbs))

  // Polygon draw (M4.3b) — transient (not persisted).
  const [drawing, setDrawing] = useState(false)
  const [vertices, setVertices] = useState([]) // [[lat, lng], …]

  // Persist across unmount so returning to Data Selection restores this state.
  useEffect(() => { mapStore.showJupiter = showJupiter }, [showJupiter])
  useEffect(() => { mapStore.loaded = loaded }, [loaded])
  useEffect(() => { mapStore.loadStatus = loadStatus }, [loadStatus])
  useEffect(() => { mapStore.hiddenDbs = [...hiddenDbs] }, [hiddenDbs])

  const toggleDb = (dbId) => setHiddenDbs(prev => {
    const next = new Set(prev)
    if (next.has(dbId)) next.delete(dbId); else next.add(dbId)
    return next
  })

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

  // ── Selection from the map (M4.4a) ──────────────────────────────────────────
  // Project index for resolving a clicked point's parent project.
  const projIndex = useRef({})
  useEffect(() => {
    invoke('list_projects')
      .then(rows => {
        const idx = {}
        for (const r of (rows || [])) idx[`${r.db_id ?? '?'}||${r.ProjectId}`] = r
        projIndex.current = idx
      })
      .catch(() => {})
  }, [])

  const selectedIds = useMemo(
    () => new Set((selectedPoints || []).map(p => `${p.db_id ?? '?'}_${p.PointId}`)),
    [selectedPoints],
  )
  const ptIdSet = useMemo(() => new Set(pts.map(f => f.id)), [pts])

  // Toggle a clicked point in/out of the selection; selecting also ensures its
  // parent project is selected so the Projects/Points subtabs populate (Q-B2).
  function toggleSelect(p) {
    const id = `${p.db_id ?? '?'}_${p.PointId}`
    if (selectedIds.has(id)) {
      setSelectedPoints((selectedPoints || []).filter(sp => `${sp.db_id ?? '?'}_${sp.PointId}` !== id))
      return
    }
    setSelectedPoints([...(selectedPoints || []), p])
    const pk = `${p.db_id ?? '?'}||${p.ProjectId}`
    const proj = projIndex.current[pk]
    if (proj && !(selectedProjects || []).some(sp => `${sp.db_id ?? '?'}||${sp.ProjectId}` === pk)) {
      setSelectedProjects([...(selectedProjects || []), proj])
    }
  }

  // Visible points (loaded ∪ selected-project) that are selected → red ring.
  const ringPoints = useMemo(() => {
    const byId = new Map()
    pts.forEach(f => byId.set(f.id, f))
    loaded.forEach(f => { if (!byId.has(f.id)) byId.set(f.id, f) })
    return [...byId.values()].filter(f => selectedIds.has(f.id) && !hiddenDbs.has(f.p.db_id))
  }, [pts, loaded, selectedIds, hiddenDbs])

  // Shared loader (M4.3a pipeline): given polygon vertices as [lng, lat] in
  // EPSG:4326, find each DB's coordinate systems, reproject the polygon into
  // each, run the spatial-intersect query, and render the results.  `merge`
  // adds to the loaded set (polygon "Add points"); otherwise it replaces it
  // (quick "Load in view").
  // Shared spatial query: polygon vertices as [lng, lat] in EPSG:4326 →
  // reproject into each DB's coordinate systems → points inside.
  async function queryPointsInPolygon(points) {
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
    if (!requests.length) return { feats: [], skipped, noEpsg: true }
    const rows = await invoke('map_polygon_points', { requests })
    const feats = (rows || []).map(p => {
      const latlng = toLatLng(Number(p.X1), Number(p.Y1), p.Projection1)
      if (!latlng) return null
      return { id: `${p.db_id ?? '?'}_${p.PointId}`, latlng, p }
    }).filter(Boolean)
    return { feats, skipped, noEpsg: false }
  }

  // Load available points inside the region (orange), de-duped against the map.
  async function loadInside(points) {
    if (!points || points.length < 3) return
    setLoading(true); setLoadStatus('querying databases…')
    try {
      const { feats, skipped, noEpsg } = await queryPointsInPolygon(points)
      if (noEpsg) { setLoadStatus('no usable coordinate systems found in the configured databases'); return }
      const onMap = new Set([...loaded.map(f => f.id), ...pts.map(f => f.id)])
      const fresh = feats.filter(f => !onMap.has(f.id))
      setLoaded(prev => {
        const seen = new Set([...prev.map(f => f.id), ...pts.map(f => f.id)])
        return [...prev, ...feats.filter(f => !seen.has(f.id))]
      })
      const dup  = (feats.length - fresh.length) ? ` · ${feats.length - fresh.length} already on map` : ''
      const skip = skipped ? ` · ${skipped} EPSG(s) skipped` : ''
      setLoadStatus(`${fresh.length} new point${fresh.length === 1 ? '' : 's'} loaded${dup}${skip}`)
    } catch (e) {
      setLoadStatus(`error: ${String(e).slice(0, 140)}`)
    } finally {
      setLoading(false)
    }
  }

  // Select every DB point inside the region, adding their parent projects (Q-B2).
  async function selectInside(points) {
    if (!points || points.length < 3) return
    setLoading(true); setLoadStatus('querying databases…')
    try {
      const { feats, skipped, noEpsg } = await queryPointsInPolygon(points)
      if (noEpsg) { setLoadStatus('no usable coordinate systems found in the configured databases'); return }
      const have = new Set((selectedPoints || []).map(p => `${p.db_id ?? '?'}_${p.PointId}`))
      const toAdd = feats.filter(f => !have.has(f.id))
      if (toAdd.length) {
        setSelectedPoints([...(selectedPoints || []), ...toAdd.map(f => f.p)])
        const projKeys = new Set((selectedProjects || []).map(sp => `${sp.db_id ?? '?'}||${sp.ProjectId}`))
        const newProjs = []
        for (const f of toAdd) {
          const pk = `${f.p.db_id ?? '?'}||${f.p.ProjectId}`
          if (!projKeys.has(pk) && projIndex.current[pk]) { projKeys.add(pk); newProjs.push(projIndex.current[pk]) }
        }
        if (newProjs.length) setSelectedProjects([...(selectedProjects || []), ...newProjs])
      }
      const skip = skipped ? ` · ${skipped} EPSG(s) skipped` : ''
      setLoadStatus(`${toAdd.length} point${toAdd.length === 1 ? '' : 's'} selected${skip}`)
    } catch (e) {
      setLoadStatus(`error: ${String(e).slice(0, 140)}`)
    } finally {
      setLoading(false)
    }
  }

  // Remove every selected point inside the polygon (client-side, no query).
  function removeInside(polyLatLng) {
    const before = (selectedPoints || []).length
    const kept = (selectedPoints || []).filter(p => {
      const ll = pointToLatLng(p)
      return ll ? !pointInPolygonLatLng(ll, polyLatLng) : true
    })
    setSelectedPoints(kept)
    setLoadStatus(`${before - kept.length} point${before - kept.length === 1 ? '' : 's'} removed from selection`)
  }

  // Quick load: every available point inside the current view rectangle.
  function loadInView() {
    if (!map) return
    const b = map.getBounds()
    loadInside([
      [b.getWest(), b.getSouth()],
      [b.getEast(), b.getSouth()],
      [b.getEast(), b.getNorth()],
      [b.getWest(), b.getNorth()],
    ])
  }

  // Apply a finished polygon: load / select / remove the points inside it.
  function applyPolygon(action) {
    if (vertices.length < 3) return
    const polyLatLng = vertices                              // [[lat, lng], …]
    const ring4326 = vertices.map(([lat, lng]) => [lng, lat]) // → [lng, lat]
    setDrawing(false)
    setVertices([])
    if (action === 'load') loadInside(ring4326)
    else if (action === 'select') selectInside(ring4326)
    else if (action === 'remove') removeInside(polyLatLng)
  }

  return (
    <div className="page page-wide" style={{ display: 'flex', flexDirection: 'column' }}>
      <h2 className="page-title">Selection map</h2>

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5rem' }}>
        <span className="hint" style={{ margin: 0 }}>
          {showJupiter ? `Jupiter: ${jupiterStatus || '…'}` : 'Jupiter: off'}
          {pts.length ? ` · ${pts.length} selected-project point${pts.length === 1 ? '' : 's'}` : ''}
          {' · toggle sources in the map legend (bottom-left)'}
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
            <button className="btn-secondary" onClick={() => applyPolygon('load')} disabled={vertices.length < 3 || loading}>
              ⬇ Load{vertices.length ? ` (${vertices.length})` : ''}
            </button>
            <button className="btn-primary" onClick={() => applyPolygon('select')} disabled={vertices.length < 3 || loading}>
              ✚ Select inside
            </button>
            <button className="btn-secondary" onClick={() => applyPolygon('remove')} disabled={vertices.length < 3 || loading}>
              ✖ Remove inside
            </button>
            <button className="btn-secondary" onClick={() => { setDrawing(false); setVertices([]) }} disabled={loading}>
              Cancel
            </button>
            <span className="hint" style={{ margin: 0 }}>
              Click to drop vertices (zoom/pan freely), then <strong>Load</strong> / <strong>Select</strong> / <strong>Remove</strong> inside
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
          {loaded.filter(f => !ptIdSet.has(f.id) && !hiddenDbs.has(f.p.db_id)).map(({ id, latlng, p }) => (
            <CircleMarker
              key={`avail_${id}`}
              center={latlng}
              radius={5}
              // Available = hollow ring in the source colour.  Click to select.
              pathOptions={{ color: colorFor(p.db_id), weight: 2, fillColor: colorFor(p.db_id), fillOpacity: 0.2 }}
              eventHandlers={{ click: () => toggleSelect(p) }}
            >
              <Tooltip>
                <span style={{ fontSize: '.75rem' }}>
                  {p.PointNo ?? p.PointId} · {p.PointType || '—'} · {p.db_id ?? '?'} · click to {selectedIds.has(id) ? 'deselect' : 'select'}
                </span>
              </Tooltip>
            </CircleMarker>
          ))}

          <FitBounds pts={pts} />

          {/* Selected-project points — blue, on top. */}
          {pts.filter(f => !hiddenDbs.has(f.p.db_id)).map(({ id, latlng, p }) => (
            <CircleMarker
              key={id}
              center={latlng}
              radius={6}
              // Selected-project point, solid fill in the source colour.  Click to select.
              pathOptions={{ color: '#fff', weight: 1.5, fillColor: colorFor(p.db_id), fillOpacity: 0.95 }}
              eventHandlers={{ click: () => toggleSelect(p) }}
            >
              <Tooltip>
                <span style={{ fontSize: '.75rem' }}>
                  {p.PointNo ?? p.PointId} · {p.PointType || '—'} · {p.db_id ?? '?'}{p.ProjectNo ? ` · ${p.ProjectNo}` : ''} · click to {selectedIds.has(id) ? 'deselect' : 'select'}
                </span>
              </Tooltip>
            </CircleMarker>
          ))}

          {/* Red ring on selected points (M4.4a) — non-interactive so clicks
              reach the underlying point. */}
          {ringPoints.map(f => (
            <CircleMarker
              key={`ring_${f.id}`}
              center={f.latlng}
              radius={9}
              interactive={false}
              pathOptions={{ color: '#dc2626', weight: 2.5, fill: false }}
            />
          ))}
        </MapContainer>

        {/* Source panel (M4.4b): a checkbox per data source toggles its points. */}
        <div
          style={{
            position: 'absolute', bottom: 12, left: 12, zIndex: 1000,
            background: 'rgba(255,255,255,0.94)', borderRadius: 6,
            padding: '.5rem .65rem', boxShadow: '0 1px 4px rgba(0,0,0,.25)',
            fontSize: '.75rem', lineHeight: 1.7, maxWidth: 240,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: '.15rem' }}>Data sources</div>
          {Object.entries(dbColors).map(([id, c]) => (
            <label key={id} style={{ display: 'flex', alignItems: 'center', gap: '.45rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={!hiddenDbs.has(id)} onChange={() => toggleDb(id)} />
              <span style={{ width: 11, height: 11, borderRadius: '50%', background: c, boxShadow: '0 0 0 1px #fff, 0 0 0 2px #94a3b8', flex: '0 0 auto' }} />
              {id}
            </label>
          ))}
          <label style={{ display: 'flex', alignItems: 'center', gap: '.45rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={showJupiter} onChange={e => setShowJupiter(e.target.checked)} />
            <span style={{ width: 11, height: 11, borderRadius: '50%', background: JUPITER_COLOR, boxShadow: '0 0 0 1px #fff, 0 0 0 2px #475569', flex: '0 0 auto' }} />
            Jupiter (GEUS)
          </label>
          {(pts.length > 0 || loaded.length > 0) && (
            <div className="hint" style={{ marginTop: '.3rem' }}>● in project · ○ available · ⭕ selected</div>
          )}
        </div>
      </div>
    </div>
  )
}
