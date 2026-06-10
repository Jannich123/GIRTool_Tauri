import { WMSTileLayer } from 'react-leaflet'
import { useApp } from '../context/AppContext'

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
        url={a.url}
        layers={a.layer || ''}
        format="image/png"
        transparent
        version={a.version || '1.3.0'}
        attribution={a.name}
      />
    ))
}
