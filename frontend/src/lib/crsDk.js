import L from 'leaflet'
import 'proj4leaflet'
import { PROJ_DEFS } from './proj'

// Danish Kortforsyning/Datafordeler tile grid (#232).
//
// The official Danish WMTS services (Skærmkort, Ortofoto, …) only publish
// EPSG:25832 tile matrix sets — View1 and KortforsyningTilingDK share the
// SAME grid: origin (120000, 6500000), scale denominators 5 851 428.57 → …,
// i.e. resolutions 1638.4 … 0.05 m/px (× 0.00028).  Verified from both
// services' GetCapabilities.  Topo stops at level 13 (maxNativeZoom);
// orthophoto goes to 15.
//
// Both Leaflet maps run in THIS grid: WMTS tiles drop in natively, WMS
// layers (GEUS etc.) are requested in EPSG:25832 — their native CRS — and
// vector layers (markers, GeoJSON, draws) are CRS-agnostic.  The price:
// web-mercator-only XYZ tiles (OSM, Esri) cannot render on this grid, so
// they are no longer built-ins.
export const DK_RESOLUTIONS = [
  1638.4, 819.2, 409.6, 204.8, 102.4, 51.2, 25.6, 12.8,
  6.4, 3.2, 1.6, 0.8, 0.4, 0.2, 0.1, 0.05,
]

export const DK_MAX_ZOOM = DK_RESOLUTIONS.length - 1 // 15

export const CRS_DK = new L.Proj.CRS(
  'EPSG:25832',
  PROJ_DEFS['EPSG:25832'],
  { origin: [120000, 6500000], resolutions: DK_RESOLUTIONS },
)

// Whole-country default view (≈ Denmark at 400 m/px).
export const DK_CENTER = [56.0, 10.5]
export const DK_DEFAULT_ZOOM = 2

// Clamp a persisted zoom (older sessions stored web-mercator zooms up to 19).
export const clampDkZoom = (z) =>
  Math.max(0, Math.min(DK_MAX_ZOOM, Number.isFinite(Number(z)) ? Number(z) : DK_DEFAULT_ZOOM))

// ── Dynamic grid selection (#234) ────────────────────────────────────────────
// A Leaflet map renders exactly ONE tile grid.  OSM/Esri only exist in
// web-mercator; the Danish WMTS only on the 25832 grid.  Rule: any visible
// XYZ layer targeted at this map → web-mercator (Danish maps fall back to
// WMS); otherwise → the Danish grid (WMTS).
export function mapGridFor(addons, target) {
  const merc = (Array.isArray(addons) ? addons : []).some(a =>
    a && a.type === 'xyz' && a.visible !== false && a.maps?.[target])
  return merc ? '3857' : 'dk'
}

export const MERC_DEFAULT_ZOOM = 7
export const clampMercZoom = (z) =>
  Math.max(0, Math.min(19, Number.isFinite(Number(z)) ? Number(z) : MERC_DEFAULT_ZOOM))
