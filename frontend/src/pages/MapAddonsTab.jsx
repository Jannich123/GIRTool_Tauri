import { useState } from 'react'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'

// Issue #169 (M4.5a) — Map addons Settings subtab.
//
// Manage overlay layers shown on the project / selection maps.  This slice
// supports WMS overlays (URL + layer name + target maps); local-file
// (shapefile / CSV / Excel → GeoJSON) addons arrive in M4.5b.

export default function MapAddonsTab() {
  const { mapAddons, saveMapAddons, connection } = useApp()
  const hasFolder = !!connection?.output_folder
  const addons = Array.isArray(mapAddons) ? mapAddons : []

  const [form, setForm] = useState({ name: '', url: '', layer: '', project: true, selection: true })
  const [msg, setMsg] = useState(null)
  const [layers, setLayers] = useState([])           // [{ name, title }] from GetCapabilities
  const [connecting, setConnecting] = useState(false)
  const [connectMsg, setConnectMsg] = useState(null)

  async function connect() {
    setConnectMsg(null); setConnecting(true)
    try {
      const list = await invoke('wms_capabilities', { url: form.url.trim() })
      const arr = Array.isArray(list) ? list : []
      setLayers(arr)
      setConnectMsg({ ok: arr.length > 0, text: `${arr.length} layer${arr.length === 1 ? '' : 's'} found` })
    } catch (e) {
      setLayers([]); setConnectMsg({ ok: false, text: String(e).slice(0, 160) })
    } finally {
      setConnecting(false)
    }
  }

  function addAddon() {
    setMsg(null)
    if (!form.name.trim() || !form.url.trim()) {
      setMsg({ ok: false, text: 'Name and service URL are required.' })
      return
    }
    if (!form.project && !form.selection) {
      setMsg({ ok: false, text: 'Pick at least one target map.' })
      return
    }
    const addon = {
      id: `addon_${Date.now()}_${Math.floor(Math.random() * 1e4)}`,
      name: form.name.trim(),
      type: 'wms',
      url: form.url.trim(),
      layer: form.layer.trim(),
      maps: { project: form.project, selection: form.selection },
      visible: true,
    }
    saveMapAddons([...addons, addon])
    setForm({ name: '', url: '', layer: '', project: true, selection: true })
    setMsg({ ok: true, text: `Added "${addon.name}".` })
  }

  const update = (id, patch) => saveMapAddons(addons.map(a => (a.id === id ? { ...a, ...patch } : a)))
  const toggleMap = (id, which) => {
    const a = addons.find(x => x.id === id)
    if (a) update(id, { maps: { ...a.maps, [which]: !a.maps?.[which] } })
  }
  const remove = (id) => saveMapAddons(addons.filter(a => a.id !== id))

  return (
    <div style={{ maxWidth: 920 }}>
      <h3 className="section-title">Map addons</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        Overlay layers for the Project map and the Selection map. This adds <strong>WMS</strong> services;
        local files (shapefile / CSV / Excel) come in a later update.
      </p>

      {/* Existing addons */}
      {addons.length === 0 ? (
        <p className="hint">No addons yet.</p>
      ) : (
        <table className="data-table" style={{ maxWidth: 900, marginBottom: '1rem' }}>
          <thead>
            <tr>
              <th>Name</th><th>Type</th><th>Layer</th>
              <th style={{ width: 70, textAlign: 'center' }}>Project</th>
              <th style={{ width: 80, textAlign: 'center' }}>Selection</th>
              <th style={{ width: 70, textAlign: 'center' }}>Visible</th>
              <th style={{ width: 60 }} />
            </tr>
          </thead>
          <tbody>
            {addons.map(a => (
              <tr key={a.id}>
                <td title={a.url}>{a.name}</td>
                <td>{(a.type || 'wms').toUpperCase()}</td>
                <td style={{ fontSize: '.8rem' }}>{a.layer || '—'}</td>
                <td style={{ textAlign: 'center' }}>
                  <input type="checkbox" checked={!!a.maps?.project} onChange={() => toggleMap(a.id, 'project')} />
                </td>
                <td style={{ textAlign: 'center' }}>
                  <input type="checkbox" checked={!!a.maps?.selection} onChange={() => toggleMap(a.id, 'selection')} />
                </td>
                <td style={{ textAlign: 'center' }}>
                  <input type="checkbox" checked={a.visible !== false} onChange={() => update(a.id, { visible: a.visible === false })} />
                </td>
                <td>
                  <button className="btn-secondary btn-sm" onClick={() => remove(a.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Add WMS addon */}
      <h4 style={{ margin: '0 0 .5rem' }}>Add WMS overlay</h4>
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '.5rem .75rem', alignItems: 'center', maxWidth: 720 }}>
        <label>Name</label>
        <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Cadastre" />
        <label>Service URL</label>
        <div style={{ display: 'flex', gap: '.4rem' }}>
          <input
            type="text" value={form.url}
            onChange={e => { setForm({ ...form, url: e.target.value }); setLayers([]); setConnectMsg(null) }}
            placeholder="https://…/wms" style={{ flex: 1 }}
          />
          <button className="btn-secondary" onClick={connect} disabled={!form.url.trim() || connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        </div>
        <label>Layer</label>
        <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {layers.length > 0 && (
            <select value={form.layer} onChange={e => setForm({ ...form, layer: e.target.value })} style={{ minWidth: 260 }}>
              <option value="">— select a layer —</option>
              {layers.map(l => (
                <option key={l.name} value={l.name}>{l.title ? `${l.title} (${l.name})` : l.name}</option>
              ))}
            </select>
          )}
          <input
            type="text" value={form.layer}
            onChange={e => setForm({ ...form, layer: e.target.value })}
            placeholder="layer name" style={{ minWidth: 160 }}
          />
          {connectMsg && <span className={`msg ${connectMsg.ok ? 'ok' : 'err'}`} style={{ margin: 0 }}>{connectMsg.text}</span>}
        </div>
        <label>Show on</label>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '.35rem' }}>
            <input type="checkbox" checked={form.project} onChange={e => setForm({ ...form, project: e.target.checked })} /> Project map
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '.35rem' }}>
            <input type="checkbox" checked={form.selection} onChange={e => setForm({ ...form, selection: e.target.checked })} /> Selection map
          </label>
        </div>
      </div>
      <div style={{ marginTop: '.75rem', display: 'flex', gap: '.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn-primary" onClick={addAddon} disabled={!hasFolder}>Add addon</button>
        {!hasFolder && <span className="hint">Connect a project folder first (Project selection tab).</span>}
        {msg && <span className={`msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</span>}
      </div>
    </div>
  )
}
