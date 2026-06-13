import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { MapContainer, TileLayer, WMSTileLayer, CircleMarker, Marker, Popup, Polygon, Polyline, LayersControl, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import proj4 from 'proj4'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'
import { useFilter } from '../context/FilterContext'
import { PROJ_DEFS, convertPoint, CRS_LABELS } from '../lib/proj'
import { useDataChanged, invokeAndNotify } from '../lib/dataChanged'
import { pointInPolygonLatLng, ringFromFeature } from '../lib/geo'
import CrsCursorReadout from '../components/CrsCursorReadout'
import { CRS_DK, DK_MAX_ZOOM, DK_CENTER, clampDkZoom, mapGridFor, clampMercZoom, MERC_DEFAULT_ZOOM, DK_DEFAULT_ZOOM } from '../lib/crsDk'
import AddonLayers from '../components/AddonLayers'
import AddonControl from '../components/AddonControl'
import MapSearch from '../components/MapSearch'
import ShapeDraw from '../components/ShapeDraw'
import ShapeActions from '../components/ShapeActions'

const { BaseLayer } = LayersControl

// ── Projection definitions ────────────────────────────────────────────────────
// PROJ_DEFS + proj4 registration now live in the shared module `lib/proj.js`
// (issue #147) so the map and the coordinate-system conversion use one source
// of truth.  Importing it (above) registers every def with proj4.

function toWGS84(x, y, epsg) {
  if (!epsg || epsg === 'EPSG:4326') return [y, x]
  try {
    const def = PROJ_DEFS[epsg] || epsg
    const [lng, lat] = proj4(def, 'EPSG:4326', [x, y])
    if (!isFinite(lat) || !isFinite(lng)) return null
    return [lat, lng]
  } catch {
    return null
  }
}

// Issue #122: Normalise a raw `Projection1` cell value into the canonical
// `EPSG:NNNN` form proj4 expects.  Accepts:
//   * `25832`                 → `"EPSG:25832"`
//   * `"25832"`               → `"EPSG:25832"`
//   * `"EPSG:25832"`          → unchanged
//   * `"epsg:25832"`          → `"EPSG:25832"`
//   * anything unknown/null   → null (caller falls back to the page CRS)
function normaliseEpsg(raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (s === '') return null
  if (/^epsg:/i.test(s)) return 'EPSG:' + s.slice(5).trim()
  if (/^\d+$/.test(s)) return `EPSG:${s}`
  return s // already some other form — proj4 will reject if unknown
}

// Resolve the source CRS for one point: prefer its own Projection1 column,
// fall back to the page-level default when missing or unknown to proj4.
function pointSourceCrs(p, fallbackCrs) {
  const own = normaliseEpsg(p?.Projection1 ?? p?.projection1)
  if (!own) return fallbackCrs
  // proj4 considers a CRS "known" once it has a def — either we registered
  // one in PROJ_DEFS, or proj4.defs(name) returns one.  Otherwise fall
  // through to the page setting.
  if (PROJ_DEFS[own] || proj4.defs(own)) return own
  return fallbackCrs
}

// ── Symbol SVG helpers ────────────────────────────────────────────────────────

const SZ = 20   // icon canvas size (px)
const R  = 7    // nominal radius

function symbolPath(symbol) {
  const c = SZ / 2
  switch (symbol) {
    case 'square':
      return `M${c - R},${c - R} H${c + R} V${c + R} H${c - R} Z`
    case 'diamond': {
      return `M${c},${c - R} L${c + R},${c} L${c},${c + R} L${c - R},${c} Z`
    }
    case 'triangle-up': {
      const h = R * 1.15
      return `M${c},${c - h} L${c + R},${c + h * 0.5} L${c - R},${c + h * 0.5} Z`
    }
    case 'triangle-down': {
      const h = R * 1.15
      return `M${c},${c + h} L${c + R},${c - h * 0.5} L${c - R},${c - h * 0.5} Z`
    }
    case 'cross': {
      const t = R * 0.28
      return `M${c - t},${c - R} H${c + t} V${c - t} H${c + R} V${c + t} H${c + t} V${c + R} H${c - t} V${c + t} H${c - R} V${c - t} H${c - t} Z`
    }
    case 'x': {
      const t = R * 0.28
      const a = R * Math.cos(Math.PI / 4)
      const b = t * Math.cos(Math.PI / 4)
      return [
        `M${c},${c - b}`,
        `L${c + a - b},${c - a}`,
        `L${c + a},${c - a + b}`,
        `L${c + b},${c}`,
        `L${c + a},${c + a - b}`,
        `L${c + a - b},${c + a}`,
        `L${c},${c + b}`,
        `L${c - a + b},${c + a}`,
        `L${c - a},${c + a - b}`,
        `L${c - b},${c}`,
        `L${c - a},${c - a + b}`,
        `L${c - a + b},${c - a}`,
        `Z`,
      ].join(' ')
    }
    case 'star': {
      const pts = []
      for (let i = 0; i < 10; i++) {
        const angle = (Math.PI / 5) * i - Math.PI / 2
        const r = i % 2 === 0 ? R : R * 0.42
        pts.push(`${c + r * Math.cos(angle)},${c + r * Math.sin(angle)}`)
      }
      return `M${pts.join(' L')} Z`
    }
    case 'hexagram': {
      const pts = []
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i - Math.PI / 6
        pts.push(`${c + R * Math.cos(angle)},${c + R * Math.sin(angle)}`)
      }
      return `M${pts.join(' L')} Z`
    }
    case 'pentagon': {
      const pts = []
      for (let i = 0; i < 5; i++) {
        const angle = (2 * Math.PI / 5) * i - Math.PI / 2
        pts.push(`${c + R * Math.cos(angle)},${c + R * Math.sin(angle)}`)
      }
      return `M${pts.join(' L')} Z`
    }
    default: // circle
      return null
  }
}

// Cache: `${symbol}_${color}` → L.divIcon
const iconCache = new Map()

function makeIcon(symbol, color) {
  const key = `${symbol}_${color}`
  if (iconCache.has(key)) return iconCache.get(key)
  const path = symbolPath(symbol)
  const svg = path
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${SZ}" height="${SZ}">
        <path d="${path}" fill="${color}" stroke="#fff" stroke-width="1.5"/>
       </svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="${SZ}" height="${SZ}">
        <circle cx="${SZ/2}" cy="${SZ/2}" r="${R}" fill="${color}" stroke="#fff" stroke-width="1.5"/>
       </svg>`
  const icon = L.divIcon({
    html: svg,
    className: '',
    iconSize:   [SZ, SZ],
    iconAnchor: [SZ / 2, SZ / 2],
  })
  iconCache.set(key, icon)
  return icon
}

// ── Point marker (circle = CircleMarker; others = divIcon Marker) ─────────────

function PointMarker({ pt, color, symbol, children, eventHandlers }) {
  if (!symbol || symbol === 'circle') {
    return (
      <CircleMarker
        center={pt.latlng}
        radius={6}
        pathOptions={{ color: '#fff', weight: 1.5, fillColor: color, fillOpacity: 0.9 }}
        {...(eventHandlers ? { eventHandlers } : {})}
      >
        {children}
      </CircleMarker>
    )
  }
  return (
    <Marker position={pt.latlng} icon={makeIcon(symbol, color)} {...(eventHandlers ? { eventHandlers } : {})}>
      {children}
    </Marker>
  )
}

// #324: capture the Leaflet map instance so the toolbar (outside MapContainer)
// can drive the shape tools.
function MapInstanceRef({ onMap }) {
  const map = useMap()
  useEffect(() => { onMap(map) }, [map, onMap])
  return null
}

// ── Polygon draw for grouping mode (#262 — mirrors SelectionMap's) ───────────

function DrawHandler({ active, onVertex }) {
  const map = useMap()
  useMapEvents({
    click: (e) => { if (active) onVertex([e.latlng.lat, e.latlng.lng]) },
  })
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

// ── Type order ────────────────────────────────────────────────────────────────

const TYPE_ORDER = ['CPT', 'BH', 'TP']

// ── Auto-fit on first mount (skipped if saved position exists) ────────────────

function FitBounds({ points }) {
  const map = useMap()
  useEffect(() => {
    if (!points.length || loadSavedPos()) return   // respect saved position
    const lats = points.map(p => p.latlng[0])
    const lngs = points.map(p => p.latlng[1])
    map.fitBounds(
      [[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]],
      { padding: [40, 40], maxZoom: 16 },
    )
  }, [])  // eslint-disable-line — only on first mount
  return null
}

// ── Session position persistence ──────────────────────────────────────────────
//
// Map view (center + zoom) is persisted in two places:
//   * sessionStorage — for instant restore on the *current* tab/window so the
//     map doesn't visibly snap to defaults while the async session load runs.
//   * GIRTool_settings.json (via patch_session) — so the view survives app
//     restarts and follows the project across windows.
// SavePosition writes to both on every pan/zoom (the session write is
// debounced via patch_session's own buffering).

const SS_POS_KEY = 'girtool_map_pos'
function loadSavedPos() {
  try { return JSON.parse(sessionStorage.getItem(SS_POS_KEY)) || null }
  catch { return null }
}

function SavePosition({ projectId, mapCfgRef }) {
  // mapCfgRef holds { crs, wfsUrl, colorMode } so we can write a complete
  // `map` payload without recreating the SavePosition component on each
  // settings change (which would unmount/remount the Leaflet event hook).
  const saveTimer = useRef(null)
  const lastWrittenRef = useRef('')

  useMapEvents({
    moveend(e) {
      const c    = e.target.getCenter()
      const zoom = e.target.getZoom()

      // Same-window cache (synchronous, used by loadSavedPos on next mount).
      sessionStorage.setItem(SS_POS_KEY, JSON.stringify({
        lat: c.lat, lng: c.lng, zoom,
      }))

      if (!projectId) return
      // Debounced cross-session persistence.
      const payload = {
        center:    { lat: c.lat, lng: c.lng },
        zoom,
        crs:       mapCfgRef.current?.crs       ?? 'EPSG:25832',
        wfsUrl:    mapCfgRef.current?.wfsUrl    ?? '',
        colorMode: mapCfgRef.current?.colorMode ?? 'type',
      }
      const str = JSON.stringify(payload)
      if (str === lastWrittenRef.current) return
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        invoke('patch_session', { projectId, patch: { map: payload } }).catch(() => {})
        lastWrittenRef.current = str
      }, 250)
    },
  })
  return null
}

// ── Legend ────────────────────────────────────────────────────────────────────

function LegendShape({ symbol, color }) {
  const size = 12
  const path = symbolPath(symbol)
  if (!path) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${SZ} ${SZ}`}>
        <circle cx={SZ/2} cy={SZ/2} r={R} fill={color} stroke="#fff" strokeWidth="1.5" />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${SZ} ${SZ}`}>
      <path d={path} fill={color} stroke="#fff" strokeWidth="1.5" />
    </svg>
  )
}

function MapLegend({ entries }) {
  if (!entries.length) return null
  return (
    <div className="map-legend">
      {entries.map(e => (
        <div key={e.label} className="map-legend-row">
          <LegendShape symbol={e.symbol || 'circle'} color={e.color} />
          <span>{e.label}</span>
        </div>
      ))}
    </div>
  )
}

// ── WFS loader ────────────────────────────────────────────────────────────────

async function loadWFS(wfsUrl, epsg, projectIds) {
  if (!wfsUrl) return []
  const url = new URL(wfsUrl)
  url.searchParams.set('SERVICE',      'WFS')
  url.searchParams.set('VERSION',      '2.0.0')
  url.searchParams.set('REQUEST',      'GetFeature')
  url.searchParams.set('outputFormat', 'application/json')
  if (projectIds?.length) {
    url.searchParams.set('CQL_FILTER',
      `ProjectId IN (${projectIds.map(id => `'${id}'`).join(',')})`)
  }
  const gj = await invoke('wfs_proxy', { url: url.toString() })
  return (gj.features || []).map(f => {
    const coords = f.geometry?.coordinates
    if (!coords) return null
    const [cx, cy] = coords
    const latlng = toWGS84(cx, cy, epsg)
    if (!latlng) return null
    return {
      id:        f.id || Math.random().toString(36),
      latlng,
      PointId:   String(f.properties?.PointId  || f.properties?.pointid  || ''),
      PointNo:   f.properties?.PointNo   || f.properties?.pointno   || '',
      PointType: f.properties?.PointType || f.properties?.pointtype || '',
      ProjectNo: f.properties?.ProjectNo || f.properties?.projectno || '',
    }
  }).filter(Boolean)
}

// ── Settings persistence ──────────────────────────────────────────────────────

const LS_MAP_KEY = 'girtool_map_settings'
function loadMapSettings() {
  try { return JSON.parse(localStorage.getItem(LS_MAP_KEY)) || {} }
  catch { return {} }
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function MapPage() {
  const { selectedProjects, typeStyles, coordinateSystem, mapAddons } = useApp()

  // #234: dynamic tile grid — web-mercator while an XYZ world map (OSM/Esri)
  // is visible on this map, the Danish 25832 grid (WMTS builtins) otherwise.
  const grid = mapGridFor(mapAddons, 'project')
  const dkGrid = grid === 'dk'

  // Get style for a type key (upper-cased), fall back to Other
  const typeStyle = t => typeStyles[(t || '').toUpperCase()] ?? typeStyles.Other ?? { color: '#7f8c8d', symbol: 'circle' }

  const {
    allPoints,           // ALL points for selected projects (from FilterContext)
    filteredPtIds,       // active cross-filter set (null = no filter)
    groupSystems,        // [{id, name, groups:[{name, color}]}]
    groupAssignments,    // {pointId: {systemId: groupName}}
    refreshGroupData,    // re-fetch grouping after a save (#262)
  } = useFilter()

  const saved = loadMapSettings()
  const [crs,       setCrs]       = useState(saved.crs       || 'EPSG:25832')
  const [wfsUrl,    setWfsUrl]    = useState(saved.wfsUrl    || '')
  const [colorMode, setColorMode] = useState(saved.colorMode || 'type')

  // ── Grouping mode (#262): assign the active group system's groups straight
  // from the map — click a point, draw a polygon, or click an addon polygon.
  const UNASSIGN = '__unknown__'
  const [grpMode,      setGrpMode]      = useState(false)
  const [grpTarget,    setGrpTarget]    = useState('')
  const [grpDrawing,   setGrpDrawing]   = useState(false)
  const [grpVerts,     setGrpVerts]     = useState([]) // [[lat, lng], …]
  const [grpFromAddon, setGrpFromAddon] = useState(null)
  const [projMap, setProjMap] = useState(null) // #324: captured Leaflet map for the toolbar shape tools
  const [grpMsg,       setGrpMsg]       = useState('')

  // Active project for session lookups.
  const projectId = selectedProjects[0]?.ProjectId

  // Keep a ref to the live map config so SavePosition's moveend handler
  // always reads the latest settings without re-subscribing.
  const mapCfgRef = useRef({ crs, wfsUrl, colorMode })
  useEffect(() => {
    mapCfgRef.current = { crs, wfsUrl, colorMode }
  }, [crs, wfsUrl, colorMode])

  // ── Hydrate from {output_folder}/GIRTool_settings.json on project change ──
  // The MapContainer is keyed off projectId below so it remounts with the
  // freshly-loaded center/zoom — Leaflet does NOT live-react to its
  // initial-center/zoom props.
  const [sessionMap, setSessionMap] = useState(null)
  useEffect(() => {
    if (!projectId) { setSessionMap(null); return }
    invoke('get_session', { projectId }).then(r => {
      const m = r?.map ?? null
      if (m) {
        // Also seed sessionStorage so loadSavedPos picks it up on the
        // first render of the new MapContainer.
        if (m.center && typeof m.zoom === 'number') {
          sessionStorage.setItem(SS_POS_KEY, JSON.stringify({
            lat: m.center.lat, lng: m.center.lng, zoom: m.zoom,
          }))
        }
        if (m.crs       && m.crs       !== crs)       setCrs(m.crs)
        if (m.wfsUrl    !== undefined && m.wfsUrl    !== wfsUrl)    setWfsUrl(m.wfsUrl)
        if (m.colorMode && m.colorMode !== colorMode) setColorMode(m.colorMode)
      }
      setSessionMap(m)
    }).catch(() => { setSessionMap(null) })
  }, [projectId])  // eslint-disable-line

  // ── Persist crs / wfsUrl / colorMode changes to session ───────────────────
  // (Pan/zoom changes are persisted by SavePosition on each moveend.)
  const cfgSaveTimer = useRef(null)
  useEffect(() => {
    if (!projectId) return
    // Wait until the initial session load has completed so we don't
    // immediately overwrite the persisted view with the default state.
    if (sessionMap === null) return
    const center = sessionMap?.center ?? { lat: 56, lng: 10 }
    const zoom   = sessionMap?.zoom   ?? 6
    const payload = { center, zoom, crs, wfsUrl, colorMode }
    clearTimeout(cfgSaveTimer.current)
    cfgSaveTimer.current = setTimeout(() => {
      invoke('patch_session', { projectId, patch: { map: payload } }).catch(() => {})
    }, 250)
    return () => clearTimeout(cfgSaveTimer.current)
  }, [projectId, crs, wfsUrl, colorMode, sessionMap])
  // colorMode: 'type'  → color by PointType
  //            gs.id   → color by that group system

  const [wfsPoints, setWfsPoints] = useState([])
  const [status,    setStatus]    = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)

  // ── Convert database allPoints to map points using X1/Y1 ─────────────────

  const dbPoints = useMemo(() => {
    if (!allPoints?.length) return []
    // Issue #126: per-load diagnostics so the user can spot points whose
    // Projection1 we don't recognise (silent fallback to the page CRS is
    // what landed Aalborg in Africa).  Counts every (Projection1 raw value
    // → resolved srcCrs) combo and logs the histogram once.  Also warns —
    // deduped per unique value — for Projection1 codes that didn't
    // resolve to a registered def.
    const histo = new Map() // raw -> { count, resolved }
    const unknownSeen = new Set()
    const suspicious = []
    const result = allPoints
      .filter(p => p.X1 != null && p.Y1 != null)
      .map(p => {
        // Issue #122: prefer the point's own Projection1 column; fall back
        // to the page-level CRS when missing or unknown to proj4.
        const rawProj = p?.Projection1 ?? p?.projection1
        const normalised = normaliseEpsg(rawProj)
        const knownPerPoint = normalised && (PROJ_DEFS[normalised] || proj4.defs(normalised))
        const srcCrs = knownPerPoint ? normalised : crs

        // Histogram bookkeeping.
        const rawKey = rawProj == null ? '<null>' : String(rawProj)
        const entry  = histo.get(rawKey) || { count: 0, resolved: srcCrs }
        entry.count += 1
        histo.set(rawKey, entry)
        if (normalised && !knownPerPoint && !unknownSeen.has(normalised)) {
          unknownSeen.add(normalised)
          console.warn(
            `[map] Projection1=${normalised} not in PROJ_DEFS — falling back to page CRS ${crs}.  ` +
            `Affected point example: db_id=${p.db_id ?? '?'} PointId=${p.PointId} PointNo=${p.PointNo}`,
          )
        }

        const latlng = toWGS84(Number(p.X1), Number(p.Y1), srcCrs)
        if (!latlng) return null
        // Suspicious-coordinate sniff: anything within 1° of (0, 0) when the
        // source CRS wasn't already lat/long usually means the projection
        // silently produced garbage.  Capture a few examples for the user.
        if (srcCrs !== 'EPSG:4326' && Math.abs(latlng[0]) < 1 && Math.abs(latlng[1]) < 1
            && suspicious.length < 5) {
          suspicious.push({
            db_id:       p.db_id,
            PointId:     p.PointId,
            PointNo:     p.PointNo,
            X1:          p.X1,
            Y1:          p.Y1,
            Projection1: rawProj,
            srcCrs,
            latlng,
          })
        }
        return {
          id:        `db_${p.PointId}`,
          latlng,
          PointId:   String(p.PointId),
          PointNo:   p.PointNo   || '',
          PointType: p.PointType || '',
          ProjectNo: p.ProjectNo || '',
          db_id:     p.db_id ?? '?',
          srcProj:   rawProj, // #232: original coordinate system from the DB
        }
      })
      .filter(Boolean)

    // Issue #126: print the projection histogram once per allPoints load
    // so the user can see at a glance which Projection1 codes their data
    // carries and how many points fell back to the page CRS.
    if (histo.size > 0) {
      const rows = [...histo.entries()].map(([raw, info]) => ({
        'Projection1 raw': raw,
        'count':           info.count,
        'projected via':   info.resolved,
      }))
      // eslint-disable-next-line no-console
      console.info('[map] Per-point CRS distribution:')
      // eslint-disable-next-line no-console
      console.table(rows)
    }
    if (suspicious.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[map] ${suspicious.length} point(s) projected to suspiciously near (0, 0) — ` +
        `their Projection1 may be wrong or unknown to proj4.  Examples:`,
        suspicious,
      )
    }
    return result
  }, [allPoints, crs])

  // #228: the Project map only shows points that actually HAVE downloaded
  // data — the distinct DB||PointNo keys across the Datasheets folder.
  // `null` = still loading (show everything briefly instead of flashing
  // empty); refreshed live when any window downloads/appends ('datasheets').
  const [downloadedKeys, setDownloadedKeys] = useState(null)
  const refreshDownloadedKeys = useCallback(() => {
    invoke('downloaded_point_keys')
      .then(keys => setDownloadedKeys(new Set(Array.isArray(keys) ? keys : [])))
      .catch(() => setDownloadedKeys(new Set()))
  }, [])
  useEffect(() => { refreshDownloadedKeys() }, [refreshDownloadedKeys])
  useDataChanged('datasheets', refreshDownloadedKeys)

  const dlPoints = useMemo(() => {
    if (downloadedKeys === null) return dbPoints
    return dbPoints.filter(pt => {
      const pn = String(pt.PointNo || '').trim()
      if (!pn) return false
      // `*||PointNo` = wildcard from sheets without a DB column (legacy).
      return downloadedKeys.has(`${pt.db_id ?? '?'}||${pn}`) || downloadedKeys.has(`*||${pn}`)
    })
  }, [dbPoints, downloadedKeys])

  // WFS replaces db points when available; otherwise downloaded-only DB points.
  const basePoints = wfsPoints.length > 0 ? wfsPoints : dlPoints

  // Apply cross-filter from Filter Panel
  const visiblePoints = useMemo(() => {
    if (!filteredPtIds) return basePoints
    return basePoints.filter(pt =>
      pt.PointId ? filteredPtIds.has(String(pt.PointId)) : true
    )
  }, [basePoints, filteredPtIds])

  // ── Color/style helpers ───────────────────────────────────────────────────

  const activeGroupSystem = useMemo(
    () => groupSystems.find(gs => gs.id === colorMode) ?? null,
    [groupSystems, colorMode],
  )

  function getStyle(pt) {
    if (!activeGroupSystem) {
      return typeStyle(pt.PointType)
    }
    const grpName = groupAssignments[pt.PointId]?.[activeGroupSystem.id] || 'Unknown'
    const grp = activeGroupSystem.groups.find(g => g.name === grpName)
    return {
      color:  grp?.color  ?? '#95a5a6',
      symbol: grp?.symbol ?? 'circle',
    }
  }

  // ── Grouping-mode logic (#262) ─────────────────────────────────────────────
  // Keep the target group valid + leave the mode when group colouring is off.
  useEffect(() => {
    if (!activeGroupSystem) {
      if (grpMode) { setGrpMode(false); setGrpDrawing(false); setGrpVerts([]); setGrpFromAddon(null) }
      return
    }
    const names = activeGroupSystem.groups.map(g => g.name)
    if (!grpTarget || (grpTarget !== UNASSIGN && !names.includes(grpTarget))) {
      setGrpTarget(names[0] || UNASSIGN)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGroupSystem, grpMode])

  async function assignGroupToPoints(mapPts) {
    if (!activeGroupSystem || !grpTarget || !mapPts.length || !projectId) return
    const sysId = activeGroupSystem.id
    const label = grpTarget === UNASSIGN ? 'Unknown' : grpTarget
    const next = { ...groupAssignments }
    for (const pt of mapPts) {
      const key = String(pt.PointId)
      const cur = { ...(next[key] || {}) }
      if (grpTarget === UNASSIGN) delete cur[sysId]
      else cur[sysId] = grpTarget
      next[key] = cur
    }
    try {
      await invokeAndNotify('grouping', 'save_grouping', {
        projectId,
        body: {
          systems: groupSystems,
          assignments: next,
          // #264: point metadata so first-time rows materialise in
          // Grouping.xlsx (the writer needs PointNo etc. for new rows).
          points: mapPts.map(pt => ({
            PointId:   String(pt.PointId),
            PointNo:   pt.PointNo || '',
            PointType: pt.PointType || '',
            ProjectNo: pt.ProjectNo || '',
          })),
        },
      })
      refreshGroupData() // markers + Grouping tab recolour from the saved truth
      setGrpMsg(`${label} → ${mapPts.length} point${mapPts.length === 1 ? '' : 's'}`)
    } catch (err) {
      setGrpMsg(`Save failed: ${err}`)
    }
  }

  function assignInsidePolygon() {
    if (grpVerts.length < 3) return
    const inside = visiblePoints.filter(pt => pointInPolygonLatLng(pt.latlng, grpVerts))
    setGrpDrawing(false)
    setGrpVerts([])
    setGrpFromAddon(null)
    if (!inside.length) { setGrpMsg('No points inside the polygon'); return }
    assignGroupToPoints(inside)
  }

  // Handlers reached from memoised markers / addon layers via refs — always
  // fresh, never stale closures.
  const grpStateRef = useRef({})
  grpStateRef.current = { grpMode, grpDrawing, grpFromAddon }
  const assignRef = useRef(null)
  assignRef.current = assignGroupToPoints
  const mapPointClickRef = useRef(null)
  mapPointClickRef.current = (grpMode && !grpDrawing)
    ? (pt) => assignRef.current?.([pt])
    : null

  // #262: in grouping mode an addon polygon click stages its ring as the
  // assignment boundary (same semantics as the selection map's #209 flow).
  function onAddonPolyClick(feature, latlng) {
    const s = grpStateRef.current
    if (!s.grpMode) return
    if (s.grpDrawing && !s.grpFromAddon) return // hand-drawing — don't hijack
    const ring = ringFromFeature(feature, latlng)
    if (!ring) return
    setGrpVerts(ring)
    setGrpFromAddon('addon')
    setGrpDrawing(true)
  }
  const onAddonPolyClickRef = useRef(onAddonPolyClick)
  onAddonPolyClickRef.current = onAddonPolyClick

  // Memoised marker tree (#218): unrelated context churn (e.g. addon
  // transparency drags) re-renders this component; a referentially stable
  // marker array lets React skip reconciling every point marker.  Popups get
  // an X/Y line in the project's target CRS (#217) — converted from the DB
  // source rows via a one-pass lookup map.
  const pointMarkers = useMemo(() => {
    const epsg = normaliseEpsg(coordinateSystem?.target_epsg)
    const srcById = epsg ? new Map(allPoints.map(p => [String(p.PointId), p])) : null
    const crsTip = (pt) => {
      const src = srcById?.get(String(pt.PointId))
      if (!src) return null
      const c = convertPoint(src, coordinateSystem)
      if (c?.X1 == null || c?.Y1 == null || !isFinite(Number(c.X1)) || !isFinite(Number(c.Y1))) return null
      return `${c.X1} · ${c.Y1} — ${CRS_LABELS[epsg] || epsg}`
    }
    // #232: the point's ORIGINAL coordinate system (Projection1 from the DB).
    const srcCrs = (raw) => {
      if (raw == null || raw === '') return null
      const e = normaliseEpsg(raw)
      return (e && (CRS_LABELS[e] || e)) || String(raw)
    }
    return visiblePoints.map(pt => {
      const { color, symbol } = getStyle(pt)
      const crsLine = crsTip(pt)
      const srcLine = srcCrs(pt.srcProj)
      return (
        <PointMarker
          key={pt.id} pt={pt} color={color} symbol={symbol}
          eventHandlers={{ click: () => mapPointClickRef.current?.(pt) }}
        >
          {/* #262: no popup while assigning — clicks assign the group. */}
          {!grpMode && (
            <Popup>
              <strong>{pt.PointNo}</strong><br />
              Type: {pt.PointType}
              {activeGroupSystem && (
                <><br />
                  {activeGroupSystem.name}:{' '}
                  {groupAssignments[pt.PointId]?.[activeGroupSystem.id] || 'Unknown'}
                </>
              )}
              {pt.ProjectNo && <><br />Project: {pt.ProjectNo}</>}
              {srcLine && <><br />Source CRS: {srcLine}</>}
              {crsLine && <><br />{crsLine}</>}
            </Popup>
          )}
        </PointMarker>
      )
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiblePoints, activeGroupSystem, groupAssignments, typeStyles, allPoints, coordinateSystem, grpMode])

  // ── Legend entries derived from color mode ────────────────────────────────

  const legendEntries = useMemo(() => {
    if (!activeGroupSystem) {
      // Type mode: only types actually present in visible points
      const seen = new Set(visiblePoints.map(p => (p.PointType || '').toUpperCase()).filter(Boolean))
      return [
        ...TYPE_ORDER.filter(t => seen.has(t)),
        ...[...seen].filter(t => !TYPE_ORDER.includes(t)).sort(),
      ].map(t => {
        const s = typeStyle(t)
        return { label: t, color: s.color, symbol: s.symbol }
      })
    }
    // Group mode: all groups in the system (always show full legend)
    return activeGroupSystem.groups.map(g => ({
      label:  g.name,
      color:  g.color,
      symbol: g.symbol ?? 'circle',
    }))
  }, [visiblePoints, activeGroupSystem, typeStyles])

  // ── Save settings ─────────────────────────────────────────────────────────

  function saveSettings() {
    localStorage.setItem(LS_MAP_KEY, JSON.stringify({ crs, wfsUrl, colorMode }))
    setSettingsOpen(false)
  }

  // Persist colorMode change immediately (no need to open settings panel)
  useEffect(() => {
    const s = loadMapSettings()
    localStorage.setItem(LS_MAP_KEY, JSON.stringify({ ...s, colorMode }))
  }, [colorMode])

  // ── WFS loader ────────────────────────────────────────────────────────────

  async function loadWFSPoints() {
    setStatus('Loading from WFS…'); setWfsPoints([])
    try {
      const ids = selectedProjects.map(p => p.ProjectId)
      const pts = await loadWFS(wfsUrl, crs, ids)
      setWfsPoints(pts)
      setStatus(pts.length
        ? `${pts.length} WFS point${pts.length !== 1 ? 's' : ''} loaded`
        : 'WFS returned no features — showing database coordinates')
    } catch (e) {
      setStatus(`WFS error: ${e.message}`)
    }
  }

  // ── Guard ─────────────────────────────────────────────────────────────────

  if (!selectedProjects.length) {
    return (
      <div className="page">
        <h2 className="page-title">Map</h2>
        <p className="hint">Select a project first.</p>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const savedPos = loadSavedPos()

  return (
    <div className="map-page">

      {/* ── Toolbar ── */}
      <div className="map-toolbar">
        <h2>Map</h2>

        {/* Color mode selector */}
        <select
          value={colorMode}
          onChange={e => setColorMode(e.target.value)}
          className="map-color-select"
          title="Color points by…"
        >
          <option value="type">Color by Type</option>
          {groupSystems.length > 0 && (
            <optgroup label="Color by Group">
              {groupSystems.map(gs => (
                <option key={gs.id} value={gs.id}>{gs.name}</option>
              ))}
            </optgroup>
          )}
        </select>

        {/* #262: grouping mode — only offered while a group system colours
            the map. */}
        {activeGroupSystem && (
          <button
            className="btn-secondary btn-sm"
            style={grpMode ? { background: '#1d4ed8', borderColor: '#1d4ed8', color: '#fff' } : undefined}
            onClick={() => {
              setGrpMode(m => !m)
              setGrpDrawing(false); setGrpVerts([]); setGrpFromAddon(null); setGrpMsg('')
            }}
            title="Assign this group system's groups from the map: click points, draw a polygon, or click an addon polygon"
          >
            🏷 {grpMode ? 'Exit grouping' : 'Assign groups'}
          </button>
        )}
        {grpMode && activeGroupSystem && (
          <>
            <select
              value={grpTarget}
              onChange={e => setGrpTarget(e.target.value)}
              className="map-color-select"
              title="Group to assign"
            >
              {activeGroupSystem.groups.map(g => (
                <option key={g.name} value={g.name}>{g.name}</option>
              ))}
              <option value={UNASSIGN}>Unknown (clear)</option>
            </select>
            {!grpDrawing ? (
              <button
                className="btn-secondary btn-sm"
                onClick={() => { setGrpVerts([]); setGrpFromAddon(null); setGrpDrawing(true); setGrpMsg('') }}
              >
                ✏️ Draw polygon
              </button>
            ) : (
              <>
                <button className="btn-primary btn-sm" disabled={grpVerts.length < 3} onClick={assignInsidePolygon}>
                  🏷 Assign inside{grpVerts.length >= 3 ? '' : ` (${grpVerts.length})`}
                </button>
                <button
                  className="btn-secondary btn-sm"
                  onClick={() => { setGrpDrawing(false); setGrpVerts([]); setGrpFromAddon(null) }}
                >
                  Cancel
                </button>
              </>
            )}
            <span className="hint" style={{ margin: 0 }}>
              {grpDrawing
                ? (grpFromAddon
                    ? 'Addon boundary staged — 🏷 Assign inside'
                    : 'Click to drop vertices, then 🏷 Assign inside')
                : 'Click a point to assign · ✏️ draw or click an addon polygon for bulk'}
            </span>
            {grpMsg && <span className="hint" style={{ margin: 0, color: '#16a34a' }}>{grpMsg}</span>}
          </>
        )}

        {/* Settings */}
        <button className="btn-secondary btn-sm" onClick={() => setSettingsOpen(o => !o)}>
          ⚙ Settings
        </button>

        {settingsOpen && (
          <div className="wfs-config-row">
            <label>Coordinate CRS</label>
            <input
              type="text"
              value={crs}
              onChange={e => setCrs(e.target.value)}
              placeholder="EPSG:25832"
              style={{ width: 120 }}
              title="EPSG code for X1/Y1 database coordinates and WFS geometry"
            />
            <label>WFS URL (optional)</label>
            <input
              type="text"
              value={wfsUrl}
              onChange={e => setWfsUrl(e.target.value)}
              placeholder="https://…/wfs"
              style={{ width: 320 }}
            />
            <button className="btn-secondary btn-sm" onClick={saveSettings}>Save</button>
          </div>
        )}

        {/* #324/#330: shape tools — draw a line, then edit/offset/delete by
            clicking a shape. */}
        <span style={{ borderLeft: '1px solid #e2e8f0', height: 22, margin: '0 .1rem' }} />
        <ShapeDraw map={projMap} target="project" />
        <ShapeActions />

        <div style={{ flex: 1 }} />

        {wfsUrl && (
          <button className="btn-secondary btn-sm" onClick={loadWFSPoints}
            title="Load points from WFS server">
            ↺ Load WFS
          </button>
        )}

        {basePoints.length > 0 && (
          <span style={{ fontSize: '.8rem', color: 'var(--muted)' }}>
            {visiblePoints.length}
            {visiblePoints.length !== basePoints.length ? `/${basePoints.length}` : ''}
            {' point'}{basePoints.length !== 1 ? 's' : ''}
            {wfsPoints.length > 0 ? ' (WFS)' : ' · with downloaded data'}
          </span>
        )}
      </div>

      {/* ── Map ── */}
      <div className="map-container">
        <MapContainer
          // Remount when the project changes so the fresh per-project view
          // hydrated from GIRTool_settings.json takes effect — Leaflet
          // doesn't react to changed initial-center / initial-zoom props.
          // #232/#234: the grid is dynamic — Danish 25832 (WMTS builtins)
          // unless an XYZ world map (OSM/Esri) is visible, then web-mercator
          // with the Danish maps falling back to WMS.  Grid changes remount.
          key={`${projectId || 'no-project'}_${grid}`}
          crs={dkGrid ? CRS_DK : L.CRS.EPSG3857}
          maxZoom={dkGrid ? DK_MAX_ZOOM : 19}
          center={savedPos ? [savedPos.lat, savedPos.lng] : DK_CENTER}
          zoom={savedPos
            ? (dkGrid ? clampDkZoom(savedPos.zoom) : clampMercZoom(savedPos.zoom))
            : (dkGrid ? DK_DEFAULT_ZOOM : MERC_DEFAULT_ZOOM)}
          zoomControl={false}
          style={{ width: '100%', height: '100%' }}
        >
          {/* Background maps + WMS addons — one unified layer list (M4.5a).
              The base maps (OSM / Esri / Dataforsyningen ortho + topo) are now
              built-in entries in the same list, managed in the top-right panel. */}
          <AddonLayers
            target="project"
            grid={grid}
            onPolygonClick={(feature, latlng) => onAddonPolyClickRef.current?.(feature, latlng)}
          />

          {/* #262: grouping-mode polygon draw + staged boundary overlay. */}
          <DrawHandler
            active={grpMode && grpDrawing && !grpFromAddon}
            onVertex={(v) => setGrpVerts(prev => [...prev, v])}
          />
          {grpMode && grpVerts.length >= 3 && (
            <Polygon positions={grpVerts} pathOptions={{ color: '#1d4ed8', weight: 2, dashArray: '5,5', fillColor: '#1d4ed8', fillOpacity: 0.08 }} />
          )}
          {grpMode && grpVerts.length === 2 && (
            <Polyline positions={grpVerts} pathOptions={{ color: '#1d4ed8', weight: 2, dashArray: '5,5' }} />
          )}
          {grpMode && !grpFromAddon && grpVerts.map((v, i) => (
            <CircleMarker key={`gv${i}`} center={v} radius={3} pathOptions={{ color: '#1d4ed8', weight: 2, fillColor: '#fff', fillOpacity: 1 }} />
          ))}

          {pointMarkers}

          {basePoints.length > 0 && <FitBounds points={basePoints} />}
          <SavePosition projectId={projectId} mapCfgRef={mapCfgRef} />

          {/* Live cursor X/Y in the project coordinate system (#217). */}
          <CrsCursorReadout targetEpsg={coordinateSystem?.target_epsg} />
          <MapSearch />
          <MapInstanceRef onMap={setProjMap} />
        </MapContainer>

        {/* Overlay control (top-right): WMS addon visibility / order / opacity. */}
        <AddonControl target="project" />

        {/* Status / hint overlays */}
        {status && <div className="map-status">{status}</div>}
        {basePoints.length === 0 && !status && allPoints.length > 0 && (
          <div className="map-status" style={{ background: 'rgba(0,0,0,.6)' }}>
            {dbPoints.length > 0
              ? 'No downloaded data for the selected points — the Project map only shows points present in downloaded datasheets (Data → ⬇ Download).'
              : 'No map coordinates — open ⚙ Settings and set the correct Coordinate CRS for your data'}
          </div>
        )}

        <MapLegend entries={legendEntries} />
      </div>
    </div>
  )
}
