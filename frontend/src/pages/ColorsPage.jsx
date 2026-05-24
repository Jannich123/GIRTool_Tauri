import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'
import { useFilter } from '../context/FilterContext'

// ── Constants ─────────────────────────────────────────────────────────────────

const SYMBOLS = [
  'circle','square','diamond','cross','x',
  'triangle-up','triangle-down','star','hexagram','pentagon',
]

const LINE_TYPES = ['solid','dash','dot','dashdot']

// ── Colour swatch (filled square that opens native picker) ────────────────────

function ColorSwatch({ value, onChange }) {
  const ref = useRef(null)
  return (
    <div className="cs-swatch-wrap" title={value} onClick={() => ref.current?.click()}>
      <div className="cs-swatch-box" style={{ background: value }} />
      <input
        ref={ref}
        type="color"
        value={value}
        onChange={onChange}
        style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
        tabIndex={-1}
      />
    </div>
  )
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

export default function ColorsPage() {
  const {
    selectedProjects,
    typeStyles, updateTypeStyle,
    strataLayerColors, updateStrataLayerStyle,
    scheduleColorsXlsxSave, xlsxSaveStatus,
  } = useApp()
  const { allPoints, refreshGroupData, strataLayers } = useFilter()
  const projectId = selectedProjects[0]?.ProjectId

  const [systems,     setSystems]     = useState([])
  const [assignments, setAssignments] = useState({})   // preserved on save
  const [csTab,       setCsTab]       = useState('__strata_primary__')

  const [saveStatus,    setSaveStatus]    = useState('idle')
  const [saveError,     setSaveError]     = useState('')
  const [loading,       setLoading]       = useState(false)
  const [dragOver,      setDragOver]      = useState(null)
  const [refreshing,    setRefreshing]    = useState(false)

  // Auto-save refs
  const saveTimer      = useRef(null)
  const initialized    = useRef(false)
  const assignmentsRef = useRef({})
  useEffect(() => { assignmentsRef.current = assignments }, [assignments])

  useEffect(() => () => { clearTimeout(saveTimer.current) }, [])

  // ── Wrappers that also trigger xlsx save ─────────────────────────────────
  // The xlsx save reads typeStyles / strataLayerColors via refs in AppContext,
  // so we just update state and ask the context to schedule a save — no need
  // to compute next-state overrides locally.

  function updateTypeStyleAndSave(type, updates) {
    updateTypeStyle(type, updates)
    scheduleColorsXlsxSave(systems)
  }

  function updateStrataLayerStyleAndSave(kind, val, updates) {
    updateStrataLayerStyle(kind, val, updates)
    scheduleColorsXlsxSave(systems)
  }

  // ── Unique point types from loaded data ───────────────────────────────────

  const uniqueTypes = useMemo(() => {
    if (!allPoints?.length) return []
    const seen = new Set(allPoints.map(p => p.PointType).filter(Boolean).map(t => t.toUpperCase()))
    return [...seen].sort()
  }, [allPoints])

  // Rows to show in Point Type tab: all types seen in data, with 'Other' always last (as fallback)
  const ptTypeRows = useMemo(() => {
    const rows = uniqueTypes.filter(t => t !== 'OTHER')
    if (!rows.includes('CPT') && !rows.includes('BH') && !rows.includes('TP') && rows.length === 0) {
      // no data yet — show the four defaults
      return ['CPT', 'BH', 'TP', 'Other']
    }
    return [...rows, 'Other']
  }, [uniqueTypes])

  // ── Core save ─────────────────────────────────────────────────────────────

  async function doSaveImpl(sys) {
    if (!projectId) return
    setSaveStatus('saving'); setSaveError('')
    try {
      await invoke('save_grouping', {
        projectId,
        body: {
          systems:     sys,
          assignments: assignmentsRef.current,
          points:      [],          // preserves existing point rows in points.xlsx
        },
      })
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2500)
      refreshGroupData()   // push updated group colours into FilterContext → charts update live
    } catch (e) {
      setSaveError(e || 'Save failed')
      setSaveStatus('error')
    }
  }

  function scheduleSave(sys) {
    if (!initialized.current || !projectId) return
    clearTimeout(saveTimer.current)
    setSaveStatus('pending')
    saveTimer.current = setTimeout(() => doSaveImpl(sys), 600)
  }

  // ── Refresh from Excel ────────────────────────────────────────────────────

  const refreshFromXlsx = useCallback(async () => {
    setRefreshing(true)
    try {
      const d = await invoke('load_colors')

      // Apply type styles
      if (d.type_styles && Object.keys(d.type_styles).length) {
        Object.entries(d.type_styles).forEach(([type, style]) => {
          if (style.color)  updateTypeStyle(type, { color:  style.color  })
          if (style.symbol) updateTypeStyle(type, { symbol: style.symbol })
        })
      }

      // Apply strata layer colors
      if (d.strata_layer_colors) {
        const slc = d.strata_layer_colors
        ;['primary', 'secondary'].forEach(kind => {
          Object.entries(slc[kind] || {}).forEach(([val, style]) => {
            updateStrataLayerStyle(kind, val, style)
          })
        })
      }

      // Apply group system colors — match by system name
      if (d.group_systems?.length) {
        setSystems(prev => {
          const next = prev.map(gs => {
            const fromFile = d.group_systems.find(x => x.name === gs.name)
            if (!fromFile) return gs
            const nameToStyle = Object.fromEntries(fromFile.groups.map(g => [g.name, g]))
            return {
              ...gs,
              groups: gs.groups.map(g => {
                const s = nameToStyle[g.name]
                if (!s) return g
                return {
                  ...g,
                  color:         s.color         ?? g.color,
                  symbol:        s.symbol        ?? g.symbol,
                  markerSize:    s.markerSize    ?? g.markerSize,
                  lineType:      s.lineType      ?? g.lineType,
                  lineThickness: s.lineThickness ?? g.lineThickness,
                }
              }),
            }
          })
          // Persist the updated group system colors back to grouping backend
          if (projectId) {
            invoke('save_grouping', {
              projectId,
              body: {
                systems:     next,
                assignments: assignmentsRef.current,
                points:      [],
              },
            }).catch(() => {})
          }
          return next
        })
      }
    } catch { /* ignore — file may not exist yet */ }
    setRefreshing(false)
  }, [updateTypeStyle, updateStrataLayerStyle, projectId])

  // ── Load ───────────────────────────────────────────────────────────────────

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
        // Auto-save Colors_&_Symbols.xlsx on initial load so the file exists
        // even before the user makes any manual edits.
        scheduleColorsXlsxSave(sys)
      })
      .catch(() => {})
      .finally(() => {
        setLoading(false)
        requestAnimationFrame(() => { initialized.current = true })
      })
  }, [projectId])

  // Re-save when strata layer data arrives (e.g. after Transfer Strata) so
  // the xlsx stays current with the new default layer rows.
  // Guard with initialized.current so we don't fire while systems is still []
  // during the project-change reset.
  useEffect(() => {
    if (!projectId || !initialized.current) return
    scheduleColorsXlsxSave(systems)
  }, [strataLayers]) // eslint-disable-line

  // ── Group helpers ──────────────────────────────────────────────────────────

  function updateGroup(gsId, grpId, updates) {
    setSystems(prev => {
      const next = prev.map(gs => {
        if (gs.id !== gsId) return gs
        return { ...gs, groups: gs.groups.map(g => g.id === grpId ? { ...g, ...updates } : g) }
      })
      scheduleSave(next)
      scheduleColorsXlsxSave(next)
      return next
    })
  }

  function reorderGroup(gsId, fromIdx, toIdx) {
    if (fromIdx === toIdx) return
    setSystems(prev => {
      const next = prev.map(gs => {
        if (gs.id !== gsId) return gs
        const groups = [...gs.groups]
        const [item] = groups.splice(fromIdx, 1)
        groups.splice(toIdx, 0, item)
        return { ...gs, groups }
      })
      scheduleSave(next)
      scheduleColorsXlsxSave(next)
      return next
    })
  }

  // ── Guard ──────────────────────────────────────────────────────────────────

  if (!selectedProjects.length) {
    return (
      <div className="page">
        <h2 className="page-title">Colors & Symbols</h2>
        <p className="hint">Select a project first.</p>
      </div>
    )
  }

  const csSystem = systems.find(gs => gs.id === csTab) ?? null

  // Map the active UI tab to the Excel sheet name that colors.py writes
  const activeTabSheetName = (() => {
    if (csTab === '__strata_primary__')   return 'Primary Layer'
    if (csTab === '__strata_secondary__') return 'Secondary Layer'
    if (csTab === '__type__')             return 'Point Types'
    // Group system tab — sheet name = system name (sanitized by _safe_sheet_name on save)
    return csSystem?.name ?? ''
  })()

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="page grouping-page">

      <div className="grp-topbar">
        <h2 className="page-title" style={{ marginBottom: 0 }}>Colors & Symbols</h2>
        <div style={{ flex: 1 }} />
        <button
          className="btn-secondary btn-sm"
          onClick={() =>
            invoke('open_colors_excel', { sheet: activeTabSheetName })
              .catch(() => alert('Could not open file. Make sure Colors & Symbols has been saved first.'))
          }
          title="Open Colors_&_Symbols.xlsx in Excel at the current tab"
          style={{ marginRight: '0.5rem' }}
        >
          📂 Open in Excel
        </button>
        <button
          className="btn-secondary btn-sm"
          onClick={refreshFromXlsx}
          disabled={refreshing}
          title="Reload all settings from Colors_&_Symbols.xlsx in the output folder"
          style={{ marginRight: '0.5rem' }}
        >
          {refreshing ? '⏳ Refreshing…' : '↺ Refresh from Excel'}
        </button>
        {xlsxSaveStatus === 'saving' && <span style={{ fontSize: '.75rem', color: '#6b7280', marginRight: '0.5rem' }}>☁ Saving xlsx…</span>}
        {xlsxSaveStatus === 'saved'  && <span style={{ fontSize: '.75rem', color: '#16a34a', marginRight: '0.5rem' }}>☁ xlsx saved</span>}
        {xlsxSaveStatus === 'error'  && <span style={{ fontSize: '.75rem', color: '#dc2626', marginRight: '0.5rem' }}>☁ xlsx error</span>}
        <SaveChip
          status={saveStatus}
          error={saveError}
          onRetry={() => scheduleSave(systems)}
        />
      </div>

      {loading ? (
        <p className="hint">Loading…</p>
      ) : (
        <div className="grp-cs-container">
          {/* Sub-tab bar — order: Primary Layer | Secondary Layer | Point Type | group systems */}
          <div className="grp-cs-tabs">
            <button
              className={`grp-cs-tab${csTab === '__strata_primary__' ? ' active' : ''}`}
              onClick={() => setCsTab('__strata_primary__')}
            >🪨 Primary Layer</button>
            <button
              className={`grp-cs-tab${csTab === '__strata_secondary__' ? ' active' : ''}`}
              onClick={() => setCsTab('__strata_secondary__')}
            >🪨 Secondary Layer</button>

            <button
              className={`grp-cs-tab${csTab === '__type__' ? ' active' : ''}`}
              onClick={() => setCsTab('__type__')}
            >Point Type</button>

            {systems.map(gs => (
              <button
                key={gs.id}
                className={`grp-cs-tab${csTab === gs.id ? ' active' : ''}`}
                onClick={() => setCsTab(gs.id)}
              >{gs.name}</button>
            ))}
          </div>

          {/* ── Strata Layer panels ── */}
          {(csTab === '__strata_primary__' || csTab === '__strata_secondary__') ? (() => {
            const type   = csTab === '__strata_primary__' ? 'primary' : 'secondary'
            const label  = type === 'primary' ? 'Primary Layer' : 'Secondary Layer'
            const baseValues = strataLayers[type] || []
            // 'Unknown' is a synthetic fallback for rows with no strata assignment.
            // It never appears in the strata master sheet so we always append it.
            const values = baseValues.includes('Unknown') ? baseValues : [...baseValues, 'Unknown']
            const styles = strataLayerColors[type] || {}
            const DEFAULT_COLORS = [
              '#3b82f6','#ef4444','#22c55e','#f59e0b','#8b5cf6',
              '#06b6d4','#f97316','#ec4899','#84cc16','#6366f1',
            ]
            const UNKNOWN_DEFAULT_COLOR = '#9ca3af'   // grey — visually distinct fallback
            const upd = (val, patch) => updateStrataLayerStyleAndSave(type, val, patch)
            return (
              <div className="grp-cs-table">
                {/* Header — same columns as group system table */}
                <div className="grp-cs-row grp-cs-head">
                  <div className="grp-cs-cell grp-cs-color">Color</div>
                  <div className="grp-cs-cell grp-cs-name">{label} value</div>
                  <div className="grp-cs-cell grp-cs-sym">Symbol</div>
                  <div className="grp-cs-cell grp-cs-num">Size</div>
                  <div className="grp-cs-cell grp-cs-lt">Line Type</div>
                  <div className="grp-cs-cell grp-cs-num">Thickness</div>
                </div>

                {baseValues.length === 0 && (
                  <p className="axis-hint muted" style={{ padding: '1rem 0 0' }}>
                    No layer values found. Load strata data in the Strata tab first.
                  </p>
                )}

                {values.map((val, idx) => {
                  const isUnknown = val === 'Unknown'
                  const s = styles[val] || {}
                  const defaultColor  = isUnknown ? UNKNOWN_DEFAULT_COLOR : DEFAULT_COLORS[idx % DEFAULT_COLORS.length]
                  const color         = s.color         ?? defaultColor
                  const symbol        = s.symbol        ?? 'circle'
                  const markerSize    = s.markerSize    ?? 6
                  const lineType      = s.lineType      ?? 'solid'
                  const lineThickness = s.lineThickness ?? 1.5
                  return (
                    <div key={val} className="grp-cs-row">
                      <div className="grp-cs-cell grp-cs-color">
                        <ColorSwatch value={color} onChange={e => upd(val, { color: e.target.value })} />
                      </div>
                      <div className="grp-cs-cell grp-cs-name">
                        {val}
                        {isUnknown && (
                          <span style={{ marginLeft: 5, opacity: 0.45, fontSize: '0.72em', fontStyle: 'italic' }}>
                            (fallback for unassigned rows)
                          </span>
                        )}
                      </div>
                      <div className="grp-cs-cell grp-cs-sym">
                        <select value={symbol} onChange={e => upd(val, { symbol: e.target.value })}>
                          {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </div>
                      <div className="grp-cs-cell grp-cs-num">
                        <input type="number" min="2" max="20" step="1" value={markerSize}
                          onChange={e => upd(val, { markerSize: Number(e.target.value) })} />
                      </div>
                      <div className="grp-cs-cell grp-cs-lt">
                        <select value={lineType} onChange={e => upd(val, { lineType: e.target.value })}>
                          {LINE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                      <div className="grp-cs-cell grp-cs-num">
                        <input type="number" min="0.5" max="6" step="0.5" value={lineThickness}
                          onChange={e => upd(val, { lineThickness: Number(e.target.value) })} />
                      </div>
                    </div>
                  )
                })}

                <p className="axis-hint muted" style={{ padding: '.5rem 0' }}>
                  Settings apply when grouping charts by {label}.
                  Values are read from the Strata master sheet.
                </p>
              </div>
            )
          })() : null}

          {/* ── Point Type / Group System panel ── */}
          {csTab !== '__strata_primary__' && csTab !== '__strata_secondary__' && csTab === '__type__' ? (
            <div className="grp-cs-table">
              <div className="grp-cs-row grp-cs-head">
                <div className="grp-cs-cell grp-cs-color">Color</div>
                <div className="grp-cs-cell grp-cs-sym">Symbol</div>
                <div className="grp-cs-cell grp-cs-name">Type</div>
              </div>
              {ptTypeRows.map(type => {
                const style = typeStyles[type] ?? typeStyles.Other ?? { color: '#7f8c8d', symbol: 'circle' }
                return (
                  <div key={type} className="grp-cs-row">
                    <div className="grp-cs-cell grp-cs-color">
                      <ColorSwatch
                        value={style.color}
                        onChange={e => updateTypeStyleAndSave(type, { color: e.target.value })}
                      />
                    </div>
                    <div className="grp-cs-cell grp-cs-sym">
                      <select
                        value={style.symbol}
                        onChange={e => updateTypeStyleAndSave(type, { symbol: e.target.value })}
                      >
                        {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div className="grp-cs-cell grp-cs-name">
                      {type}
                      {type === 'Other' && (
                        <span style={{ marginLeft: 5, opacity: 0.45, fontSize: '0.72em', fontStyle: 'italic' }}>
                          (fallback for unrecognised types)
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
              <p className="axis-hint muted" style={{ padding: '.5rem 0' }}>
                Changes apply immediately to the Map and Points pages.
              </p>
            </div>
          ) : csTab !== '__strata_primary__' && csTab !== '__strata_secondary__' && systems.length === 0 ? (
            <p className="axis-hint muted" style={{ padding: '1rem 0' }}>
              No group systems found. Go to the Grouping page to create one.
            </p>
          ) : csSystem ? (
            csSystem.groups.length === 0 ? (
              <p className="axis-hint muted" style={{ padding: '1rem' }}>
                No groups in this system. Go to the Grouping page to add them.
              </p>
            ) : (
              <div className="grp-cs-table">
                {/* Header */}
                <div className="grp-cs-row grp-cs-head">
                  <div className="grp-cs-cell grp-cs-order" />
                  <div className="grp-cs-cell grp-cs-color">Color</div>
                  <div className="grp-cs-cell grp-cs-name">Name</div>
                  <div className="grp-cs-cell grp-cs-sym">Symbol</div>
                  <div className="grp-cs-cell grp-cs-num">Size</div>
                  <div className="grp-cs-cell grp-cs-lt">Line Type</div>
                  <div className="grp-cs-cell grp-cs-num">Thickness</div>
                </div>

                {/* Data rows */}
                {csSystem.groups.map((g, idx) => {
                  const isUnknown = g.name === 'Unknown'
                  return (
                  <div
                    key={g.id}
                    className={`grp-cs-row${dragOver === idx ? ' drag-over' : ''}${isUnknown ? ' grp-cs-row-locked' : ''}`}
                    draggable={!isUnknown}
                    onDragStart={isUnknown ? undefined : e => {
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', String(idx))
                    }}
                    onDragOver={isUnknown ? undefined : e => { e.preventDefault(); setDragOver(idx) }}
                    onDragLeave={isUnknown ? undefined : () => setDragOver(null)}
                    onDrop={isUnknown ? undefined : e => {
                      e.preventDefault()
                      const from = Number(e.dataTransfer.getData('text/plain'))
                      setDragOver(null)
                      reorderGroup(csSystem.id, from, idx)
                    }}
                    onDragEnd={isUnknown ? undefined : () => setDragOver(null)}
                  >
                    <div className="grp-cs-cell grp-cs-order">
                      {isUnknown
                        ? <span className="drag-handle" style={{ opacity: 0.2, cursor: 'default' }} title="Reserved group — cannot be moved">⠿</span>
                        : <span className="drag-handle" title="Drag to reorder">⠿</span>
                      }
                    </div>

                    <div className="grp-cs-cell grp-cs-color">
                      <ColorSwatch
                        value={g.color}
                        onChange={e => updateGroup(csSystem.id, g.id, { color: e.target.value })}
                      />
                    </div>

                    <div className="grp-cs-cell grp-cs-name">
                      {g.name}
                      {isUnknown && <span style={{ marginLeft: 5, opacity: 0.45, fontSize: '0.72em', fontStyle: 'italic' }} title="Reserved catch-all for unassigned points">(reserved)</span>}
                    </div>

                    <div className="grp-cs-cell grp-cs-sym">
                      <select value={g.symbol}
                        onChange={e => updateGroup(csSystem.id, g.id, { symbol: e.target.value })}>
                        {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>

                    <div className="grp-cs-cell grp-cs-num">
                      <input type="number" min="2" max="20" step="1" value={g.markerSize}
                        onChange={e => updateGroup(csSystem.id, g.id, { markerSize: Number(e.target.value) })} />
                    </div>

                    <div className="grp-cs-cell grp-cs-lt">
                      <select value={g.lineType}
                        onChange={e => updateGroup(csSystem.id, g.id, { lineType: e.target.value })}>
                        {LINE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>

                    <div className="grp-cs-cell grp-cs-num">
                      <input type="number" min="0.5" max="6" step="0.5" value={g.lineThickness}
                        onChange={e => updateGroup(csSystem.id, g.id, { lineThickness: Number(e.target.value) })} />
                    </div>
                  </div>
                  )
                })}

                <p className="axis-hint muted" style={{ padding: '.5rem 0' }}>
                  ⠿ drag rows to reorder &nbsp;·&nbsp; top row = drawn in front &nbsp;·&nbsp; bottom = drawn behind
                </p>
              </div>
            )
          ) : null}
        </div>
      )}
    </div>
  )
}
