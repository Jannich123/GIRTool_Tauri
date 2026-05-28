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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ProjectsPage({ setPage }) {
  const { connected, connection, selectedProjects, setSelectedProjects, setSelectedPoints } = useApp()
  const [projects,    setProjects]    = useState([])
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState('')
  const [search,      setSearch]      = useState('')
  const [checked,     setChecked]     = useState({})
  const [sortCol,     setSortCol]     = useState('ProjectNo')
  const [sortDir,     setSortDir]     = useState('asc')
  const [xlsxMsg,     setXlsxMsg]     = useState(null)   // { kind: 'ok'|'warn'|'err', text }

  // Tracks whether we've already auto-loaded the persisted selection for the
  // current `projects` array — avoids re-applying on every render.
  const autoLoadedFor = useRef(null)

  useEffect(() => {
    if (connected) fetchProjects()
  }, [connected])

  // Pre-tick already-selected projects whenever the upstream `selectedProjects`
  // changes (e.g. session restore).
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

  // After the initial `list_projects` resolves, attempt to load
  // `projects.xlsx` once and auto-tick matching rows.  Silent if the file is
  // missing.  We key on the array identity so a manual refresh re-runs.
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

  // Single-key toggle.  `key` is already the composite `db_id||ProjectId`.
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
    getKey:   projKey,
    onAdd:    addKeys,
    onToggle: toggle,
  })

  const numChecked = Object.values(checked).filter(Boolean).length

  // ── xlsx action handlers ──────────────────────────────────────────────────

  async function handleSaveXlsx() {
    setXlsxMsg(null)
    try {
      const selected = projects.filter(p => checked[projKey(p)]).map(p => ({
        db_id:     p.db_id ?? '',
        ProjectId: p.ProjectId,
        ProjectNo: p.ProjectNo ?? '',
        Title:     p.Title ?? '',
      }))
      await invoke('save_projects_xlsx', { selected })
      const n = selected.length
      setXlsxMsg({ kind: 'ok', text: `Saved ${n} project${n === 1 ? '' : 's'} to projects.xlsx` })
    } catch (err) {
      console.error('save_projects_xlsx failed:', err)
      setXlsxMsg({ kind: 'err', text: `Failed to save: ${err}` })
    }
  }

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
      const additions = {}
      const orphans  = []
      for (const r of rows) {
        const k = projKey(r)
        if (present.has(k)) {
          additions[k] = true
        } else {
          orphans.push(r)
        }
      }
      setChecked(prev => ({ ...prev, ...additions }))
      const okCount = Object.keys(additions).length
      if (orphans.length > 0) {
        console.warn(
          `${orphans.length} project(s) from projects.xlsx not in current list — ` +
          'db not configured or project deleted:',
          orphans,
        )
        setXlsxMsg({
          kind: 'warn',
          text: `Ticked ${okCount}. ${orphans.length} row${orphans.length === 1 ? '' : 's'} ` +
                `in projects.xlsx weren't found in any configured database — see console.`,
        })
      } else {
        setXlsxMsg({ kind: 'ok', text: `Reloaded ${okCount} project${okCount === 1 ? '' : 's'} from projects.xlsx.` })
      }
    } catch (err) {
      console.error('load_projects_xlsx failed:', err)
      setXlsxMsg({ kind: 'err', text: `Failed to reload: ${err}` })
    }
  }

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

  const hasOutputFolder = !!connection?.output_folder
  const xlsxMsgClass = xlsxMsg?.kind === 'err'  ? 'msg err'
                    : xlsxMsg?.kind === 'warn' ? 'msg warn'
                    :                            'msg ok'

  return (
    <div className="page">
      <div className="page-header">
        <h2 className="page-title">Projects</h2>
        <div className="page-actions">
          <input
            className="search-input"
            placeholder="Search by No, Title or db_id…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button onClick={selectAll}   className="btn-secondary btn-sm">Select all</button>
          <button onClick={clearAll}    className="btn-secondary btn-sm">Clear</button>
          <button
            onClick={handleSaveXlsx}
            className="btn-secondary btn-sm"
            disabled={!hasOutputFolder}
            title={hasOutputFolder ? 'Save current selection to projects.xlsx' : 'Configure an output folder in Settings first'}
          >
            💾 Save selection to Excel
          </button>
          <button
            onClick={handleOpenXlsx}
            className="btn-secondary btn-sm"
            disabled={!hasOutputFolder}
            title={hasOutputFolder ? 'Open projects.xlsx in Excel' : 'Configure an output folder in Settings first'}
          >
            📂 Open projects.xlsx
          </button>
          <button
            onClick={handleReloadXlsx}
            className="btn-secondary btn-sm"
            disabled={!hasOutputFolder}
            title={hasOutputFolder ? 'Re-read projects.xlsx and tick matching rows' : 'Configure an output folder in Settings first'}
          >
            ↻ Reload from Excel
          </button>
          <button onClick={fetchProjects} className="btn-secondary btn-sm">↻ Refresh</button>
          <button onClick={confirm} disabled={numChecked === 0} className="btn-primary">
            Load {numChecked > 0 ? `${numChecked} project${numChecked > 1 ? 's' : ''}` : 'projects'} →
          </button>
        </div>
      </div>

      {error   && <p className="msg err">{error}</p>}
      {xlsxMsg && <p className={xlsxMsgClass}>{xlsxMsg.text}</p>}

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
                <th className="sortable" onClick={() => handleSort('db_id')}>
                  Database <SortIcon col="db_id" sortCol={sortCol} sortDir={sortDir} />
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
                    <td>
                      <code style={{
                        fontSize:     '.78rem',
                        padding:      '0.1rem 0.4rem',
                        background:   '#f1f5f9',
                        borderRadius: 4,
                      }}>
                        {p.db_id ?? '?'}
                      </code>
                    </td>
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
