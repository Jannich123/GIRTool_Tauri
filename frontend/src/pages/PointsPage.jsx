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

// Issue #89: same pagination cadence as the Projects tab (#83).
const PAGE_STEP = 50

// ── Shared table (issue #190 — mirrors ProjectsTable) ─────────────────────────

function PointsTable({
  items, checkedFlag, onToggle, dragRowProps, tbodyStyle,
  sortCol, sortDir, onSort, emptyText, height, maxHeight, onScroll,
  footerHint, typeColor,
}) {
  const wrapStyle = {
    overflowY: 'auto',
    ...(height ? { height } : {}),
    ...(maxHeight ? { maxHeight } : {}),
  }
  return (
    <div className="table-wrap" style={wrapStyle} onScroll={onScroll}>
      <table className="data-table">
        <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: '#fff' }}>
          <tr>
            <th style={{ width: 40 }} />
            <th style={{ width: 10 }} />
            <th className="sortable" onClick={() => onSort('db_id')} style={{ width: 110 }}>
              DB <SortIcon col="db_id" sortCol={sortCol} sortDir={sortDir} />
            </th>
            <th className="sortable" onClick={() => onSort('PointNo')}>
              Point No <SortIcon col="PointNo" sortCol={sortCol} sortDir={sortDir} />
            </th>
            <th className="sortable" onClick={() => onSort('PointType')}>
              Type <SortIcon col="PointType" sortCol={sortCol} sortDir={sortDir} />
            </th>
            <th className="sortable" onClick={() => onSort('ProjectNo')}>
              Project <SortIcon col="ProjectNo" sortCol={sortCol} sortDir={sortDir} />
            </th>
            <th className="sortable" style={{ textAlign: 'right' }} onClick={() => onSort('X1')}>
              X <SortIcon col="X1" sortCol={sortCol} sortDir={sortDir} />
            </th>
            <th className="sortable" style={{ textAlign: 'right' }} onClick={() => onSort('Y1')}>
              Y <SortIcon col="Y1" sortCol={sortCol} sortDir={sortDir} />
            </th>
            <th className="sortable" style={{ textAlign: 'right' }} onClick={() => onSort('Z1')}>
              Z <SortIcon col="Z1" sortCol={sortCol} sortDir={sortDir} />
            </th>
            <th className="sortable" style={{ textAlign: 'right' }} onClick={() => onSort('Top')}>
              Top <SortIcon col="Top" sortCol={sortCol} sortDir={sortDir} />
            </th>
            <th className="sortable" style={{ textAlign: 'right' }} onClick={() => onSort('Bottom')}>
              Bottom <SortIcon col="Bottom" sortCol={sortCol} sortDir={sortDir} />
            </th>
          </tr>
        </thead>
        <tbody style={tbodyStyle}>
          {items.map((p, idx) => {
            const k = ptKey(p)
            const rowProps = dragRowProps
              ? dragRowProps(p, idx)
              : { onClick: () => onToggle(k), style: { cursor: 'pointer' } }
            return (
              <tr key={k} className={checkedFlag ? 'selected' : ''} {...rowProps}>
                <td>
                  <input
                    type="checkbox"
                    checked={checkedFlag}
                    onChange={() => onToggle(k)}
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
          {items.length === 0 && (
            <tr><td colSpan={11} className="no-data">{emptyText}</td></tr>
          )}
          {footerHint && (
            <tr>
              <td colSpan={11} className="no-data" style={{ fontStyle: 'italic', textAlign: 'center' }}>
                {footerHint}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PointsPage({ setPage }) {
  const { selectedProjects, selectedPoints, setSelectedPoints, typeStyles, coordinateSystem } = useApp()
  const typeColor = t => (typeStyles[(t || '').toUpperCase()] ?? typeStyles.Other)?.color ?? '#7f8c8d'
  const [points,  setPoints]  = useState([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [search,         setSearch]         = useState('')   // Available table
  const [selectedSearch, setSelectedSearch] = useState('')   // Selected table
  const [checked, setChecked] = useState({})
  const [sortCol, setSortCol] = useState('PointNo')
  const [sortDir, setSortDir] = useState('asc')
  const [xlsxBusy, setXlsxBusy] = useState(false)
  const [xlsxMsg,  setXlsxMsg]  = useState(null)   // { ok, text }
  const xlsxAutoLoadedRef = useRef(false)
  // Auto-save guard (issue #190, mirrors Projects): only persist after a real
  // user interaction so the initial restore doesn't immediately rewrite xlsx.
  const userInteractedRef = useRef(false)

  useEffect(() => {
    if (selectedProjects.length > 0) fetchPoints()
  }, [selectedProjects])

  useEffect(() => {
    const init = {}
    selectedPoints.forEach(p => { init[ptKey(p)] = true })
    setChecked(init)
  }, [selectedPoints])

  // Issue #190: `force` re-queries the DB; the default path is served from the
  // backend's points cache (memory + points_cache.json) when warm.
  async function fetchPoints(force = false) {
    setLoading(true); setError('')
    try {
      const ids = selectedProjects.some(p => p?.db_id)
        ? selectedProjects.map(p => ({ db_id: p.db_id, ProjectId: p.ProjectId }))
        : selectedProjects.map(p => p.ProjectId)
      const res = await invoke('get_points', { projectIds: ids, refresh: !!force })
      setPoints(res)
    } catch (err) {
      console.error(err)
      setError(err || 'Failed to load points')
    } finally {
      setLoading(false)
    }
  }

  // ── points.xlsx auto-load on first fetch (issue #77) ─────────────────────
  // #207: only a COLD-START fallback.  The in-app (cross-window synced)
  // selection is the live truth — when one exists, re-ticking rows from the
  // possibly-stale file would resurrect an old selection, which live-apply
  // would then promote back into the app on the next interaction.
  useEffect(() => {
    if (xlsxAutoLoadedRef.current || points.length === 0) return
    xlsxAutoLoadedRef.current = true
    if (selectedPointsRef.current.length) return
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

  function toggle(key) {
    userInteractedRef.current = true
    setChecked(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const addKeys = useCallback((keys) => {
    userInteractedRef.current = true
    setChecked(prev => {
      const next = { ...prev }
      keys.forEach(k => { next[k] = true })
      return next
    })
  }, [])

  function selectAllAvailable() {
    userInteractedRef.current = true
    const all = {}
    availableFiltered.forEach(p => { all[ptKey(p)] = true })
    setChecked(prev => ({ ...prev, ...all }))
  }
  function clearAll() {
    userInteractedRef.current = true
    setChecked({})
  }

  // Select from the CONVERTED view (issue #147) so the persisted points.xlsx
  // and the in-app selection both carry the project's target-CRS coordinates.
  // #207: the selection is exactly the ticked rows — the old "nothing ticked
  // → take everything" fallback silently turned a project-only selection into
  // an all-points selection (and wrote it to points.xlsx, which then kept
  // resurrecting it).
  function currentSelection() {
    return viewPoints.filter(p => checked[ptKey(p)])
  }

  async function savePointsXlsx(selectedRows) {
    try {
      const num = v => (v == null || v === '' || !isFinite(Number(v))) ? null : Number(v)
      const payload = selectedRows.map(p => ({
        db_id:     p.db_id ?? '',
        ProjectId: p.ProjectId ?? '',
        PointId:   p.PointId ?? '',
        PointNo:   String(p.PointNo ?? ''),
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

  // Ref mirror for the live-apply content compare (read at timer fire time).
  const selectedPointsRef = useRef(selectedPoints)
  useEffect(() => { selectedPointsRef.current = selectedPoints }, [selectedPoints])

  // Auto-save + live-apply (issue #190 + #205): persist the ticked rows to
  // points.xlsx 300 ms after any user-driven change, AND push them into the
  // app-wide selection — the table IS the selection, no "Use points →" press
  // needed, so the map and other windows follow every tick.
  useEffect(() => {
    if (!userInteractedRef.current) return
    const t = setTimeout(async () => {
      const rows = viewPoints.filter(p => checked[ptKey(p)])
      // Live-apply — skipped when content-identical (e.g. the checked re-seed
      // that follows a cross-window update) so apply/broadcast can't echo.
      const newKeys = rows.map(ptKey).join('\n')
      const curKeys = selectedPointsRef.current.map(ptKey).join('\n')
      if (newKeys !== curKeys) setSelectedPoints(rows)
      const r = await savePointsXlsx(rows)
      setXlsxMsg(r.ok
        ? { ok: true, text: `Auto-saved ${r.count} point${r.count === 1 ? '' : 's'} to points.xlsx` }
        : { ok: false, text: `Auto-save failed: ${r.error}` })
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked])

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
      userInteractedRef.current = true
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
    // selection.  Cross-restart restoration flows through load_points_xlsx.
    savePointsXlsx(selected).catch(() => {})
    // After picking points, go to the map to see the selection.
    setPage('map')
  }

  function handleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  // Issue #147: converted view (target CRS) — re-derives live on CRS change.
  const viewPoints = useMemo(
    () => applyCoordinateSystem(points, coordinateSystem),
    [points, coordinateSystem],
  )

  // ── Derived: selected vs. available, each with its OWN search (#190) ──────
  function applySort(arr) {
    return [...arr].sort((a, b) => {
      const av = a[sortCol] ?? ''
      const bv = b[sortCol] ?? ''
      const cmp = typeof av === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv))
      return sortDir === 'asc' ? cmp : -cmp
    })
  }

  const matchesQuery = (p, q) =>
    p.PointNo?.toLowerCase().includes(q)   ||
    p.PointType?.toLowerCase().includes(q) ||
    p.ProjectNo?.toLowerCase().includes(q) ||
    p.db_id?.toLowerCase().includes(q)

  const selectedSorted = useMemo(() => {
    const q = selectedSearch.toLowerCase()
    const sel = viewPoints.filter(p => checked[ptKey(p)])
    return applySort(q ? sel.filter(p => matchesQuery(p, q)) : sel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewPoints, checked, selectedSearch, sortCol, sortDir])

  const availableFiltered = useMemo(() => {
    const q = search.toLowerCase()
    const avail = viewPoints.filter(p => !checked[ptKey(p)])
    return applySort(q ? avail.filter(p => matchesQuery(p, q)) : avail)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewPoints, checked, search, sortCol, sortDir])

  // Issue #89: paginated Available table with infinite scroll.
  const [visibleCount, setVisibleCount] = useState(PAGE_STEP)
  useEffect(() => {
    setVisibleCount(PAGE_STEP)
  }, [search, sortCol, sortDir, points])

  const availableSlice = useMemo(
    () => availableFiltered.slice(0, visibleCount),
    [availableFiltered, visibleCount],
  )
  const hasMore = availableFiltered.length > availableSlice.length

  const { rowProps: dragRowProps, tbodyStyle } = useDragSelect({
    items:    availableSlice,
    getKey:   p => ptKey(p),
    onAdd:    addKeys,
    onToggle: toggle,
  })

  function handleAvailableScroll(e) {
    if (!hasMore) return
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      setVisibleCount(c => Math.min(c + PAGE_STEP, availableFiltered.length))
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

  // CRS caption (issue #147).
  const crsCaption = (() => {
    const t = normaliseEpsg(coordinateSystem?.target_epsg)
    if (!t) return null
    const label = CRS_LABELS[t] ? ` (${CRS_LABELS[t]})` : ''
    return <> · Coordinates in <strong>{t}{label}</strong></>
  })()

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="page page-wide">
      <div className="page-header">
        <h2 className="page-title">Points</h2>
        <div className="page-actions">
          <button onClick={() => fetchPoints(true)} className="btn-secondary btn-sm"
                  title="Re-query the databases (otherwise the cached points are used)">
            ↻ Refresh
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
      {/* Fixed-height slot (mirrors Projects, #87) so the auto-save banner
          doesn't push the tables up and down. */}
      <div style={{ minHeight: '2.25rem', display: 'flex', alignItems: 'center' }}>
        {xlsxMsg && (
          <p className={`msg ${xlsxMsg.ok ? 'ok' : 'err'}`} style={{ margin: 0 }}>{xlsxMsg.text}</p>
        )}
      </div>

      {loading ? (
        <p className="hint">Loading…</p>
      ) : (
        <>
          {/* ── Selected (top) ────────────────────────────────────────────── */}
          <div style={{ marginBottom: '1rem' }}>
            <div style={{
              display: 'flex', alignItems: 'baseline', gap: '0.75rem',
              padding: '0.4rem 0', borderBottom: '1px solid #e5e7eb',
              marginBottom: '0.4rem',
            }}>
              <h3 style={{ margin: 0, fontSize: '.95rem', fontWeight: 600 }}>
                Selected points
              </h3>
              <span className="hint" style={{ fontSize: '.78rem' }}>
                {numChecked === 0
                  ? 'Tick rows below to add them here'
                  : `${numChecked} point${numChecked === 1 ? '' : 's'} · auto-saved to points.xlsx`}
              </span>
              <div style={{ flex: 1 }} />
              <input
                className="search-input"
                placeholder="Search selected…"
                value={selectedSearch}
                onChange={e => setSelectedSearch(e.target.value)}
                style={{ maxWidth: 220 }}
              />
              {numChecked > 0 && (
                <button onClick={clearAll} className="btn-secondary btn-sm">Clear all</button>
              )}
            </div>
            <PointsTable
              items={selectedSorted}
              checkedFlag={true}
              onToggle={toggle}
              sortCol={sortCol} sortDir={sortDir} onSort={handleSort}
              emptyText={selectedSearch
                ? 'No selected points match the search.'
                : 'No points selected — tick rows in the table below to add them.'}
              height="210px"
              typeColor={typeColor}
            />
          </div>

          {/* ── Available (bottom) ───────────────────────────────────────── */}
          <div>
            <div style={{
              display: 'flex', alignItems: 'baseline', gap: '0.75rem',
              padding: '0.4rem 0', borderBottom: '1px solid #e5e7eb',
              marginBottom: '0.4rem',
            }}>
              <h3 style={{ margin: 0, fontSize: '.95rem', fontWeight: 600 }}>
                Available points
              </h3>
              <span className="hint" style={{ fontSize: '.78rem' }}>
                Showing {availableSlice.length} of {availableFiltered.length} row
                {availableFiltered.length === 1 ? '' : 's'}
                {hasMore && ' · scroll for more'}
                {crsCaption}
              </span>
              <div style={{ flex: 1 }} />
              <input
                className="search-input"
                placeholder="Search by No, Type, Project or DB…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ maxWidth: 260 }}
              />
              <button onClick={selectAllAvailable} className="btn-secondary btn-sm"
                      disabled={availableFiltered.length === 0}>
                Select all visible
              </button>
            </div>
            <PointsTable
              items={availableSlice}
              checkedFlag={false}
              onToggle={toggle}
              dragRowProps={dragRowProps}
              tbodyStyle={tbodyStyle}
              sortCol={sortCol} sortDir={sortDir} onSort={handleSort}
              emptyText={search ? 'No points match the search.' : 'No more available points.'}
              maxHeight="48vh"
              onScroll={handleAvailableScroll}
              footerHint={hasMore
                ? `${availableFiltered.length - availableSlice.length} more row(s) — keep scrolling…`
                : null}
              typeColor={typeColor}
            />
          </div>
        </>
      )}
    </div>
  )
}
