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

  const [form, setForm] = useState({ service: 'wms', name: '', url: '', layer: '', token: '', epsg: '25832', project: true, selection: true })
  // #230: full WMTS capabilities of the last Connect — layers carry formats /
  // styles / matrix-set links; matrix_sets carry each grid's CRS so addAddon
  // can pick a web-mercator one (or refuse with the grids it found).
  const [wmtsInfo, setWmtsInfo] = useState(null)

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
  // #350: which built-in row is expanded to show its URL / layer / format.
  const [expandedBuiltin, setExpandedBuiltin] = useState(null)

  async function connect() {
    setConnectMsg(null); setConnecting(true); setWmtsInfo(null)
    try {
      if (form.service === 'wmts') {
        const r = await invoke('wmts_capabilities', { url: withToken(form.url.trim(), form.token) })
        const arr = Array.isArray(r?.layers) ? r.layers : []
        setWmtsInfo(r || null)
        setLayers(arr)
        const merc = webMercatorSet(r)
        setConnectMsg({
          ok: arr.length > 0 && !!merc,
          text: arr.length === 0
            ? 'No layers found'
            : merc
              ? `${arr.length} layer${arr.length === 1 ? '' : 's'} found · Danish-grid tile matrix set: ${merc}`
              : `${arr.length} layer${arr.length === 1 ? '' : 's'} found, but NO EPSG:25832 tile grid (found: ${gridSummary(r)}) — this WMTS can't be drawn on the Danish-grid map; use the service's WMS variant instead.`,
        })
      } else if (form.service === 'wfs') {
        const list = await invoke('wfs_capabilities', { url: withToken(form.url.trim(), form.token) })
        const arr = Array.isArray(list) ? list : []
        setLayers(arr)
        setConnectMsg({ ok: arr.length > 0, text: `${arr.length} feature type${arr.length === 1 ? '' : 's'} found` })
      } else {
        const list = await invoke('wms_capabilities', { url: withToken(form.url.trim(), form.token) })
        const arr = Array.isArray(list) ? list : []
        setLayers(arr)
        setConnectMsg({ ok: arr.length > 0, text: `${arr.length} layer${arr.length === 1 ? '' : 's'} found` })
      }
    } catch (e) {
      setLayers([]); setConnectMsg({ ok: false, text: String(e).slice(0, 160) })
    } finally {
      setConnecting(false)
    }
  }

  // #232: the maps run on the Danish EPSG:25832 grid (lib/crsDk.js) — a WMTS
  // is usable when it publishes a 25832 tile matrix set (the Kortforsyning
  // grid: View1 / KortforsyningTilingDK / DKtiling…).  Returns its id or null.
  function webMercatorSet(info) {
    const sets = Array.isArray(info?.matrix_sets) ? info.matrix_sets : []
    const hit = sets.find(s =>
      /25832/.test(String(s.crs || '')) ||
      /view1|kortforsyning|dktiling/i.test(String(s.id || '')))
    return hit ? hit.id : null
  }
  function gridSummary(info) {
    const sets = Array.isArray(info?.matrix_sets) ? info.matrix_sets : []
    return sets.map(s => {
      const epsg = String(s.crs || '').match(/EPSG:?:?(\d+)/i)?.[1]
      return epsg ? `${s.id} — EPSG:${epsg}` : s.id
    }).join(', ') || 'none'
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
      type: form.service === 'wmts' ? 'wmts' : form.service === 'wfs' ? 'wfs' : 'wms',
      url: form.url.trim(),
      layer: form.layer.trim(),
      token: form.token.trim(),
      maps: { project: form.project, selection: form.selection },
      visible: true,
    }
    // #342: WFS = a vector overlay — needs a feature type + the CRS its geometry
    // comes back in (reprojected to WGS84 at render time).
    if (addon.type === 'wfs') {
      if (!addon.layer) {
        setMsg({ ok: false, text: 'Pick a feature type first (Connect, then choose from the list).' })
        return
      }
      addon.epsg = parseInt(form.epsg, 10) || 25832
    }
    // #230: WMTS needs a chosen layer and a WEB-MERCATOR tile grid — raster
    // tiles in another projection (e.g. the Danish EPSG:25832-only services)
    // cannot be drawn on the web-mercator map; their WMS variant can.
    if (addon.type === 'wmts') {
      if (!addon.layer) {
        setMsg({ ok: false, text: 'Pick a layer first (Connect, then choose from the list).' })
        return
      }
      const tms = webMercatorSet(wmtsInfo)
      if (!tms) {
        setMsg({
          ok: false,
          text: `This WMTS has no EPSG:25832 tile grid (found: ${gridSummary(wmtsInfo)}) — it cannot be drawn on the Danish-grid map. Use the service's WMS variant instead.`,
        })
        return
      }
      addon.tilematrixset = tms
      const li = (wmtsInfo?.layers || []).find(l => l.name === addon.layer)
      addon.format = li?.formats?.[0] || 'image/png'
      addon.style  = li?.styles?.[0] || 'default'
    }
    updateNow([...addons, addon])
    setForm({ service: form.service, name: '', url: '', layer: '', token: '', epsg: '25832', project: true, selection: true })
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
        // GeoJSON preview suggests a source EPSG (crs member / coordinate range).
        epsg: pv?.epsg ? String(pv.epsg) : f.epsg,
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
    <div className="panel" style={{ maxWidth: 920 }}>
      <h3 className="section-title">Map addons</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        Overlay layers for the Project map and the Selection map: <strong>WMS</strong> / <strong>WMTS</strong> raster
        services, <strong>WFS</strong> vector layers, and local files (shapefile / CSV / Excel). Each layer can be shown
        on either or both maps.
      </p>

      {/* Built-in background maps (#222): the fixed WMS/XYZ services, shown so
          the URLs and layers in use are visible.  Static fields are read-only
          (defined in code — baseLayers.js); the toggles edit the same entries
          the on-map layer panel manages. */}
      <h4 className="section-title">Built-in background maps</h4>
      <p className="hint" style={{ marginTop: 0 }}>
        The map picks its tile grid automatically (#234): with <strong>OpenStreetMap / Esri</strong> on,
        it runs web-mercator and the Danish maps use their WMS variant; with only Danish layers on,
        it runs the Danish 25832 grid and serves the faster WMTS tiles.
      </p>
      {/* #350: compact rows — click a row to drop down its Service URL / Layer /
          Format so the table fits inside the panel instead of overflowing. */}
      <table className="data-table" style={{ maxWidth: 900, marginBottom: '1.25rem' }}>
        <thead>
          <tr>
            <th style={{ width: 24 }}></th>
            <th>Name</th><th>Type</th>
            <th style={{ width: 70, textAlign: 'center' }}>Project</th>
            <th style={{ width: 80, textAlign: 'center' }}>Selection</th>
            <th style={{ width: 70, textAlign: 'center' }}>Visible</th>
          </tr>
        </thead>
        <tbody>
          {addons.filter(a => a?.builtin).map(a => {
            const open = expandedBuiltin === a.id
            return (
              <Fragment key={a.id}>
                <tr
                  onClick={() => setExpandedBuiltin(open ? null : a.id)}
                  style={{ cursor: 'pointer' }}
                  title={open ? 'Hide details' : 'Show Service URL / Layer / Format'}
                >
                  <td style={{ textAlign: 'center', color: 'var(--muted)' }}>{open ? '▾' : '▸'}</td>
                  <td>{a.name}</td>
                  <td>{(a.type || 'wms').toUpperCase()}</td>
                  <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={!!a.maps?.project} onChange={() => toggleMap(a.id, 'project')} />
                  </td>
                  <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={!!a.maps?.selection} onChange={() => toggleMap(a.id, 'selection')} />
                  </td>
                  <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={a.visible !== false} onChange={() => update(a.id, { visible: a.visible === false })} />
                  </td>
                </tr>
                {open && (
                  <tr>
                    <td colSpan={6} style={{ background: 'var(--light)' }} onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '.4rem .85rem', alignItems: 'center', padding: '.35rem .3rem' }}>
                        <strong style={{ fontSize: '.8rem' }}>Service URL</strong>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '.72rem', wordBreak: 'break-all' }}>{a.url}</span>
                        <strong style={{ fontSize: '.8rem' }}>Layer</strong>
                        <span style={{ fontSize: '.8rem' }}>
                          {/* #232: services exposing several layers get a dropdown. */}
                          {Array.isArray(a.layers) && a.layers.length > 1 ? (
                            <select
                              value={a.layer}
                              onChange={e => update(a.id, { layer: e.target.value })}
                              style={{ marginBottom: 0, maxWidth: 260 }}
                            >
                              {a.layers.map(l => <option key={l} value={l}>{l}</option>)}
                            </select>
                          ) : (a.layer || '—')}
                        </span>
                        <strong style={{ fontSize: '.8rem' }}>Format</strong>
                        <span style={{ fontSize: '.8rem' }}>{a.format || (a.type === 'xyz' ? 'tiles' : '—')}</span>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>

      {/* Existing addons */}
      <h4 className="section-title">Your addons</h4>
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

      {/* Add WMS / WMTS / WFS addon */}
      <h4 className="section-title">Add WMS / WMTS / WFS overlay</h4>
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '.5rem .75rem', alignItems: 'center', maxWidth: 720 }}>
        <label>Service</label>
        <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={form.service}
            onChange={e => { setForm({ ...form, service: e.target.value, layer: '' }); setLayers([]); setWmtsInfo(null); setConnectMsg(null) }}
            style={{ maxWidth: 140 }}
          >
            <option value="wms">WMS</option>
            <option value="wmts">WMTS</option>
            <option value="wfs">WFS</option>
          </select>
          {form.service === 'wmts' && (
            <span className="hint" style={{ margin: 0 }}>
              WMTS must publish the Danish EPSG:25832 grid (View1 / KortforsyningTilingDK) — Connect checks and refuses otherwise.
            </span>
          )}
          {form.service === 'wfs' && (
            <span className="hint" style={{ margin: 0 }}>
              Vector overlay — Connect lists feature types; features are reprojected to the map from the CRS below.
            </span>
          )}
        </div>
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
        {form.service === 'wfs' && (
          <>
            <label>Geometry CRS</label>
            <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={form.epsg} onChange={e => setForm({ ...form, epsg: e.target.value })} style={{ maxWidth: 280 }}>
                {COMMON_CRS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <span className="hint" style={{ margin: 0 }}>The CRS the WFS returns geometry in (reprojected to the map).</span>
            </div>
          </>
        )}
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
      <h4 style={{ margin: '1.5rem 0 .5rem' }}>Add local file (shapefile / GeoJSON / CSV / Excel)</h4>
      <p className="hint" style={{ marginTop: 0 }}>
        Converted to GeoJSON on import and cached in the project's <code>map addons/</code> folder.
        CSV/Excel become points from your chosen X/Y columns (first sheet for Excel); shapefiles and
        GeoJSON/JSON keep the geometry &amp; attributes they carry (EPSG auto-detected for GeoJSON).
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
        {preview?.kind === 'geojson' && (
          <>
            <label>Properties</label>
            <span className="hint" style={{ margin: 0 }}>
              {(preview.headers || []).length
                ? `carried as-is: ${(preview.headers || []).join(', ')}`
                : 'no properties — geometry only'}
              {preview.feature_count != null
                ? ` · ${preview.feature_count} feature${preview.feature_count === 1 ? '' : 's'}`
                : ''}
              {' · EPSG auto-detected — adjust above if needed'}
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
