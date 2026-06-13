import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import '@geoman-io/leaflet-geoman-free'
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css'
import { invoke } from '../tauri-api'
import { useThrottledAddons } from '../lib/useThrottledAddons'

// Draw a polygon / line on the map and save it as a GeoJSON Map addon (#320).
// Uses leaflet-geoman for the drawing; the finished shape is named inline and
// written via save_geojson_addon, then rendered + persisted like an imported
// addon.  Lives INSIDE <MapContainer> (uses useMap); the toolbar is portaled
// into the map container, top-centre.
export default function ShapeDraw({ target }) {
  const map = useMap()
  const { addons, updateNow } = useThrottledAddons()
  const addonsRef = useRef(addons)
  addonsRef.current = addons

  const [host] = useState(() => document.createElement('div'))
  const [drawing, setDrawing] = useState(null)   // 'Polygon' | 'Line' | null
  const [pending, setPending] = useState(null)   // { gj, shape } awaiting a name
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  // Mount the toolbar overlay.
  useEffect(() => {
    host.className = 'shape-draw-host'
    const parent = map.getContainer()
    parent.appendChild(host)
    L.DomEvent.disableClickPropagation(host)
    L.DomEvent.disableScrollPropagation(host)
    return () => { try { parent.removeChild(host) } catch { /* gone */ } }
  }, [map, host])

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
      setPending({ gj, shape: e.shape })
      setName(e.shape === 'Line' ? 'Line' : 'Polygon')
      setMsg('')
    }
    map.on('pm:create', onCreate)
    return () => {
      map.off('pm:create', onCreate)
      try { map.pm.disableDraw() } catch { /* idle */ }
    }
  }, [map])

  function startDraw(shape) {
    if (!map?.pm || pending) return
    try { map.pm.disableDraw() } catch { /* idle */ }
    if (drawing === shape) { setDrawing(null); return }
    map.pm.enableDraw(shape, { snappable: true, continueDrawing: false })
    setDrawing(shape)
  }

  async function savePending() {
    if (!pending || !name.trim()) return
    setBusy(true); setMsg('')
    try {
      const entry = await invoke('save_geojson_addon', {
        req: {
          name: name.trim(),
          geojson: pending.gj,
          epsg: 4326, // geoman draws in WGS84 lat/lng
          maps: { project: true, selection: true },
        },
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

  const btn = (activeFlag) => ({
    padding: '.3rem .6rem', borderRadius: 6, cursor: pending ? 'default' : 'pointer',
    border: '1px solid #cbd5e1', font: 'inherit', fontSize: '.8rem',
    background: activeFlag ? '#2563eb' : '#fff', color: activeFlag ? '#fff' : '#111827',
    opacity: pending ? 0.5 : 1,
  })

  const ui = (
    <div style={{
      position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 1000,
      display: 'flex', alignItems: 'center', gap: '.4rem',
      background: 'rgba(255,255,255,0.96)', borderRadius: 8, padding: '.35rem .5rem',
      boxShadow: '0 1px 4px rgba(0,0,0,.28)', fontSize: '.8rem', whiteSpace: 'nowrap',
    }}>
      {!pending ? (
        <>
          <button style={btn(drawing === 'Polygon')} onClick={() => startDraw('Polygon')} title="Draw a polygon, then double-click to finish">✏ Polygon</button>
          <button style={btn(drawing === 'Line')} onClick={() => startDraw('Line')} title="Draw a line, then double-click to finish">／ Line</button>
          {drawing && <span style={{ color: '#64748b' }}>click to add points, double-click to finish · Esc cancels</span>}
        </>
      ) : (
        <>
          <span style={{ color: '#475569' }}>Save shape as addon:</span>
          <input
            autoFocus value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') savePending(); if (e.key === 'Escape') discardPending() }}
            placeholder="name" style={{ width: 130, padding: '.25rem .4rem', borderRadius: 4, border: '1px solid #cbd5e1' }}
          />
          <button style={{ ...btn(false), background: '#2563eb', color: '#fff', opacity: 1 }} disabled={busy || !name.trim()} onClick={savePending}>{busy ? '…' : 'Save'}</button>
          <button style={{ ...btn(false), opacity: 1 }} disabled={busy} onClick={discardPending}>Discard</button>
        </>
      )}
      {msg && <span style={{ color: '#dc2626' }}>{msg}</span>}
    </div>
  )

  return createPortal(ui, host)
}
