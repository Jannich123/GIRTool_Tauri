import { useState } from 'react'
import { useMapEvents } from 'react-leaflet'
import { reproject, normaliseEpsg, CRS_LABELS } from '../lib/proj'

// #217: live cursor-position readout in the project's target coordinate
// system (Settings → Coordinate system), bottom-right of the map.  Renders
// nothing when no target CRS is configured.  Mousemove only re-renders this
// tiny component — the map and its markers are untouched.
export default function CrsCursorReadout({ targetEpsg }) {
  const [pos, setPos] = useState(null)
  useMapEvents({
    mousemove: (e) => setPos(e.latlng),
    mouseout:  () => setPos(null),
  })
  const epsg = normaliseEpsg(targetEpsg)
  if (!epsg || !pos) return null
  const xy = reproject(pos.lng, pos.lat, 'EPSG:4326', epsg)
  if (!xy) return null
  return (
    <div
      style={{
        position: 'absolute', bottom: 12, right: 12, zIndex: 1000,
        background: 'rgba(255,255,255,0.92)', borderRadius: 6,
        padding: '.25rem .6rem', boxShadow: '0 1px 4px rgba(0,0,0,.25)',
        fontFamily: 'monospace', fontSize: '.72rem', fontWeight: 600,
        color: '#1f2937', pointerEvents: 'none', whiteSpace: 'nowrap',
      }}
    >
      {(CRS_LABELS[epsg] || epsg)}: {xy[0].toFixed(1)} · {xy[1].toFixed(1)}
    </div>
  )
}
