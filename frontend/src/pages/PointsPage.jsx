import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'


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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PointsPage({ setPage }) {
  const { selectedProjects, selectedPoints, setSelectedPoints, typeStyles } = useApp()
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
  function currentSelection() {
    const anyChecked = Object.values(checked).some(Boolean)
    if (anyChecked) {
      return points.filter(p => checked[ptKey(p)])
    }
    return points
  }

  // Persist the current selection (or all points when nothing ticked) to
  // points.xlsx — fire from the primary Use → button AND the explicit 💾
  // button (issue #77).
  async function savePointsXlsx(selectedRows) {
    try {
      const payload = selectedRows.map(p => ({
        db_id:     p.db_id ?? '',
        ProjectId: p.ProjectId ?? '',
        PointId:   p.PointId ?? '',
        PointNo:   String(p.PointNo ?? ''),
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
    // Persist point selection to GIRTool_settings.json (fire-and-forget).
    invoke('save_selection', { selectedPoints: selected })
      .catch(err => console.warn('save_selection failed:', err))
    // Also persist to points.xlsx so the user can edit it / re-import (#77).
    savePointsXlsx(selected).catch(() => {})
    // Strata tab is the natural next step — user picks interpretation/series
    // before downloading. Data tab is reachable from the sidebar afterwards.
    setPage('strata')
  }

  function handleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    const rows = !q ? points : points.filter(p =>
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
  }, [points, search, sortCol, sortDir])

  const { rowProps: dragRowProps, tbodyStyle } = useDragSelect({
    items:    filtered,
    getKey:   p => ptKey(p),
    onAdd:    addKeys,
    onToggle: toggle,
  })

  const numChecked = Object.values(checked).filter(Boolean).length

  // ── Guards ────────────────────────────────────────────────────────────────────

  if (selectedProjects.length === 0) {
    return (
      <div className="page">
        <h2 className="page-title">Points</h2>
        <p className="hint">Select one or more projects first.</p>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="page">
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
        <div className="table-wrap">
          <table className="data-table">
            <thead>
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
              {filtered.map((p, idx) => {
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
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
