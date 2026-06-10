import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'
import { applyCoordinateSystem, normaliseEpsg, CRS_LABELS } from '../lib/proj'


import { useDragSelect } from '../hooks/useDragSelect'

// ── Helpers ───────────────────────────────────────────────────────────────────


function SortIcon({ col, sortCol, sortDir }) {
  if (sortCol !== col) return <span className="sort-icon neutral">⇅</span>
  return <span className="sort-icon active">{sortDir === 'asc' ? '↑' : '↓'}</span>
}

// Composite selection key (issue #77) — same shape as the strata `selKey` and
// the Projects-page `projKey` so same `PointId` from two different databases
// is treated as two distinct rows.  Falls back to `'?'` for legacy rows that
// somehow arrive without a `db_id`.
const ptKey = (p) => `${p.db_id ?? '?'}||${p.PointId}`

// Small monospace pill renderer for the DB column.
function DbIdPill({ id }) {
  return (
    <code
      style={{
        fontSize: '.75rem',
        padding: '0.08rem 0.5rem',
        background: '#eef2ff',
        color: '#3730a3',
        border: '1px solid #c7d2fe',
        borderRadius: 999,
        whiteSpace: 'nowrap',
      }}
      title="Database this point belongs to (configured in Settings → Database)"
    >
      {id || '?'}
    </code>
  )
}

// Issue #89: same pagination cadence the Available table on the Projects tab
// uses (#83).  Render this many rows initially and append PAGE_STEP more
// whenever the user scrolls within ~120 px of the bottom.
const PAGE_STEP = 50

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PointsPage({ setPage }) {
  const { selectedProjects, selectedPoints, setSelectedPoints, typeStyles, coordinateSystem } = useApp()
  const typeColor = t => (typeStyles[(t || '').toUpperCase()] ?? typeStyles.Other)?.color ?? '#7f8c8d'
  const [points,  setPoints]  = useState([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [search,  setSearch]  = useState('')
  const [checked, setChecked] = useState({})
  const [sortCol, setSortCol] = useState('PointNo')
  const [sortDir, setSortDir] = useState('asc')
  const [xlsxBusy, setXlsxBusy] = useState(false)
  const [xlsxMsg,  setXlsxMsg]  = useState(null)   // { ok, text }
  const xlsxAutoLoadedRef = useRef(false)

  useEffect(() => {
    if (selectedProjects.length > 0) fetchPoints()
  }, [selectedProjects])

  useEffect(() => {
    const init = {}
    selectedPoints.forEach(p => { init[ptKey(p)] = true })
    setChecked(init)
  }, [selectedPoints])

  async function fetchPoints() {
    setLoading(true); setError('')
    try {
      // Multi-DB routing (issue #48): when a project row carries `db_id`
      // (added by list_projects fan-out), send the per-DB form so the backend
      // routes the query to the correct database.  Otherwise fall back to the
      // legacy flat list (which the backend runs against every DB).
      const ids = selectedProjects.some(p => p?.db_id)
        ? selectedProjects.map(p => ({ db_id: p.db_id, ProjectId: p.ProjectId }))
        : selectedProjects.map(p => p.ProjectId)
      const res = await invoke('get_points', { projectIds: ids })
      setPoints(res)
    } catch (err) {
      console.error(err)
      setError(err || 'Failed to load points')
    } finally {
      setLoading(false)
    }
  }

  // ── points.xlsx auto-load on first fetch (issue #77) ─────────────────────
  // After the initial get_points resolves, look for a saved points.xlsx and
  // tick any rows whose (db_id, PointId) matches.  Runs once per mount.
  useEffect(() => {
    if (xlsxAutoLoadedRef.current || points.length === 0) return
    xlsxAutoLoadedRef.current = true
    invoke('load_points_xlsx')
      .then(rows => {
        if (!Array.isArray(rows) || rows.length === 0) return
        const present = new Set(points.map(ptKey))
        const matched = []
        const orphans = []
        for (const r of rows) {
          const k = `${r.db_id ?? '?'}||${r.PointId}`
          if (present.has(k)) matched.push(k)
          else                 orphans.push(`${r.db_id}/${r.PointId}`)
        }
        if (matched.length) {
          setChecked(prev => {
            const next = { ...prev }
            matched.forEach(k => { next[k] = true })
            return next
          })
        }
        if (orphans.length) {
          console.warn('points.xlsx contained rows not in the current points list:', orphans)
        }
      })
      .catch(() => { /* file missing — fine */ })
  }, [points])

  function toggle(key) { setChecked(prev => ({ ...prev, [key]: !prev[key] })) }

  const addKeys = useCallback((keys) => {
    setChecked(prev => {
      const next = { ...prev }
      keys.forEach(k => { next[k] = true })
      return next
    })
  }, [])

  function selectAll() {
    const all = {}
    filtered.forEach(p => { all[ptKey(p)] = true })
    setChecked(prev => ({ ...prev, ...all }))
  }
  function clearAll() { setChecked({}) }

  // Build the list of currently-checked point objects (or all visible
  // points when nothing is ticked — matches the "Use all points" semantics
  // of the primary button).
  // Select from the CONVERTED view (issue #147) so the persisted points.xlsx
  // and the in-app selection both carry the project's target-CRS coordinates
  // (+ origin_* source values), matching what the table shows.
  function currentSelection() {
    const anyChecked = Object.values(checked).some(Boolean)
    if (anyChecked) {
      return viewPoints.filter(p => checked[ptKey(p)])
    }
    return viewPoints
  }

  // Persist the current selection (or all points when nothing ticked) to
  // points.xlsx — fire from the primary Use → button AND the explicit 💾
  // button (issue #77).
  async function savePointsXlsx(selectedRows) {
    try {
      const num = v => (v == null || v === '' || !isFinite(Number(v))) ? null : Number(v)
      const payload = selectedRows.map(p => ({
        db_id:     p.db_id ?? '',
        ProjectId: p.ProjectId ?? '',
        PointId:   p.PointId ?? '',
        PointNo:   String(p.PointNo ?? ''),
        // Coordinate snapshot (#147): converted X1/Y1/Z1 + target Projection1,
        // plus the preserved source values.  null where unavailable.
        X1: num(p.X1), Y1: num(p.Y1), Z1: num(p.Z1),
        Projection1: p.Projection1 != null ? String(p.Projection1) : '',
        origin_X1: num(p.origin_X1), origin_Y1: num(p.origin_Y1), origin_Z1: num(p.origin_Z1),
        origin_Projection1: p.origin_Projection1 != null ? String(p.origin_Projection1) : '',
      }))
      await invoke('save_points_xlsx', { selected: payload })
      return { ok: true, count: payload.length }
    } catch (err) {
      console.warn('save_points_xlsx failed:', err)
      return { ok: false, error: err }
    }
  }

  async function handleSaveToExcel() {
    setXlsxBusy(true); setXlsxMsg(null)
    const sel = currentSelection()
    const r = await savePointsXlsx(sel)
    setXlsxBusy(false)
    if (r.ok) setXlsxMsg({ ok: true, text: `Saved ${r.count} point${r.count === 1 ? '' : 's'} to points.xlsx` })
    else      setXlsxMsg({ ok: false, text: String(r.error || 'Save failed') })
    setTimeout(() => setXlsxMsg(m => (m && m.ok ? null : m)), 3500)
  }

  async function handleOpenExcel() {
    setXlsxMsg(null)
    try { await invoke('open_points_xlsx') }
    catch (err) { setXlsxMsg({ ok: false, text: String(err || 'Could not open points.xlsx') }) }
  }

  async function handleReloadFromExcel() {
    setXlsxBusy(true); setXlsxMsg(null)
    try {
      const rows = await invoke('load_points_xlsx')
      if (!Array.isArray(rows) || rows.length === 0) {
        setXlsxMsg({ ok: false, text: 'points.xlsx is empty or missing.' })
        return
      }
      const present = new Set(points.map(ptKey))
      const matched = []
      const orphans = []
      for (const r of rows) {
        const k = `${r.db_id ?? '?'}||${r.PointId}`
        if (present.has(k)) matched.push(k)
        else                 orphans.push(`${r.db_id}/${r.PointId}`)
      }
      const next = {}
      matched.forEach(k => { next[k] = true })
      setChecked(next)
      const orphanBit = orphans.length
        ? ` · ${orphans.length} row(s) in xlsx not in current list (see console)`
        : ''
      if (orphans.length) {
        console.warn('points.xlsx orphan rows:', orphans)
      }
      setXlsxMsg({
        ok: matched.length > 0,
        text: `Ticked ${matched.length} of ${rows.length} row(s) from points.xlsx${orphanBit}`,
      })
    } catch (err) {
      setXlsxMsg({ ok: false, text: String(err || 'Reload failed') })
    } finally {
      setXlsxBusy(false)
    }
  }

  async function confirm() {
    const selected = currentSelection()
    setSelectedPoints(selected)
    // Issue #91: points.xlsx is the SOLE persistence path for the point
    // selection — no longer write to GIRTool_settings.json::selectedPoints.
    // Cross-restart restoration flows through load_points_xlsx on Points
    // page mount (#78).
    savePointsXlsx(selected).catch(() => {})
    // After picking points, go to the map to see the selection.  In Data
    // Selection this switches to the Map subtab; standalone it opens the map.
    setPage('map')
  }

  function handleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  // Issue #147: convert raw DB points into the project's target coordinate
  // system (origin_* preserved, X/Y reprojected, Z offset applied).  Pure no-op
  // when no coordinate system is configured.  Kept separate from `points` so the
  // table re-derives instantly when the target CRS changes — without refetching.
  const viewPoints = useMemo(
    () => applyCoordinateSystem(points, coordinateSystem),
    [points, coordinateSystem],
  )

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    const rows = !q ? viewPoints : viewPoints.filter(p =>
      p.PointNo?.toLowerCase().includes(q)   ||
      p.PointType?.toLowerCase().includes(q) ||
      p.ProjectNo?.toLowerCase().includes(q) ||
      p.db_id?.toLowerCase().includes(q)
    )
    return [...rows].sort((a, b) => {
      const av = a[sortCol] ?? ''
      const bv = b[sortCol] ?? ''
      const cmp = typeof av === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv))
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [viewPoints, search, sortCol, sortDir])

  // Issue #89: only render the first N rows of the (sorted, search-filtered)
  // points list.  Reset to PAGE_STEP whenever the filter / sort changes so
  // the user always starts at the top of the new result set.
  const [visibleCount, setVisibleCount] = useState(PAGE_STEP)
  useEffect(() => {
    setVisibleCount(PAGE_STEP)
  }, [search, sortCol, sortDir, points])

  const visibleSlice = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  )
  const hasMore = filtered.length > visibleSlice.length

  // Drag-select is bound to the visible slice so dragging only touches rows
  // the user can actually see — matches the Available table on Projects.
  const { rowProps: dragRowProps, tbodyStyle } = useDragSelect({
    items:    visibleSlice,
    getKey:   p => ptKey(p),
    onAdd:    addKeys,
    onToggle: toggle,
  })

  // Infinite-scroll handler — bump visibleCount when the user nears the
  // bottom of the table-wrap scroll container.
  function handleTableScroll(e) {
    if (!hasMore) return
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      setVisibleCount(c => Math.min(c + PAGE_STEP, filtered.length))
    }
  }

  const numChecked = Object.values(checked).filter(Boolean).length

  // ── Guards ────────────────────────────────────────────────────────────────────

  if (selectedProjects.length === 0) {
    return (
      <div className="page page-wide">
        <h2 className="page-title">Points</h2>
        <p className="hint">Select one or more projects first.</p>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="page page-wide">
      <div className="page-header">
        <h2 className="page-title">Points</h2>
        <div className="page-actions">
          <input
            className="search-input"
            placeholder="Search by No, Type, Project or DB…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button onClick={selectAll}   className="btn-secondary btn-sm">Select all</button>
          <button onClick={clearAll}    className="btn-secondary btn-sm">Clear</button>
          <button onClick={fetchPoints} className="btn-secondary btn-sm">↻ Refresh</button>
          <button onClick={handleSaveToExcel} disabled={xlsxBusy} className="btn-secondary btn-sm"
                  title="Write the current (or all visible) selection to points.xlsx">
            💾 Save to Excel
          </button>
          <button onClick={handleOpenExcel} className="btn-secondary btn-sm"
                  title="Open points.xlsx in your default xlsx handler">
            📂 Open xlsx
          </button>
          <button onClick={handleReloadFromExcel} disabled={xlsxBusy} className="btn-secondary btn-sm"
                  title="Tick all rows whose (db_id, PointId) is listed in points.xlsx">
            ↻ Reload from Excel
          </button>
          <button onClick={confirm} className="btn-primary">
            {numChecked > 0
              ? `Use ${numChecked} point${numChecked > 1 ? 's' : ''} →`
              : 'Use all points →'}
          </button>
        </div>
      </div>

      {error && <p className="msg err">{error}</p>}
      {xlsxMsg && (
        <p className={`msg ${xlsxMsg.ok ? 'ok' : 'err'}`}>{xlsxMsg.text}</p>
      )}

      {loading ? (
        <p className="hint">Loading…</p>
      ) : (
        <>
          {/* Row-count + "scroll for more" hint above the scroll container
              so it doesn't jiggle inside the scroll area. */}
          <p className="hint" style={{ margin: '0 0 .35rem 0', fontSize: '.78rem' }}>
            Showing {visibleSlice.length} of {filtered.length} row{filtered.length === 1 ? '' : 's'}
            {hasMore && ' · scroll for more'}
            {(() => {
              const t = normaliseEpsg(coordinateSystem?.target_epsg)
              if (!t) return null
              const label = CRS_LABELS[t] ? ` (${CRS_LABELS[t]})` : ''
              return <> · Coordinates in <strong>{t}{label}</strong> · original values kept as origin_*</>
            })()}
          </p>
        <div
          className="table-wrap"
          style={{ maxHeight: '62vh', overflowY: 'auto' }}
          onScroll={handleTableScroll}
        >
          <table className="data-table">
            <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: '#fff' }}>
              <tr>
                <th style={{ width: 40 }}>
                  <input
                    type="checkbox"
                    checked={filtered.length > 0 && filtered.every(p => checked[ptKey(p)])}
                    onChange={e => e.target.checked ? selectAll() : clearAll()}
                    title="Select / deselect all visible"
                  />
                </th>
                <th style={{ width: 10 }} />
                <th className="sortable" onClick={() => handleSort('db_id')} style={{ width: 110 }}>
                  DB <SortIcon col="db_id" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className="sortable" onClick={() => handleSort('PointNo')}>
                  Point No <SortIcon col="PointNo" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className="sortable" onClick={() => handleSort('PointType')}>
                  Type <SortIcon col="PointType" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className="sortable" onClick={() => handleSort('ProjectNo')}>
                  Project <SortIcon col="ProjectNo" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className="sortable" style={{ textAlign: 'right' }} onClick={() => handleSort('X1')}>
                  X <SortIcon col="X1" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className="sortable" style={{ textAlign: 'right' }} onClick={() => handleSort('Y1')}>
                  Y <SortIcon col="Y1" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className="sortable" style={{ textAlign: 'right' }} onClick={() => handleSort('Z1')}>
                  Z <SortIcon col="Z1" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className="sortable" style={{ textAlign: 'right' }} onClick={() => handleSort('Top')}>
                  Top <SortIcon col="Top" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className="sortable" style={{ textAlign: 'right' }} onClick={() => handleSort('Bottom')}>
                  Bottom <SortIcon col="Bottom" sortCol={sortCol} sortDir={sortDir} />
                </th>
              </tr>
            </thead>
            <tbody style={tbodyStyle}>
              {visibleSlice.map((p, idx) => {
                const k = ptKey(p)
                return (
                  <tr
                    key={k}
                    className={checked[k] ? 'selected' : ''}
                    {...dragRowProps(p, idx)}
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={!!checked[k]}
                        onChange={() => toggle(k)}
                        onClick={e => e.stopPropagation()}
                      />
                    </td>
                    <td>
                      <span
                        style={{
                          display: 'inline-block', width: 8, height: 8,
                          borderRadius: '50%', background: typeColor(p.PointType),
                        }}
                      />
                    </td>
                    <td><DbIdPill id={p.db_id} /></td>
                    <td>{p.PointNo}</td>
                    <td>{p.PointType}</td>
                    <td>{p.ProjectNo}</td>
                    <td style={{ textAlign: 'right' }}>{p.X1}</td>
                    <td style={{ textAlign: 'right' }}>{p.Y1}</td>
                    <td style={{ textAlign: 'right' }}>{p.Z1}</td>
                    <td style={{ textAlign: 'right' }}>{p.Top}</td>
                    <td style={{ textAlign: 'right' }}>{p.Bottom}</td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={11} className="no-data">No points found</td></tr>
              )}
              {hasMore && (
                <tr>
                  <td colSpan={11} className="no-data" style={{ fontStyle: 'italic', textAlign: 'center' }}>
                    {filtered.length - visibleSlice.length} more row(s) — keep scrolling…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  )
}
