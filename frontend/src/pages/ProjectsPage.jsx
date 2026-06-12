import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'
import { useDragSelect } from '../hooks/useDragSelect'

// ── Helpers ───────────────────────────────────────────────────────────────────

// Composite selection key — same shape used downstream by `ProjectIdsArg::PerDb`
// (issue #48) so the same `ProjectId` appearing in two databases is treated as
// two distinct rows.  Falls back to `'?'` for the rare case where `db_id`
// hasn't been populated yet (legacy single-DB session restore).
const projKey = (p) => `${p?.db_id ?? '?'}||${p?.ProjectId ?? ''}`

// ── Sort icon ─────────────────────────────────────────────────────────────────

function SortIcon({ col, sortCol, sortDir }) {
  if (sortCol !== col) return <span className="sort-icon neutral">⇅</span>
  return <span className="sort-icon active">{sortDir === 'asc' ? '↑' : '↓'}</span>
}

// ── DB pill ───────────────────────────────────────────────────────────────────

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
      title="Database this project belongs to (configured in Settings → Database)"
    >
      {id || '?'}
    </code>
  )
}

// ── Inner table — shared by both Selected and Available (issue #81) ──────────
//
// `items`        rows to render in row order
// `checkedFlag`  fixed visual state of every checkbox (true for the top table,
//                false for the bottom).  The actual selection state lives in
//                the parent's `checked` map; clicking a row calls onToggle to
//                flip it.
// `onToggle`     `(projKey) => void` — fires from row click or checkbox click
// `dragRowProps` / `tbodyStyle`  drag-select hookup for the bottom table only
// `sortCol`/`sortDir`/`onSort`   delegated to the parent so both tables sort
//                via the same handler
// `headerExtra`  optional element rendered in the colspan banner above headers
// `emptyText`    message shown when items is empty (e.g. "No projects selected")

function ProjectsTable({
  items, checkedFlag, onToggle,
  dragRowProps, tbodyStyle,
  sortCol, sortDir, onSort,
  emptyText,
  // Issue #83: internal scroll + infinite-scroll pagination.
  // Issue #85: `height` is a fixed window (Selected table); `maxHeight` is a
  // soft cap (Available table).  When both are provided `height` wins so the
  // layout is stable regardless of row count.
  maxHeight, height, onScroll, footerHint,
}) {
  return (
    <div
      className="table-wrap"
      style={{ height, maxHeight: height ? undefined : maxHeight, overflowY: 'auto' }}
      onScroll={onScroll}
    >
      <table className="data-table">
        <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: '#fff' }}>
          <tr>
            <th style={{ width: 40 }} />
            <th className="sortable" onClick={() => onSort('db_id')} style={{ width: 110 }}>
              DB <SortIcon col="db_id" sortCol={sortCol} sortDir={sortDir} />
            </th>
            <th className="sortable" onClick={() => onSort('ProjectNo')}>
              Project No <SortIcon col="ProjectNo" sortCol={sortCol} sortDir={sortDir} />
            </th>
            <th className="sortable" onClick={() => onSort('Title')}>
              Title <SortIcon col="Title" sortCol={sortCol} sortDir={sortDir} />
            </th>
            <th className="sortable" style={{ textAlign: 'right' }} onClick={() => onSort('PointCount')}>
              Points <SortIcon col="PointCount" sortCol={sortCol} sortDir={sortDir} />
            </th>
          </tr>
        </thead>
        <tbody style={tbodyStyle}>
          {items.map((p, idx) => {
            const k = projKey(p)
            return (
              <tr
                key={k}
                className={checkedFlag ? 'selected' : ''}
                onClick={() => onToggle(k)}
                {...(dragRowProps ? dragRowProps(p, idx) : {})}
                style={{ cursor: 'pointer' }}
              >
                <td>
                  <input
                    type="checkbox"
                    checked={checkedFlag}
                    onChange={() => onToggle(k)}
                    onClick={e => e.stopPropagation()}
                  />
                </td>
                <td><DbIdPill id={p.db_id} /></td>
                <td>{p.ProjectNo}</td>
                <td>{p.Title}</td>
                <td style={{ textAlign: 'right' }}>{p.PointCount}</td>
              </tr>
            )
          })}
          {items.length === 0 && (
            <tr><td colSpan={5} className="no-data">{emptyText}</td></tr>
          )}
          {footerHint && (
            <tr>
              <td colSpan={5} className="no-data" style={{ fontStyle: 'italic', textAlign: 'center' }}>
                {footerHint}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

// Issue #83: pagination step for the Available table.  Render this many rows
// initially and append PAGE_STEP more whenever the user scrolls within ~120 px
// of the bottom of the scroll container.
const PAGE_STEP = 50

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ProjectsPage({ setPage }) {
  const { connected, connection, selectedProjects, setSelectedProjects, setSelectedPoints } = useApp()
  const [projects, setProjects] = useState([])
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [search,   setSearch]   = useState('')
  const [checked,  setChecked]  = useState({})
  const [sortCol,  setSortCol]  = useState('ProjectNo')
  const [sortDir,  setSortDir]  = useState('asc')
  const [xlsxMsg,  setXlsxMsg]  = useState(null)   // { kind: 'ok'|'warn'|'err', text }

  // Prevents the auto-save effect from firing during initial load (mount,
  // session restore, xlsx auto-load).  Flips true on the first real user
  // interaction (toggle, select-all, clear, reload-from-xlsx).
  const userInteractedRef = useRef(false)
  // Tracks whether xlsx auto-load has run for the current projects array.
  const autoLoadedFor     = useRef(null)

  // Issue #83: Available-table pagination.  Render PAGE_STEP rows initially,
  // append PAGE_STEP more on each scroll-near-bottom event.  Reset whenever
  // the filter (search) or sort order changes so the user always starts at
  // the top of the new result set.
  const [visibleAvailableCount, setVisibleAvailableCount] = useState(PAGE_STEP)
  useEffect(() => {
    setVisibleAvailableCount(PAGE_STEP)
  }, [search, sortCol, sortDir])

  useEffect(() => {
    if (connected) fetchProjects()
  }, [connected])

  // Pre-tick already-selected projects whenever the upstream `selectedProjects`
  // changes (e.g. session restore).  Does NOT mark user interaction so it
  // won't trigger the auto-save effect.
  useEffect(() => {
    const init = {}
    selectedProjects.forEach(p => { init[projKey(p)] = true })
    setChecked(init)
  }, [selectedProjects])

  // Issue #185: list_projects is served from a per-session backend cache (the
  // DB query runs once, then it's instant).  `force` re-queries — wired to the
  // ↻ Refresh list button.
  async function fetchProjects(force = false) {
    setLoading(true); setError('')
    try {
      const res = await invoke('list_projects', { refresh: !!force })
      setProjects(res)
    } catch (err) {
      console.error(err)
      setError(err || 'Failed to load projects')
    } finally {
      setLoading(false)
    }
  }

  // After the initial `list_projects` resolves, attempt to load
  // `projects.xlsx` once and auto-tick matching rows.  Silent if the file is
  // missing.  Does NOT mark user interaction.
  useEffect(() => {
    if (!projects.length) return
    if (autoLoadedFor.current === projects) return
    autoLoadedFor.current = projects

    invoke('load_projects_xlsx')
      .then(rows => {
        if (!Array.isArray(rows) || rows.length === 0) return
        const present = new Set(projects.map(projKey))
        const additions = {}
        for (const r of rows) {
          const k = projKey(r)
          if (present.has(k)) additions[k] = true
        }
        if (Object.keys(additions).length > 0) {
          setChecked(prev => ({ ...prev, ...additions }))
        }
      })
      .catch(err => console.warn('load_projects_xlsx failed:', err))
  }, [projects])

  // Ref mirror for the live-apply content compare (read at timer fire time).
  const selectedProjectsRef = useRef(selectedProjects)
  useEffect(() => { selectedProjectsRef.current = selectedProjects }, [selectedProjects])

  // Auto-save + live-apply: whenever the table selection changes (after a
  // user interaction), rewrite `projects.xlsx` (#81) AND push the ticked rows
  // into the app-wide selection (#205) — the tables ARE the selection, no
  // "Use projects →" press needed, so the map and other windows follow every
  // tick.  300 ms debounce so a burst of clicks coalesces into one write.
  useEffect(() => {
    if (!userInteractedRef.current) return
    const t = setTimeout(() => {
      const selObjs = projects.filter(p => checked[projKey(p)])
      const rows = selObjs.map(p => ({
        db_id:     p.db_id ?? '',
        ProjectId: p.ProjectId,
        ProjectNo: p.ProjectNo ?? '',
        Title:     p.Title ?? '',
      }))
      invoke('save_projects_xlsx', { selected: rows })
        .then(() => setXlsxMsg({
          kind: 'ok',
          text: `Auto-saved ${rows.length} project${rows.length === 1 ? '' : 's'} to projects.xlsx`,
        }))
        .catch(err => {
          console.warn('auto save_projects_xlsx failed:', err)
          setXlsxMsg({ kind: 'err', text: `Auto-save failed: ${err}` })
        })
      // Live-apply — skipped when content-identical (e.g. the checked re-seed
      // that follows a cross-window update) so apply/broadcast can't echo.
      const newKeys = selObjs.map(projKey).join('\n')
      const curKeys = selectedProjectsRef.current.map(projKey).join('\n')
      if (newKeys !== curKeys) {
        setSelectedProjects(selObjs)
        // Points of deselected projects leave the selection with them.
        const keep = new Set(selObjs.map(projKey))
        setSelectedPoints(prev => prev.filter(pt => keep.has(projKey(pt))))
      }
    }, 300)
    return () => clearTimeout(t)
  }, [checked, projects])

  // Toggle a row — the same handler powers both tables.  Marks user
  // interaction so the auto-save effect picks up the change.
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

  function selectAllUnselected() {
    userInteractedRef.current = true
    const all = {}
    unselectedFiltered.forEach(p => { all[projKey(p)] = true })
    setChecked(prev => ({ ...prev, ...all }))
  }
  function clearAll() {
    userInteractedRef.current = true
    setChecked({})
  }

  // (#209: the "Load N projects →" confirm button is gone — ticking rows
  // live-applies the selection since #206, so it only duplicated navigation.)

  function handleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  // ── Derived: selected vs. unselected, sorted, search applied ──────────────

  // Apply current sort to either array.  Helper used twice.
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

  const selectedSorted = useMemo(() => {
    return applySort(projects.filter(p => checked[projKey(p)]))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, checked, sortCol, sortDir])

  // Bottom table: only the unselected rows, search-filtered.
  const unselectedFiltered = useMemo(() => {
    const q = search.toLowerCase()
    const unsel = projects.filter(p => !checked[projKey(p)])
    const filtered = !q ? unsel : unsel.filter(p =>
      p.ProjectNo?.toLowerCase().includes(q) ||
      p.Title?.toLowerCase().includes(q) ||
      p.db_id?.toLowerCase().includes(q)
    )
    return applySort(filtered)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, checked, search, sortCol, sortDir])

  // Issue #83: only render the first N rows of the (sorted, search-filtered)
  // unselected set; infinite scroll appends more as the user nears the
  // bottom.  Drag-select is keyed against the SAME slice so dragging only
  // ever touches rows the user can see.
  const unselectedSlice = useMemo(
    () => unselectedFiltered.slice(0, visibleAvailableCount),
    [unselectedFiltered, visibleAvailableCount],
  )
  const hasMoreAvailable = unselectedFiltered.length > unselectedSlice.length

  // Drag-select is only wired to the bottom (Available) table — the top
  // table's checkbox always reads `true`, so dragging there would be a
  // no-op anyway.
  const { rowProps: dragRowProps, tbodyStyle } = useDragSelect({
    items:    unselectedSlice,
    getKey:   projKey,
    onAdd:    addKeys,
    onToggle: toggle,
  })

  // Infinite-scroll handler — when the user scrolls within ~120 px of the
  // bottom of the Available table, append the next PAGE_STEP rows.
  function handleAvailableScroll(e) {
    if (!hasMoreAvailable) return
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      setVisibleAvailableCount(c => Math.min(c + PAGE_STEP, unselectedFiltered.length))
    }
  }

  const numSelected = selectedSorted.length

  // ── xlsx action handlers ──────────────────────────────────────────────────

  async function handleOpenXlsx() {
    setXlsxMsg(null)
    try {
      await invoke('open_projects_xlsx')
    } catch (err) {
      console.error('open_projects_xlsx failed:', err)
      setXlsxMsg({ kind: 'err', text: `Failed to open: ${err}` })
    }
  }

  async function handleReloadXlsx() {
    setXlsxMsg(null)
    try {
      const rows = await invoke('load_projects_xlsx')
      if (!Array.isArray(rows) || rows.length === 0) {
        setXlsxMsg({ kind: 'warn', text: 'projects.xlsx is empty or missing.' })
        return
      }
      const present = new Set(projects.map(projKey))
      const nextChecked = {}
      const orphans = []
      for (const r of rows) {
        const k = projKey(r)
        if (present.has(k)) {
          nextChecked[k] = true
        } else {
          orphans.push(r)
        }
      }
      // Mark user interaction so the auto-save effect picks up the new
      // checked state.  Effectively a round-trip through xlsx → state → xlsx
      // (idempotent — orphans get dropped on the way back out).
      userInteractedRef.current = true
      setChecked(nextChecked)

      const okCount = Object.keys(nextChecked).length
      if (orphans.length > 0) {
        console.warn(
          `${orphans.length} project(s) from projects.xlsx not in current list — ` +
          'db not configured or project deleted:',
          orphans,
        )
        setXlsxMsg({
          kind: 'warn',
          text: `Ticked ${okCount}. ${orphans.length} row${orphans.length === 1 ? '' : 's'} ` +
                `in xlsx not in current list (see console).`,
        })
      } else {
        setXlsxMsg({ kind: 'ok', text: `Ticked ${okCount} project${okCount === 1 ? '' : 's'} from xlsx.` })
      }
    } catch (err) {
      console.error('load_projects_xlsx failed:', err)
      setXlsxMsg({ kind: 'err', text: `Reload failed: ${err}` })
    }
  }

  // ── Guards ────────────────────────────────────────────────────────────────────

  if (!connected) {
    return (
      <div className="page page-wide">
        <h2 className="page-title">Projects</h2>
        <p className="hint">Go to <strong>Settings</strong> and connect to the database first.</p>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="page page-wide">
      <div className="page-header">
        <h2 className="page-title">Projects</h2>
        <div className="page-actions">
          <button onClick={() => fetchProjects(true)} className="btn-secondary btn-sm" title="Re-query the databases (otherwise the cached list is used)">↻ Refresh list</button>
          <button onClick={handleOpenXlsx} disabled={!connection?.output_folder}
                  className="btn-secondary btn-sm"
                  title={!connection?.output_folder
                    ? 'Pick a project folder first'
                    : 'Open projects.xlsx in your default xlsx handler'}>
            📂 Open xlsx
          </button>
          <button onClick={handleReloadXlsx} className="btn-secondary btn-sm"
                  title="Re-read projects.xlsx and rebuild the selection from it">
            ↻ Reload from Excel
          </button>
        </div>
      </div>

      {error && <p className="msg err">{error}</p>}
      {/* Issue #87: fixed-height slot so the auto-save banner appearing /
          disappearing doesn't push the Selected / Available tables up and
          down by one line every few seconds. */}
      <div style={{ minHeight: '2.25rem', display: 'flex', alignItems: 'center' }}>
        {xlsxMsg && (
          <p
            className={`msg ${xlsxMsg.kind === 'err' ? 'err' : xlsxMsg.kind === 'warn' ? 'warn' : 'ok'}`}
            style={{ margin: 0 }}
          >
            {xlsxMsg.text}
          </p>
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
                Selected projects
              </h3>
              <span className="hint" style={{ fontSize: '.78rem' }}>
                {numSelected === 0
                  ? 'Click a row below to add it here'
                  : `${numSelected} project${numSelected === 1 ? '' : 's'} · auto-saved to projects.xlsx`}
              </span>
              <div style={{ flex: 1 }} />
              {numSelected > 0 && (
                <button onClick={clearAll} className="btn-secondary btn-sm">Clear all</button>
              )}
            </div>
            <ProjectsTable
              items={selectedSorted}
              checkedFlag={true}
              onToggle={toggle}
              sortCol={sortCol} sortDir={sortDir} onSort={handleSort}
              emptyText="No projects selected — click rows in the table below to add them."
              // Issue #85: fixed window — always tall enough for header + 5
              // rows, scrolls internally past that.  Keeps the Available
              // table below from jumping as selections change.
              height="210px"
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
                Available projects
              </h3>
              <span className="hint" style={{ fontSize: '.78rem' }}>
                Showing {unselectedSlice.length} of {unselectedFiltered.length} row
                {unselectedFiltered.length === 1 ? '' : 's'}
                {hasMoreAvailable && ' · scroll for more'}
              </span>
              <div style={{ flex: 1 }} />
              <input
                className="search-input"
                placeholder="Search by No, Title or DB…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ maxWidth: 260 }}
              />
              <button onClick={selectAllUnselected} className="btn-secondary btn-sm"
                      disabled={unselectedFiltered.length === 0}>
                Select all visible
              </button>
            </div>
            <ProjectsTable
              items={unselectedSlice}
              checkedFlag={false}
              onToggle={toggle}
              dragRowProps={dragRowProps}
              tbodyStyle={tbodyStyle}
              sortCol={sortCol} sortDir={sortDir} onSort={handleSort}
              emptyText={search ? 'No projects match the search.' : 'No more available projects.'}
              maxHeight="48vh"
              onScroll={handleAvailableScroll}
              footerHint={hasMoreAvailable
                ? `${unselectedFiltered.length - unselectedSlice.length} more row(s) — keep scrolling…`
                : null}
            />
          </div>
        </>
      )}
    </div>
  )
}
