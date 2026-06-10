import { WMSTileLayer } from 'react-leaflet'
import { useApp } from '../context/AppContext'

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

// Map addons (M4.5a) — renders the overlay layers targeted at `target`
// ('project' | 'selection').  Must be a child of a react-leaflet <MapContainer>.
//
// Only WMS overlays are rendered here; WFS / local-file (GeoJSON) addons arrive
// in M4.5b (they need per-service / per-format handling).  Unknown types are
// skipped so a saved WFS addon simply doesn't draw yet.
export default function AddonLayers({ target }) {
  const { mapAddons } = useApp()
  return (mapAddons || [])
    .filter(a => a && a.visible !== false && a.type === 'wms' && a.maps?.[target])
    .map(a => (
      <WMSTileLayer
        key={a.id}
        url={wmsBaseUrl(a.url)}
        layers={a.layer || ''}
        format="image/png"
        transparent
        version={a.version || '1.3.0'}
        attribution={a.name}
      />
    ))
}
