import { useState, useEffect, useMemo, useRef } from 'react'
import { invoke } from '../tauri-api'
import { useColumnFilters, ColumnFilterButton } from '../components/ColumnFilter'
import { invokeAndNotify, useDataChanged } from '../lib/dataChanged'
import { useApp } from '../context/AppContext'
import { useFilter } from '../context/FilterContext'
import { applyCoordinateSystem, normaliseEpsg } from '../lib/proj'

// ── CPT data reduction (issue #180, M7 / plan §D1; persisted config #196) ─────
function CptReduceSection({ datasheets, cfg, onPatch, onDone }) {
  const names = datasheets.map(d => d.fname)
  const c = { fname: 'CPTData', window_cm: '2', method: 'average', auto_apply: false, ...(cfg || {}) }
  // Offer the remembered fname even when the sheet has not been downloaded yet.
  const options = [...new Set([c.fname, ...names])].filter(Boolean)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg]   = useState(null)

  async function run() {
    setMsg(null)
    const w = parseFloat(String(c.window_cm).replace(',', '.'))
    if (!c.fname) { setMsg({ ok: false, text: 'Pick a datasheet.' }); return }
    if (!isFinite(w) || w <= 0) { setMsg({ ok: false, text: 'Window must be a positive number of centimetres.' }); return }
    setBusy(true)
    try {
      const r = await invokeAndNotify('datasheets', 'reduce_cpt_data', { fname: c.fname, windowCm: w, method: c.method })
      setMsg({ ok: true, text: `${r.file}: ${r.rows_before} → ${r.rows_after} rows` })
      onDone?.(c.fname)
    } catch (e) {
      setMsg({ ok: false, text: String(e).slice(0, 200) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ maxWidth: 680 }}>
      <h3 className="section-title">CPT data reduction</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        Reduces a CPT datasheet <strong>in place</strong>: per borehole, rows are bucketed into fixed
        depth windows (from 0 m, on the <code>Depth</code> column) and each non-empty window becomes
        one row — the average/median of every numeric column, incl. Depth. Strata columns are
        re-applied afterwards. Empty windows produce no row. This overwrites the file — run
        Download again to restore the raw data.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '.5rem .75rem', alignItems: 'center' }}>
        <label>Datasheet</label>
        <select value={c.fname} onChange={e => onPatch({ fname: e.target.value })} style={{ maxWidth: 260 }}>
          {options.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <label>Window</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
          <input
            type="text" inputMode="decimal" value={String(c.window_cm ?? '')}
            onChange={e => onPatch({ window_cm: e.target.value })}
            style={{ width: 80 }}
          />
          <span className="hint" style={{ margin: 0 }}>cm (e.g. 2 or 10)</span>
        </div>
        <label>Method</label>
        <select value={c.method} onChange={e => onPatch({ method: e.target.value })} style={{ maxWidth: 260 }}>
          <option value="average">Moving average</option>
          <option value="median">Moving median</option>
        </select>
        <label>Auto-apply</label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem', fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={!!c.auto_apply}
            onChange={e => onPatch({ auto_apply: e.target.checked })}
          />
          Run this reduction automatically after Download / Append of <code>{c.fname}</code>
        </label>
      </div>
      <p className="hint" style={{ marginTop: '.5rem' }}>
        These settings are saved in <code>GIRTool_settings.json</code> — they survive tab switches and restarts.
      </p>
      <div style={{ marginTop: '.75rem', display: 'flex', gap: '.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn-primary" onClick={run} disabled={busy || !c.fname}>
          {busy ? 'Reducing…' : '🔬 Reduce data'}
        </button>
        {msg && <span className={`msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</span>}
      </div>
      {names.length === 0 && <p className="hint" style={{ marginTop: '.6rem' }}>No datasheets yet — download data first.</p>}
    </div>
  )
}

export default function DataPage() {
  const { selectedProjects, selectedPoints, connection, coordinateSystem } = useApp()
  // allPoints = every point in the selected projects (issue #149).  Used to
  // build the per-point coordinate overrides so datasheets convert even when no
  // specific points are ticked (download = all project points).
  const { allPoints } = useFilter()

  // ── Query list (read-only — editing moved to Settings → Query Config in #47) ─
  const [queries, setQueries]   = useState([])
  const [loadingQ, setLoadingQ] = useState(false)

  // ── Data save ─────────────────────────────────────────────────────────────
  const [selected, setSelected]     = useState({})   // fname -> bool
  const [savingData, setSavingData] = useState(false)
  const [saveResult, setSaveResult] = useState(null)
  // Issue #192: per-datasheet status badges shown beside each query name
  // during/after Download / Append / Re-add.  fname → { state, text }.
  const [fileStatus, setFileStatus] = useState({})
  const markStatuses = (names, st) =>
    setFileStatus(prev => {
      const next = { ...prev }
      names.forEach(f => { next[f] = st })
      return next
    })
  const applyResultStatuses = (res, okText) =>
    setFileStatus(prev => {
      const next = { ...prev }
      for (const f of (res?.saved ?? res?.results ?? res?.updated ?? [])) {
        next[String(f.file).replace(/\.xlsx$/i, '')] = { state: 'ok', text: okText(f) }
      }
      for (const e of (res?.errors ?? [])) {
        next[String(e.file).replace(/\.xlsx$/i, '')] = { state: 'err', text: String(e.error).slice(0, 80) }
      }
      return next
    })

  // ── CPT reduction config (issue #196): persisted in GIRTool_settings.json ─
  const [reduceCfg, setReduceCfg] = useState(null)
  const reduceSaveTimer = useRef(null)
  useEffect(() => {
    if (!connection?.output_folder) return
    invoke('get_cpt_reduction_config')
      .then(c => setReduceCfg({ fname: 'CPTData', window_cm: '2', method: 'average', auto_apply: false, ...(c || {}) }))
      .catch(() => setReduceCfg({ fname: 'CPTData', window_cm: '2', method: 'average', auto_apply: false }))
  }, [connection?.output_folder])
  // #213: reduction settings changed in another window (incl. Auto-apply).
  useDataChanged('cpt', () => {
    invoke('get_cpt_reduction_config')
      .then(c => setReduceCfg(prev => ({ ...(prev || {}), ...(c || {}) })))
      .catch(() => {})
  })
  function patchReduceCfg(patch) {
    setReduceCfg(prev => {
      const next = { ...(prev || {}), ...patch }
      clearTimeout(reduceSaveTimer.current)
      reduceSaveTimer.current = setTimeout(() => {
        invokeAndNotify('cpt', 'save_cpt_reduction_config', { config: next }).catch(() => {})
      }, 400)
      return next
    })
  }
  // Auto-apply the reduction to `name` right after Download/Append wrote it.
  async function maybeAutoReduce(name) {
    const rc = reduceCfg
    if (!rc?.auto_apply || name !== (rc.fname || 'CPTData')) return
    const w = parseFloat(String(rc.window_cm).replace(',', '.'))
    if (!isFinite(w) || w <= 0) return
    markStatuses([name], { state: 'pending', text: '⏳ reducing…' })
    try {
      const r = await invokeAndNotify('datasheets', 'reduce_cpt_data', { fname: name, windowCm: w, method: rc.method || 'average' })
      markStatuses([name], {
        state: 'ok',
        text: `✓ ${Number(r.rows_before).toLocaleString()} → ${Number(r.rows_after).toLocaleString()} rows (reduced)`,
      })
    } catch (e) {
      markStatuses([name], { state: 'err', text: `reduction failed: ${String(e).slice(0, 60)}` })
    }
  }

  // ── Re-add Strata ─────────────────────────────────────────────────────────
  const [readdingStrata, setReaddingStrata] = useState(false)
  const [readdResult,    setReaddResult]    = useState(null)

  // ── Shared error ──────────────────────────────────────────────────────────
  const [error, setError] = useState('')

  // ── Issue #113: Datasheet subtabs (one per .xlsx under output/Datasheets/) ─
  const [datasheets, setDatasheets] = useState([])
  const [activeTab,  setActiveTab]  = useState(null)
  // Issue #115: top-level toggle between the Download menu and the Data
  // preview.  Default chosen on first render based on whether any files
  // already exist; auto-switches to 'preview' after a successful
  // Download / Append.
  const [viewTab,    setViewTab]    = useState('download')
  // Cache for the preview's read_datasheet results.  Lives on the page so
  // flipping between subtabs is instant; cleared per-fname when the
  // datasheet list refreshes (after Download / Append).
  const previewCacheRef = useRef(new Map())

  // Tracks whether the user has manually toggled the top view tab.  Stops the
  // initial-load auto-switch from overriding their choice on later
  // connection-folder changes.
  const viewTabTouchedRef = useRef(false)
  // Issue #117: pre-load all datasheets into the cache so flipping between
  // subtabs is instant.  This flag lets us show a small "Loading…" hint while
  // the parallel fetches resolve.
  const [preloading, setPreloading] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)

  // Pre-load every fname in `names` into `previewCacheRef` in parallel.
  // Already-cached entries are skipped unless `force` is true.
  async function preloadDatasheets(names, { force = false } = {}) {
    const toFetch = force
      ? names
      : names.filter(n => !previewCacheRef.current.has(n))
    if (toFetch.length === 0) return
    setPreloading(true)
    try {
      await Promise.all(toFetch.map(async fname => {
        try {
          const data = await invoke('read_datasheet', { fname })
          if (data) previewCacheRef.current.set(fname, data)
        } catch (err) {
          console.warn(`preload ${fname} failed:`, err)
        }
      }))
    } finally {
      setPreloading(false)
    }
  }

  // #213: another window downloaded / appended / reduced datasheets — drop
  // the preview cache (we don't know which files changed) and re-list.
  useDataChanged('datasheets', () => {
    previewCacheRef.current.clear()
    refreshDatasheets({ keepActive: true })
  })

  async function refreshDatasheets({ keepActive = true, invalidate = null, autoSwitchView = false } = {}) {
    try {
      const list = await invoke('list_datasheets')
      // Drop any stale preview cache entries for files that no longer exist
      // (deleted) or that we know just changed.
      const live = new Set(list.map(e => e.fname))
      for (const k of [...previewCacheRef.current.keys()]) {
        if (!live.has(k) || (invalidate && invalidate.has(k))) {
          previewCacheRef.current.delete(k)
        }
      }
      setDatasheets(list)
      if (!keepActive || !list.some(e => e.fname === activeTab)) {
        setActiveTab(list[0]?.fname ?? null)
      }
      // Issue #115: on first load, jump to the Data preview if there are
      // already files on disk.  Skip the jump once the user has clicked the
      // top tab themselves.
      if (autoSwitchView && !viewTabTouchedRef.current && list.length > 0) {
        setViewTab('preview')
      }
      // Issue #117: pre-load every datasheet into the cache in parallel.
      // Fire-and-forget; the subtab UI shows whatever is cached.
      preloadDatasheets(list.map(e => e.fname))
    } catch (err) {
      console.error(err)
    }
  }

  // Manual "↻ Reload data" — drops the cache and re-fetches every file.
  async function reloadAllDatasheets() {
    previewCacheRef.current.clear()
    // Bump tick so the DatasheetPreview re-reads from cache (otherwise it
    // would keep showing the old data because activeTab didn't change).
    setReloadTick(t => t + 1)
    await preloadDatasheets(datasheets.map(d => d.fname), { force: true })
  }

  // Initial + connection-change load.  Pre-existing files surface before the
  // user even clicks Download.  `autoSwitchView` lets refreshDatasheets jump
  // to the Data preview tab when files already exist on first mount.
  useEffect(() => {
    refreshDatasheets({ keepActive: true, autoSwitchView: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.output_folder])

  const projectId = selectedProjects[0]?.ProjectId

  // Load queries when project changes
  useEffect(() => { if (projectId) fetchQueries() }, [projectId])  // eslint-disable-line react-hooks/exhaustive-deps

  // Select all queries by default when list loads
  useEffect(() => {
    const all = {}
    queries.forEach(q => { all[q.fname] = true })
    setSelected(all)
  }, [queries])

  async function fetchQueries() {
    setLoadingQ(true); setError('')
    try {
      const res = await invoke('list_queries', { projectId })
      setQueries(res)
    } catch (err) {
      console.error(err)
      setError(err || 'Failed to load queries')
    } finally { setLoadingQ(false) }
  }

  // ── Data save ─────────────────────────────────────────────────────────────

  const [appendResult, setAppendResult] = useState(null)
  const [appending,    setAppending]    = useState(false)

  function buildPayload(queryNames) {
    // Issue #105: send project_ids / point_ids in per-DB form so the
    // backend can fan out across every database.  Each entry carries
    // the db_id of the source database so download_data groups them
    // correctly.  Falls back to the legacy ProjectId-only shape when
    // the upstream rows don't have db_id (shouldn't happen post-#51).
    const hasProjDb = selectedProjects.some(p => p?.db_id)
    const hasPtDb   = selectedPoints.some(p => p?.db_id)

    // Issue #149: per-point coordinate overrides keyed by `db_id||PointId`.
    // Built from the converted project points so the backend can rewrite each
    // datasheet's coordinate / Level columns into the project's target CRS.
    // Omitted (empty) when no coordinate system is configured.
    const coord_overrides = {}
    if (normaliseEpsg(coordinateSystem?.target_epsg)) {
      const basis = (allPoints && allPoints.length) ? allPoints : selectedPoints
      const converted = applyCoordinateSystem(basis, coordinateSystem)
      const offsets = coordinateSystem?.elevation_offsets || {}
      for (const cp of converted) {
        if (cp?.PointId == null) continue
        const key = `${cp.db_id ?? ''}||${cp.PointId}`
        const zoff = Number(offsets[String(cp.LevelReference)]) || 0
        coord_overrides[key] = {
          X1: cp.X1 ?? null,
          Y1: cp.Y1 ?? null,
          Z1: cp.Z1 ?? null,
          Projection1: cp.Projection1 != null ? String(cp.Projection1) : '',
          Zoffset: zoff,
        }
      }
    }

    return {
      coord_overrides,
      // Primary project — used by the backend for strata lookup.
      project_id:    selectedProjects[0]?.ProjectId ?? '',
      project_ids:   hasProjDb
        ? selectedProjects.map(p => ({ db_id: p.db_id, ProjectId: p.ProjectId }))
        : selectedProjects.map(p => p.ProjectId),
      point_ids:     hasPtDb
        ? selectedPoints.map(p => ({ db_id: p.db_id, PointId: p.PointId }))
        : selectedPoints.map(p => p.PointId),
      query_names:   queryNames,
      projects_meta: selectedProjects.map(p => ({
        ProjectId: p.ProjectId, ProjectNo: p.ProjectNo, Title: p.Title,
      })),
      points_meta: selectedPoints.map(p => ({
        PointId: p.PointId, PointNo: p.PointNo, PointType: p.PointType,
      })),
    }
  }

  // Issue #194: Download runs ONE BACKEND CALL PER DATASHEET, sequentially —
  // the per-sheet status badges tick over live and one failing sheet can't
  // block the rest.  Results aggregate into the same summary box.
  async function handleSave() {
    setSavingData(true); setSaveResult(null); setAppendResult(null); setReaddResult(null); setError('')
    const queryNames = Object.entries(selected).filter(([, v]) => v).map(([k]) => k)
    markStatuses(queryNames, { state: 'pending', text: '⏳ queued…' })
    const base = buildPayload([])
    const agg = { folder: '', saved: [], errors: [] }
    for (const name of queryNames) {
      markStatuses([name], { state: 'pending', text: '⏳ downloading…' })
      try {
        const res = await invokeAndNotify('datasheets', 'download_data', { projectId, query: { ...base, query_names: [name] } })
        agg.folder = res?.folder ?? agg.folder
        for (const f of (res?.saved ?? [])) agg.saved.push(f)
        for (const e of (res?.errors ?? [])) agg.errors.push(e)
        applyResultStatuses(res, f => `✓ ${Number(f.rows ?? 0).toLocaleString()} rows`)
        if ((res?.saved ?? []).length) await maybeAutoReduce(name)
      } catch (err) {
        console.error(err)
        agg.errors.push({ file: `${name}.xlsx`, error: String(err) })
        markStatuses([name], { state: 'err', text: String(err).slice(0, 80) })
      }
    }
    setSaveResult(agg)
    // Issue #113: refresh subtab list + invalidate cache for files just rewritten.
    const touched = new Set(agg.saved.map(s => s.file.replace(/\.xlsx$/i, '')))
    await refreshDatasheets({ keepActive: true, invalidate: touched })
    // Issue #115: jump to the preview so the user sees the result.
    setViewTab('preview')
    viewTabTouchedRef.current = true
    setSavingData(false)
  }

  async function handleAppend() {
    setAppending(true); setSaveResult(null); setAppendResult(null); setReaddResult(null); setError('')
    const queryNames = Object.entries(selected).filter(([, v]) => v).map(([k]) => k)
    markStatuses(queryNames, { state: 'pending', text: '⏳ queued…' })
    const base = buildPayload([])
    const agg = { folder: '', results: [], errors: [] }
    for (const name of queryNames) {
      markStatuses([name], { state: 'pending', text: '⏳ appending…' })
      try {
        const res = await invokeAndNotify('datasheets', 'append_data', { projectId, query: { ...base, query_names: [name] } })
        agg.folder = res?.folder ?? agg.folder
        for (const f of (res?.saved ?? res?.results ?? [])) agg.results.push(f)
        for (const e of (res?.errors ?? [])) agg.errors.push(e)
        applyResultStatuses(res, f => (f.appended != null
          ? `✓ +${f.appended} · ${f.skipped ?? 0} skipped`
          : `✓ ${Number(f.rows ?? 0).toLocaleString()} rows`))
        if ((res?.saved ?? res?.results ?? []).length) await maybeAutoReduce(name)
      } catch (err) {
        console.error(err)
        agg.errors.push({ file: `${name}.xlsx`, error: String(err) })
        markStatuses([name], { state: 'err', text: String(err).slice(0, 80) })
      }
    }
    setAppendResult(agg)
    const touched = new Set(agg.results.map(s => s.file.replace(/\.xlsx$/i, '')))
    await refreshDatasheets({ keepActive: true, invalidate: touched })
    // Issue #115: jump to the preview so the user sees the appended rows.
    setViewTab('preview')
    viewTabTouchedRef.current = true
    setAppending(false)
  }

  async function handleReaddStrata() {
    setReaddingStrata(true); setSaveResult(null); setAppendResult(null); setReaddResult(null); setError('')
    const strataNames = queries.filter(q => q.apply_strata === 'Yes').map(q => q.fname)
    markStatuses(strataNames, { state: 'pending', text: '⏳ re-adding strata…' })
    try {
      const res = await invokeAndNotify('datasheets', 'readd_strata', { projectId, query: buildPayload([]) })
      setReaddResult(res)
      applyResultStatuses(res, f => `🪨 ✓ ${Number(f.rows ?? 0).toLocaleString()} rows`)
      const touched = new Set((res?.updated ?? []).map(s => s.file.replace(/\.xlsx$/i, '')))
      await refreshDatasheets({ keepActive: true, invalidate: touched })
    } catch (err) {
      console.error(err)
      setError(err || 'Re-add strata failed — check the backend log.')
      markStatuses(strataNames, { state: 'err', text: 'failed' })
    } finally { setReaddingStrata(false) }
  }

  // ── Guard ─────────────────────────────────────────────────────────────────

  if (!selectedProjects.length) {
    return (
      <div className="page page-wide">
        <h2 className="page-title">Data</h2>
        <p className="hint">Select a project first.</p>
      </div>
    )
  }

  const numSelected = Object.values(selected).filter(Boolean).length
  const hasFolder   = !!connection?.output_folder

  return (
    <div className="page page-wide">
      <div className="page-header">
        <h2 className="page-title">Data</h2>
        {/*
          The legacy in-page "Query config" tab moved to Settings → Query Config
          in issue #47.  The Save data tab is the only one left here.
        */}
      </div>

      <p
        className="hint"
        style={{ marginBottom: '1.25rem' }}
        title={selectedProjects.map(p => p.ProjectNo).join(', ')}
      >
        {selectedProjects.length > 3
          ? <>Projects: <strong>{selectedProjects.length} selected</strong> (hover for the list)</>
          : <>Project{selectedProjects.length > 1 ? 's' : ''}: <strong>{selectedProjects.map(p => p.ProjectNo).join(', ')}</strong></>}
        {selectedPoints.length > 0
          ? <> · <strong>{selectedPoints.length} point{selectedPoints.length > 1 ? 's' : ''}</strong> selected</>
          : <> · <em>all points</em></>}
      </p>

      {error && <p className="msg err" style={{ marginBottom: '1rem' }}>{error}</p>}

      {/* ══ TOP VIEW TABS (issue #115) ═════════════════════════════════════ */}
      <div style={{
        display: 'flex', gap: '.4rem', marginBottom: '1rem',
        borderBottom: '1px solid var(--border, #e5e7eb)', paddingBottom: '.4rem',
      }}>
        {[
          { key: 'download', label: '⬇ Download menu' },
          { key: 'preview',  label: `📊 Data preview${datasheets.length > 0 ? ` (${datasheets.length})` : ''}` },
          { key: 'reduce',   label: '🔬 CPT reduction' },
        ].map(t => {
          const active = viewTab === t.key
          return (
            <button
              key={t.key}
              onClick={() => { setViewTab(t.key); viewTabTouchedRef.current = true }}
              style={{
                padding:      '.45rem .9rem',
                borderRadius: '6px 6px 0 0',
                border:       active ? '1px solid var(--border, #d1d5db)' : '1px solid transparent',
                borderBottom: active ? '1px solid #fff' : '1px solid transparent',
                background:   active ? '#fff' : 'transparent',
                color:        active ? 'var(--primary, #1d4ed8)' : '#374151',
                cursor:       'pointer',
                fontSize:     '.88rem',
                fontWeight:   active ? 600 : 500,
                marginBottom: '-1px',
              }}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      {/* ══ SAVE DATA ═════════════════════════════════════════════════════ */}
      {viewTab === 'download' && (
        <div className="card" style={{ maxWidth: 620, gap: '1rem' }}>

          {/* Query checklist */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>Select queries to save</strong>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn-secondary btn-sm"
                onClick={() => setSelected(Object.fromEntries(queries.map(q => [q.fname, true])))}>
                All
              </button>
              <button className="btn-secondary btn-sm" onClick={() => setSelected({})}>
                None
              </button>
            </div>
          </div>

          {loadingQ ? <p className="hint">Loading queries…</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {queries.map(q => (
                <label key={q.fname} className="query-check-row">
                  <input type="checkbox"
                    checked={!!selected[q.fname]}
                    onChange={() => setSelected(s => ({ ...s, [q.fname]: !s[q.fname] }))}
                  />
                  <span className="query-check-name">{q.fname}</span>
                  <span className={`strata-badge ${q.apply_strata === 'Yes' ? 'yes' : 'no'}`}>
                    {q.apply_strata === 'Yes' ? 'Strata' : 'No strata'}
                  </span>
                  {fileStatus[q.fname] && (
                    <span
                      style={{
                        marginLeft: 'auto', fontSize: '.75rem', whiteSpace: 'nowrap',
                        color: fileStatus[q.fname].state === 'ok' ? '#15803d'
                          : fileStatus[q.fname].state === 'err' ? '#b91c1c' : '#b45309',
                      }}
                      title={fileStatus[q.fname].text}
                    >
                      {fileStatus[q.fname].text}
                    </span>
                  )}
                </label>
              ))}
            </div>
          )}

          {/* Save action */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
            {!hasFolder ? (
              <p className="msg err">
                No output folder configured — go to <strong>⚙ Settings</strong> and set a folder path first.
              </p>
            ) : (
              <>
                <p className="hint" style={{ marginBottom: '0.75rem' }}>
                  Saving to: <code>{connection.output_folder}</code>
                </p>
                <div style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap' }}>
                  <button className="btn-primary" onClick={handleSave}
                          disabled={savingData || appending || readdingStrata || numSelected === 0} style={{ minWidth: 180 }}>
                    {savingData ? '⏳ Downloading…' : `⬇ Download ${numSelected} datasheet${numSelected !== 1 ? 's' : ''}`}
                  </button>
                  <button className="btn-secondary" onClick={handleAppend}
                          disabled={savingData || appending || readdingStrata || numSelected === 0} style={{ minWidth: 180 }}
                          title="Append only rows whose ID is not already in the file">
                    {appending ? '⏳ Appending…' : `⊕ Append ${numSelected} datasheet${numSelected !== 1 ? 's' : ''}`}
                  </button>
                  <button className="btn-secondary" onClick={handleReaddStrata}
                          disabled={savingData || appending || readdingStrata}
                          title="Re-apply Primary Layer / Secondary Layer from strata.xlsx to all data files with Apply Strata = Yes">
                    {readdingStrata ? '⏳ Re-adding…' : '🪨 Re-add Strata'}
                  </button>
                </div>
                {reduceCfg?.auto_apply && (
                  <p className="hint" style={{ marginTop: '.5rem' }}>
                    🔬 Auto-reduction is <strong>ON</strong>: {reduceCfg.fname || 'CPTData'} will be reduced
                    ({String(reduceCfg.window_cm)} cm {reduceCfg.method}) right after Download / Append.
                    Configure under the <strong>CPT reduction</strong> tab.
                  </p>
                )}
              </>
            )}

            {saveResult && (
              <div className="save-result">
                <p className="save-result-folder">✓ Saved to: <strong>{saveResult.folder}</strong></p>
                <div className="save-result-list">
                  {saveResult.saved.map(f => (
                    <div key={f.file} className="save-result-row ok">
                      <span className="save-result-name">{f.file}</span>
                      <span className="save-result-rows">{f.rows.toLocaleString()} rows</span>
                      {f.sp_upload?.uploaded && (
                        <span style={{ marginLeft: 6, color: '#0369a1', fontSize: '.78rem' }} title="Uploaded to SharePoint">☁</span>
                      )}
                      {f.sp_upload?.error && (
                        <span style={{ marginLeft: 6, color: '#b91c1c', fontSize: '.78rem' }} title={`SharePoint upload failed: ${f.sp_upload.error}`}>☁⚠</span>
                      )}
                    </div>
                  ))}
                  {saveResult.errors.map(e => (
                    <div key={e.file} className="save-result-row err">
                      <span className="save-result-name">{e.file}</span>
                      <span className="save-result-rows" style={{ color: '#991b1b' }}>{e.error}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {appendResult && (
              <div className="save-result">
                <p className="save-result-folder">⊕ Appended to: <strong>{appendResult.folder}</strong></p>
                <div className="save-result-list">
                  {appendResult.results?.map(f => (
                    <div key={f.file} className="save-result-row ok">
                      <span className="save-result-name">{f.file}</span>
                      <span className="save-result-rows">
                        +{f.appended} appended · {f.skipped} already present
                      </span>
                      {f.sp_upload?.uploaded && (
                        <span style={{ marginLeft: 6, color: '#0369a1', fontSize: '.78rem' }} title="Uploaded to SharePoint">☁</span>
                      )}
                      {f.sp_upload?.error && (
                        <span style={{ marginLeft: 6, color: '#b91c1c', fontSize: '.78rem' }} title={`SharePoint upload failed: ${f.sp_upload.error}`}>☁⚠</span>
                      )}
                    </div>
                  ))}
                  {appendResult.errors?.map(e => (
                    <div key={e.file} className="save-result-row err">
                      <span className="save-result-name">{e.file}</span>
                      <span className="save-result-rows" style={{ color: '#991b1b' }}>{e.error}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {readdResult && (
              <div className="save-result">
                <p className="save-result-folder">🪨 Strata re-applied</p>
                <div className="save-result-list">
                  {readdResult.updated?.map(f => (
                    <div key={f.file} className="save-result-row ok">
                      <span className="save-result-name">{f.file}</span>
                      <span className="save-result-rows">{f.rows.toLocaleString()} rows updated</span>
                    </div>
                  ))}
                  {readdResult.errors?.map(e => (
                    <div key={e.file} className="save-result-row err">
                      <span className="save-result-name">{e.file}</span>
                      <span className="save-result-rows" style={{ color: '#991b1b' }}>{e.error}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══ DATASHEET SUBTABS (issue #113) — gated by top view tab (#115) ═ */}
      {/* ══ CPT REDUCTION VIEW (issue #180, M7) ════════════════════════════ */}
      {viewTab === 'reduce' && (
        <CptReduceSection
          datasheets={datasheets}
          cfg={reduceCfg}
          onPatch={patchReduceCfg}
          onDone={(fname) => refreshDatasheets({ keepActive: true, invalidate: new Set([fname]) })}
        />
      )}

      {viewTab === 'preview' && datasheets.length === 0 && (
        <p className="hint">
          No downloaded datasheets in <code>{connection?.output_folder || '<output folder>'}/Datasheets/</code> yet.
          Switch to the <strong>Download menu</strong> tab above to fetch some.
        </p>
      )}
      {viewTab === 'preview' && datasheets.length > 0 && (
        <div style={{ marginTop: '0.5rem' }}>
          <div className="datasheet-tabs"
               style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center',
                        gap: '.4rem', marginBottom: '.75rem' }}>
            {/* Issue #117: drop the in-memory cache + re-fetch every file. */}
            <button
              onClick={reloadAllDatasheets}
              disabled={preloading}
              className="btn-secondary btn-sm"
              title="Drop cached previews and re-read every datasheet from disk"
              style={{ marginRight: '.3rem' }}
            >
              {preloading ? '⏳ Loading…' : '↻ Reload data'}
            </button>
            <button
              onClick={() => activeTab && invoke('open_datasheet', { path: activeTab }).catch(err => setError(String(err)))}
              disabled={!activeTab}
              className="btn-secondary btn-sm"
              title={activeTab ? `Open ${activeTab}.xlsx in Excel` : 'Select a datasheet first'}
              style={{ marginRight: '.3rem' }}
            >
              📂 Open in Excel
            </button>
            {datasheets.map(ds => {
              const active = ds.fname === activeTab
              return (
                <button
                  key={ds.fname}
                  className="datasheet-tab-pill"
                  onClick={() => setActiveTab(ds.fname)}
                  style={{
                    padding:      '.35rem .8rem',
                    borderRadius: 999,
                    border:       active ? '1px solid var(--primary, #2563eb)' : '1px solid var(--border, #d1d5db)',
                    background:   active ? 'var(--primary, #2563eb)' : 'var(--surface, #f9fafb)',
                    color:        active ? '#fff' : 'inherit',
                    cursor:       'pointer',
                    fontSize:     '.82rem',
                    fontWeight:   active ? 600 : 500,
                    transition:   'background .12s, color .12s',
                  }}
                  title={ds.has_strata ? 'Includes Primary Layer column' : 'No strata column'}
                >
                  {ds.fname}
                  <span style={{
                    marginLeft: '.4rem', opacity: 0.7, fontSize: '.78rem',
                  }}>
                    ({ds.row_count.toLocaleString()})
                  </span>
                </button>
              )
            })}
          </div>

          {activeTab && (
            <DatasheetPreview
              // Issue #117: include reloadTick in the key so Reload forces a
              // fresh DatasheetPreview mount that re-reads the (now empty
              // and re-populated) cache.
              key={`${activeTab}#${reloadTick}`}
              fname={activeTab}
              cacheRef={previewCacheRef}
            />
          )}
        </div>
      )}

      {/* The in-page Query Config tab moved to Settings → Query Config (issue #47). */}
    </div>
  )
}

// ── Issue #113: Paginated, filterable preview of one datasheet xlsx ──────────

const PAGE_STEP = 50

function DatasheetPreview({ fname, cacheRef }) {
  const [data, setData]       = useState({ columns: [], rows: [] })
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')

  // Sort + search + pagination state.  All reset whenever `fname` changes.
  const [sortCol, setSortCol] = useState(null)   // index into visibleColumns
  const [sortDir, setSortDir] = useState('asc')
  const [search,  setSearch]  = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_STEP)

  const { filteredPtIds, checkedStrataPrimary, checkedStrataSecondary } = useFilter()

  // Load + cache on fname change.
  useEffect(() => {
    let cancelled = false
    const cached = cacheRef.current.get(fname)
    if (cached) {
      setData(cached)
      setLoading(false)
      setLoadError('')
    } else {
      setLoading(true)
      setLoadError('')
      setData({ columns: [], rows: [] })
      invoke('read_datasheet', { fname })
        .then(res => {
          if (cancelled) return
          const payload = {
            columns: Array.isArray(res?.columns) ? res.columns : [],
            rows:    Array.isArray(res?.rows)    ? res.rows    : [],
          }
          cacheRef.current.set(fname, payload)
          setData(payload)
        })
        .catch(err => {
          if (cancelled) return
          console.error(err)
          setLoadError(String(err))
        })
        .finally(() => { if (!cancelled) setLoading(false) })
    }
    setSortCol(null); setSortDir('asc'); setSearch('')
    setVisibleCount(PAGE_STEP)
    return () => { cancelled = true }
  }, [fname, cacheRef])

  // Hide every column whose header ends in `Id` (case-insensitive),
  // EXCEPT `db_id` which always stays visible.  Mirrors the xlsx behaviour
  // in `is_id_column` (download.rs) and matches the acceptance criteria.
  const visibleColumns = useMemo(() => {
    return data.columns
      .map((c, i) => ({ name: c, idx: i }))
      .filter(c => /^db_id$/i.test(c.name) || !/id$/i.test(c.name))
  }, [data.columns])

  // Column lookups used for filter wiring (case-insensitive against the raw
  // column names, not the visible subset — filter must apply even if
  // PointId itself is hidden from the table).
  const filterIdx = useMemo(() => {
    const find = (re) => data.columns.findIndex(c => re.test(c))
    return {
      pid: find(/^pointid$/i),
      pri: find(/^primary layer$/i),
      sec: find(/^secondary layer$/i),
    }
  }, [data.columns])

  // Apply the global FilterPanel selection (same axes Map/Charts consume).
  // A null selection on a given axis means "no filter on that axis".  If a
  // row's value isn't in the active set the row is filtered out.
  const filteredRows = useMemo(() => {
    const anyFilter = filteredPtIds !== null
                   || checkedStrataPrimary   !== null
                   || checkedStrataSecondary !== null
    if (!anyFilter) return data.rows

    return data.rows.filter(row => {
      if (filteredPtIds !== null && filterIdx.pid >= 0) {
        const v = row[filterIdx.pid]
        if (v == null || !filteredPtIds.has(String(v))) return false
      }
      if (checkedStrataPrimary !== null && filterIdx.pri >= 0) {
        const v = row[filterIdx.pri] ?? 'Unknown'
        if (!checkedStrataPrimary.has(v)) return false
      }
      if (checkedStrataSecondary !== null && filterIdx.sec >= 0) {
        const v = row[filterIdx.sec] ?? 'Unknown'
        if (!checkedStrataSecondary.has(v)) return false
      }
      return true
    })
  }, [data.rows, filteredPtIds, checkedStrataPrimary, checkedStrataSecondary, filterIdx])

  // #248: Excel-style per-column filters.  Preview rows are POSITIONAL
  // arrays, so the column key is the real column index.
  const { filters: colFilters, setColFilter, filteredItems: colFilteredRows } =
    useColumnFilters(filteredRows)

  // Search across the *visible* columns only — hidden ID columns shouldn't
  // pollute the search.
  const searchedRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return colFilteredRows
    const visIdxs = visibleColumns.map(c => c.idx)
    return colFilteredRows.filter(row => {
      for (const i of visIdxs) {
        const v = row[i]
        if (v == null) continue
        if (String(v).toLowerCase().includes(q)) return true
      }
      return false
    })
  }, [colFilteredRows, search, visibleColumns])

  // Sort by the clicked visible column.  Stable, simple — copies once.
  const sortedRows = useMemo(() => {
    if (sortCol == null || !visibleColumns[sortCol]) return searchedRows
    const realIdx = visibleColumns[sortCol].idx
    const dir = sortDir === 'asc' ? 1 : -1
    const rows = [...searchedRows]
    rows.sort((a, b) => {
      const av = a[realIdx]; const bv = b[realIdx]
      if (av == null && bv == null) return 0
      if (av == null) return  1
      if (bv == null) return -1
      // Numeric compare when both look numeric, else lexicographic.
      const an = typeof av === 'number' ? av : Number(av)
      const bn = typeof bv === 'number' ? bv : Number(bv)
      if (Number.isFinite(an) && Number.isFinite(bn)) return dir * (an - bn)
      return dir * String(av).localeCompare(String(bv))
    })
    return rows
  }, [searchedRows, sortCol, sortDir, visibleColumns])

  // Reset pagination whenever the result set or sort changes.
  useEffect(() => { setVisibleCount(PAGE_STEP) }, [search, sortCol, sortDir, colFilters,
                                                  filteredPtIds, checkedStrataPrimary, checkedStrataSecondary])

  const displayed = sortedRows.slice(0, visibleCount)
  const hasMore   = sortedRows.length > displayed.length

  function handleScroll(e) {
    if (!hasMore) return
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      setVisibleCount(c => Math.min(c + PAGE_STEP, sortedRows.length))
    }
  }

  function handleSort(visColIdx) {
    setSortCol(prev => {
      if (prev === visColIdx) {
        setSortDir(d => d === 'asc' ? 'desc' : 'asc')
        return prev
      }
      setSortDir('asc')
      return visColIdx
    })
  }

  if (loadError) {
    return <p className="msg err">Failed to load <code>{fname}.xlsx</code>: {loadError}</p>
  }
  if (loading && !data.columns.length) {
    return <p className="hint">Loading {fname}…</p>
  }
  if (!data.columns.length) {
    return <p className="hint">No data in <code>{fname}.xlsx</code>.</p>
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    gap: '.75rem', marginBottom: '.5rem', flexWrap: 'wrap' }}>
        <span className="hint" style={{ fontSize: '.82rem' }}>
          Showing {displayed.length.toLocaleString()} of {sortedRows.length.toLocaleString()} rows
          {hasMore && ' · scroll for more'}
        </span>
        <input
          type="text"
          placeholder="Search…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            padding: '.25rem .5rem', borderRadius: 4,
            border: '1px solid var(--border, #d1d5db)', fontSize: '.82rem',
            minWidth: 180,
          }}
        />
      </div>

      <div
        style={{ maxHeight: '60vh', overflowY: 'auto',
                 border: '1px solid var(--border, #d1d5db)', borderRadius: 6 }}
        onScroll={handleScroll}
      >
        <table className="data-table" style={{ fontSize: '.82rem' }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: '#fff' }}>
            <tr>
              {visibleColumns.map((c, i) => (
                <th
                  key={c.idx}
                  onClick={() => handleSort(i)}
                  style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
                           padding: '.4rem .55rem', borderBottom: '1px solid var(--border, #d1d5db)' }}
                  title={`Sort by ${c.name}`}
                >
                  {c.name}{sortCol === i ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                  {' '}
                  <ColumnFilterButton col={c.idx} label={c.name} items={filteredRows}
                                      filters={colFilters} setColFilter={setColFilter} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayed.map((row, ri) => (
              <tr key={ri}>
                {visibleColumns.map(c => (
                  <td key={c.idx} style={{ padding: '.3rem .55rem',
                                            whiteSpace: 'nowrap',
                                            borderBottom: '1px solid var(--border-light, #f1f5f9)' }}>
                    {formatCell(row[c.idx])}
                  </td>
                ))}
              </tr>
            ))}
            {displayed.length === 0 && (
              <tr>
                <td colSpan={visibleColumns.length}
                    style={{ padding: '1rem .55rem', color: 'var(--muted, #6b7280)',
                             textAlign: 'center' }}>
                  No rows match the current filter / search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function formatCell(v) {
  if (v == null) return ''
  if (typeof v === 'number') {
    // Preserve integers exactly; trim trailing-zero float noise.
    return Number.isInteger(v) ? v.toLocaleString() : v.toString()
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}
