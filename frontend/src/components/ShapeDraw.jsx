import { useEffect, useRef, useState } from 'react'
import '@geoman-io/leaflet-geoman-free'
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css'
import { invoke } from '../tauri-api'
import { useThrottledAddons } from '../lib/useThrottledAddons'
import { useShapeTools } from '../lib/shapeTools'

// Draw a line on the map and save it as a Map addon (#320, #330). Rendered
// inline in each map's toolbar (takes the Leaflet map instance as a prop).
// Selection / edit / offset / delete live in ShapeActions; this is draw-only.
// Also clears the selection when the user clicks empty map.
export default function ShapeDraw({ map, target }) {
  const { addons, updateNow } = useThrottledAddons()
  const addonsRef = useRef(addons)
  addonsRef.current = addons
  const { selected, setSelected, editing, suppressDeselectRef } = useShapeTools()

  const [drawing, setDrawing] = useState(false)
  const [pending, setPending] = useState(null)   // { gj } awaiting a name
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  // geoman draw → capture the finished line for naming.
  useEffect(() => {
    if (!map?.pm) return undefined
    const onCreate = (e) => {
      let gj
      try { gj = e.layer.toGeoJSON() } catch { gj = null }
      try { map.removeLayer(e.layer) } catch { /* gone */ }
      try { map.pm.disableDraw() } catch { /* idle */ }
      setDrawing(false)
      if (!gj) return
      setPending({ gj }); setName('Line'); setMsg('')
    }
    map.on('pm:create', onCreate)
    return () => {
      map.off('pm:create', onCreate)
      try { map.pm.disableDraw() } catch { /* idle */ }
    }
  }, [map])

  // #330: click on empty map → deselect (not while drawing / editing).
  const selRef = useRef({ selected, editing, drawing, pending })
  selRef.current = { selected, editing, drawing, pending }
  useEffect(() => {
    if (!map) return undefined
    const onMapClick = () => {
      // #332: skip the deselect that fires in the same event as a shape click.
      if (suppressDeselectRef.current) { suppressDeselectRef.current = false; return }
      const s = selRef.current
      if (s.selected && !s.editing && !s.drawing && !s.pending) setSelected(null)
    }
    map.on('click', onMapClick)
    return () => { map.off('click', onMapClick) }
  }, [map, setSelected])

  function startLine() {
    if (!map?.pm || pending) return
    try { map.pm.disableDraw() } catch { /* idle */ }
    if (drawing) { setDrawing(false); return }
    map.pm.enableDraw('Line', { snappable: true, continueDrawing: false })
    setDrawing(true)
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

  if (!map) return null

  if (pending) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem', flexWrap: 'wrap' }}>
        <span className="hint" style={{ margin: 0 }}>Name the line:</span>
        <input
          autoFocus value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') savePending(); if (e.key === 'Escape') discardPending() }}
          placeholder="name" style={{ width: 120, padding: '.25rem .4rem', borderRadius: 4, border: '1px solid #cbd5e1' }}
        />
        <button className="btn-primary btn-sm" disabled={busy || !name.trim()} onClick={savePending}>{busy ? '…' : 'Save'}</button>
        <button className="btn-secondary btn-sm" disabled={busy} onClick={discardPending}>Discard</button>
        {msg && <span style={{ color: '#dc2626', fontSize: '.8rem' }}>{msg}</span>}
      </span>
    )
  }

  return (
    <button
      className="btn-secondary btn-sm"
      onClick={startLine}
      style={drawing ? { background: '#2563eb', borderColor: '#2563eb', color: '#fff' } : undefined}
      title="Draw a line, double-click to finish; saved as a map addon"
    >
      ／ Line{drawing ? ' — drawing…' : ''}
    </button>
  )
}
