import { useState, useMemo, useCallback } from 'react'
import { useFilter } from '../context/FilterContext'
import { useDragSelect } from '../hooks/useDragSelect'

// ── Type colours (matches MapPage / PointsPage) ───────────────────────────────

const TYPE_COLORS = { CPT: '#e67e22', BH: '#2980b9', TP: '#27ae60' }
function typeColor(t) { return TYPE_COLORS[t?.toUpperCase()] || '#7f8c8d' }

// ── Reusable scrollable list tab ──────────────────────────────────────────────

function FilterTab({ items, getKey, getLabel, getDot, isChecked, isDimmed, onToggle, onAdd, onSelectAll, onDeselectAll }) {
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

  const { rowProps: dragRowProps, tbodyStyle } = useDragSelect({
    items:    visible,
    getKey,
    onAdd,
    onToggle,
  })

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
        <button className="fp-icon-btn" onClick={onSelectAll}   title="Select all">✓</button>
        <button className="fp-icon-btn" onClick={onDeselectAll} title="Deselect all">✕</button>
      </div>

      <div className="fp-list" style={tbodyStyle}>
        {visible.map((item, idx) => {
          const key     = getKey(item)
          const checked = isChecked(key)
          const dim     = isDimmed?.(key)
          const dot     = getDot?.(item)
          return (
            <label key={key} className={`fp-item${dim ? ' fp-dim' : ''}`}
              {...dragRowProps(item, idx)}>
              <input
                type="checkbox"
                checked={checked}
                readOnly   /* controlled by drag/mousedown, not onChange */
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

  const showStrataFilter = page === 'charts' || page === 'map'

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
          onAdd={keys => keys.forEach(k => togglePt(k))}
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
          onAdd={names => names.forEach(n => toggleGroup(gs.id, n))}
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
          onAdd={keys => keys.forEach(k => toggleStrataPrimary(k))}
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
          onAdd={keys => keys.forEach(k => toggleStrataSecondary(k))}
          onSelectAll={selectAllStrataSecondary}
          onDeselectAll={deselectAllStrataSecondary}
        />
      )}
    </aside>
  )
}
