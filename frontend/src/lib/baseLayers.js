// Built-in background map layers (M4.5a follow-up).  Merged into the same
// `mapAddons` list as user WMS addons so base maps + addons share one panel
// (multi-select, reorder, transparency).  XYZ = tile layer, WMS = WMSTileLayer.
//
// The Danish base maps are Dataforsyningen WMS (public API tokens, same as the
// old base-layer control).  Default: OpenStreetMap on, the rest off.
export const BUILTIN_LAYERS = [
  { id: 'base_osm',  name: 'OpenStreetMap',    type: 'xyz', url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, builtin: true },
  { id: 'base_esri', name: 'Aerial (Esri)',    type: 'xyz', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZoom: 19, builtin: true },
  { id: 'base_dk_ortho', name: 'Orthophoto (DK)', type: 'wms', url: 'https://api.dataforsyningen.dk/orto_foraar_DAF',    layer: 'orto_foraar',    format: 'image/jpeg', token: '3fb3906a5fd463fa23e041854d827723', transparent: false, maxZoom: 21, builtin: true },
  { id: 'base_dk_topo',  name: 'Topo map (DK)',   type: 'wms', url: 'https://api.dataforsyningen.dk/topo_skaermkort_DAF', layer: 'topo_skaermkort', format: 'image/png',  token: 'ff95a717c7d986d1bcf2f4187753a8ab', transparent: false, maxZoom: 21, builtin: true },
]

// Merge saved layers with the built-ins: keep the saved array order + each
// built-in's saved state (visible / opacity / maps) while refreshing its static
// fields from code, then append any built-ins not yet saved (OSM on by default).
export function mergeBuiltins(saved) {
  const arr = Array.isArray(saved) ? saved.slice() : []
  const ids = new Set(arr.map(a => a && a.id))
  const merged = arr.map(a => {
    const def = a && a.builtin && BUILTIN_LAYERS.find(b => b.id === a.id)
    return def
      ? { ...def, maps: a.maps || { project: true, selection: true }, visible: !!a.visible, opacity: typeof a.opacity === 'number' ? a.opacity : 1 }
      : a
  })
  BUILTIN_LAYERS.forEach((b, i) => {
    if (!ids.has(b.id)) {
      merged.push({ ...b, maps: { project: true, selection: true }, visible: i === 0, opacity: 1 })
    }
  })
  return merged
}
