import { useRef, useState } from 'react'
import buffer from '@turf/buffer'
import { invoke } from '../tauri-api'
import { reprojectGeoJSON } from '../lib/proj'
import { useThrottledAddons } from '../lib/useThrottledAddons'
import { useShapeTools } from '../lib/shapeTools'

// Contextual shape buttons (#330) — shown in the toolbar's second row when a
// shape is selected (click) or being edited (double-click). Map-independent:
// works off the shared shapeTools context + the addon list. Renders nothing
// when there's no selection / edit in progress.
export default function ShapeActions() {
  const { addons, updateNow } = useThrottledAddons()
  const addonsRef = useRef(addons)
  addonsRef.current = addons
  const { selected, setSelected, editing, setEditing, editLayerRef, reloadRef } = useShapeTools()

  const [offsetM, setOffsetM] = useState('5')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function saveEdit() {
    const id = editing
    const layer = editLayerRef.current
    if (!id || !layer) { setEditing(null); return }
    setBusy(true); setMsg('')
    try {
      const gj = layer.toGeoJSON() // WGS84 from the map
      const addon = (addonsRef.current || []).find(a => a.id === id)
      if (!addon) throw new Error('Shape no longer exists.')
      await invoke('update_addon_geojson', { req: { file: addon.file, geojson: gj } })
      updateNow((addonsRef.current || []).map(a => (a.id === id ? { ...a, epsg: 4326 } : a)))
      setEditing(null)
      reloadRef.current?.(id, true)
    } catch (err) {
      setMsg(String(err).slice(0, 160))
    } finally {
      setBusy(false)
    }
  }

  function cancelEdit() {
    const id = editing
    setEditing(null)
    reloadRef.current?.(id, false)
  }

  async function deleteSelected() {
    if (!selected) return
    const list = addonsRef.current || []
    const addon = list.find(a => a.id === selected.id)
    updateNow(list.filter(a => a.id !== selected.id))
    if (addon?.file) { try { await invoke('delete_addon_file', { file: addon.file }) } catch { /* best-effort */ } }
    setSelected(null)
  }

  async function offsetSelected() {
    if (!selected) return
    const m = parseFloat(String(offsetM).replace(',', '.'))
    if (!isFinite(m) || m <= 0) { setMsg('Enter a positive offset in metres.'); return }
    setBusy(true); setMsg('')
    try {
      const gj = await invoke('load_addon_geojson', { file: selected.file })
      const gj4326 = reprojectGeoJSON(gj, selected.epsg ?? 25832)
      const poly = buffer(gj4326, m, { units: 'meters' })
      if (!poly) throw new Error('Offset produced no geometry.')
      const entry = await invoke('save_geojson_addon', {
        req: { name: `${selected.name} +${m}m`, geojson: poly, epsg: 4326, maps: { project: true, selection: true } },
      })
      updateNow([...(addonsRef.current || []), entry])
    } catch (err) {
      setMsg(String(err).slice(0, 160))
    } finally {
      setBusy(false)
    }
  }

  if (!editing && !selected) return null

  if (editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.45rem', flexWrap: 'wrap' }}>
        <span className="hint" style={{ margin: 0 }}>Editing <strong>{selected?.name || 'shape'}</strong> — drag a vertex; drag a segment midpoint to add one</span>
        <button className="btn-primary btn-sm" disabled={busy} onClick={saveEdit}>{busy ? '…' : '✓ Save'}</button>
        <button className="btn-secondary btn-sm" disabled={busy} onClick={cancelEdit}>✕ Cancel</button>
        {msg && <span style={{ color: '#dc2626', fontSize: '.8rem' }}>{msg}</span>}
      </span>
    )
  }

  const isLine = selected.type === 'LineString' || selected.type === 'MultiLineString'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.45rem', flexWrap: 'wrap' }}>
      <span className="hint" style={{ margin: 0 }}>Selected <strong>{selected.name}</strong>:</span>
      <button className="btn-secondary btn-sm" disabled={busy} onClick={() => setEditing(selected.id)} title="Edit the vertices (or double-click the shape)">✎ Edit</button>
      {isLine && (
        <>
          <span className="hint" style={{ margin: 0 }}>offset</span>
          <input value={offsetM} onChange={e => setOffsetM(e.target.value)} title="Offset in metres (each side)"
            style={{ width: 52, padding: '.2rem .35rem', borderRadius: 4, border: '1px solid #cbd5e1' }} />
          <span className="hint" style={{ margin: 0 }}>m</span>
          <button className="btn-secondary btn-sm" disabled={busy} onClick={offsetSelected} title="Offset the line both sides into a corridor polygon">↔ Offset → polygon</button>
        </>
      )}
      <button className="btn-secondary btn-sm" style={{ color: '#b91c1c' }} disabled={busy} onClick={deleteSelected}>🗑 Delete</button>
      <button className="btn-secondary btn-sm" disabled={busy} onClick={() => setSelected(null)}>Clear</button>
      {msg && <span style={{ color: '#dc2626', fontSize: '.8rem' }}>{msg}</span>}
    </span>
  )
}
