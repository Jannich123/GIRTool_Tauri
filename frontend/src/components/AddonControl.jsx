import { useState } from 'react'
import { useThrottledAddons } from '../lib/useThrottledAddons'

// On-map overlay control (M4.5a follow-up): a top-right panel listing the WMS
// addons for a map, each with a visibility checkbox (multi-select), ↑/↓ reorder
// (draw order = z-order), and a transparency slider.  A plain DOM overlay
// (rendered beside the map, not a Leaflet layer) so it can do what the built-in
// LayersControl can't (opacity + reorder).
//
// #218: slider drags commit through the throttled committer — the old
// per-input-tick saveMapAddons re-rendered every point marker (context
// update), wrote settings.json and emitted a cross-window event ~20× per drag.
//
// #286: sits in the top-right corner at the same 10px inset as the zoom
// buttons, and is a dropdown — collapsed shows just the "Map layers" header
// (with the layer count); click it to expand the list.
export default function AddonControl({ target }) {
  const { addons, updateThrottled, updateNow } = useThrottledAddons()
  const [open, setOpen] = useState(false)
  const list = addons.filter(a => a && a.maps?.[target])
  if (list.length === 0) return null

  // #222: the panel lists layers top-of-list = drawn ON TOP of the map.  The
  // addons array stores bottom→top (zIndex = 200 + array position), so the
  // display order is the reverse of storage order.
  const display = [...list].reverse()

  const patched = (id, patch) => addons.map(a => (a.id === id ? { ...a, ...patch } : a))

  // Move a layer within the same-target layers, keeping others in place.
  // dir +1 = later in the ARRAY = drawn further to the front.
  function move(id, dir) {
    const idxs = addons.map((a, i) => (a && a.maps?.[target] ? i : -1)).filter(i => i >= 0)
    const subset = idxs.map(i => addons[i])
    const pos = subset.findIndex(a => a.id === id)
    const swap = pos + dir
    if (pos < 0 || swap < 0 || swap >= subset.length) return
    ;[subset[pos], subset[swap]] = [subset[swap], subset[pos]]
    const next = [...addons]
    idxs.forEach((gi, k) => { next[gi] = subset[k] })
    updateNow(next)
  }

  const btn = {
    padding: '0 .35rem', lineHeight: 1.5, fontSize: '.8rem',
    border: '1px solid var(--border, #cbd5e1)', borderRadius: 4,
    background: '#fff', cursor: 'pointer',
    color: '#111827', // #224: explicit black — the glyphs inherited an invisible colour
  }

  return (
    <div
      style={{
        position: 'absolute', top: 10, right: 10, zIndex: 1000,
        background: 'rgba(255,255,255,0.95)', borderRadius: 6,
        padding: open ? '.5rem .6rem' : '.3rem .55rem',
        boxShadow: '0 1px 4px rgba(0,0,0,.25)',
        fontSize: '.75rem', width: open ? 220 : 'auto',
      }}
    >
      <div
        onClick={() => setOpen(o => !o)}
        title={open ? 'Collapse' : 'Show map layers'}
        style={{
          fontWeight: 700, cursor: 'pointer', userSelect: 'none',
          display: 'flex', alignItems: 'center', gap: '.4rem', whiteSpace: 'nowrap',
          marginBottom: open ? '.3rem' : 0,
        }}
      >
        <span style={{ width: 9, color: '#475569', fontSize: '.7rem' }}>{open ? '▾' : '▸'}</span>
        Map layers
        <span style={{ fontWeight: 400, color: '#64748b' }}>
          {open ? '(top = in front)' : `(${list.length})`}
        </span>
      </div>
      {open && display.map((a, i) => (
        <div key={a.id} style={{ marginBottom: '.45rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.35rem' }}>
            <input
              type="checkbox" checked={a.visible !== false}
              onChange={() => updateNow(patched(a.id, { visible: a.visible === false }))}
            />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.name}>
              {a.name}
            </span>
            <button style={btn} disabled={i === 0} onClick={() => move(a.id, +1)} title="Bring forward (draw above)">↑</button>
            <button style={btn} disabled={i === display.length - 1} onClick={() => move(a.id, -1)} title="Send backward (draw below)">↓</button>
          </div>
          {a.visible !== false && (
            <input
              type="range" min="0" max="1" step="0.05"
              value={typeof a.opacity === 'number' ? a.opacity : 1}
              onChange={e => updateThrottled(patched(a.id, { opacity: parseFloat(e.target.value) }))}
              style={{ width: '100%' }}
              title="Transparency"
            />
          )}
        </div>
      ))}
    </div>
  )
}
