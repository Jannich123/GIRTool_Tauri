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
      className="map-overlay"
      style={{
        bottom: 12, right: 12,
        padding: '.25rem .6rem',
        fontFamily: 'var(--font-mono)', fontWeight: 600,
        color: 'var(--text)', pointerEvents: 'none', whiteSpace: 'nowrap',
      }}
    >
      {label}: {a.toFixed(dp)} · {b.toFixed(dp)}
    </div>
  )
}
