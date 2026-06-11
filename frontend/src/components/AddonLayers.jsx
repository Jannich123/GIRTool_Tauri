import { useEffect, useRef, useState } from 'react'
import { GeoJSON, TileLayer, WMSTileLayer } from 'react-leaflet'
import L from 'leaflet'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'
import { reprojectGeoJSON } from '../lib/proj'

// Standard WMS operation params that Leaflet's WMSTileLayer adds itself.  If the
// saved URL already carries them (e.g. a pasted GetCapabilities URL), they
// collide — ArcGIS then honours the leading `request=GetCapabilities` and
// returns XML instead of a tile.  Strip them, keeping the base endpoint + any
// vendor params (tokens, mapname, …).
const WMS_OP_PARAMS = new Set([
  'service', 'request', 'version', 'layers', 'styles', 'format',
  'transparent', 'bbox', 'width', 'height', 'crs', 'srs', 'exceptions',
])

function wmsBaseUrl(raw) {
  // WMS tiles load in the webview → upgrade http to https (mixed content).
  const upgraded = (raw || '').replace(/^http:\/\//i, 'https://')
  try {
    const u = new URL(upgraded)
    for (const k of [...u.searchParams.keys()]) {
      if (WMS_OP_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k)
    }
    const qs = u.searchParams.toString()
    return `${u.origin}${u.pathname}${qs ? `?${qs}` : ''}`
  } catch {
    return upgraded.split('?')[0]
  }
}

// Session-wide cache: addon id → reprojected FeatureCollection.  Module-level
// so it survives unmount/remount (tab switches) — each imported file is read +
// parsed + reprojected ONCE per app session, then map opens are instant.  Safe
// because the cached .geojson is immutable after import (re-imports get a new
// id); cleared only by an app restart.
const geoFileCache = new Map()

// Optional render-type override (Edit → "Render as"): connect a point-set into
// a single Line / Polygon in file order.  Non-point features pass through; with
// fewer than 2 points the input is returned unchanged.
function applyRenderType(gj, render) {
  if (!gj || !render || render === 'points') return gj
  const pts = []
  const others = []
  for (const f of (gj.features || [])) {
    if (f?.geometry?.type === 'Point') pts.push(f.geometry.coordinates)
    else others.push(f)
  }
  if (pts.length < 2) return gj
  let geometry
  if (render === 'line') {
    geometry = { type: 'LineString', coordinates: pts }
  } else {
    const ring = [...pts]
    const [f0, l0] = [ring[0], ring[ring.length - 1]]
    if (f0[0] !== l0[0] || f0[1] !== l0[1]) ring.push(f0)
    geometry = { type: 'Polygon', coordinates: [ring] }
  }
  return { ...gj, features: [...others, { type: 'Feature', properties: {}, geometry }] }
}

// Renders every visible map layer targeted at `target` ('project' |
// 'selection'), in list order: XYZ tiles, WMS overlays, and (M4.5b) local-file
// GeoJSON addons.  Must be a child of a react-leaflet <MapContainer>.
export default function AddonLayers({ target }) {
  const { mapAddons } = useApp()

  // Local mirror of the session cache (state, so loads trigger a re-render).
  const [geoCache, setGeoCache] = useState({})
  const loadingRef = useRef(new Set())

  useEffect(() => {
    for (const a of (mapAddons || [])) {
      if (!a || a.type !== 'geojson' || a.visible === false || !a.maps?.[target]) continue
      if (geoCache[a.id] || loadingRef.current.has(a.id)) continue
      if (geoFileCache.has(a.id)) {
        setGeoCache(prev => ({ ...prev, [a.id]: geoFileCache.get(a.id) }))
        continue
      }
      loadingRef.current.add(a.id)
      invoke('load_addon_geojson', { file: a.file })
        .then(gj => {
          const reprojected = reprojectGeoJSON(gj, a.epsg ?? 25832)
          geoFileCache.set(a.id, reprojected)
          setGeoCache(prev => ({ ...prev, [a.id]: reprojected }))
        })
        .catch(err => console.warn(`addon ${a.name}: failed to load GeoJSON:`, err))
        .finally(() => loadingRef.current.delete(a.id))
    }
  }, [mapAddons, target]) // eslint-disable-line react-hooks/exhaustive-deps

  return (mapAddons || [])
    .filter(a => a && a.visible !== false && a.maps?.[target])
    .map((a, i) => {
      const opacity = typeof a.opacity === 'number' ? a.opacity : 1
      const zIndex = 200 + i // later in the list draws on top (still under markers)
      const httpsUrl = (a.url || '').replace(/^http:\/\//i, 'https://')

      if (a.type === 'xyz') {
        return (
          <TileLayer
            key={a.id}
            url={httpsUrl}
            opacity={opacity}
            zIndex={zIndex}
            attribution={a.name}
            {...(a.maxZoom ? { maxZoom: a.maxZoom } : {})}
          />
        )
      }

      if (a.type === 'geojson') {
        const cached = geoCache[a.id]
        if (!cached) return null
        const data = applyRenderType(cached, a.render)
        const color = a.color || '#7c3aed'
        return (
          <GeoJSON
            // Key includes opacity / colour / render type: react-leaflet doesn't
            // re-style a mounted GeoJSON layer, so changes remount it.
            key={`${a.id}_${opacity}_${color}_${a.render || 'native'}`}
            data={data}
            style={() => ({ color, weight: 2, opacity, fillColor: color, fillOpacity: opacity * 0.35 })}
            pointToLayer={(feat, latlng) =>
              L.circleMarker(latlng, {
                radius: 5, color: '#fff', weight: 1.2,
                fillColor: color, fillOpacity: Math.min(0.95, opacity),
              })
            }
            onEachFeature={(feature, layer) => {
              const props = feature?.properties || {}
              const keys = Object.keys(props).slice(0, 8)
              const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
              const html = keys.length
                ? `<strong>${esc(a.name)}</strong><br/>` +
                  keys.map(k => `${esc(k)}: ${esc(props[k])}`).join('<br/>')
                : `<strong>${esc(a.name)}</strong>`
              layer.bindTooltip(html, { sticky: true })
            }}
          />
        )
      }

      // WMS (user addons + Danish base maps).  Extra vendor props (token,
      // maxZoom) are only passed when present.
      const extra = {}
      if (a.token) extra.token = a.token
      if (a.maxZoom) extra.maxZoom = a.maxZoom
      return (
        <WMSTileLayer
          key={a.id}
          url={wmsBaseUrl(a.url)}
          layers={a.layer || ''}
          format={a.format || 'image/png'}
          transparent={a.transparent !== false}
          version={a.version || '1.3.0'}
          opacity={opacity}
          zIndex={zIndex}
          attribution={a.name}
          {...extra}
        />
      )
    })
}
