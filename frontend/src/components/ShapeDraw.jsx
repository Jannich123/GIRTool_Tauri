import { useEffect, useRef, useState } from 'react'
import '@geoman-io/leaflet-geoman-free'
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css'
import { invoke } from '../tauri-api'
import { useThrottledAddons } from '../lib/useThrottledAddons'
import { useShapeTools } from '../lib/shapeTools'

// Draw a line or polygon on the map and save it as a Map addon (#320, #330,
// #334). Rendered inline in each map's toolbar (takes the Leaflet map instance
// as a prop). On the project map both shapes are offered; the selection map
// shows only the line here because it has its own ✏ Polygon (temp draw → load /
// select inside). Selection / edit / offset / delete live in ShapeActions; this
// is draw-only. Also clears the selection when the user clicks empty map.
export default function ShapeDraw({ map, target }) {
  const { addons, updateNow } = useThrottledAddons()
  const addonsRef = useRef(addons)
  addonsRef.current = addons
  const { selected, setSelected, editing, suppressDeselectRef } = useShapeTools()

  const [drawing, setDrawing] = useState(null)   // 'Polygon' | 'Line' | null
  const [pending, setPending] = useState(null)   // { gj } awaiting a name
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const drawingRef = useRef(drawing)
  drawingRef.current = drawing

  // geoman draw → capture the finished shape for naming.
  useEffect(() => {
    if (!map?.pm) return undefined
    const onCreate = (e) => {
      const shape = drawingRef.current
      let gj
      try { gj = e.layer.toGeoJSON() } catch { gj = null }
      try { map.removeLayer(e.layer) } catch { /* gone */ }
      try { map.pm.disableDraw() } catch { /* idle */ }
      setDrawing(null)
      if (!gj) return
      setPending({ gj }); setName(shape === 'Polygon' ? 'Polygon' : 'Line'); setMsg('')
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

  function startDraw(shape) {
    if (!map?.pm || pending) return
    try { map.pm.disableDraw() } catch { /* idle */ }
    if (drawing === shape) { setDrawing(null); return }   // toggle off
    map.pm.enableDraw(shape, { snappable: true, continueDrawing: false })
    setDrawing(shape)
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
    const kind = pending.gj?.geometry?.type === 'Polygon' ? 'polygon' : 'line'
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem', flexWrap: 'wrap' }}>
        <span className="hint" style={{ margin: 0 }}>Name the {kind}:</span>
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

  const activeBtn = { background: '#2563eb', borderColor: '#2563eb', color: '#fff' }
  return (
    <>
      {/* The selection map has its own ✏ Polygon (temp draw → load/select inside);
          only the project map draws+saves a polygon addon from here (#334). */}
      {target !== 'selection' && (
        <button
          className="btn-secondary btn-sm"
          onClick={() => startDraw('Polygon')}
          style={drawing === 'Polygon' ? activeBtn : undefined}
          title="Draw a polygon, double-click to finish; saved as a map addon"
        >
          ✏ Polygon{drawing === 'Polygon' ? ' — drawing…' : ''}
        </button>
      )}
      <button
        className="btn-secondary btn-sm"
        onClick={() => startDraw('Line')}
        style={drawing === 'Line' ? activeBtn : undefined}
        title="Draw a line, double-click to finish; saved as a map addon"
      >
        ／ Line{drawing === 'Line' ? ' — drawing…' : ''}
      </button>
    </>
  )
}
