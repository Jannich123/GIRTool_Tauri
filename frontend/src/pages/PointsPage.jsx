import { useState, useEffect, useMemo, useCallback } from 'react'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'


import { useDragSelect } from '../hooks/useDragSelect'

// ── Helpers ───────────────────────────────────────────────────────────────────


function SortIcon({ col, sortCol, sortDir }) {
  if (sortCol !== col) return <span className="sort-icon neutral">⇅</span>
  return <span className="sort-icon active">{sortDir === 'asc' ? '↑' : '↓'}</span>
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

  useEffect(() => {
    if (selectedProjects.length > 0) fetchPoints()
  }, [selectedProjects])

  useEffect(() => {
    const init = {}
    selectedPoints.forEach(p => { init[p.PointId] = true })
    setChecked(init)
  }, [selectedPoints])

  async function fetchPoints() {
    setLoading(true); setError('')
    try {
      const ids = selectedProjects.map(p => p.ProjectId)
      const res = await invoke('get_points', { projectIds: ids })
      setPoints(res)
    } catch (err) {
      console.error(err)
      setError(err || 'Failed to load points')
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

  function selectAll() {
    const all = {}
    filtered.forEach(p => { all[p.PointId] = true })
    setChecked(prev => ({ ...prev, ...all }))
  }
  function clearAll() { setChecked({}) }

  function confirm() {
    const selected = points.filter(p => checked[p.PointId])
    setSelectedPoints(selected)
    setPage('data')
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
      p.ProjectNo?.toLowerCase().includes(q)
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
    getKey:   p => p.PointId,
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
            placeholder="Search by No, Type or Project…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button onClick={selectAll}   className="btn-secondary btn-sm">Select all</button>
          <button onClick={clearAll}    className="btn-secondary btn-sm">Clear</button>
          <button onClick={fetchPoints} className="btn-secondary btn-sm">↻ Refresh</button>
          <button onClick={confirm} className="btn-primary">
            {numChecked > 0
              ? `Use ${numChecked} point${numChecked > 1 ? 's' : ''} →`
              : 'Use all points →'}
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
                    checked={filtered.length > 0 && filtered.every(p => checked[p.PointId])}
                    onChange={e => e.target.checked ? selectAll() : clearAll()}
                    title="Select / deselect all visible"
                  />
                </th>
                <th style={{ width: 10 }} />
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
              {filtered.map((p, idx) => (
                <tr
                  key={p.PointId}
                  className={checked[p.PointId] ? 'selected' : ''}
                  {...dragRowProps(p, idx)}
                >
                  <td>
                    <input
                      type="checkbox"
                      checked={!!checked[p.PointId]}
                      onChange={() => toggle(p.PointId)}
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
                  <td>{p.PointNo}</td>
                  <td>{p.PointType}</td>
                  <td>{p.ProjectNo}</td>
                  <td style={{ textAlign: 'right' }}>{p.X1}</td>
                  <td style={{ textAlign: 'right' }}>{p.Y1}</td>
                  <td style={{ textAlign: 'right' }}>{p.Z1}</td>
                  <td style={{ textAlign: 'right' }}>{p.Top}</td>
                  <td style={{ textAlign: 'right' }}>{p.Bottom}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={10} className="no-data">No points found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
