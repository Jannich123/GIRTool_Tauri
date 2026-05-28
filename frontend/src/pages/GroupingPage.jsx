import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'
import { useFilter } from '../context/FilterContext'
import { useDragSelect } from '../hooks/useDragSelect'

// ── Constants ─────────────────────────────────────────────────────────────────

const PALETTE = [
  '#2980b9','#e67e22','#27ae60','#8e44ad','#c0392b',
  '#16a085','#d35400','#2c3e50','#f39c12','#1abc9c',
]

let _gsSeq = 1, _grpSeq = 1

function mkSystem() {
  return {
    id:     `gs_${Date.now()}_${(_gsSeq++).toString(36)}`,
    name:   `System ${_gsSeq - 1}`,
    groups: [],
  }
}

function mkGroup(existingCount) {
  return {
    id:            `grp_${Date.now()}_${(_grpSeq++).toString(36)}`,
    name:          `Group ${existingCount + 1}`,
    color:         PALETTE[existingCount % PALETTE.length],
    symbol:        'circle',
    markerSize:    6,
    lineType:      'solid',
    lineThickness: 1.5,
  }
}

// ── Sort icon ─────────────────────────────────────────────────────────────────

function SortIcon({ col, sortCol, sortDir }) {
  if (sortCol !== col) return <span style={{ opacity: .3, marginLeft: 3 }}>⇅</span>
  return <span style={{ marginLeft: 3 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>
}

// ── Save status chip ──────────────────────────────────────────────────────────

function SaveChip({ status, error, onRetry }) {
  if (status === 'pending') return <span className="save-chip pending">● Unsaved…</span>
  if (status === 'saving')  return <span className="save-chip saving">⏳ Saving…</span>
  if (status === 'saved')   return <span className="save-chip saved">✔ Saved</span>
  if (status === 'error')   return (
    <span className="save-chip error">
      ✕ {error}&nbsp;
      <button className="retry-btn" onClick={onRetry}>Retry</button>
    </span>
  )
  return null
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function GroupingPage() {
  const { selectedProjects, scheduleColorsXlsxSave } = useApp()
  const { refreshGroupData } = useFilter()
  const projectId = selectedProjects[0]?.ProjectId

  const [systems,          setSystems]          = useState([])
  const [assignments,      setAssignments]      = useState({})
  const [activeGsId,       setActiveGsId]       = useState(null)
  const [collapsedSystems, setCollapsedSystems] = useState(new Set())

  // Points fetched directly
  const [points,        setPoints]        = useState([])
  const [pointsLoading, setPointsLoading] = useState(false)

  // Assignment table UI
  const [search,        setSearch]        = useState('')
  const [sortCol,       setSortCol]       = useState('PointNo')
  const [sortDir,       setSortDir]       = useState('asc')
  const [selectedPtIds, setSelectedPtIds] = useState(new Set())
  const [bulkGroup,     setBulkGroup]     = useState('')

  // Save state
  const [saveStatus,  setSaveStatus]  = useState('idle')  // idle|pending|saving|saved|error
  const [saveError,   setSaveError]   = useState('')
  const [loading,     setLoading]     = useState(false)
  const [refreshing,  setRefreshing]  = useState(false)

  // Auto-save refs
  const saveTimer   = useRef(null)
  const initialized = useRef(false)
  const pointsRef   = useRef([])
  useEffect(() => { pointsRef.current = points }, [points])

  // Cleanup on unmount
  useEffect(() => () => clearTimeout(saveTimer.current), [])

  // ── Core save ─────────────────────────────────────────────────────────────

  async function doSaveImpl(sys, asgn) {
    if (!projectId) return
    setSaveStatus('saving'); setSaveError('')
    try {
      await invoke('save_grouping', {
        projectId,
        body: {
          systems:     sys,
          assignments: asgn,
          points:      pointsRef.current.map(p => ({
            PointId:     p.PointId,
            PointNo:     p.PointNo     || '',
            PointType:   p.PointType   || '',
            ProjectNo:   p.ProjectNo   || '',
            ProjectName: selectedProjects.find(sp => sp.ProjectId === p.ProjectId)?.Title || '',
          })),
        },
      })
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2500)
      // Push updated group assignments into FilterContext so charts & filter
      // reflect the latest grouping without requiring a page reload.
      refreshGroupData()
    } catch (e) {
      console.error(e)
      setSaveError(e || 'Save failed')
      setSaveStatus('error')
    }
  }

  function scheduleSave(sys, asgn) {
    if (!initialized.current || !projectId) return
    clearTimeout(saveTimer.current)
    setSaveStatus('pending')
    saveTimer.current = setTimeout(() => doSaveImpl(sys, asgn), 600)
  }

  // ── Collapse toggle ───────────────────────────────────────────────────────

  function toggleCollapse(sysId, e) {
    e.stopPropagation()
    setCollapsedSystems(prev => {
      const next = new Set(prev)
      next.has(sysId) ? next.delete(sysId) : next.add(sysId)
      return next
    })
  }

  // ── Refresh from Excel ─────────────────────────────────────────────────────

  async function refreshFromExcel() {
    if (!projectId) return
    setRefreshing(true)
    try {
      const res = await invoke('reload_from_excel', { projectId })
      setSystems(res.systems || [])
      setAssignments(res.assignments || {})
      refreshGroupData()
    } catch {
      alert('Could not reload from Excel.')
    } finally {
      setRefreshing(false)
    }
  }

  // ── Fetch all project points ───────────────────────────────────────────────

  useEffect(() => {
    if (!selectedProjects.length) { setPoints([]); return }
    setPointsLoading(true)
    // Issue #48: forward db_id when present so the backend routes per-DB.
    invoke('get_points', {
      projectIds: selectedProjects.some(p => p?.db_id)
        ? selectedProjects.map(p => ({ db_id: p.db_id, ProjectId: p.ProjectId }))
        : selectedProjects.map(p => p.ProjectId),
    })
      .then(r => setPoints(r || []))
      .catch(() => setPoints([]))
      .finally(() => setPointsLoading(false))
  }, [selectedProjects])

  // ── Load grouping data ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!projectId) return
    initialized.current = false
    setLoading(true)
    setSystems([]); setAssignments({}); setSaveStatus('idle')
    invoke('get_grouping', { projectId })
      .then(r => {
        const sys = r.systems || []
        setSystems(sys)
        setAssignments(r.assignments || {})
        setActiveGsId(sys[0]?.id ?? null)
        setCollapsedSystems(new Set(sys.map(gs => gs.id)))
      })
      .catch(() => {})
      .finally(() => {
        setLoading(false)
        // Allow auto-save after React has committed the loaded state
        requestAnimationFrame(() => { initialized.current = true })
      })
  }, [projectId])

  // ── System CRUD ────────────────────────────────────────────────────────────

  function addSystem() {
    const gs = mkSystem()
    setSystems(prev => {
      const next = [...prev, gs]
      scheduleSave(next, assignments)
      scheduleColorsXlsxSave(next)
      return next
    })
    setActiveGsId(gs.id)
  }

  function updateSystem(id, updates) {
    setSystems(prev => {
      const next = prev.map(gs => gs.id === id ? { ...gs, ...updates } : gs)
      scheduleSave(next, assignments)
      scheduleColorsXlsxSave(next)
      return next
    })
  }

  function removeSystem(id) {
    setSystems(prev => {
      const next = prev.filter(gs => gs.id !== id)
      if (activeGsId === id) setActiveGsId(next[0]?.id ?? null)
      scheduleSave(next, assignments)
      scheduleColorsXlsxSave(next)
      return next
    })
    setAssignments(prev => {
      const next = {}
      for (const [pid, asgn] of Object.entries(prev)) {
        const { [id]: _, ...rest } = asgn
        if (Object.keys(rest).length) next[pid] = rest
      }
      return next
    })
  }

  // ── Group CRUD ─────────────────────────────────────────────────────────────

  function addGroup(gsId) {
    setSystems(prev => {
      const next = prev.map(gs => {
        if (gs.id !== gsId) return gs
        return { ...gs, groups: [...gs.groups, mkGroup(gs.groups.length)] }
      })
      scheduleSave(next, assignments)
      scheduleColorsXlsxSave(next)
      return next
    })
  }

  function updateGroup(gsId, grpId, updates) {
    setSystems(prev => {
      const next = prev.map(gs => {
        if (gs.id !== gsId) return gs
        return { ...gs, groups: gs.groups.map(g => g.id === grpId ? { ...g, ...updates } : g) }
      })
      scheduleSave(next, assignments)
      scheduleColorsXlsxSave(next)
      return next
    })
  }

  function removeGroup(gsId, grpId) {
    const grpName = systems.find(g => g.id === gsId)?.groups.find(g => g.id === grpId)?.name
    setSystems(prev => {
      const next = prev.map(gs => {
        if (gs.id !== gsId) return gs
        return { ...gs, groups: gs.groups.filter(g => g.id !== grpId) }
      })
      scheduleSave(next, assignments)
      scheduleColorsXlsxSave(next)
      return next
    })
    if (grpName) {
      setAssignments(prev => {
        const next = {}
        for (const [pid, asgn] of Object.entries(prev)) {
          if (asgn[gsId] === grpName) {
            const { [gsId]: _, ...rest } = asgn
            if (Object.keys(rest).length) next[pid] = rest
          } else {
            next[pid] = asgn
          }
        }
        scheduleSave(systems.filter(g => g.id !== grpId), next)
        return next
      })
    }
  }

  // ── Single-point assignment ────────────────────────────────────────────────

  function assignPoint(pointId, systemId, groupName) {
    setAssignments(prev => {
      const pa = { ...(prev[pointId] || {}) }
      if (groupName) pa[systemId] = groupName
      else delete pa[systemId]
      const next = !Object.keys(pa).length
        ? (() => { const { [pointId]: _, ...rest } = prev; return rest })()
        : { ...prev, [pointId]: pa }
      scheduleSave(systems, next)
      return next
    })
  }

  // ── Bulk assign ────────────────────────────────────────────────────────────

  function applyBulk() {
    if (!activeGs || !bulkGroup) return
    setAssignments(prev => {
      const next = { ...prev }
      for (const pid of selectedPtIds) {
        if (bulkGroup === '__clear__') {
          if (next[pid]) {
            const { [activeGs.id]: _, ...rest } = next[pid]
            if (!Object.keys(rest).length) delete next[pid]
            else next[pid] = rest
          }
        } else {
          next[pid] = { ...(next[pid] || {}), [activeGs.id]: bulkGroup }
        }
      }
      scheduleSave(systems, next)
      return next
    })
    setSelectedPtIds(new Set())
    setBulkGroup('')
  }

  // ── Multi-select ───────────────────────────────────────────────────────────

  function toggleSelectPt(ptId) {
    setSelectedPtIds(prev => {
      const next = new Set(prev)
      if (next.has(ptId)) next.delete(ptId)
      else next.add(ptId)
      return next
    })
  }

  const addPtKeys = useCallback((keys) => {
    setSelectedPtIds(prev => {
      const next = new Set(prev)
      keys.forEach(k => next.add(k))
      return next
    })
  }, [])

  function toggleSelectAll(filteredPts) {
    const allSelected = filteredPts.every(p => selectedPtIds.has(p.PointId))
    setSelectedPtIds(allSelected ? new Set() : new Set(filteredPts.map(p => p.PointId)))
  }

  // ── Sort ───────────────────────────────────────────────────────────────────

  function toggleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  // ── Filtered + sorted points ───────────────────────────────────────────────

  const filteredPoints = useMemo(() => {
    let pts = [...points]
    if (search.trim()) {
      const s = search.toLowerCase()
      pts = pts.filter(p =>
        p.PointNo?.toLowerCase().includes(s) ||
        p.PointType?.toLowerCase().includes(s) ||
        p.ProjectNo?.toLowerCase().includes(s)
      )
    }
    pts.sort((a, b) => {
      const av = (a[sortCol] ?? '').toString().toLowerCase()
      const bv = (b[sortCol] ?? '').toString().toLowerCase()
      return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    })
    return pts
  }, [points, search, sortCol, sortDir])

  // ── Guard ──────────────────────────────────────────────────────────────────

  if (!selectedProjects.length) {
    return (
      <div className="page">
        <h2 className="page-title">Grouping</h2>
        <p className="hint">Select a project first.</p>
      </div>
    )
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { rowProps: dragRowProps, tbodyStyle } = useDragSelect({
    items:    filteredPoints,
    getKey:   p => p.PointId,
    onAdd:    addPtKeys,
    onToggle: toggleSelectPt,
  })

  const activeGs = systems.find(gs => gs.id === activeGsId) ?? null
  const assignedCount = activeGs
    ? points.filter(p => {
        const g = assignments[p.PointId]?.[activeGs.id]
        return g && g !== 'Unknown'
      }).length
    : 0
  const allVisibleSelected = filteredPoints.length > 0 &&
    filteredPoints.every(p => selectedPtIds.has(p.PointId))

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="page grouping-page">

      <div className="grp-topbar">
        <h2 className="page-title" style={{ marginBottom: 0 }}>Grouping</h2>
        <div style={{ flex: 1 }} />
        <button
          className="btn-secondary btn-sm"
          onClick={() => invoke('open_grouping_excel', { projectId })
            .catch(() => alert('Grouping.xlsx not found — save grouping first.'))}
          disabled={!projectId}
          title="Open points.xlsx in Excel"
          style={{ marginRight: '0.5rem' }}
        >
          📂 Open Grouping Sheet
        </button>
        <button
          className="btn-secondary btn-sm"
          onClick={refreshFromExcel}
          disabled={refreshing || !projectId}
          title="Reload assignments from points.xlsx, fuzzy-matching any edited group names"
          style={{ marginRight: '0.5rem' }}
        >
          {refreshing ? '⏳ Refreshing…' : '↺ Refresh from Excel'}
        </button>
        <SaveChip
          status={saveStatus}
          error={saveError}
          onRetry={() => scheduleSave(systems, assignments)}
        />
      </div>

      {loading ? (
        <p className="hint">Loading…</p>
      ) : (
        <div className="grp-layout">

          {/* ── Left: system + group CRUD ── */}
          <div className="grp-left">
            <div className="grp-panel-hdr">
              <span className="grp-panel-title">Group Systems</span>
              <button className="btn-secondary btn-sm" onClick={addSystem}>＋ Add System</button>
            </div>

            {systems.length === 0 && (
              <p className="axis-hint muted" style={{ padding: '.5rem 0' }}>
                No group systems yet. Click "Add System" to create one.
              </p>
            )}

            {systems.map(gs => (
              <div key={gs.id} className={`grp-system-item${activeGsId === gs.id ? ' active' : ''}`}>
                <div className="grp-system-row" onClick={() => setActiveGsId(gs.id)}>
                  <span
                    className="gs-chevron"
                    onClick={e => toggleCollapse(gs.id, e)}
                    title="Expand / collapse"
                  >
                    {collapsedSystems.has(gs.id) ? '▶' : '▼'}
                  </span>
                  <input
                    className="grp-system-name"
                    value={gs.name}
                    onChange={e => updateSystem(gs.id, { name: e.target.value })}
                    onClick={e => e.stopPropagation()}
                    title="Rename system"
                  />
                  <button
                    className="btn-icon btn-sm"
                    style={{ color: '#991b1b', flexShrink: 0 }}
                    onClick={e => { e.stopPropagation(); removeSystem(gs.id) }}
                    title="Delete system"
                  >✕</button>
                </div>

                {!collapsedSystems.has(gs.id) && (
                  <div className="grp-groups-list">
                    {gs.groups.length === 0 && (
                      <span className="axis-hint muted">No groups yet.</span>
                    )}
                    {gs.groups.map(g => (
                      <div key={g.id} className="grp-group-row">
                        <input
                          className="group-name-input"
                          value={g.name}
                          disabled={g.name === 'Unknown'}
                          onChange={e => updateGroup(gs.id, g.id, { name: e.target.value })}
                          title={g.name === 'Unknown' ? 'Reserved name — cannot be changed' : ''}
                        />
                        {g.name !== 'Unknown' && (
                          <button
                            className="btn-icon btn-sm"
                            onClick={() => removeGroup(gs.id, g.id)}
                            title="Remove group"
                          >✕</button>
                        )}
                      </div>
                    ))}
                    <button
                      className="btn-secondary btn-sm"
                      style={{ marginTop: '.4rem' }}
                      onClick={() => addGroup(gs.id)}
                    >＋ Add Group</button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* ── Right: point assignments ── */}
          <div className="grp-right">
            <div className="grp-panel-hdr">
              <span className="grp-panel-title">
                {activeGs ? `Assignments — ${activeGs.name}` : 'Point Assignments'}
              </span>
              {activeGs && points.length > 0 && (
                <span className="axis-hint muted">
                  {assignedCount} / {points.length} assigned
                </span>
              )}
            </div>

            {!activeGs ? (
              <p className="axis-hint muted">Select a group system on the left.</p>
            ) : pointsLoading ? (
              <p className="axis-hint muted">Loading points…</p>
            ) : points.length === 0 ? (
              <p className="axis-hint muted">No points found for the selected project.</p>
            ) : (
              <>
                <div className="grp-assign-toolbar">
                  <input
                    type="text"
                    className="grp-assign-search"
                    placeholder="Search by point, type or project…"
                    value={search}
                    onChange={e => { setSearch(e.target.value); setSelectedPtIds(new Set()) }}
                  />
                  {selectedPtIds.size > 0 && (
                    <div className="grp-bulk-bar">
                      <span className="grp-bulk-count">{selectedPtIds.size} selected</span>
                      <select value={bulkGroup} onChange={e => setBulkGroup(e.target.value)} className="grp-bulk-select">
                        <option value="">— assign group —</option>
                        {activeGs.groups.filter(g => g.name !== 'Unknown').map(g => (
                          <option key={g.id} value={g.name}>{g.name}</option>
                        ))}
                        <option value="__clear__">✕ Reset to Unknown</option>
                      </select>
                      <button className="btn-primary btn-sm" onClick={applyBulk} disabled={!bulkGroup}>Apply</button>
                      <button className="btn-secondary btn-sm" onClick={() => setSelectedPtIds(new Set())}>Deselect all</button>
                    </div>
                  )}
                </div>

                <div className="grp-assign-table-wrap">
                  <table className="grp-assign-table">
                    <thead>
                      <tr>
                        <th style={{ width: 28 }}>
                          <input type="checkbox" checked={allVisibleSelected}
                            onChange={() => toggleSelectAll(filteredPoints)}
                            title={allVisibleSelected ? 'Deselect all' : 'Select all visible'} />
                        </th>
                        <th style={{ width: 16 }} />
                        {[['PointNo','Point'],['PointType','Type'],['ProjectNo','Project']].map(([col, label]) => (
                          <th key={col} className="sortable" onClick={() => toggleSort(col)}>
                            {label}<SortIcon col={col} sortCol={sortCol} sortDir={sortDir} />
                          </th>
                        ))}
                        <th>Group</th>
                      </tr>
                    </thead>
                    <tbody style={tbodyStyle}>
                      {filteredPoints.map((pt, idx) => {
                        const groupName  = assignments[pt.PointId]?.[activeGs.id] || ''
                        const displayGrp = groupName || 'Unknown'
                        const grp        = activeGs.groups.find(g => g.name === displayGrp)
                        const isChecked  = selectedPtIds.has(pt.PointId)
                        return (
                          <tr key={pt.PointId} className={isChecked ? 'row-selected' : ''}
                              {...dragRowProps(pt, idx)} style={{ cursor: 'pointer' }}>
                            <td onClick={e => e.stopPropagation()}>
                              <input type="checkbox" checked={isChecked} onChange={() => toggleSelectPt(pt.PointId)} />
                            </td>
                            <td>
                              <span className="point-assign-dot" style={{ background: grp?.color || '#d1d5db' }} />
                            </td>
                            <td>{pt.PointNo}</td>
                            <td>{pt.PointType}</td>
                            <td>{pt.ProjectNo}</td>
                            <td onClick={e => e.stopPropagation()}>
                              <select value={groupName}
                                onChange={e => assignPoint(pt.PointId, activeGs.id, e.target.value)}>
                                <option value="">— Unknown —</option>
                                {activeGs.groups.filter(g => g.name !== 'Unknown').map(g => (
                                  <option key={g.id} value={g.name}>{g.name}</option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {filteredPoints.length === 0 && (
                    <p className="axis-hint muted" style={{ padding: '.75rem' }}>
                      No points match your search.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
