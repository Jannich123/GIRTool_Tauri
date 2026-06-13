import { useState } from 'react'
import { useMapEvents } from 'react-leaflet'
import { reproject, normaliseEpsg, CRS_LABELS } from '../lib/proj'

// #217: live cursor-position readout in the project's target coordinate
// system (Settings → Coordinate system), bottom-right of the map.  #334: when
// no target CRS is configured (or it can't be projected) it falls back to
// WGS84 lon/lat, so a readout is ALWAYS visible while the cursor is over the
// map — it no longer silently disappears.  Mousemove only re-renders this tiny
// component — the map and its markers are untouched.
export default function CrsCursorReadout({ targetEpsg }) {
  const [pos, setPos] = useState(null)
  useMapEvents({
    mousemove: (e) => setPos(e.latlng),
    mouseout:  () => setPos(null),
  })
  if (!pos) return null
  const epsg = normaliseEpsg(targetEpsg)
  const xy = epsg ? reproject(pos.lng, pos.lat, 'EPSG:4326', epsg) : null
  // Projected CRS → easting/northing in metres (1 dp); fallback → lon/lat (5 dp).
  const label = xy ? (CRS_LABELS[epsg] || epsg) : 'WGS84 lon/lat'
  const a = xy ? xy[0] : pos.lng
  const b = xy ? xy[1] : pos.lat
  const dp = xy ? 1 : 5
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
      {label}: {a.toFixed(dp)} · {b.toFixed(dp)}
    </div>
  )
}
