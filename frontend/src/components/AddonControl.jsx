import { useApp } from '../context/AppContext'

// On-map overlay control (M4.5a follow-up): a top-right panel listing the WMS
// addons for a map, each with a visibility checkbox (multi-select), ↑/↓ reorder
// (draw order = z-order), and a transparency slider.  A plain DOM overlay
// (rendered beside the map, not a Leaflet layer) so it can do what the built-in
// LayersControl can't (opacity + reorder).
export default function AddonControl({ target }) {
  const { mapAddons, saveMapAddons } = useApp()
  const addons = Array.isArray(mapAddons) ? mapAddons : []
  const list = addons.filter(a => a && a.type === 'wms' && a.maps?.[target])
  if (list.length === 0) return null

  const update = (id, patch) => saveMapAddons(addons.map(a => (a.id === id ? { ...a, ...patch } : a)))

  // Move an addon up/down among the same-target addons, keeping others in place.
  function move(id, dir) {
    const idxs = addons.map((a, i) => (a && a.type === 'wms' && a.maps?.[target] ? i : -1)).filter(i => i >= 0)
    const subset = idxs.map(i => addons[i])
    const pos = subset.findIndex(a => a.id === id)
    const swap = pos + dir
    if (pos < 0 || swap < 0 || swap >= subset.length) return
    ;[subset[pos], subset[swap]] = [subset[swap], subset[pos]]
    const next = [...addons]
    idxs.forEach((gi, k) => { next[gi] = subset[k] })
    saveMapAddons(next)
  }

  const btn = {
    padding: '0 .35rem', lineHeight: 1.5, fontSize: '.8rem',
    border: '1px solid var(--border, #cbd5e1)', borderRadius: 4,
    background: '#fff', cursor: 'pointer',
  }

  return (
    <div
      style={{
        position: 'absolute', top: 48, right: 10, zIndex: 1000,
        background: 'rgba(255,255,255,0.95)', borderRadius: 6,
        padding: '.5rem .6rem', boxShadow: '0 1px 4px rgba(0,0,0,.25)',
        fontSize: '.75rem', width: 220,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: '.3rem' }}>Overlays</div>
      {list.map((a, i) => (
        <div key={a.id} style={{ marginBottom: '.45rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.35rem' }}>
            <input
              type="checkbox" checked={a.visible !== false}
              onChange={() => update(a.id, { visible: a.visible === false })}
            />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.name}>
              {a.name}
            </span>
            <button style={btn} disabled={i === 0} onClick={() => move(a.id, -1)} title="Move up">↑</button>
            <button style={btn} disabled={i === list.length - 1} onClick={() => move(a.id, 1)} title="Move down">↓</button>
          </div>
          <input
            type="range" min="0" max="1" step="0.05"
            value={typeof a.opacity === 'number' ? a.opacity : 1}
            onChange={e => update(a.id, { opacity: parseFloat(e.target.value) })}
            style={{ width: '100%' }}
            title="Transparency"
            disabled={a.visible === false}
          />
        </div>
      ))}
    </div>
  )
}
