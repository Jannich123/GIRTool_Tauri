import { useState, useEffect, useMemo, useCallback } from 'react'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'
import { useDragSelect } from '../hooks/useDragSelect'

// ── Sort icon ─────────────────────────────────────────────────────────────────

function SortIcon({ col, sortCol, sortDir }) {
  if (sortCol !== col) return <span className="sort-icon neutral">⇅</span>
  return <span className="sort-icon active">{sortDir === 'asc' ? '↑' : '↓'}</span>
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

  // Pre-tick already selected projects
  useEffect(() => {
    const init = {}
    selectedProjects.forEach(p => { init[p.ProjectId] = true })
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

  function toggle(id) { setChecked(prev => ({ ...prev, [id]: !prev[id] })) }

  const addKeys = useCallback((keys) => {
    setChecked(prev => {
      const next = { ...prev }
      keys.forEach(k => { next[k] = true })
      return next
    })
  }, [])

  function selectAll()  {
    const all = {}
    filtered.forEach(p => { all[p.ProjectId] = true })
    setChecked(prev => ({ ...prev, ...all }))
  }
  function clearAll() { setChecked({}) }

  function confirm() {
    const selected = projects.filter(p => checked[p.ProjectId])
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
      p.Title?.toLowerCase().includes(q)
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
    getKey:   p => p.ProjectId,
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
            placeholder="Search by No or Title…"
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
                    checked={filtered.length > 0 && filtered.every(p => checked[p.ProjectId])}
                    onChange={e => e.target.checked ? selectAll() : clearAll()}
                    title="Select / deselect all visible"
                  />
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
              {filtered.map((p, idx) => (
                <tr
                  key={p.ProjectId}
                  className={checked[p.ProjectId] ? 'selected' : ''}
                  {...dragRowProps(p, idx)}
                >
                  <td>
                    <input
                      type="checkbox"
                      checked={!!checked[p.ProjectId]}
                      onChange={() => toggle(p.ProjectId)}
                      onClick={e => e.stopPropagation()}
                    />
                  </td>
                  <td>{p.ProjectNo}</td>
                  <td>{p.Title}</td>
                  <td style={{ textAlign: 'right' }}>{p.PointCount}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={4} className="no-data">No projects found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
