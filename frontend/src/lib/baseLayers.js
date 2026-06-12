// Built-in background map layers (M4.5a follow-up).  Merged into the same
// `mapAddons` list as user addons so base maps + addons share one panel
// (multi-select, reorder, transparency).
//
// #232/#234 — DYNAMIC MAP GRID: the Danish WMTS services only exist on the
// Kortforsyning EPSG:25832 grid, while OpenStreetMap/Esri only exist in
// web-mercator, and a Leaflet map can render exactly one grid.  So the map
// picks its grid from what is visible (see mapGridFor in lib/crsDk.js):
//   · any visible XYZ layer (OSM / Esri) → web-mercator; the Danish base
//     maps then render through their WMS fallback (server-side 3857) —
//     exactly the pre-#233 setup;
//   · otherwise → the Danish grid, where the Danish maps use WMTS (cached
//     tiles, faster).
// Both Danish services expose TWO WMTS layers (regular + `_tls`) —
// selectable in Settings → Map addons.  Default: Topo map on.
export const BUILTIN_LAYERS = [
  {
    id: 'base_dk_topo_wmts', name: 'Topo map (DK)', type: 'wmts',
    url: 'https://api.dataforsyningen.dk/topo_skaermkort_wmts_DAF',
    layer: 'topo_skaermkort', layers: ['topo_skaermkort', 'topo_skaermkort_tls'],
    tilematrixset: 'View1', style: 'default', format: 'image/jpeg',
    token: 'ff95a717c7d986d1bcf2f4187753a8ab',
    maxNativeZoom: 13, builtin: true,
    // Used when the map runs in web-mercator (OSM/Esri visible).
    wmsFallback: {
      url: 'https://api.dataforsyningen.dk/topo_skaermkort_DAF',
      layer: 'topo_skaermkort', format: 'image/png', transparent: false, maxZoom: 21,
    },
  },
  {
    id: 'base_dk_ortho_wmts', name: 'Orthophoto (DK)', type: 'wmts',
    url: 'https://api.dataforsyningen.dk/orto_foraar_wmts_DAF',
    layer: 'orto_foraar_wmts', layers: ['orto_foraar_wmts', 'orto_foraar_wmts_tls'],
    tilematrixset: 'KortforsyningTilingDK', style: 'default', format: 'image/jpeg',
    token: '3fb3906a5fd463fa23e041854d827723',
    builtin: true,
    wmsFallback: {
      url: 'https://api.dataforsyningen.dk/orto_foraar_DAF',
      layer: 'orto_foraar', format: 'image/jpeg', transparent: false, maxZoom: 21,
    },
  },
  { id: 'base_osm',  name: 'OpenStreetMap', type: 'xyz', url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, builtin: true },
  { id: 'base_esri', name: 'Aerial (Esri)', type: 'xyz', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZoom: 19, builtin: true },
]

// Merge saved layers with the built-ins: keep the saved array order + each
// built-in's saved state (visible / opacity / maps / layer + token overrides)
// while refreshing its other static fields from code; drop saved built-ins
// that no longer exist (the retired #233 WMS pair); then append any built-ins
// not yet saved (Topo on by default).
export function mergeBuiltins(saved) {
  const arr = (Array.isArray(saved) ? saved.slice() : [])
    .filter(a => a && (!a.builtin || BUILTIN_LAYERS.some(b => b.id === a.id)))
  const ids = new Set(arr.map(a => a && a.id))
  const merged = arr.map(a => {
    const def = a && a.builtin && BUILTIN_LAYERS.find(b => b.id === a.id)
    return def
      ? {
          ...def,
          maps: a.maps || { project: true, selection: true },
          visible: !!a.visible,
          opacity: typeof a.opacity === 'number' ? a.opacity : 1,
          ...(a.layer && (def.layers || []).includes(a.layer) ? { layer: a.layer } : {}),
          ...(a.token ? { token: a.token } : {}),
        }
      : a
  })
  BUILTIN_LAYERS.forEach((b, i) => {
    if (!ids.has(b.id)) {
      merged.push({ ...b, maps: { project: true, selection: true }, visible: i === 0, opacity: 1 })
    }
  })
  return merged
}
