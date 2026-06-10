import proj4 from 'proj4'

// Shared projection definitions + helpers (issue #147, follow-up to #145).
//
// Single source of truth for the proj4 CRS strings used across the app: the map
// (MapPage) for rendering, and the coordinate-system conversion applied to point
// data.  Previously the defs lived only in MapPage; they now live here so both
// consumers stay in sync and gain the DKTM3/DKTM4 zones.

export const PROJ_DEFS = {
  // ETRS89 / UTM (modern Danish standard)
  'EPSG:25832': '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:25833': '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  // WGS84 / UTM (often interchangeable with the ETRS89 set above for plotting)
  'EPSG:32632': '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs',
  'EPSG:32633': '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs',
  // ETRS89 / DKTM 1–4 (Danish Transverse Mercator).  #145/#147: 4095 & 4096
  // were previously missing — without them DKTM3/DKTM4 points fell back to the
  // page CRS on the map and could not be a conversion target.
  'EPSG:4093':  '+proj=tmerc +lat_0=0 +lon_0=9     +k=0.99995 +x_0=200000 +y_0=-5000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:4094':  '+proj=tmerc +lat_0=0 +lon_0=10    +k=0.99995 +x_0=200000 +y_0=-5000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:4095':  '+proj=tmerc +lat_0=0 +lon_0=11.75 +k=0.99995 +x_0=200000 +y_0=-5000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:4096':  '+proj=tmerc +lat_0=0 +lon_0=15    +k=0.99995 +x_0=200000 +y_0=-5000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  // ED50 / UTM (very old European datum; still surfaces in some Danish DBs)
  'EPSG:23032': '+proj=utm +zone=32 +ellps=intl +towgs84=-87,-98,-121,0,0,0,0 +units=m +no_defs',
  'EPSG:23033': '+proj=utm +zone=33 +ellps=intl +towgs84=-87,-98,-121,0,0,0,0 +units=m +no_defs',
  'EPSG:4230':  '+proj=longlat +ellps=intl +towgs84=-87,-98,-121,0,0,0,0 +no_defs',
  // Generic / web
  'EPSG:3857':  '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs',
  'EPSG:4326':  '+proj=longlat +datum=WGS84 +no_defs',
  'EPSG:4258':  '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs',
  'EPSG:2157':  '+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=0.99982 +x_0=600000 +y_0=750000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:27700': '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.247,0.8421,-20.4894 +units=m +no_defs',
}

// Register every def with proj4 (idempotent — safe even if a consumer also
// registers them).  Importing this module is enough to make the CRS known.
Object.entries(PROJ_DEFS).forEach(([name, def]) => proj4.defs(name, def))

// Friendly short names for a few systems, used in UI captions.
export const CRS_LABELS = {
  'EPSG:25832': 'ETRS89 / UTM 32N',
  'EPSG:25833': 'ETRS89 / UTM 33N',
  'EPSG:4093':  'DKTM1',
  'EPSG:4094':  'DKTM2',
  'EPSG:4095':  'DKTM3',
  'EPSG:4096':  'DKTM4',
  'EPSG:23032': 'ED50 / UTM 32N',
  'EPSG:4326':  'WGS 84',
  'EPSG:3857':  'Web Mercator',
}

// Normalise a raw EPSG/Projection1 cell into the canonical `EPSG:NNNN` form
// proj4 expects.  Accepts 25832 | "25832" | "EPSG:25832" | "epsg:25832".
// Returns null for empty/missing values.
export function normaliseEpsg(raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (s === '') return null
  if (/^epsg:/i.test(s)) return 'EPSG:' + s.slice(5).trim()
  if (/^\d+$/.test(s)) return `EPSG:${s}`
  return s // already some other form — proj4 will reject if unknown
}

// True when proj4 can use this CRS (we registered it, or proj4 already knows it).
export function isKnownCrs(epsg) {
  return !!epsg && (!!PROJ_DEFS[epsg] || !!proj4.defs(epsg))
}

// Reproject [x, y] from one EPSG to another.  Returns null on failure or unknown
// CRS so callers can leave coordinates untouched rather than place them wrong.
export function reproject(x, y, fromEpsg, toEpsg) {
  if (x == null || y == null || !isFinite(x) || !isFinite(y)) return null
  if (!fromEpsg || !toEpsg) return null
  if (fromEpsg === toEpsg) return [x, y]
  if (!isKnownCrs(fromEpsg) || !isKnownCrs(toEpsg)) return null
  try {
    const [nx, ny] = proj4(fromEpsg, toEpsg, [x, y])
    if (!isFinite(nx) || !isFinite(ny)) return null
    return [nx, ny]
  } catch {
    return null
  }
}

// Convert a projected (or geographic) coordinate to Leaflet's [lat, lng].
// Returns null when the CRS is unusable or the reprojection fails, so callers
// can skip the point rather than place it at (0,0).
export function toLatLng(x, y, epsg) {
  const e = normaliseEpsg(epsg)
  if (e === 'EPSG:4326') {
    // Already geographic — x = lon, y = lat (proj4 axis order).
    const lat = Number(y), lng = Number(x)
    return (isFinite(lat) && isFinite(lng)) ? [lat, lng] : null
  }
  const out = reproject(Number(x), Number(y), e, 'EPSG:4326') // [lon, lat]
  return out ? [out[1], out[0]] : null
}

// Project one point object to Leaflet [lat, lng], mirroring MapPage's proven
// logic (issue #155 follow-up): prefer the point's own Projection1 when proj4
// knows it; otherwise fall back to `fallbackEpsg` (the Danish default) and still
// plot it — rather than dropping points that lack a recognised CRS.  Returns
// null only when X1/Y1 are missing/non-numeric.
export function pointToLatLng(p, fallbackEpsg = 'EPSG:25832') {
  const x = Number(p?.X1 ?? p?.x1)
  const y = Number(p?.Y1 ?? p?.y1)
  if (!isFinite(x) || !isFinite(y)) return null
  const own = normaliseEpsg(p?.Projection1 ?? p?.projection1)
  const src = own && isKnownCrs(own) ? own : fallbackEpsg
  return toLatLng(x, y, src)
}

const round2 = (n) =>
  (n == null || !isFinite(Number(n))) ? n : Math.round(Number(n) * 100) / 100

// Apply the project coordinate-system config to one point.  Pure + idempotent:
// always re-derives from the ORIGINAL source values (origin_*), so repeated
// application — or changing the target — never chain-converts.
//
//   config = { target_epsg: 'EPSG:25832', elevation_offsets: { <sys>: number } }
//
// Returns a NEW point with:
//   • origin_X1 / origin_Y1 / origin_Z1 / origin_Projection1 — preserved source
//   • X1 / Y1   — reprojected to the target CRS
//   • Z1        — origin_Z1 + offset[LevelReference]
//   • Projection1 — set to the target EPSG
// If horizontal reprojection can't be done (unknown source CRS, missing coords)
// the original X/Y are kept so nothing is silently mis-placed; the Z offset and
// origin_* are still applied.
export function convertPoint(p, config) {
  const target = normaliseEpsg(config?.target_epsg)
  if (!target) return p

  // Source values: prefer already-captured origin_* (re-derive, never chain).
  const ox = p.origin_X1 ?? p.X1
  const oy = p.origin_Y1 ?? p.Y1
  const oz = p.origin_Z1 ?? p.Z1
  const oproj = p.origin_Projection1 ?? p.Projection1
  const sourceEpsg = normaliseEpsg(oproj)

  const offset = Number(config?.elevation_offsets?.[String(p.LevelReference)]) || 0
  const ozNum = Number(oz)
  const nz = (oz == null || !isFinite(ozNum)) ? oz : round2(ozNum + offset)

  const xy = reproject(Number(ox), Number(oy), sourceEpsg, target)
  const base = {
    ...p,
    origin_X1: ox, origin_Y1: oy, origin_Z1: oz, origin_Projection1: oproj,
    Z1: nz,
  }
  if (!xy) return base // keep original X/Y when the source CRS is unusable
  return { ...base, X1: round2(xy[0]), Y1: round2(xy[1]), Projection1: target }
}

// Apply to an array; returns the same array unchanged when there is no usable
// target CRS (so it's a cheap no-op when the project has no coordinate system).
export function applyCoordinateSystem(points, config) {
  if (!Array.isArray(points) || points.length === 0) return points
  if (!normaliseEpsg(config?.target_epsg)) return points
  return points.map(p => convertPoint(p, config))
}
