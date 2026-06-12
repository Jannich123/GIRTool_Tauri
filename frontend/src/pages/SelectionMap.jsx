import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, CircleMarker, Polygon, Polyline, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import { invoke } from '../tauri-api'
import { useDataChanged } from '../lib/dataChanged'
import { useApp } from '../context/AppContext'
import { useFilter } from '../context/FilterContext'
import { reproject, toLatLng, pointToLatLng, convertPoint, normaliseEpsg, CRS_LABELS } from '../lib/proj'
import AddonLayers from '../components/AddonLayers'
import AddonControl from '../components/AddonControl'
import CrsCursorReadout from '../components/CrsCursorReadout'
import { CRS_DK, DK_MAX_ZOOM, DK_CENTER, DK_DEFAULT_ZOOM, clampDkZoom, mapGridFor, clampMercZoom, MERC_DEFAULT_ZOOM } from '../lib/crsDk'

// Issue #153 (M4.1) + #155 (M4.2) + #159 (M4.3) — selection map.
//
// Renders the selected projects' available points over the live Jupiter WFS
// reference layer, and (M4.3) loads *available* DB points inside the current
// view via a multi-EPSG spatial query — the first step of the polygon-driven
// loading (the polygon draw UI is M4.3b).
//
// Later: M4.3b polygon draw; M4.4 red-ring selection (click a loaded point →
// add it + its parent project to the Projects/Points subtabs).

// Jupiter boreholes (#174) — the comprehensive jupiter_boringer_ws layer (all
// Danish boreholes with owner / terrænkote / purpose / cyklogram / borerapport),
// loaded PER REGION with the same Load buttons as the DB sources (view
// rectangle or drawn polygon).  No auto-fetch on pan.  Only three purpose
// categories are kept — everything else is dropped at load time (verified
// `formaal` codes from live data; GEUS's vendor filter param is ignored
// server-side, so filtering happens client-side after the bbox fetch).
const JUPITER_WFS       = 'https://data.geus.dk/geusmap/ows/25832.jsp'
const JUPITER_TYPENAME  = 'jupiter_boringer_ws'
const JUPITER_FETCH_MAX = 10000

const JUPITER_CATS = [
  { key: 'geo',    label: 'Geoteknik', color: '#b45309', codes: ['G'] },
  { key: 'vand',   label: 'Vand',      color: '#0369a1', codes: ['V', 'VV', 'VP', 'VM'] },
  { key: 'miljoe', label: 'Miljø',     color: '#15803d', codes: ['L'] },
]
const JUPITER_CODE_TO_CAT = {}
JUPITER_CATS.forEach(c => c.codes.forEach(code => { JUPITER_CODE_TO_CAT[code] = c.key }))
const JUPITER_CAT_COLOR = Object.fromEntries(JUPITER_CATS.map(c => [c.key, c.color]))

// Distinct colours for data sources (databases).  Assigned by the sorted db_id
// set so DB1/DB2/… stay consistent across renders.
const SOURCE_PALETTE = ['#2563eb', '#16a34a', '#db2777', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#dc2626']

// Session-scoped memory of the selection map so leaving Data Selection (or its
// Map subtab) and returning restores the last view, loaded points, and toggles.
const mapStore = {
  folder: null, // #238: which output folder this state belongs to
  view: null, loaded: [], loadStatus: '', hiddenDbs: [],
  jupiter: [], jupiterCats: { geo: true, vand: true, miljoe: true },
}

// #238: the store is FOLDER-scoped.  Points loaded under another project
// folder must not survive a folder switch — their (db_id, ProjectId)
// identities belong to that folder's database list, so parent-project
// lookups would silently miss.  Returns true when a switch wiped the store.
function ensureMapStoreFolder(folder) {
  if (!folder || mapStore.folder === folder) return false
  mapStore.folder = folder
  mapStore.view = null
  mapStore.loaded = []
  mapStore.loadStatus = ''
  mapStore.hiddenDbs = []
  mapStore.jupiter = []
  return true
}

// Cyklogram summaries (#174): borid → 'loading' | null (no data) | [{label, pct}].
// GEUS's cyklogram IMAGE is dead upstream (it redirects to the retired Google
// Image Charts API), but the redirect URL carries the lithology data — fetched
// lazily on first hover via cyklogram_summary and drawn locally as a small SVG
// pie.  Module-level so results survive tab switches.
const cykCache = new Map()

// Approximate Danish lithology colours for the locally-drawn cyklogram
// (keyword match on the GEUS labels; first hit wins).
const LITH_COLORS = [
  ['tørv',  '#4a3b2a'], ['gytje', '#5d4a36'], ['muld', '#6d4c41'],
  ['grus',  '#e67e22'], ['sten',  '#9e9e9e'], ['sand', '#f4d03f'],
  ['silt',  '#d7bd8d'], ['kalk',  '#aee3e8'], ['kridt', '#cfeaed'],
  ['ler',   '#8d6e63'], ['fyld',  '#b0bec5'], ['brønd', '#90a4ae'],
]
function lithColor(label) {
  const l = String(label).toLowerCase()
  for (const [kw, c] of LITH_COLORS) if (l.includes(kw)) return c
  return '#b0a18f'
}

// Pie segment path: angles in radians from 12 o'clock, clockwise.
function arcPath(cx, cy, r, a0, a1) {
  const large = (a1 - a0) > Math.PI ? 1 : 0
  const x0 = cx + r * Math.sin(a0), y0 = cy - r * Math.cos(a0)
  const x1 = cx + r * Math.sin(a1), y1 = cy - r * Math.cos(a1)
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`
}

// Locally-drawn cyklogram: SVG pie (segments ∝ layer share, top→bottom drawn
// clockwise from 12 o'clock, GEUS-style) + a compact colour legend.
function CyklogramFigure({ seq }) {
  const total = seq.reduce((s, x) => s + x.pct, 0) || 1
  let a = 0
  const segs = seq.map(s => {
    const a0 = a
    a += (s.pct / total) * Math.PI * 2
    return { ...s, a0, a1: a, color: lithColor(s.label) }
  })
  const shown = segs.slice(0, 8)
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 3 }}>
      <svg width="64" height="64" viewBox="0 0 64 64" style={{ flex: '0 0 auto' }}>
        {segs.length === 1 ? (
          <circle cx="32" cy="32" r="30" fill={segs[0].color} />
        ) : (
          segs.map((s, i) => (
            <path key={i} d={arcPath(32, 32, 30, s.a0, s.a1)} fill={s.color} stroke="#fff" strokeWidth="0.8" />
          ))
        )}
        <circle cx="32" cy="32" r="30" fill="none" stroke="#64748b" strokeWidth="1" />
      </svg>
      <div style={{ fontSize: '.68rem', lineHeight: 1.4 }}>
        {shown.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, background: s.color, border: '1px solid #94a3b8', flex: '0 0 auto' }} />
            {s.label} {s.pct < 1 ? s.pct.toFixed(1) : Math.round(s.pct)}%
          </div>
        ))}
        {segs.length > shown.length && (
          <div style={{ opacity: 0.7 }}>+{segs.length - shown.length} more…</div>
        )}
      </div>
    </div>
  )
}

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

// #209: outer ring of a clicked addon (sub-)polygon as unclosed [[lat, lng], …]
// — the same shape as hand-drawn `vertices`.  Addon GeoJSON is reprojected to
// EPSG:4326 at load time, so coordinates arrive as [lng, lat].  For a
// MultiPolygon the sub-polygon containing the click wins (fallback: the ring
// with the most vertices).
function ringFromFeature(feature, clickLatLng) {
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

// (The live per-view Jupiter WFS layer was replaced in #174 by per-region
// loading of jupiter_boringer_ws via the same Load buttons as the DB sources —
// see fetchJupiterRegion + the Jupiter render block in SelectionMap below.)

export default function SelectionMap() {
  const { allPoints } = useFilter()
  const { selectedPoints, setSelectedPoints, selectedProjects, setSelectedProjects, coordinateSystem, mapAddons, connection } = useApp()

  // #238: wipe folder-foreign session state BEFORE the useState initialisers
  // below seed from mapStore (fresh mounts after a folder switch).
  const folder = connection?.output_folder || ''
  ensureMapStoreFolder(folder)

  // #234: dynamic tile grid — web-mercator while an XYZ world map (OSM/Esri)
  // is visible on this map, the Danish 25832 grid (WMTS builtins) otherwise.
  const grid = mapGridFor(mapAddons, 'selection')
  const dkGrid = grid === 'dk'
  const [initials, setInitials] = useState('')

  // Jupiter boreholes (#174) — loaded per region; category show/hide toggles.
  const [jupiter, setJupiter] = useState(() => mapStore.jupiter)
  const [jupiterCats, setJupiterCats] = useState(() => ({ ...mapStore.jupiterCats }))
  const toggleJupiterCat = (key) =>
    setJupiterCats(prev => ({ ...prev, [key]: !prev[key] }))

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
  // #209: addon name when the active boundary came from a clicked addon
  // polygon (Settings → Map addons) instead of a hand draw.  While set, map
  // clicks do NOT drop vertices — the ring is fixed.
  const [polyFromAddon, setPolyFromAddon] = useState(null)

  // Persist across unmount so returning to Data Selection restores this state.
  useEffect(() => { mapStore.jupiter = jupiter }, [jupiter])
  useEffect(() => { mapStore.jupiterCats = { ...jupiterCats } }, [jupiterCats])
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

  // Fetch Jupiter boreholes (jupiter_boringer_ws, #174) inside the region —
  // same trigger as the DB load.  BBOX WFS GetFeature → GeoJSON, then
  // client-side polygon test + category filter (geo/vand/miljø only; the rest
  // is never kept).  Dedups by borid across overlapping loads.
  async function fetchJupiterRegion(points4326) {
    const polyLatLng = points4326.map(([lng, lat]) => [lat, lng])
    const proj = points4326.map(([lng, lat]) => reproject(lng, lat, 'EPSG:4326', 'EPSG:25832'))
    if (proj.some(p => !p)) return { added: 0 }
    const xs = proj.map(p => p[0]), ys = proj.map(p => p[1])
    const bbox = `${Math.min(...xs).toFixed(1)},${Math.min(...ys).toFixed(1)},${Math.max(...xs).toFixed(1)},${Math.max(...ys).toFixed(1)}`
    const who = whoami ? `&whoami=${encodeURIComponent(whoami)}` : ''
    const url =
      `${JUPITER_WFS}?mapname=jupiter${who}` +
      `&service=WFS&version=1.0.0&request=GetFeature` +
      `&typename=${JUPITER_TYPENAME}&outputformat=geojson&srsname=EPSG:25832` +
      `&maxfeatures=${JUPITER_FETCH_MAX}&bbox=${bbox}`
    const gj = await invoke('wfs_proxy', { url })
    const fetched = (gj?.features || []).length
    const seen = new Set(jupiter.map(f => f.borid))
    const fresh = []
    for (const f of (gj?.features || [])) {
      const c = f.geometry?.coordinates
      const p = f.properties || {}
      if (!Array.isArray(c)) continue
      const cat = JUPITER_CODE_TO_CAT[String(p.formaal ?? '').trim()]
      if (!cat) continue // not geoteknik / vand / miljø — never loaded
      const latlng = toLatLng(Number(c[0]), Number(c[1]), 'EPSG:25832')
      if (!latlng) continue
      if (!pointInPolygonLatLng(latlng, polyLatLng)) continue
      const borid = String(p.borid ?? p.id ?? `${c[0]}_${c[1]}`)
      if (seen.has(borid)) continue
      seen.add(borid)
      fresh.push({
        borid, latlng, cat,
        dgunr: p.dgunr || '', formaal: p.formaal_tekst || '',
        ejer: p.dataejer || '', terraen: p.terraen_kote ?? '',
        dybde: p.dybde || '', aar: p.aar || '', status: p.kode_tekst || '',
        cyklogram: p.cyklogram || '', url: p.url || '',
      })
    }
    if (fresh.length) setJupiter(prev => [...prev, ...fresh])
    return { added: fresh.length, capped: fetched >= JUPITER_FETCH_MAX }
  }

  // Lazy cyklogram summary on first hover (#174).  Bumps a counter so the open
  // tooltip re-renders when the result lands.
  // The version VALUE is consumed by the memoised Jupiter markers (#218) —
  // bumping it recomputes their tooltips after a cyklogram loads.
  const [cykVersion, setCykVersion] = useState(0)
  function loadCyklogram(f) {
    if (!f.cyklogram || cykCache.has(f.borid)) return
    cykCache.set(f.borid, 'loading')
    setCykVersion(v => v + 1)
    invoke('cyklogram_summary', { url: f.cyklogram })
      .then(r => {
        let seq = null
        if (Array.isArray(r?.groups) && Array.isArray(r?.labels)) {
          // Google chl semantics: labels map to slices in order across all
          // series; unlabeled slices are chart filler — keep labelled ones.
          const flat = r.groups.flat()
          seq = r.labels
            .map((label, i) => ({ label: String(label).trim(), pct: Number(flat[i]) }))
            .filter(s => s.label && isFinite(s.pct) && s.pct > 0)
          if (!seq.length) seq = null
        }
        cykCache.set(f.borid, seq)
      })
      .catch(() => cykCache.set(f.borid, null))
      .finally(() => setCykVersion(v => v + 1))
  }

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
  // Version bump so memoised tooltips (#222) recompute once the index loads.
  const [projIndexVersion, setProjIndexVersion] = useState(0)
  const refetchProjIndex = useCallback(() => {
    invoke('list_projects')
      .then(rows => {
        const idx = {}
        for (const r of (rows || [])) idx[`${r.db_id ?? '?'}||${r.ProjectId}`] = r
        projIndex.current = idx
        setProjIndexVersion(v => v + 1)
      })
      .catch(() => {})
  }, [])
  useEffect(() => { refetchProjIndex() }, [refetchProjIndex])
  // #238: database config / folder reconnects announce 'databases' — the
  // project index must follow, or parent-project lookups go stale.
  useDataChanged('databases', refetchProjIndex)

  // #238: folder switched WHILE this map is mounted (e.g. from another
  // window): wipe the module store AND the local copies seeded from it.
  const prevFolderRef = useRef(folder)
  useEffect(() => {
    if (prevFolderRef.current === folder) return
    prevFolderRef.current = folder
    ensureMapStoreFolder(folder)
    setJupiter([])
    setLoaded([])
    setLoadStatus(folder ? 'Project folder changed — loaded map points were cleared (⬇ Load in view to reload).' : '')
    setHiddenDbs(new Set())
    refetchProjIndex()
  }, [folder, refetchProjIndex])

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
    } else if (!proj) {
      // #238: loud instead of silent — typically stale points from another
      // project folder / database set.
      setLoadStatus(`Point selected, but project ${p.ProjectId} (${p.db_id ?? '?'}) is not in the current project list — if you switched project folder, re-load the map points (⬇ Load in view).`)
    }
  }

  // #222/#224: double-click adds/removes the point's WHOLE parent project.
  // The CLICKED POINT decides the direction — point currently selected →
  // remove the project and all its points; point not selected → add the
  // project (if missing) and ALL its points (cached get_points).  Keying on
  // the project instead (#222) made it impossible to bulk-add the rest of a
  // project that was already selected via a single point.
  async function toggleProjectByPoint(p) {
    const pk = `${p.db_id ?? '?'}||${p.ProjectId}`
    const proj = projIndex.current[pk]
    const pointSelected = selectedIds.has(`${p.db_id ?? '?'}_${p.PointId}`)
    if (pointSelected) {
      setSelectedProjects(prev => (prev || []).filter(sp => `${sp.db_id ?? '?'}||${sp.ProjectId}` !== pk))
      setSelectedPoints(prev => (prev || []).filter(pt => `${pt.db_id ?? '?'}||${pt.ProjectId}` !== pk))
      setLoadStatus(`Removed project ${proj?.ProjectNo ?? p.ProjectId} and its points from the selection`)
      return
    }
    if (!proj) {
      // #238: typically stale points from another project folder / DB set.
      setLoadStatus(`Project ${p.ProjectId} (${p.db_id ?? '?'}) is not in the current project list — if you switched project folder, re-load the map points (⬇ Load in view).`)
      return
    }
    setSelectedProjects(prev =>
      (prev || []).some(sp => `${sp.db_id ?? '?'}||${sp.ProjectId}` === pk) ? prev : [...(prev || []), proj])
    try {
      const rows = await invoke('get_points', { projectIds: [{ db_id: p.db_id, ProjectId: p.ProjectId }] })
      setSelectedPoints(prev => {
        const have = new Set((prev || []).map(x => `${x.db_id ?? '?'}_${x.PointId}`))
        const fresh = (Array.isArray(rows) ? rows : []).filter(x => !have.has(`${x.db_id ?? '?'}_${x.PointId}`))
        return fresh.length ? [...(prev || []), ...fresh] : (prev || [])
      })
      setLoadStatus(`Added project ${proj.ProjectNo ?? p.ProjectId} with all its points`)
    } catch (err) {
      setLoadStatus(`Failed to load the project's points: ${err}`)
    }
  }

  // Click vs double-click disambiguation (#222): a double-click also fires
  // two clicks, so the single-point toggle waits 260 ms and is cancelled
  // when the second click arrives.  Map double-click zoom is suppressed
  // while handling a marker double-click.
  const clickTimerRef = useRef(null)
  useEffect(() => () => { clearTimeout(clickTimerRef.current) }, [])
  function onMarkerClick(p) {
    clearTimeout(clickTimerRef.current)
    clickTimerRef.current = setTimeout(() => toggleSelectRef.current(p), 260)
  }
  function onMarkerDblClick(p, e) {
    clearTimeout(clickTimerRef.current)
    try { if (e?.originalEvent) L.DomEvent.stopPropagation(e.originalEvent) } catch { /* best effort */ }
    if (map?.doubleClickZoom) {
      try {
        map.doubleClickZoom.disable()
        setTimeout(() => { try { map.doubleClickZoom.enable() } catch { /* gone */ } }, 350)
      } catch { /* best effort */ }
    }
    toggleProjectByPointRef.current(p)
  }

  // Visible points (loaded ∪ selected-project) that are selected → red ring.
  const ringPoints = useMemo(() => {
    const byId = new Map()
    pts.forEach(f => byId.set(f.id, f))
    loaded.forEach(f => { if (!byId.has(f.id)) byId.set(f.id, f) })
    return [...byId.values()].filter(f => selectedIds.has(f.id) && !hiddenDbs.has(f.p.db_id))
  }, [pts, loaded, selectedIds, hiddenDbs])

  // ── Memoised marker trees (#218) ──────────────────────────────────────────
  // Unrelated context churn (e.g. dragging an addon's transparency slider)
  // re-renders this component on every commit; keeping the marker arrays
  // referentially stable lets React skip reconciling thousands of
  // CircleMarkers.  Handlers go through refs so the memos never hold stale
  // closures.
  const toggleSelectRef = useRef(null)
  toggleSelectRef.current = toggleSelect
  const toggleProjectByPointRef = useRef(null)
  toggleProjectByPointRef.current = toggleProjectByPoint
  const markerClickRef = useRef(null)
  markerClickRef.current = onMarkerClick
  const markerDblRef = useRef(null)
  markerDblRef.current = onMarkerDblClick
  const loadCyklogramRef = useRef(null)
  loadCyklogramRef.current = loadCyklogram

  // #222: labelled multi-line tooltip for DB points (mirrors the Jupiter
  // style).  Lines appear only when the value exists; Depth = Bottom − Top.
  function pointTooltip(p, id) {
    const proj = projIndex.current[`${p.db_id ?? '?'}||${p.ProjectId}`]
    const num = v => (v == null || v === '' || !isFinite(Number(v))) ? null : Number(v)
    const top = num(p.Top)
    const bottom = num(p.Bottom)
    const depth = (top != null && bottom != null) ? Math.round((bottom - top) * 100) / 100 : null
    const z = num(p.Z1)
    const projectNo = p.ProjectNo ?? proj?.ProjectNo
    const crsLine = crsTip(p)
    return (
      <div style={{ fontSize: '.72rem', lineHeight: 1.45, maxWidth: 280 }}>
        <strong>{p.PointNo ?? p.PointId}</strong>{p.PointType ? ` · ${p.PointType}` : ''}<br />
        {projectNo != null && <>ProjectNo: {projectNo}<br /></>}
        {proj?.Title ? <>Project name: {proj.Title}<br /></> : null}
        Database: {p.db_id ?? '?'}<br />
        {z != null && <>Z1: {z} m<br /></>}
        {depth != null && <>Depth: {depth} m (Bottom − Top)<br /></>}
        {srcCrsLabel(p) && <>Source CRS: {srcCrsLabel(p)}<br /></>}
        {crsLine && <>{crsLine}<br /></>}
        <span style={{ opacity: 0.7 }}>
          click = {selectedIds.has(id) ? 'deselect' : 'select'} point · double-click = whole project
        </span>
      </div>
    )
  }

  // X/Y line for point tooltips in the project's target CRS (#217).
  const crsTip = useCallback((p) => {
    const epsg = normaliseEpsg(coordinateSystem?.target_epsg)
    if (!epsg) return null
    const c = convertPoint(p, coordinateSystem)
    if (c?.X1 == null || c?.Y1 == null || !isFinite(Number(c.X1)) || !isFinite(Number(c.Y1))) return null
    return `${c.X1} · ${c.Y1} — ${CRS_LABELS[epsg] || epsg}`
  }, [coordinateSystem])

  // #232: the point's ORIGINAL coordinate system as stored in the database
  // (origin_Projection1 survives conversions; raw points carry Projection1).
  const srcCrsLabel = useCallback((p) => {
    const raw = p.origin_Projection1 ?? p.Projection1
    if (raw == null || raw === '') return null
    const epsg = normaliseEpsg(raw)
    return (epsg && (CRS_LABELS[epsg] || epsg)) || String(raw)
  }, [])

  const jupiterMarkers = useMemo(() => (
    jupiter.filter(f => jupiterCats[f.cat]).map(f => (
      <CircleMarker
        key={`j_${f.borid}`}
        center={f.latlng}
        radius={4}
        pathOptions={{ color: '#475569', weight: 1, fillColor: JUPITER_CAT_COLOR[f.cat], fillOpacity: 0.9 }}
        eventHandlers={{
          click: () => { if (f.url) invoke('open_url', { url: f.url }).catch(() => {}) },
          tooltipopen: () => loadCyklogramRef.current(f),
        }}
      >
        <Tooltip sticky>
          <div style={{ fontSize: '.72rem', lineHeight: 1.45, maxWidth: 280 }}>
            <strong>DGU {f.dgunr || '?'}</strong>{f.formaal ? ` · ${f.formaal}` : ''}<br />
            {f.ejer ? <>Ejer: {f.ejer}<br /></> : null}
            {(f.terraen !== '' && f.terraen != null) ? <>Terræn: {f.terraen} m<br /></> : null}
            {f.dybde ? <>Dybde: {f.dybde}</> : null}
            {f.aar ? ` · ${f.aar}` : ''}
            {f.status ? ` · ${f.status}` : ''}
            {(f.dybde || f.aar || f.status) ? <br /> : null}
            {(() => {
              // Cyklogram as compact text (the GEUS image is dead upstream).
              const cyk = cykCache.get(f.borid)
              const small = { fontSize: '.7rem', opacity: 0.75, marginTop: 2 }
              if (!f.cyklogram) return null
              if (cyk === 'loading') return <div style={small}>henter cyklogram…</div>
              if (Array.isArray(cyk)) return (
                <div style={{ marginTop: 2 }}>
                  <strong>Cyklogram:</strong>
                  <CyklogramFigure seq={cyk} />
                </div>
              )
              if (cyk === null) return <div style={small}>Cyklogram: ingen data</div>
              return null // loads on hover (tooltipopen)
            })()}
            <div style={{ opacity: 0.7, marginTop: 2 }}>click → borerapport</div>
          </div>
        </Tooltip>
      </CircleMarker>
    ))
  ), [jupiter, jupiterCats, cykVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  const availMarkers = useMemo(() => (
    loaded.filter(f => !ptIdSet.has(f.id) && !hiddenDbs.has(f.p.db_id)).map(({ id, latlng, p }) => (
      <CircleMarker
        key={`avail_${id}`}
        center={latlng}
        radius={5}
        // Available = hollow ring in the source colour.  Click selects the
        // point; double-click toggles the whole parent project (#222).
        pathOptions={{ color: colorFor(p.db_id), weight: 2, fillColor: colorFor(p.db_id), fillOpacity: 0.2 }}
        eventHandlers={{
          click: () => markerClickRef.current(p),
          dblclick: (e) => markerDblRef.current(p, e),
        }}
      >
        <Tooltip>{pointTooltip(p, id)}</Tooltip>
      </CircleMarker>
    ))
  ), [loaded, ptIdSet, hiddenDbs, dbColors, selectedIds, crsTip, projIndexVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  const ptsMarkers = useMemo(() => (
    pts.filter(f => !hiddenDbs.has(f.p.db_id)).map(({ id, latlng, p }) => (
      <CircleMarker
        key={id}
        center={latlng}
        radius={6}
        // Selected-project point, solid fill in the source colour.  Click
        // selects the point; double-click toggles the whole project (#222).
        pathOptions={{ color: '#fff', weight: 1.5, fillColor: colorFor(p.db_id), fillOpacity: 0.95 }}
        eventHandlers={{
          click: () => markerClickRef.current(p),
          dblclick: (e) => markerDblRef.current(p, e),
        }}
      >
        <Tooltip>{pointTooltip(p, id)}</Tooltip>
      </CircleMarker>
    ))
  ), [pts, hiddenDbs, dbColors, selectedIds, crsTip, projIndexVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  const ringMarkers = useMemo(() => (
    ringPoints.map(f => (
      <CircleMarker
        key={`ring_${f.id}`}
        center={f.latlng}
        radius={9}
        interactive={false}
        pathOptions={{ color: '#dc2626', weight: 2.5, fill: false }}
      />
    ))
  ), [ringPoints])

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

  // Load available points inside the region (de-duped against the map) AND the
  // Jupiter boreholes for the same region (#174) — one button, both sources.
  async function loadInside(points) {
    if (!points || points.length < 3) return
    setLoading(true); setLoadStatus('querying databases + Jupiter…')
    try {
      const [q, jup] = await Promise.all([
        queryPointsInPolygon(points),
        fetchJupiterRegion(points).catch(() => ({ added: 0 })),
      ])
      const jupBit = ` · ${jup.added} Jupiter borehole${jup.added === 1 ? '' : 's'}${jup.capped ? ' (area capped — load a smaller region for all)' : ''}`
      if (q.noEpsg) {
        setLoadStatus(`no usable coordinate systems found in the configured databases${jupBit}`)
        return
      }
      const { feats, skipped } = q
      const onMap = new Set([...loaded.map(f => f.id), ...pts.map(f => f.id)])
      const fresh = feats.filter(f => !onMap.has(f.id))
      setLoaded(prev => {
        const seen = new Set([...prev.map(f => f.id), ...pts.map(f => f.id)])
        return [...prev, ...feats.filter(f => !seen.has(f.id))]
      })
      const dup  = (feats.length - fresh.length) ? ` · ${feats.length - fresh.length} already on map` : ''
      const skip = skipped ? ` · ${skipped} EPSG(s) skipped` : ''
      setLoadStatus(`${fresh.length} new DB point${fresh.length === 1 ? '' : 's'}${dup}${skip}${jupBit}`)
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
    setPolyFromAddon(null)
    if (action === 'load') loadInside(ring4326)
    else if (action === 'select') selectInside(ring4326)
    else if (action === 'remove') removeInside(polyLatLng)
  }

  // #209: clicking a polygon from a map addon stages it as the active
  // boundary — same buttons/flow as a hand-drawn one.  Reads state via a ref
  // because AddonLayers attaches the handler once per layer mount.
  const drawStateRef = useRef({ drawing: false, fromAddon: null })
  useEffect(() => { drawStateRef.current = { drawing, fromAddon: polyFromAddon } }, [drawing, polyFromAddon])
  const onAddonPolygonClick = useCallback((feature, latlng, addonName) => {
    const s = drawStateRef.current
    if (s.drawing && !s.fromAddon) return  // hand-drawing in progress — don't hijack
    const ring = ringFromFeature(feature, latlng)
    if (!ring) return
    setVertices(ring)
    setPolyFromAddon(addonName || 'addon')
    setDrawing(true)
  }, [])

  return (
    <div className="page page-wide" style={{ display: 'flex', flexDirection: 'column' }}>
      <h2 className="page-title">Selection map</h2>

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5rem' }}>
        <span className="hint" style={{ margin: 0 }}>
          Jupiter: {jupiter.length
            ? `${jupiter.length} borehole${jupiter.length === 1 ? '' : 's'} loaded · hover = info + cyklogram · click = borerapport`
            : 'none loaded — ⬇ Load in view or draw a polygon'}
          {pts.length ? ` · ${pts.length} selected-project point${pts.length === 1 ? '' : 's'}` : ''}
          {' · toggle sources in the map legend (bottom-left)'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5rem' }}>
        {!drawing ? (
          <>
            <button className="btn-secondary" onClick={() => { setVertices([]); setPolyFromAddon(null); setDrawing(true) }} disabled={!map || loading}>
              ✏️ Draw polygon
            </button>
            <button className="btn-secondary" onClick={loadInView} disabled={!map || loading}>
              {loading ? 'Loading…' : '⬇ Load in view'}
            </button>
            {(loaded.length > 0 || jupiter.length > 0) && (
              <button className="btn-secondary" onClick={() => { setLoaded([]); setJupiter([]); setLoadStatus('') }} disabled={loading}>
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
            <button className="btn-secondary" onClick={() => { setDrawing(false); setVertices([]); setPolyFromAddon(null) }} disabled={loading}>
              Cancel
            </button>
            <span className="hint" style={{ margin: 0 }}>
              {polyFromAddon
                ? <>Boundary from <strong>{polyFromAddon}</strong> — <strong>Load</strong> / <strong>Select</strong> / <strong>Remove</strong> points inside it</>
                : <>Click to drop vertices (zoom/pan freely), then <strong>Load</strong> / <strong>Select</strong> / <strong>Remove</strong> inside</>}
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
          // #232/#234: dynamic grid — Danish 25832 (WMTS builtins) unless an
          // XYZ world map is visible, then web-mercator with WMS fallbacks.
          // Grid changes remount the map (Leaflet can't switch CRS live).
          key={`selmap_${grid}`}
          crs={dkGrid ? CRS_DK : L.CRS.EPSG3857}
          maxZoom={dkGrid ? DK_MAX_ZOOM : 19}
          center={mapStore.view ? [mapStore.view.lat, mapStore.view.lng] : DK_CENTER}
          zoom={mapStore.view
            ? (dkGrid ? clampDkZoom(mapStore.view.zoom) : clampMercZoom(mapStore.view.zoom))
            : (dkGrid ? DK_DEFAULT_ZOOM : MERC_DEFAULT_ZOOM)}
          scrollWheelZoom preferCanvas style={{ height: '100%', width: '100%' }}
        >
          <MapRef onMap={setMap} />
          {/* #209: while an addon polygon is staged, map clicks must NOT drop
              vertices — the ring is fixed. */}
          <DrawHandler active={drawing && !polyFromAddon} onVertex={(v) => setVertices(prev => [...prev, v])} />

          {/* In-progress draw polygon (M4.3b) / staged addon boundary (#209). */}
          {drawing && vertices.length >= 3 && (
            <Polygon positions={vertices} pathOptions={{ color: '#dc2626', weight: 2, dashArray: '5,5', fillColor: '#dc2626', fillOpacity: 0.08 }} />
          )}
          {drawing && vertices.length === 2 && (
            <Polyline positions={vertices} pathOptions={{ color: '#dc2626', weight: 2, dashArray: '5,5' }} />
          )}
          {/* Per-vertex handles only for hand-drawn rings — addon rings can
              easily have hundreds of vertices. */}
          {drawing && !polyFromAddon && vertices.map((v, i) => (
            <CircleMarker key={`v${i}`} center={v} radius={3} pathOptions={{ color: '#dc2626', weight: 2, fillColor: '#fff', fillOpacity: 1 }} />
          ))}

          {/* Background maps + WMS addons — one unified layer list (M4.5a).
              Addon polygons double as clickable selection boundaries (#209). */}
          <AddonLayers target="selection" grid={grid} onPolygonClick={onAddonPolygonClick} />

          {/* Jupiter boreholes (#174), available points (M4.3), selected-project
              points and selection rings (M4.4a) — all memoised marker trees
              (#218) so unrelated re-renders skip reconciling them. */}
          {jupiterMarkers}
          {availMarkers}
          <FitBounds pts={pts} />
          {ptsMarkers}
          {ringMarkers}

          {/* Live cursor X/Y in the project coordinate system (#217). */}
          <CrsCursorReadout targetEpsg={coordinateSystem?.target_epsg} />
        </MapContainer>

        {/* Overlay control (top-right): WMS addon visibility / order / opacity. */}
        <AddonControl target="selection" />

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
          <div style={{ fontWeight: 700, margin: '.3rem 0 .05rem' }}>Jupiter (GEUS)</div>
          {JUPITER_CATS.map(c => (
            <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: '.45rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={!!jupiterCats[c.key]} onChange={() => toggleJupiterCat(c.key)} />
              <span style={{ width: 11, height: 11, borderRadius: '50%', background: c.color, boxShadow: '0 0 0 1px #fff, 0 0 0 2px #475569', flex: '0 0 auto' }} />
              {c.label}
            </label>
          ))}
          {(pts.length > 0 || loaded.length > 0) && (
            <div className="hint" style={{ marginTop: '.3rem' }}>● in project · ○ available · ⭕ selected</div>
          )}
        </div>
      </div>
    </div>
  )
}
