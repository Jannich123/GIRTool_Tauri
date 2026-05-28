import { useState, useEffect, useMemo, useCallback } from 'react'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'
import { useDragSelect } from '../hooks/useDragSelect'

// ── Sort icon ─────────────────────────────────────────────────────────────────

function SortIcon({ col, sortCol, sortDir }) {
  if (sortCol !== col) return <span className="sort-icon neutral">⇅</span>
  return <span className="sort-icon active">{sortDir === 'asc' ? '↑' : '↓'}</span>
}

// Composite selection key — same shape used by the strata selKey (issue #66)
// so a project with the same ProjectId showing up in two databases is
// treated as two distinct rows.  Falls back to `'?'` for legacy rows that
// somehow arrive without a `db_id` (shouldn't happen post-#51).
const projKey = (p) => `${p.db_id ?? '?'}||${p.ProjectId}`

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
      title="Database this project belongs to (configured in Settings → Database)"
    >
      {id || '?'}
    </code>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ProjectsPage({ setPage }) {
  const { connected, selectedProjects, setSelectedProjects, setSelectedPoints } = useApp()
  const [projects, setProjects] = useState([])
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [search,   setSearch]   = useState('')
  const [checked,  setChecked]  = useState({})
  const [sortCol,  setSortCol]  = useState('ProjectNo')
  const [sortDir,  setSortDir]  = useState('asc')

  useEffect(() => {
    if (connected) fetchProjects()
  }, [connected])

  // Pre-tick already selected projects (keyed by composite db_id||ProjectId).
  useEffect(() => {
    const init = {}
    selectedProjects.forEach(p => { init[projKey(p)] = true })
    setChecked(init)
  }, [selectedProjects])

  async function fetchProjects() {
    setLoading(true); setError('')
    try {
      const res = await invoke('list_projects')
      setProjects(res)
    } catch (err) {
      console.error(err)
      setError(err || 'Failed to load projects')
    } finally {
      setLoading(false)
    }
  }

  function toggle(key) { setChecked(prev => ({ ...prev, [key]: !prev[key] })) }

  const addKeys = useCallback((keys) => {
    setChecked(prev => {
      const next = { ...prev }
      keys.forEach(k => { next[k] = true })
      return next
    })
  }, [])

  function selectAll()  {
    const all = {}
    filtered.forEach(p => { all[projKey(p)] = true })
    setChecked(prev => ({ ...prev, ...all }))
  }
  function clearAll() { setChecked({}) }

  function confirm() {
    const selected = projects.filter(p => checked[projKey(p)])
    setSelectedProjects(selected)
    setSelectedPoints([])
    // Persist top-level selection state to GIRTool_settings.json so the
    // tool restores it on the next launch.  Fire-and-forget — we don't
    // want to block navigation on disk I/O.
    invoke('save_selection', {
      selectedProjects: selected,
      selectedPoints:   [],
    }).catch(err => console.warn('save_selection failed:', err))
    setPage('points')
  }

  function handleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    const rows = !q ? projects : projects.filter(p =>
      p.ProjectNo?.toLowerCase().includes(q) ||
      p.Title?.toLowerCase().includes(q) ||
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
  }, [projects, search, sortCol, sortDir])

  const { rowProps: dragRowProps, tbodyStyle } = useDragSelect({
    items:    filtered,
    getKey:   p => projKey(p),
    onAdd:    addKeys,
    onToggle: toggle,
  })

  const numChecked = Object.values(checked).filter(Boolean).length

  // ── Guards ────────────────────────────────────────────────────────────────────

  if (!connected) {
    return (
      <div className="page">
        <h2 className="page-title">Projects</h2>
        <p className="hint">Go to <strong>Settings</strong> and connect to the database first.</p>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="page">
      <div className="page-header">
        <h2 className="page-title">Projects</h2>
        <div className="page-actions">
          <input
            className="search-input"
            placeholder="Search by No, Title or DB…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button onClick={selectAll}   className="btn-secondary btn-sm">Select all</button>
          <button onClick={clearAll}    className="btn-secondary btn-sm">Clear</button>
          <button onClick={fetchProjects} className="btn-secondary btn-sm">↻ Refresh</button>
          <button onClick={confirm} disabled={numChecked === 0} className="btn-primary">
            Load {numChecked > 0 ? `${numChecked} project${numChecked > 1 ? 's' : ''}` : 'projects'} →
          </button>
        </div>
      </div>

      {error && <p className="msg err">{error}</p>}

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
                    checked={filtered.length > 0 && filtered.every(p => checked[projKey(p)])}
                    onChange={e => e.target.checked ? selectAll() : clearAll()}
                    title="Select / deselect all visible"
                  />
                </th>
                <th className="sortable" onClick={() => handleSort('db_id')} style={{ width: 110 }}>
                  DB <SortIcon col="db_id" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className="sortable" onClick={() => handleSort('ProjectNo')}>
                  Project No <SortIcon col="ProjectNo" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className="sortable" onClick={() => handleSort('Title')}>
                  Title <SortIcon col="Title" sortCol={sortCol} sortDir={sortDir} />
                </th>
                <th className="sortable" style={{ textAlign: 'right' }} onClick={() => handleSort('PointCount')}>
                  Points <SortIcon col="PointCount" sortCol={sortCol} sortDir={sortDir} />
                </th>
              </tr>
            </thead>
            <tbody style={tbodyStyle}>
              {filtered.map((p, idx) => {
                const k = projKey(p)
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
                    <td><DbIdPill id={p.db_id} /></td>
                    <td>{p.ProjectNo}</td>
                    <td>{p.Title}</td>
                    <td style={{ textAlign: 'right' }}>{p.PointCount}</td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={5} className="no-data">No projects found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
