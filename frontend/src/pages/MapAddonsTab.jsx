import { Fragment, useState } from 'react'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'
import { useThrottledAddons } from '../lib/useThrottledAddons'
import { COMMON_CRS_OPTIONS } from '../lib/proj'

// Issues #169 (M4.5a) + #171 (M4.5b) — Map addons Settings subtab.
//
// Manage overlay layers shown on the project / selection maps:
//   • WMS services (Connect → pick a layer from GetCapabilities), and
//   • local files (shapefile / CSV / Excel) converted to GeoJSON on import and
//     cached under the project's `map addons/` folder (Q-A6).

export default function MapAddonsTab() {
  const { connection } = useApp()
  // #218: addon edits go through the throttled committer — colour-picker
  // drags batch to ~4 commits/s instead of one full save per input tick.
  const { addons, updateThrottled, updateNow } = useThrottledAddons()
  const hasFolder = !!connection?.output_folder
  const userAddons = addons.filter(a => !a.builtin) // built-ins managed in the on-map panel

  const [form, setForm] = useState({ name: '', url: '', layer: '', token: '', project: true, selection: true })

  // #224: services like api.dataforsyningen.dk require a `token` query param —
  // append it for GetCapabilities probes when the user supplied one.
  const withToken = (url, token) => {
    const t = (token || '').trim()
    if (!t) return url
    return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t)
  }
  const [msg, setMsg] = useState(null)
  const [layers, setLayers] = useState([])           // [{ name, title }] from GetCapabilities
  const [connecting, setConnecting] = useState(false)
  const [connectMsg, setConnectMsg] = useState(null)

  async function connect() {
    setConnectMsg(null); setConnecting(true)
    try {
      const list = await invoke('wms_capabilities', { url: withToken(form.url.trim(), form.token) })
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
      token: form.token.trim(),
      maps: { project: form.project, selection: form.selection },
      visible: true,
    }
    updateNow([...addons, addon])
    setForm({ name: '', url: '', layer: '', token: '', project: true, selection: true })
    setMsg({ ok: true, text: `Added "${addon.name}".` })
  }

  const update     = (id, patch) => updateNow(addons.map(a => (a.id === id ? { ...a, ...patch } : a)))
  // Continuous inputs (colour picker) — throttled commits (#218).
  const updateLive = (id, patch) => updateThrottled(addons.map(a => (a.id === id ? { ...a, ...patch } : a)))
  const toggleMap = (id, which) => {
    const a = addons.find(x => x.id === id)
    if (a) update(id, { maps: { ...a.maps, [which]: !a.maps?.[which] } })
  }
  const remove = (id) => {
    // File addons also drop their cached GeoJSON (best-effort).
    const a = addons.find(x => x.id === id)
    if (a?.file) invoke('delete_addon_file', { file: a.file }).catch(() => {})
    updateNow(addons.filter(x => x.id !== id))
  }

  // ── Local-file import (M4.5b) ───────────────────────────────────────────────
  const [ff, setFf] = useState({
    path: '', name: '', epsg: '25832', xCol: '', yCol: '',
    infoCols: [], project: true, selection: true,
  })
  const [preview, setPreview]     = useState(null)  // { kind, headers, rows }
  const [importing, setImporting] = useState(false)
  const [fileMsg, setFileMsg]     = useState(null)
  const [editId, setEditId]       = useState(null)  // expanded addon editor row

  async function browseFile() {
    setFileMsg(null)
    const r = await invoke('pick_addon_file').catch(() => null)
    const path = r?.path
    if (!path) return
    const stem = path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
    try {
      const pv = await invoke('addon_file_preview', { path })
      const hs = pv?.headers || []
      const guess = (cands) =>
        hs.find(h => cands.includes(String(h).toLowerCase().trim())) || ''
      setPreview(pv)
      setFf(f => ({
        ...f, path, name: stem, infoCols: [],
        xCol: guess(['x', 'x1', 'easting', 'east', 'xcoord', 'x-koordinat', 'x_koordinat']) || hs[0] || '',
        yCol: guess(['y', 'y1', 'northing', 'north', 'ycoord', 'y-koordinat', 'y_koordinat']) || hs[1] || '',
      }))
    } catch (e) {
      setPreview(null)
      setFf(f => ({ ...f, path }))
      setFileMsg({ ok: false, text: String(e).slice(0, 160) })
    }
  }

  const toggleInfoCol = (h) => setFf(f => ({
    ...f,
    infoCols: f.infoCols.includes(h) ? f.infoCols.filter(c => c !== h) : [...f.infoCols, h],
  }))

  async function importFile() {
    setFileMsg(null)
    if (!ff.path || !preview) { setFileMsg({ ok: false, text: 'Pick a file first.' }); return }
    if (!ff.name.trim()) { setFileMsg({ ok: false, text: 'Give the addon a name.' }); return }
    if (!ff.project && !ff.selection) { setFileMsg({ ok: false, text: 'Pick at least one target map.' }); return }
    const isTable = preview.kind === 'table'
    if (isTable && (!ff.xCol || !ff.yCol)) {
      setFileMsg({ ok: false, text: 'Pick the X and Y columns.' }); return
    }
    setImporting(true)
    try {
      const entry = await invoke('import_addon_file', {
        req: {
          path: ff.path,
          name: ff.name.trim(),
          epsg: parseInt(ff.epsg, 10) || 25832,
          x_col: isTable ? ff.xCol : null,
          y_col: isTable ? ff.yCol : null,
          info_cols: isTable ? ff.infoCols : [],
          maps: { project: ff.project, selection: ff.selection },
        },
      })
      updateNow([...addons, entry])
      setFileMsg({ ok: true, text: `Imported "${entry.name}" (${entry.feature_count} features).` })
      setFf({ path: '', name: '', epsg: '25832', xCol: '', yCol: '', infoCols: [], project: true, selection: true })
      setPreview(null)
    } catch (e) {
      setFileMsg({ ok: false, text: String(e).slice(0, 200) })
    } finally {
      setImporting(false)
    }
  }

  return (
    <div style={{ maxWidth: 920 }}>
      <h3 className="section-title">Map addons</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        Overlay layers for the Project map and the Selection map. This adds <strong>WMS</strong> services;
        local files (shapefile / CSV / Excel) come in a later update.
      </p>

      {/* Built-in background maps (#222): the fixed WMS/XYZ services, shown so
          the URLs and layers in use are visible.  Static fields are read-only
          (defined in code — baseLayers.js); the toggles edit the same entries
          the on-map layer panel manages. */}
      <h4 style={{ margin: '0 0 .35rem' }}>Built-in background maps</h4>
      <table className="data-table" style={{ maxWidth: 900, marginBottom: '1.25rem' }}>
        <thead>
          <tr>
            <th>Name</th><th>Type</th><th>Service URL</th><th>Layer</th><th>Format</th>
            <th style={{ width: 70, textAlign: 'center' }}>Project</th>
            <th style={{ width: 80, textAlign: 'center' }}>Selection</th>
            <th style={{ width: 70, textAlign: 'center' }}>Visible</th>
          </tr>
        </thead>
        <tbody>
          {addons.filter(a => a?.builtin).map(a => (
            <tr key={a.id}>
              <td>{a.name}</td>
              <td>{(a.type || 'wms').toUpperCase()}</td>
              <td style={{ fontSize: '.72rem', fontFamily: 'monospace', wordBreak: 'break-all' }} title={a.url}>
                {a.url}
              </td>
              <td style={{ fontSize: '.8rem' }}>{a.layer || '—'}</td>
              <td style={{ fontSize: '.8rem' }}>{a.format || (a.type === 'xyz' ? 'tiles' : '—')}</td>
              <td style={{ textAlign: 'center' }}>
                <input type="checkbox" checked={!!a.maps?.project} onChange={() => toggleMap(a.id, 'project')} />
              </td>
              <td style={{ textAlign: 'center' }}>
                <input type="checkbox" checked={!!a.maps?.selection} onChange={() => toggleMap(a.id, 'selection')} />
              </td>
              <td style={{ textAlign: 'center' }}>
                <input type="checkbox" checked={a.visible !== false} onChange={() => update(a.id, { visible: a.visible === false })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Existing addons */}
      <h4 style={{ margin: '0 0 .35rem' }}>Your addons</h4>
      {userAddons.length === 0 ? (
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
            {userAddons.map(a => (
              <Fragment key={a.id}>
                <tr>
                  <td title={a.url || a.file}>
                    {a.type === 'geojson' && (
                      <span style={{
                        display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
                        background: a.color || '#7c3aed', marginRight: 6, verticalAlign: 'middle',
                      }} />
                    )}
                    {a.name}
                  </td>
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
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className="btn-secondary btn-sm"
                      onClick={() => setEditId(editId === a.id ? null : a.id)}
                      style={{ marginRight: '.35rem' }}
                    >
                      {editId === a.id ? 'Close' : 'Edit'}
                    </button>
                    <button className="btn-secondary btn-sm" onClick={() => remove(a.id)}>Delete</button>
                  </td>
                </tr>
                {/* #224: WMS edit panel — token (and layer) adjustable after the fact. */}
                {editId === a.id && a.type !== 'geojson' && (
                  <tr>
                    <td colSpan={7} style={{ background: '#f8fafc' }}>
                      <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap', padding: '.3rem 0' }}>
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '.45rem' }}>
                          Token
                          <input
                            type="text"
                            value={a.token || ''}
                            onChange={e => updateLive(a.id, { token: e.target.value.trim() })}
                            placeholder="service token (optional)"
                            style={{ minWidth: 260, marginBottom: 0 }}
                          />
                        </label>
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '.45rem' }}>
                          Layer
                          <input
                            type="text"
                            value={a.layer || ''}
                            onChange={e => updateLive(a.id, { layer: e.target.value })}
                            placeholder="layer name"
                            style={{ minWidth: 180, marginBottom: 0 }}
                          />
                        </label>
                        <span className="hint" style={{ margin: 0 }}>
                          The token is sent as <code>token=…</code> with every tile request (api.dataforsyningen.dk needs one).
                        </span>
                      </div>
                    </td>
                  </tr>
                )}
                {editId === a.id && a.type === 'geojson' && (
                  <tr>
                    <td colSpan={7} style={{ background: '#f8fafc' }}>
                      <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap', padding: '.3rem 0' }}>
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '.45rem' }}>
                          Colour
                          <input
                            type="color"
                            value={a.color || '#7c3aed'}
                            onChange={e => updateLive(a.id, { color: e.target.value })}
                          />
                        </label>
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '.45rem' }}>
                          Render as
                          <select value={a.render || ''} onChange={e => update(a.id, { render: e.target.value })}>
                            <option value="">As imported</option>
                            <option value="points">Scatter (points)</option>
                            <option value="line">Line</option>
                            <option value="polygon">Polygon</option>
                          </select>
                        </label>
                        <span className="hint" style={{ margin: 0 }}>
                          Line / Polygon connect the imported points in file order.
                        </span>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
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
        <label>Token</label>
        <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text" value={form.token}
            onChange={e => setForm({ ...form, token: e.target.value })}
            placeholder="service token (optional)" style={{ minWidth: 260 }}
          />
          <span className="hint" style={{ margin: 0 }}>
            Required by e.g. api.dataforsyningen.dk — sent as <code>token=…</code> with every request.
          </span>
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

      {/* ── Add local file (M4.5b) ── */}
      <h4 style={{ margin: '1.5rem 0 .5rem' }}>Add local file (shapefile / CSV / Excel)</h4>
      <p className="hint" style={{ marginTop: 0 }}>
        Converted to GeoJSON on import and cached in the project's <code>map addons/</code> folder.
        CSV/Excel become points from your chosen X/Y columns (first sheet for Excel); shapefiles keep
        the attributes they carry.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '.5rem .75rem', alignItems: 'center', maxWidth: 720 }}>
        <label>File</label>
        <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
          <button className="btn-secondary" onClick={browseFile} disabled={importing}>Browse…</button>
          <span className="hint" style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ff.path || 'no file selected'}
          </span>
        </div>

        <label>Name</label>
        <input type="text" value={ff.name} onChange={e => setFf({ ...ff, name: e.target.value })} placeholder="layer name" />

        <label>EPSG</label>
        <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={COMMON_CRS_OPTIONS.some(o => o.value === ff.epsg) ? ff.epsg : ''}
            onChange={e => { if (e.target.value) setFf({ ...ff, epsg: e.target.value }) }}
            style={{ maxWidth: 280 }}
          >
            <option value="">— common systems —</option>
            {COMMON_CRS_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <input
            type="text" inputMode="numeric" value={ff.epsg}
            onChange={e => setFf({ ...ff, epsg: e.target.value.replace(/[^\d]/g, '') })}
            style={{ width: 100 }}
            title="Coordinate system of the file — pick from the list or type any EPSG code"
          />
          <span className="hint" style={{ margin: 0 }}>coordinate system of the file</span>
        </div>

        {preview?.kind === 'table' && (
          <>
            <label>X column</label>
            <select value={ff.xCol} onChange={e => setFf({ ...ff, xCol: e.target.value })} style={{ maxWidth: 280 }}>
              <option value="">— pick —</option>
              {(preview.headers || []).map(h => <option key={h} value={h}>{h}</option>)}
            </select>

            <label>Y column</label>
            <select value={ff.yCol} onChange={e => setFf({ ...ff, yCol: e.target.value })} style={{ maxWidth: 280 }}>
              <option value="">— pick —</option>
              {(preview.headers || []).map(h => <option key={h} value={h}>{h}</option>)}
            </select>

            <label style={{ alignSelf: 'start' }}>Hover info</label>
            <div style={{ display: 'flex', gap: '.35rem .9rem', flexWrap: 'wrap' }}>
              {(preview.headers || []).filter(h => h !== ff.xCol && h !== ff.yCol).map(h => (
                <label key={h} style={{ display: 'inline-flex', alignItems: 'center', gap: '.3rem', fontSize: '.82rem' }}>
                  <input type="checkbox" checked={ff.infoCols.includes(h)} onChange={() => toggleInfoCol(h)} />
                  {h}
                </label>
              ))}
              <span className="hint" style={{ margin: 0 }}>(none ticked = all columns)</span>
            </div>
          </>
        )}
        {preview?.kind === 'shapefile' && (
          <>
            <label>Attributes</label>
            <span className="hint" style={{ margin: 0 }}>
              {(preview.headers || []).length
                ? `carried as-is: ${(preview.headers || []).join(', ')}`
                : 'no attribute table found — geometry only'}
            </span>
          </>
        )}

        <label>Show on</label>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '.35rem' }}>
            <input type="checkbox" checked={ff.project} onChange={e => setFf({ ...ff, project: e.target.checked })} /> Project map
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '.35rem' }}>
            <input type="checkbox" checked={ff.selection} onChange={e => setFf({ ...ff, selection: e.target.checked })} /> Selection map
          </label>
        </div>
      </div>
      <div style={{ marginTop: '.75rem', display: 'flex', gap: '.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn-primary" onClick={importFile} disabled={!hasFolder || importing || !ff.path}>
          {importing ? 'Importing…' : 'Import file'}
        </button>
        {fileMsg && <span className={`msg ${fileMsg.ok ? 'ok' : 'err'}`}>{fileMsg.text}</span>}
      </div>
    </div>
  )
}
