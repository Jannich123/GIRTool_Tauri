// Built-in background map layers (M4.5a follow-up).  Merged into the same
// `mapAddons` list as user addons so base maps + addons share one panel
// (multi-select, reorder, transparency).
//
// #232: the maps run on the Danish EPSG:25832 tile grid (see lib/crsDk.js),
// so the built-ins are the official Dataforsyningen WMTS services (cached
// tiles — faster than the old WMS GetMap).  Both expose TWO layers (regular
// + `_tls` variant) — selectable in Settings → Map addons.  Web-mercator-only
// XYZ tiles (OpenStreetMap, Esri) cannot render on this grid and were
// retired; stale saved entries for them are dropped in mergeBuiltins.
// Default: Topo map on, Orthophoto off.
export const BUILTIN_LAYERS = [
  {
    id: 'base_dk_topo_wmts', name: 'Topo map (DK)', type: 'wmts',
    url: 'https://api.dataforsyningen.dk/topo_skaermkort_wmts_DAF',
    layer: 'topo_skaermkort', layers: ['topo_skaermkort', 'topo_skaermkort_tls'],
    tilematrixset: 'View1', style: 'default', format: 'image/jpeg',
    token: 'ff95a717c7d986d1bcf2f4187753a8ab',
    maxNativeZoom: 13, builtin: true,
  },
  {
    id: 'base_dk_ortho_wmts', name: 'Orthophoto (DK)', type: 'wmts',
    url: 'https://api.dataforsyningen.dk/orto_foraar_wmts_DAF',
    layer: 'orto_foraar_wmts', layers: ['orto_foraar_wmts', 'orto_foraar_wmts_tls'],
    tilematrixset: 'KortforsyningTilingDK', style: 'default', format: 'image/jpeg',
    token: '3fb3906a5fd463fa23e041854d827723',
    builtin: true,
  },
]

// Merge saved layers with the built-ins: keep the saved array order + each
// built-in's saved state (visible / opacity / maps / layer + token overrides)
// while refreshing its other static fields from code; drop saved built-ins
// that no longer exist (e.g. the retired OSM/Esri/WMS entries, #232); then
// append any built-ins not yet saved (Topo on by default).
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
