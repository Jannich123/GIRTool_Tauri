import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '../tauri-api'
import { useColumnFilters, ColumnFilterButton } from '../components/ColumnFilter'
import { invokeAndNotify, useDataChanged } from '../lib/dataChanged'
import { useApp } from '../context/AppContext'

// CPT – Calculations (M8, issue #182 / plan §E).
//
// Three subtabs feeding the Rust port of the reference CPT_Calc pipeline
// (verified against the python oracle by fixture tests):
//   1. CPT calculations — column picker (catalogue + Round) + γ_water + Run
//   2. CPT point data   — per-point inputs  → cpt calc settings/cpt_point_data.xlsx
//   3. CPT layer data   — per-strata inputs → cpt calc settings/cpt_layer_data.xlsx
//      + the Nkt estimation-method selector (Q-E5)
//
// Config (selected columns, rounds, nkt_method, gamma_water) persists in
// GIRTool_settings.json::cpt_calc (Q-E4); the two input tables are xlsx files
// the user can also edit in Excel (Q-E4a).

const PH = {
  point: 'PointNo',
  db: 'DB',
  proj: 'Project',
  area: 'Insert Cone Area Ratio [-]',
  gsb: 'Ground/Seabed Level [m]',
  water: 'Insert Water Level [m]',
}
const LH = { layer: 'Strata', uw: 'Unit weight [kN/m^3]', nkt: 'Nkt [-]' }

export default function CptCalcPage() {
  const { selectedProjects, connection } = useApp()
  const hasFolder = !!connection?.output_folder
  const [sub, setSub] = useState('calc')

  // ── Shared config (Q-E4) ────────────────────────────────────────────────────
  const [catalog, setCatalog] = useState([])
  const [config, setConfig] = useState(null) // { selected, round, nkt_method, gamma_water }
  const saveTimer = useRef(null)

  useEffect(() => {
    invoke('get_cpt_catalog').then(c => setCatalog(Array.isArray(c) ? c : [])).catch(() => {})
  }, [])
  useEffect(() => {
    if (!hasFolder) return
    invoke('get_cpt_calc_config').then(c => setConfig(c || null)).catch(() => {})
  }, [hasFolder, connection?.output_folder])

  function patchConfig(patch) {
    setConfig(prev => {
      const next = { ...(prev || {}), ...patch }
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        invokeAndNotify('cpt', 'save_cpt_calc_config', { config: next }).catch(() => {})
      }, 500)
      return next
    })
  }

  const selectedSet = useMemo(() => new Set(config?.selected || []), [config])
  const toggleCol = (name) => {
    const next = new Set(selectedSet)
    if (next.has(name)) next.delete(name); else next.add(name)
    patchConfig({ selected: [...next] })
  }
  const toggleGroup = (entries, on) => {
    const next = new Set(selectedSet)
    entries.forEach(c => { if (on) next.add(c.name); else next.delete(c.name) })
    patchConfig({ selected: [...next] })
  }
  const setRound = (name, raw) => {
    const v = parseInt(raw, 10)
    patchConfig({ round: { ...(config?.round || {}), [name]: isFinite(v) ? v : 0 } })
  }

  // ── Run (Subtab 1) ──────────────────────────────────────────────────────────
  const [fname, setFname] = useState('CPTData')
  const [running, setRunning] = useState(false)
  const [runMsg, setRunMsg] = useState(null)

  async function run() {
    setRunMsg(null); setRunning(true)
    try {
      const r = await invokeAndNotify('datasheets', 'run_cpt_calc', { fname })
      setRunMsg({ ok: true, text: `${r.file}: ${r.columns_written} column(s) written across ${r.rows} rows.` })
    } catch (e) {
      setRunMsg({ ok: false, text: String(e).slice(0, 220) })
    } finally {
      setRunning(false)
    }
  }

  // ── Point data (Subtab 2, Q-E4a; #198: sourced from the CPTData sheet) ─────
  const [pointRows, setPointRows] = useState([])
  const pointSaveTimer = useRef(null)
  const [pointMsg, setPointMsg] = useState('')

  const loadPointData = useCallback(async () => {
    if (!hasFolder) return
    try {
      const [saved, sheet, projects] = await Promise.all([
        invoke('load_cpt_point_data').catch(() => []),
        invoke('read_datasheet', { fname: 'CPTData' }).catch(() => null),
        invoke('list_projects').catch(() => []),
      ])
      if (!sheet || !Array.isArray(sheet.columns)) {
        setPointRows([])
        setPointMsg('CPTData.xlsx not found — download CPT data first (Data → Download menu).')
        return
      }
      const ci = (n) => sheet.columns.findIndex(c => String(c).toLowerCase() === n)
      const iPn = ci('pointno'), iDb = ci('db_id'), iProj = ci('projectid')
      if (iPn < 0) {
        setPointRows([])
        setPointMsg('CPTData.xlsx has no PointNo column.')
        return
      }
      const projNo = new Map((projects || []).map(pr => [`${pr.db_id ?? '?'}||${pr.ProjectId}`, pr.ProjectNo]))
      const byNo = new Map((Array.isArray(saved) ? saved : []).map(r => [String(r[PH.point] ?? ''), r]))
      const seen = new Set()
      const rows = []
      for (const r of (sheet.rows || [])) {
        const no = String(r[iPn] ?? '').trim()
        if (!no || no === 'No Data' || seen.has(no)) continue
        seen.add(no)
        const db = iDb >= 0 ? String(r[iDb] ?? '') : ''
        const pid = iProj >= 0 ? String(r[iProj] ?? '') : ''
        const ex = byNo.get(no) || {}
        rows.push({
          [PH.point]: no,
          [PH.db]: db,
          [PH.proj]: projNo.get(`${db || '?'}||${pid}`) ?? (ex[PH.proj] ?? ''),
          [PH.area]: ex[PH.area] ?? 0.8,
          [PH.gsb]: ex[PH.gsb] ?? null,
          [PH.water]: ex[PH.water] ?? 0,
        })
      }
      setPointRows(rows)
      setPointMsg(rows.length ? '' : 'No CPT points found in CPTData.xlsx.')
    } catch (e) {
      setPointMsg(String(e).slice(0, 160))
    }
  }, [hasFolder, connection?.output_folder]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadPointData() }, [loadPointData])

  // #248: Excel-style filters on the point table.  Items are {r, i} tuples so
  // edits keep routing through the ORIGINAL row index after filtering.
  const pointItems = useMemo(() => pointRows.map((r, i) => ({ r, i })), [pointRows])
  const { filters: pointColFilters, setColFilter: setPointColFilter, filteredItems: pointItemsFiltered } =
    useColumnFilters(pointItems, it => it.r)

  function editPoint(i, key, raw) {
    setPointRows(prev => {
      const next = prev.map((r, j) => (j === i ? { ...r, [key]: raw === '' ? null : Number(String(raw).replace(',', '.')) } : r))
      clearTimeout(pointSaveTimer.current)
      pointSaveTimer.current = setTimeout(() => {
        invokeAndNotify('cpt', 'save_cpt_point_data', { rows: next }).catch(() => {})
      }, 600)
      return next
    })
  }

  // ── Layer data (Subtab 3, Q-E4a + Q-E5) ─────────────────────────────────────
  const [layerRows, setLayerRows] = useState([])
  const layerSaveTimer = useRef(null)
  const [newLayer, setNewLayer] = useState('')

  const loadLayerData = useCallback(() => {
    if (!hasFolder) return
    Promise.all([
      invoke('load_cpt_layer_data').catch(() => []),
      invoke('get_strata_layers').catch(() => ({ primary: [] })),
    ]).then(([saved, layers]) => {
      const savedRows = Array.isArray(saved) ? saved : []
      const byLayer = new Map(savedRows.map(r => [String(r[LH.layer] ?? ''), r]))
      const rows = []
      const names = new Set()
      for (const l of (layers?.primary || []).sort()) {
        if (!l || names.has(l)) continue
        names.add(l)
        rows.push(byLayer.get(l) || { [LH.layer]: l, [LH.uw]: null, [LH.nkt]: null })
        byLayer.delete(l)
      }
      for (const r of byLayer.values()) rows.push(r) // xlsx-only rows kept
      setLayerRows(rows)
    })
  }, [hasFolder, connection?.output_folder]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadLayerData() }, [loadLayerData])

  // #248: Excel-style filter on the layer table (tuple pattern → original
  // indices survive filtering for edits).
  const layerItems = useMemo(() => layerRows.map((r, i) => ({ r, i })), [layerRows])
  const { filters: layerColFilters, setColFilter: setLayerColFilter, filteredItems: layerItemsFiltered } =
    useColumnFilters(layerItems, it => it.r)

  // #213: CPT settings changed in another window — reload the calc config and
  // both settings tables.  (Own-window saves are skipped by the bus.)
  useDataChanged('cpt', () => {
    if (!hasFolder) return
    invoke('get_cpt_calc_config').then(c => setConfig(c || null)).catch(() => {})
    loadPointData()
    loadLayerData()
  })

  // 📂 Open the settings workbooks in Excel (#198): persist the current rows
  // first so the file matches the UI, then open it.
  async function openSettingsXlsx(which) {
    try {
      if (which === 'point') await invokeAndNotify('cpt', 'save_cpt_point_data', { rows: pointRows })
      else await invokeAndNotify('cpt', 'save_cpt_layer_data', { rows: layerRows })
    } catch { /* best-effort — open anyway */ }
    invoke('open_cpt_settings_xlsx', { which }).catch(() => {})
  }

  function persistLayers(next) {
    clearTimeout(layerSaveTimer.current)
    layerSaveTimer.current = setTimeout(() => {
      invokeAndNotify('cpt', 'save_cpt_layer_data', { rows: next }).catch(() => {})
    }, 600)
  }
  function editLayer(i, key, raw) {
    setLayerRows(prev => {
      const next = prev.map((r, j) => (j === i ? { ...r, [key]: raw === '' ? null : Number(String(raw).replace(',', '.')) } : r))
      persistLayers(next)
      return next
    })
  }
  function addLayerRow() {
    const name = newLayer.trim()
    if (!name || layerRows.some(r => r[LH.layer] === name)) return
    const next = [...layerRows, { [LH.layer]: name, [LH.uw]: null, [LH.nkt]: null }]
    setLayerRows(next)
    setNewLayer('')
    persistLayers(next)
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (!selectedProjects.length) {
    return (
      <div className="page page-wide">
        <h2 className="page-title">CPT – Calculations</h2>
        <p className="hint">Select a project first.</p>
      </div>
    )
  }

  const numInput = (val, onChange, width = 110) => (
    <input
      type="text" inputMode="decimal"
      value={val ?? ''} onChange={e => onChange(e.target.value)}
      style={{ width, textAlign: 'right' }}
    />
  )

  // Group the catalogue for Subtab 1.
  const groups = useMemo(() => {
    const m = new Map()
    for (const c of catalog) {
      if (!m.has(c.group)) m.set(c.group, [])
      m.get(c.group).push(c)
    }
    return [...m.entries()]
  }, [catalog])

  return (
    <div className="page page-wide">
      <h2 className="page-title">CPT – Calculations</h2>

      <div className="grp-cs-tabs" style={{ marginBottom: '1rem' }}>
        <button className={`grp-cs-tab${sub === 'calc' ? ' active' : ''}`} onClick={() => setSub('calc')}>
          CPT calculations
        </button>
        <button className={`grp-cs-tab${sub === 'points' ? ' active' : ''}`} onClick={() => setSub('points')}>
          CPT point data
        </button>
        <button className={`grp-cs-tab${sub === 'layers' ? ' active' : ''}`} onClick={() => setSub('layers')}>
          CPT layer data
        </button>
      </div>

      {/* ── Subtab 1: column picker + run ── */}
      {sub === 'calc' && (
        <div>
          <div style={{ display: 'flex', gap: '.75rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.75rem' }}>
            <label>Datasheet</label>
            <input type="text" value={fname} onChange={e => setFname(e.target.value)} style={{ width: 140 }} />
            <label>γ<sub>water</sub></label>
            {numInput(config?.gamma_water ?? 10, v => patchConfig({ gamma_water: Number(String(v).replace(',', '.')) || 10 }), 70)}
            <span className="hint" style={{ margin: 0 }}>kN/m³</span>
            <button className="btn-primary" onClick={run} disabled={running || !hasFolder}>
              {running ? 'Calculating…' : '▶ Run calculation'}
            </button>
            {runMsg && <span className={`msg ${runMsg.ok ? 'ok' : 'err'}`}>{runMsg.text}</span>}
          </div>
          <p className="hint" style={{ marginTop: 0 }}>
            Ticked columns are computed and written into the <code>{fname}.xlsx</code> datasheet
            (existing calc columns are overwritten in place). Defaults: UW + Nkt.
            Inputs come from the <strong>CPT point data</strong> / <strong>CPT layer data</strong> subtabs.
          </p>

          {groups.map(([g, entries]) => {
            const allSel = entries.every(c => selectedSet.has(c.name))
            const someSel = entries.some(c => selectedSet.has(c.name))
            return (
            <div key={g} style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '.45rem', margin: '0 0 .35rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={allSel}
                  ref={el => { if (el) el.indeterminate = !allSel && someSel }}
                  onChange={e => toggleGroup(entries, e.target.checked)}
                  title={`Select / deselect all ${g} columns`}
                />
                <h4 style={{ margin: 0 }}>{g}</h4>
                <span className="hint" style={{ fontWeight: 400 }}>
                  ({entries.filter(c => selectedSet.has(c.name)).length}/{entries.length} selected)
                </span>
              </label>
              <table className="data-table" style={{ maxWidth: 1280 }}>
                <thead>
                  <tr>
                    <th style={{ width: 36 }} />
                    <th style={{ width: 220 }}>Column</th>
                    <th>Description</th>
                    <th style={{ width: 64 }}>Unit</th>
                    <th style={{ width: 64 }}>Round</th>
                    <th style={{ width: 360 }}>Calculation reference</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(c => (
                    <tr
                      key={c.name}
                      onClick={() => toggleCol(c.name)}
                      className={selectedSet.has(c.name) ? 'selected' : ''}
                      style={{ cursor: 'pointer' }}
                    >
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox" checked={selectedSet.has(c.name)}
                          onChange={() => toggleCol(c.name)}
                          onClick={e => e.stopPropagation()}
                        />
                      </td>
                      <td><code style={{ fontSize: '.82em' }}>{c.name}</code></td>
                      <td style={{ fontSize: '.85em' }}>{c.desc}</td>
                      <td>{c.unit}</td>
                      <td onClick={e => e.stopPropagation()}>
                        {c.round >= 0 ? (
                          <input
                            type="text" inputMode="numeric"
                            value={config?.round?.[c.name] ?? c.round}
                            onChange={e => setRound(c.name, e.target.value)}
                            style={{ width: 48, textAlign: 'right' }}
                          />
                        ) : <span className="hint">text</span>}
                      </td>
                      <td style={{ fontSize: '.78em', color: '#475569' }}>{c.reference}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )
          })}
        </div>
      )}

      {/* ── Subtab 2: per-point inputs ── */}
      {sub === 'points' && (
        <div style={{ maxWidth: 920 }}>
          <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5rem' }}>
            <button className="btn-secondary btn-sm" onClick={() => openSettingsXlsx('point')}
                    title="Save the table below to cpt_point_data.xlsx and open it in Excel">
              📂 Open in Excel
            </button>
            <button className="btn-secondary btn-sm" onClick={loadPointData}
                    title="Re-read cpt_point_data.xlsx and the CPTData sheet">
              ↻ Reload from Excel
            </button>
            <span className="hint" style={{ margin: 0 }}>
              One row per point found in <code>CPTData.xlsx</code> · saved to{' '}
              <code>cpt calc settings/cpt_point_data.xlsx</code>
            </span>
          </div>
          {pointMsg && <p className="hint">{pointMsg}</p>}
          {pointRows.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>PointNo <ColumnFilterButton col={PH.point} label="PointNo" items={pointItems} getRow={it => it.r} filters={pointColFilters} setColFilter={setPointColFilter} /></th>
                  <th style={{ width: 90 }}>DB <ColumnFilterButton col={PH.db} label="DB" items={pointItems} getRow={it => it.r} filters={pointColFilters} setColFilter={setPointColFilter} /></th>
                  <th style={{ width: 130 }}>Project <ColumnFilterButton col={PH.proj} label="Project" items={pointItems} getRow={it => it.r} filters={pointColFilters} setColFilter={setPointColFilter} /></th>
                  <th style={{ width: 170 }}>Cone Area Ratio [-]</th>
                  <th style={{ width: 190 }}>Ground/Seabed Level [m]</th>
                  <th style={{ width: 160 }}>Water Level [m]</th>
                </tr>
              </thead>
              <tbody>
                {pointItemsFiltered.map(({ r, i }) => (
                  <tr key={`${r[PH.point]}_${i}`}>
                    <td>{r[PH.point]}</td>
                    <td>
                      <code style={{
                        fontSize: '.75rem', padding: '0.08rem 0.5rem', background: '#eef2ff',
                        color: '#3730a3', border: '1px solid #c7d2fe', borderRadius: 999, whiteSpace: 'nowrap',
                      }}>
                        {r[PH.db] || '?'}
                      </code>
                    </td>
                    <td>{r[PH.proj]}</td>
                    <td>{numInput(r[PH.area], v => editPoint(i, PH.area, v))}</td>
                    <td>{numInput(r[PH.gsb], v => editPoint(i, PH.gsb, v))}</td>
                    <td>{numInput(r[PH.water], v => editPoint(i, PH.water, v))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Subtab 3: per-layer inputs + Nkt method (Q-E5) ── */}
      {sub === 'layers' && (
        <div style={{ maxWidth: 700 }}>
          <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.6rem' }}>
            <label><strong>Nkt estimation method</strong> (used where the Nkt cell is blank)</label>
            <select
              value={config?.nkt_method || 'Mayne and Peuchen (2022)'}
              onChange={e => patchConfig({ nkt_method: e.target.value })}
            >
              <option value="Mayne and Peuchen (2022)">Mayne and Peuchen (2022)</option>
              <option value="Robertson (2012)">Robertson (2012)</option>
            </select>
          </div>
          <p className="hint" style={{ marginTop: 0 }}>
            Manual cells win; blank cells fall back to the estimate (UW: Robertson correlation;
            Nkt: the method above). Saved to <code>cpt calc settings/cpt_layer_data.xlsx</code>.
          </p>
          <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5rem' }}>
            <button className="btn-secondary btn-sm" onClick={() => openSettingsXlsx('layer')}
                    title="Save the table below to cpt_layer_data.xlsx and open it in Excel">
              📂 Open in Excel
            </button>
            <button className="btn-secondary btn-sm" onClick={loadLayerData}
                    title="Re-read cpt_layer_data.xlsx and the strata layers">
              ↻ Reload from Excel
            </button>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Strata <ColumnFilterButton col={LH.layer} label="Strata" items={layerItems} getRow={it => it.r} filters={layerColFilters} setColFilter={setLayerColFilter} /></th>
                <th style={{ width: 180 }}>Unit weight [kN/m³]</th>
                <th style={{ width: 140 }}>Nkt [-]</th>
              </tr>
            </thead>
            <tbody>
              {layerItemsFiltered.map(({ r, i }) => (
                <tr key={`${r[LH.layer]}_${i}`}>
                  <td>{r[LH.layer]}</td>
                  <td>{numInput(r[LH.uw], v => editLayer(i, LH.uw, v))}</td>
                  <td>{numInput(r[LH.nkt], v => editLayer(i, LH.nkt, v))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: '.6rem', display: 'flex', gap: '.4rem', alignItems: 'center' }}>
            <input
              type="text" value={newLayer} onChange={e => setNewLayer(e.target.value)}
              placeholder="add strata code…" style={{ width: 160 }}
            />
            <button className="btn-secondary btn-sm" onClick={addLayerRow} disabled={!newLayer.trim()}>+ Add</button>
          </div>
        </div>
      )}
    </div>
  )
}
