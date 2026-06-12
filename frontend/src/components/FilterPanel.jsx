import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useFilter } from '../context/FilterContext'

// ── Type colours (matches MapPage / PointsPage) ───────────────────────────────

const TYPE_COLORS = { CPT: '#e67e22', BH: '#2980b9', TP: '#27ae60' }
function typeColor(t) { return TYPE_COLORS[t?.toUpperCase()] || '#7f8c8d' }

// ── Reusable scrollable list tab ──────────────────────────────────────────────

function FilterTab({ items, getKey, getLabel, getDot, isChecked, isDimmed, onToggle, onSetExact, onSelectAll, onDeselectAll }) {
  const [search,  setSearch]  = useState('')
  const [sortDir, setSortDir] = useState('asc')

  const visible = useMemo(() => {
    const q = search.toLowerCase()
    const rows = q ? items.filter(item => getLabel(item).toLowerCase().includes(q)) : items
    return [...rows].sort((a, b) => {
      const cmp = getLabel(a).localeCompare(getLabel(b))
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [items, search, sortDir])

  // ── Excel-slicer interaction (#268) ──────────────────────────────────────
  // Plain click → ONLY that item.  Ctrl/Cmd+click → toggle it in/out.
  // Shift+click → the whole range from the last clicked row (visible order);
  // Ctrl+Shift adds the range to the current selection.  The checkbox stays
  // an explicit additive toggle.
  const anchorRef = useRef(null)
  const handleRowClick = useCallback((e, idx) => {
    const keys = visible.map(getKey)
    const key  = keys[idx]
    if (e.shiftKey && anchorRef.current != null) {
      const [a, b] = [Math.min(anchorRef.current, idx), Math.max(anchorRef.current, idx)]
      const range = keys.slice(a, b + 1)
      const base = (e.ctrlKey || e.metaKey)
        ? new Set(items.map(getKey).filter(k => isChecked(k)))
        : new Set()
      range.forEach(k => base.add(k))
      onSetExact(base)
      return // anchor stays for follow-up shift-clicks
    }
    if (e.ctrlKey || e.metaKey) {
      onToggle(key)
    } else {
      onSetExact(new Set([key]))
    }
    anchorRef.current = idx
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, items, isChecked, onToggle, onSetExact])

  // ── Master checkbox state ────────────────────────────────────────────────
  // State is computed from the *currently visible* (post-search) items so the
  // master row mirrors what the user actually sees.  The action below operates
  // on the same `visible` set, so a search + master click selects/deselects
  // only the matching rows — items hidden by the search are left untouched.
  const { checkedCount, totalCount } = useMemo(() => {
    let c = 0
    for (const item of visible) if (isChecked(getKey(item))) c++
    return { checkedCount: c, totalCount: visible.length }
  }, [visible, isChecked, getKey])

  const allChecked  = totalCount > 0 && checkedCount === totalCount
  const noneChecked = checkedCount === 0
  const indeterminate = !allChecked && !noneChecked

  // Native HTML doesn't expose `indeterminate` as a React prop — set via ref.
  const masterRef = useRef(null)
  useEffect(() => {
    if (masterRef.current) masterRef.current.indeterminate = indeterminate
  }, [indeterminate])

  const handleMasterClick = useCallback(() => {
    // Search-aware tri-state toggle.
    //
    // - No search active (visible === all items):
    //     * allChecked → deselect everything (use onDeselectAll for one render)
    //     * otherwise  → select everything   (use onSelectAll for one render)
    //
    // - Search active (visible is a subset):
    //     * iterate the visible subset, toggling each row so only those are
    //       flipped — items outside the search keep their current state.
    //
    // Using `onToggle` once per row (instead of also calling onAdd) avoids
    // the previous double-fire bug where each item ended up toggled twice
    // and the net result was no change.
    const isSearching = visible.length !== items.length
    if (!isSearching) {
      if (allChecked) onDeselectAll()
      else            onSelectAll()
      return
    }
    if (allChecked) {
      // Deselect every visible row that is currently checked.
      for (const item of visible) {
        const key = getKey(item)
        if (isChecked(key)) onToggle(key)
      }
    } else {
      // Select every visible row that is currently unchecked.
      for (const item of visible) {
        const key = getKey(item)
        if (!isChecked(key)) onToggle(key)
      }
    }
  }, [allChecked, visible, items, isChecked, getKey, onToggle, onSelectAll, onDeselectAll])

  return (
    <div className="fp-tab-body">
      <div className="fp-toolbar">
        <input
          className="fp-search"
          placeholder="Search…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button className="fp-icon-btn" onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}
          title="Toggle sort">
          {sortDir === 'asc' ? '↑' : '↓'}
        </button>
      </div>

      {/* Master "select / deselect all" checkbox row — sticky at the top of
          the list.  Shows tri-state (checked / unchecked / indeterminate)
          and toggles all rows currently visible (respects active search). */}
      <label className="fp-item fp-master-row" onClick={(e) => {
        // Prevent the row's drag-select handlers from firing here.
        e.stopPropagation()
      }}>
        <input
          ref={masterRef}
          type="checkbox"
          checked={allChecked}
          onChange={handleMasterClick}
        />
        <span className="fp-label fp-master-label">
          {(() => {
            const matchSuffix = search.trim() ? ` matching` : ''
            if (allChecked)  return `Deselect all ${totalCount}${matchSuffix}`
            if (noneChecked) return `Select all ${totalCount}${matchSuffix}`
            return `Select all ${totalCount}${matchSuffix} (${checkedCount} now)`
          })()}
        </span>
      </label>

      <p className="fp-empty" style={{ margin: '.2rem 0', fontSize: '.7rem' }}>
        Click = only this · Ctrl = add/remove · Shift = range
      </p>

      <div className="fp-list" style={{ userSelect: 'none' }}>
        {visible.map((item, idx) => {
          const key     = getKey(item)
          const checked = isChecked(key)
          const dim     = isDimmed?.(key)
          const dot     = getDot?.(item)
          return (
            <label key={key} className={`fp-item${dim ? ' fp-dim' : ''}`}
              onClick={(e) => { e.preventDefault(); handleRowClick(e, idx) }}>
              <input
                type="checkbox"
                checked={checked}
                onClick={(e) => e.stopPropagation()}
                onChange={() => { onToggle(key); anchorRef.current = idx }}
              />
              {dot && <span className="fp-dot" style={{ background: dot }} />}
              <span className="fp-label">{getLabel(item)}</span>
            </label>
          )
        })}
        {visible.length === 0 && <p className="fp-empty">No items</p>}
      </div>
    </div>
  )
}

// ── Main filter panel ─────────────────────────────────────────────────────────

export default function FilterPanel({ page }) {
  const {
    filterOpen, setFilterOpen,
    allPoints, groupSystems, groupAssignments,
    checkedPtIds, checkedGroups,
    filteredPtIds,
    togglePt, selectAllPts, deselectAllPts,
    setPtSelection, setGroupSelection, setStrataSelection,
    toggleGroup, selectAllGroups, deselectAllGroups,
    resetFilters,
    groupDimmedPtIds, isGroupDimmed,
    strataLayers,
    checkedStrataPrimary,   checkedStrataSecondary,
    toggleStrataPrimary,    toggleStrataSecondary,
    selectAllStrataPrimary, deselectAllStrataPrimary,
    selectAllStrataSecondary, deselectAllStrataSecondary,
  } = useFilter()

  const [activeTab, setActiveTab] = useState('points')

  // Issue #117: Data tab also shows the Primary / Secondary Layer tabs —
  // DatasheetPreview already consumes the filter state.
  const showStrataFilter = page === 'charts' || page === 'map' || page === 'data'

  const tabs = [
    { key: 'points', label: 'Points' },
    ...groupSystems.map(gs => ({ key: gs.id, label: gs.name })),
    ...(showStrataFilter && strataLayers.primary.length   > 0 ? [{ key: '__strata_primary__',   label: '🪨 Primary Layer'   }] : []),
    ...(showStrataFilter && strataLayers.secondary.length > 0 ? [{ key: '__strata_secondary__', label: '🪨 Secondary Layer' }] : []),
  ]

  const activeCount = filteredPtIds === null ? null : filteredPtIds.size
  const totalCount  = allPoints.length

  // ── Toggle button (panel closed) ─────────────────────────────────────────

  if (!filterOpen) {
    return (
      <button
        className={`fp-open-btn${activeCount !== null && activeCount < totalCount ? ' fp-active' : ''}`}
        onClick={() => setFilterOpen(true)}
        title="Open filter panel"
      >
        <span className="fp-open-icon">◀</span>
        <span className="fp-open-label">Filter</span>
        {activeCount !== null && activeCount < totalCount && (
          <span className="fp-badge">{activeCount}/{totalCount}</span>
        )}
      </button>
    )
  }

  // ── Panel open ────────────────────────────────────────────────────────────

  return (
    <aside className="filter-panel">

      {/* Header */}
      <div className="fp-header">
        <span className="fp-title">Filter</span>
        {activeCount !== null && activeCount < totalCount && (
          <span className="fp-count">{activeCount} / {totalCount} pts</span>
        )}
        <div style={{ flex: 1 }} />
        <button className="fp-reset-btn" onClick={resetFilters} title="Reset all filters">
          Reset
        </button>
        <button className="fp-close-btn" onClick={() => setFilterOpen(false)} title="Close">
          ▶
        </button>
      </div>

      {/* Tab bar */}
      <div className="fp-tabs">
        {tabs.map(t => (
          <button
            key={t.key}
            className={`fp-tab-btn${activeTab === t.key ? ' active' : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'points' && (
        <FilterTab
          items={allPoints}
          getKey={pt => String(pt.PointId)}
          getLabel={pt => `${pt.PointNo}${pt.ProjectNo ? ` (${pt.ProjectNo})` : ''}`}
          getDot={pt => typeColor(pt.PointType)}
          isChecked={ptId => checkedPtIds === null || checkedPtIds.has(ptId)}
          isDimmed={ptId => groupDimmedPtIds.has(ptId)}
          onToggle={ptId => togglePt(ptId)}
          onSetExact={keys => setPtSelection(keys)}
          onSelectAll={selectAllPts}
          onDeselectAll={deselectAllPts}
        />
      )}

      {groupSystems.map(gs => activeTab === gs.id && (
        <FilterTab
          key={gs.id}
          items={gs.groups.map(g => ({ key: g.name, label: g.name, color: g.color }))}
          getKey={item => item.key}
          getLabel={item => item.label}
          getDot={item => item.color}
          isChecked={name => {
            const s = checkedGroups[gs.id]
            return s === null || s === undefined || s.has(name)
          }}
          isDimmed={name => isGroupDimmed(gs.id, name)}
          onToggle={name => toggleGroup(gs.id, name)}
          onSetExact={names => setGroupSelection(gs.id, names)}
          onSelectAll={() => selectAllGroups(gs.id)}
          onDeselectAll={() => deselectAllGroups(gs.id)}
        />
      ))}

      {showStrataFilter && activeTab === '__strata_primary__' && (
        <FilterTab
          key="__strata_primary__"
          items={strataLayers.primary.map(v => ({ key: v, label: v }))}
          getKey={item => item.key}
          getLabel={item => item.label}
          getDot={null}
          isChecked={v => checkedStrataPrimary === null || checkedStrataPrimary.has(v)}
          isDimmed={null}
          onToggle={v => toggleStrataPrimary(v)}
          onSetExact={values => setStrataSelection('primary', values)}
          onSelectAll={selectAllStrataPrimary}
          onDeselectAll={deselectAllStrataPrimary}
        />
      )}

      {showStrataFilter && activeTab === '__strata_secondary__' && (
        <FilterTab
          key="__strata_secondary__"
          items={strataLayers.secondary.map(v => ({ key: v, label: v }))}
          getKey={item => item.key}
          getLabel={item => item.label}
          getDot={null}
          isChecked={v => checkedStrataSecondary === null || checkedStrataSecondary.has(v)}
          isDimmed={null}
          onToggle={v => toggleStrataSecondary(v)}
          onSetExact={values => setStrataSelection('secondary', values)}
          onSelectAll={selectAllStrataSecondary}
          onDeselectAll={deselectAllStrataSecondary}
        />
      )}
    </aside>
  )
}
