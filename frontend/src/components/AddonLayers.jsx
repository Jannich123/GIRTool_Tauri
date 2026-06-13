import { useEffect, useRef, useState } from 'react'
import { GeoJSON, TileLayer, WMSTileLayer } from 'react-leaflet'
import L from 'leaflet'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'
import { reprojectGeoJSON } from '../lib/proj'
import { useShapeTools } from '../lib/shapeTools'

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

// One mounted GeoJSON file addon.  Colour/opacity changes restyle the layer
// IN PLACE (#218) — the old approach baked them into the React key, so every
// transparency-slider tick re-added all features.  react-leaflet's GeoJSON
// never restyles by prop, hence the imperative setStyle effect.
function GeoFileLayer({ addon, data, polyClickRef }) {
  const layerRef = useRef(null)
  const color = addon.color || '#7c3aed'
  const opacity = typeof addon.opacity === 'number' ? addon.opacity : 1

  // #322: shape-tools selection — selected addon is highlighted, and clicks in
  // 'select' mode pick this addon instead of acting as a boundary.
  const shapeTools = useShapeTools()
  const shapeToolsRef = useRef(shapeTools)
  shapeToolsRef.current = shapeTools
  const isSelected = shapeTools.selected?.id === addon.id

  // #254/#256: keep every vector in the SHARED renderer (so canvas
  // hit-testing, tooltips and the polygon-as-boundary clicks all work) and
  // enforce points-above-addons via DRAW ORDER: send the addon to the back
  // after mount and after every restyle.  Marker sets (re)mounted by the
  // pages append to the canvas end, so they draw on top of addons anyway.
  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    const c = isSelected ? '#ef4444' : color
    const w = isSelected ? 4 : 2
    layer.setStyle((feat) => (feat?.geometry?.type === 'Point'
      ? { color: isSelected ? '#ef4444' : '#fff', weight: isSelected ? 3 : 1.2, fillColor: c, fillOpacity: Math.min(0.95, opacity) }
      : { color: c, weight: w, opacity, fillColor: c, fillOpacity: opacity * 0.35 }))
    try { layer.bringToBack() } catch { /* not on a map yet */ }
  }, [color, opacity, isSelected])

  useEffect(() => {
    try { layerRef.current?.bringToBack() } catch { /* not on a map yet */ }
  }, [data])

  return (
    <GeoJSON
      ref={layerRef}
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
          ? `<strong>${esc(addon.name)}</strong><br/>` +
            keys.map(k => `${esc(k)}: ${esc(props[k])}`).join('<br/>')
          : `<strong>${esc(addon.name)}</strong>`
        layer.bindTooltip(html, { sticky: true })
        // Click: in shape-tools 'select' mode → select this addon (#322);
        // otherwise polygons double as clickable selection boundaries (#209).
        layer.on('click', (e) => {
          const st = shapeToolsRef.current
          if (st?.mode === 'select') {
            L.DomEvent.stop(e)
            st.setSelected?.({ id: addon.id, name: addon.name, type: feature?.geometry?.type, file: addon.file })
            return
          }
          const gt = feature?.geometry?.type
          if (gt === 'Polygon' || gt === 'MultiPolygon') {
            polyClickRef?.current?.(feature, e.latlng, addon.name)
          }
        })
      }}
    />
  )
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
// 'selection'), in list order: XYZ tiles, WMS/WMTS overlays, and (M4.5b)
// local-file GeoJSON addons.  Must be a child of a react-leaflet <MapContainer>.
//
// `grid` (#234): the map's active tile grid — 'dk' (EPSG:25832) or '3857'.
// WMTS layers render natively on 'dk' and fall back to their WMS variant on
// '3857'; XYZ layers only exist on '3857' (their visibility is what flips the
// grid in the first place — see mapGridFor).
//
// `onPolygonClick(feature, latlng, addonName)` (#209, optional): fired when a
// Polygon/MultiPolygon feature of a GeoJSON addon is clicked — the selection
// map uses it to stage the polygon as the active selection boundary.
export default function AddonLayers({ target, grid = 'dk', onPolygonClick }) {
  const { mapAddons } = useApp()

  // Local mirror of the session cache (state, so loads trigger a re-render).
  const [geoCache, setGeoCache] = useState({})
  const loadingRef = useRef(new Set())

  // Latest click handler in a ref: onEachFeature only runs when a GeoJSON
  // layer mounts, so a directly-captured prop would go stale on re-renders.
  const polyClickRef = useRef(onPolygonClick)
  useEffect(() => { polyClickRef.current = onPolygonClick })

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
        if (grid !== '3857') return null // web-mercator tiles need the 3857 grid
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
        return (
          <GeoFileLayer
            // Key carries identity + render type only — colour/opacity changes
            // restyle the mounted layer in place (#218) instead of remounting.
            key={`${a.id}_${a.render || 'native'}`}
            addon={a}
            data={applyRenderType(cached, a.render)}
            polyClickRef={polyClickRef}
          />
        )
      }

      // WMTS (#230/#234): rendered as a plain TileLayer over the KVP GetTile
      // endpoint when the map runs the Danish grid.  On the web-mercator grid
      // (an XYZ world map is visible) the entry renders through its WMS
      // fallback instead — same imagery, server-side 3857.
      if (a.type === 'wmts' && grid !== 'dk') {
        const fb = a.wmsFallback
        if (!fb) return null // no fallback — incompatible with this grid
        const extra = {}
        if (a.token) extra.token = a.token
        if (fb.maxZoom) extra.maxZoom = fb.maxZoom
        return (
          <WMSTileLayer
            key={`${a.id}_wmsfb`}
            url={wmsBaseUrl(fb.url)}
            layers={fb.layer || ''}
            format={fb.format || 'image/png'}
            transparent={fb.transparent !== false ? 'TRUE' : 'FALSE'}
            version={fb.version || '1.3.0'}
            opacity={opacity}
            zIndex={zIndex}
            attribution={a.name}
            {...extra}
          />
        )
      }
      if (a.type === 'wmts') {
        const base = httpsUrl.split('?')[0]
        const qp = new URLSearchParams()
        qp.set('service', 'WMTS')
        qp.set('request', 'GetTile')
        qp.set('version', '1.0.0')
        qp.set('layer', a.layer || '')
        qp.set('style', a.style || 'default')
        qp.set('format', a.format || 'image/png')
        qp.set('tilematrixset', a.tilematrixset || 'GoogleMapsCompatible')
        if (a.token) qp.set('token', a.token)
        try {
          const orig = new URL(httpsUrl)
          for (const [k, v] of orig.searchParams) {
            const kl = k.toLowerCase()
            if (!['service', 'request', 'version', 'layer', 'style', 'format',
                  'tilematrixset', 'tilematrix', 'tilerow', 'tilecol'].includes(kl) && !qp.has(k)) {
              qp.set(k, v)
            }
          }
        } catch { /* keep the computed params */ }
        const wmtsTileUrl = `${base}?${qp.toString()}&tilematrix={z}&tilerow={y}&tilecol={x}`
        return (
          <TileLayer
            key={`${a.id}_${a.layer || ''}_${a.tilematrixset || ''}`}
            url={wmtsTileUrl}
            opacity={opacity}
            zIndex={zIndex}
            attribution={a.name}
            {...(a.maxZoom ? { maxZoom: a.maxZoom } : {})}
            {...(a.maxNativeZoom ? { maxNativeZoom: a.maxNativeZoom } : {})}
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
          // #226: WMS-spec spelling is TRUE/FALSE — Dataforsyningen rejects
          // Leaflet's lowercase boolean serialisation ("TRANSPARENT must be
          // either TRUE or FALSE"), which blanked every layer it served.
          transparent={a.transparent !== false ? 'TRUE' : 'FALSE'}
          version={a.version || '1.3.0'}
          opacity={opacity}
          zIndex={zIndex}
          attribution={a.name}
          {...extra}
        />
      )
    })
}
