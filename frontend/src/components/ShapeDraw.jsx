import { useEffect, useRef, useState } from 'react'
import '@geoman-io/leaflet-geoman-free'
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css'
import { invoke } from '../tauri-api'
import { useThrottledAddons } from '../lib/useThrottledAddons'
import { useShapeTools } from '../lib/shapeTools'

// On-map shape tools (#320, #322, #324): draw a Polygon / Line → save as a Map
// addon, and a Select mode to pick an addon shape (highlighted) and Delete it.
// Built on leaflet-geoman. Rendered INLINE in each map's page toolbar (the two
// button areas are merged), so it takes the Leaflet map instance as a prop
// rather than living inside <MapContainer>.
export default function ShapeDraw({ map, target }) {
  const { addons, updateNow } = useThrottledAddons()
  const addonsRef = useRef(addons)
  addonsRef.current = addons
  const { mode, setMode, selected, setSelected } = useShapeTools()

  const [drawing, setDrawing] = useState(null)   // 'Polygon' | 'Line' | null
  const [pending, setPending] = useState(null)   // { gj } awaiting a name
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  // Reset tool state when the map goes away (leaving the page).
  useEffect(() => () => { setMode(null); setSelected(null) }, [setMode, setSelected])

  // geoman draw → capture the finished shape for naming.
  useEffect(() => {
    if (!map?.pm) return undefined
    const onCreate = (e) => {
      let gj
      try { gj = e.layer.toGeoJSON() } catch { gj = null }
      try { map.removeLayer(e.layer) } catch { /* gone */ }
      try { map.pm.disableDraw() } catch { /* idle */ }
      setDrawing(null)
      if (!gj) return
      setPending({ gj }); setName(e.shape === 'Line' ? 'Line' : 'Polygon'); setMsg('')
    }
    map.on('pm:create', onCreate)
    return () => {
      map.off('pm:create', onCreate)
      try { map.pm.disableDraw() } catch { /* idle */ }
    }
  }, [map])

  function startDraw(shape) {
    if (!map?.pm || pending) return
    setMode(null); setSelected(null)
    try { map.pm.disableDraw() } catch { /* idle */ }
    if (drawing === shape) { setDrawing(null); return }
    map.pm.enableDraw(shape, { snappable: true, continueDrawing: false })
    setDrawing(shape)
  }

  function toggleSelect() {
    if (pending) return
    try { map?.pm?.disableDraw() } catch { /* idle */ }
    setDrawing(null)
    if (mode === 'select') { setMode(null); setSelected(null) }
    else setMode('select')
  }

  async function savePending() {
    if (!pending || !name.trim()) return
    setBusy(true); setMsg('')
    try {
      const entry = await invoke('save_geojson_addon', {
        req: { name: name.trim(), geojson: pending.gj, epsg: 4326, maps: { project: true, selection: true } },
      })
      updateNow([...(addonsRef.current || []), entry])
      setPending(null); setName('')
    } catch (err) {
      setMsg(String(err).slice(0, 160))
    } finally {
      setBusy(false)
    }
  }

  function discardPending() { setPending(null); setName(''); setMsg('') }

  async function deleteSelected() {
    if (!selected) return
    const list = addonsRef.current || []
    const addon = list.find(a => a.id === selected.id)
    updateNow(list.filter(a => a.id !== selected.id))
    if (addon?.file) { try { await invoke('delete_addon_file', { file: addon.file }) } catch { /* best-effort */ } }
    setSelected(null)
  }

  if (!map) return null

  const btn = (active, disabled) => ({
    padding: '.3rem .6rem', borderRadius: 6, cursor: disabled ? 'default' : 'pointer',
    border: '1px solid #cbd5e1', font: 'inherit', fontSize: '.82rem',
    background: active ? '#2563eb' : '#fff', color: active ? '#fff' : '#111827',
    opacity: disabled ? 0.5 : 1,
  })

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem', flexWrap: 'wrap' }}>
      {pending ? (
        <>
          <span style={{ color: '#475569' }}>Save shape as addon:</span>
          <input
            autoFocus value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') savePending(); if (e.key === 'Escape') discardPending() }}
            placeholder="name" style={{ width: 120, padding: '.25rem .4rem', borderRadius: 4, border: '1px solid #cbd5e1' }}
          />
          <button style={btn(true, busy || !name.trim())} disabled={busy || !name.trim()} onClick={savePending}>{busy ? '…' : 'Save'}</button>
          <button style={btn(false, busy)} disabled={busy} onClick={discardPending}>Discard</button>
        </>
      ) : (
        <>
          <button style={btn(drawing === 'Polygon')} onClick={() => startDraw('Polygon')} title="Draw a polygon, double-click to finish; saved as a map addon">✏ Polygon</button>
          <button style={btn(drawing === 'Line')} onClick={() => startDraw('Line')} title="Draw a line, double-click to finish; saved as a map addon">／ Line</button>
          <button style={btn(mode === 'select')} onClick={toggleSelect} title="Select a shape on the map to delete it">☝ Select</button>
          {drawing && <span style={{ color: '#64748b' }}>click to add points, double-click to finish · Esc cancels</span>}
          {mode === 'select' && !selected && <span style={{ color: '#64748b' }}>click a shape to select it</span>}
          {mode === 'select' && selected && (
            <>
              <span style={{ color: '#475569' }}>Selected: <strong>{selected.name}</strong></span>
              <button style={{ ...btn(false, busy), borderColor: '#fecaca', color: '#b91c1c' }} disabled={busy} onClick={deleteSelected}>🗑 Delete</button>
              <button style={btn(false, busy)} disabled={busy} onClick={() => setSelected(null)}>Clear</button>
            </>
          )}
        </>
      )}
      {msg && <span style={{ color: '#dc2626' }}>{msg}</span>}
    </span>
  )
}
