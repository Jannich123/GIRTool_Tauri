import { useState, useEffect, useRef, useMemo } from 'react'
import { MapContainer, TileLayer, CircleMarker, Marker, Popup, LayersControl, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import proj4 from 'proj4'
import { useApp } from '../context/AppContext'
import { useFilter } from '../context/FilterContext'

const { BaseLayer } = LayersControl

// ── Projection definitions ────────────────────────────────────────────────────

const PROJ_DEFS = {
  'EPSG:25832': '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:25833': '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:32632': '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs',
  'EPSG:32633': '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs',
  'EPSG:3857':  '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs',
  'EPSG:4326':  '+proj=longlat +datum=WGS84 +no_defs',
  'EPSG:4258':  '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs',
  'EPSG:2157':  '+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=0.99982 +x_0=600000 +y_0=750000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:27700': '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.247,0.8421,-20.4894 +units=m +no_defs',
}
Object.entries(PROJ_DEFS).forEach(([name, def]) => proj4.defs(name, def))

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

function PointMarker({ pt, color, symbol, children }) {
  if (!symbol || symbol === 'circle') {
    return (
      <CircleMarker
        center={pt.latlng}
        radius={6}
        pathOptions={{ color: '#fff', weight: 1.5, fillColor: color, fillOpacity: 0.9 }}
      >
        {children}
      </CircleMarker>
    )
  }
  return (
    <Marker position={pt.latlng} icon={makeIcon(symbol, color)}>
      {children}
    </Marker>
  )
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

const SS_POS_KEY = 'girtool_map_pos'
function loadSavedPos() {
  try { return JSON.parse(sessionStorage.getItem(SS_POS_KEY)) || null }
  catch { return null }
}

function SavePosition() {
  useMapEvents({
    moveend(e) {
      const c = e.target.getCenter()
      sessionStorage.setItem(SS_POS_KEY, JSON.stringify({
        lat: c.lat, lng: c.lng, zoom: e.target.getZoom(),
      }))
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
  const proxyRes = await fetch('/api/map/wfs-proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: url.toString() }),
  })
  if (!proxyRes.ok) {
    const err = await proxyRes.json().catch(() => ({}))
    throw new Error(err.detail || `Proxy error ${proxyRes.status}`)
  }
  const gj = await proxyRes.json()
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
  const { selectedProjects, typeStyles } = useApp()

  // Get style for a type key (upper-cased), fall back to Other
  const typeStyle = t => typeStyles[(t || '').toUpperCase()] ?? typeStyles.Other ?? { color: '#7f8c8d', symbol: 'circle' }

  const {
    allPoints,           // ALL points for selected projects (from FilterContext)
    filteredPtIds,       // active cross-filter set (null = no filter)
    groupSystems,        // [{id, name, groups:[{name, color}]}]
    groupAssignments,    // {pointId: {systemId: groupName}}
  } = useFilter()

  const saved = loadMapSettings()
  const [crs,       setCrs]       = useState(saved.crs       || 'EPSG:25832')
  const [wfsUrl,    setWfsUrl]    = useState(saved.wfsUrl    || '')
  const [colorMode, setColorMode] = useState(saved.colorMode || 'type')
  // colorMode: 'type'  → color by PointType
  //            gs.id   → color by that group system

  const [wfsPoints, setWfsPoints] = useState([])
  const [status,    setStatus]    = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)

  // ── Convert database allPoints to map points using X1/Y1 ─────────────────

  const dbPoints = useMemo(() => {
    if (!allPoints?.length) return []
    return allPoints
      .filter(p => p.X1 != null && p.Y1 != null)
      .map(p => {
        const latlng = toWGS84(Number(p.X1), Number(p.Y1), crs)
        if (!latlng) return null
        return {
          id:        `db_${p.PointId}`,
          latlng,
          PointId:   String(p.PointId),
          PointNo:   p.PointNo   || '',
          PointType: p.PointType || '',
          ProjectNo: p.ProjectNo || '',
        }
      })
      .filter(Boolean)
  }, [allPoints, crs])

  // WFS replaces db points when available; otherwise fall back to db coordinates
  const basePoints = wfsPoints.length > 0 ? wfsPoints : dbPoints

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
            {wfsPoints.length > 0 ? ' (WFS)' : ''}
          </span>
        )}
      </div>

      {/* ── Map ── */}
      <div className="map-container">
        <MapContainer
          center={savedPos ? [savedPos.lat, savedPos.lng] : [56, 10]}
          zoom={savedPos ? savedPos.zoom : 6}
          style={{ width: '100%', height: '100%' }}
        >
          <LayersControl position="topright">
            <BaseLayer checked name="OpenStreetMap">
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                maxZoom={19}
              />
            </BaseLayer>
            <BaseLayer name="Ortophoto (ESRI)">
              <TileLayer
                attribution='Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
                url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                maxZoom={19}
              />
            </BaseLayer>
          </LayersControl>

          {visiblePoints.map(pt => {
            const { color, symbol } = getStyle(pt)
            return (
              <PointMarker key={pt.id} pt={pt} color={color} symbol={symbol}>
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
                </Popup>
              </PointMarker>
            )
          })}

          {basePoints.length > 0 && <FitBounds points={basePoints} />}
          <SavePosition />
        </MapContainer>

        {/* Status / hint overlays */}
        {status && <div className="map-status">{status}</div>}
        {basePoints.length === 0 && !status && allPoints.length > 0 && (
          <div className="map-status" style={{ background: 'rgba(0,0,0,.6)' }}>
            No map coordinates — open ⚙ Settings and set the correct Coordinate CRS for your data
          </div>
        )}

        <MapLegend entries={legendEntries} />
      </div>
    </div>
  )
}
