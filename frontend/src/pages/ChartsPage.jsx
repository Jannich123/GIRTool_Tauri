import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { invoke } from '../tauri-api'
import { useColumnFilters, ColumnFilterButton } from '../components/ColumnFilter'
import { useDataChanged } from '../lib/dataChanged'
import { useApp } from '../context/AppContext'
import { useFilter } from '../context/FilterContext'
import Plot from 'react-plotly.js'

// #266: charts pointing at the same query + selection share ONE
// run_chart_query result (a 100k-row sheet is fetched once, not once per
// chart — and the cached `rows` array is shared by reference, so ten charts
// hold one copy).  Promise-cached so concurrent mounts coalesce; failures
// are evicted; size-capped; cleared on refresh / datasheet changes.
const chartQueryCache = new Map() // key -> Promise<{columns, rows, truncated}>
const CHART_CACHE_MAX = 8
function cachedChartQuery(key, run) {
  let p = chartQueryCache.get(key)
  if (!p) {
    p = run()
    chartQueryCache.set(key, p)
    p.catch(() => chartQueryCache.delete(key))
    while (chartQueryCache.size > CHART_CACHE_MAX) {
      const oldest = chartQueryCache.keys().next().value
      chartQueryCache.delete(oldest)
    }
  }
  return p
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CHART_TYPES = [
  { value: 'scatter',   label: '● Scatter 2D'          },
  { value: 'line',      label: '╱ Line 2D'              },
  { value: 'mixed',     label: '∿ Mixed (Line + Scatter)' },
  { value: 'scatter3d', label: '⬡ Scatter 3D'           },
]

const PALETTE = [
  '#2980b9','#e67e22','#27ae60','#8e44ad','#c0392b',
  '#16a085','#d35400','#2c3e50','#f39c12','#1abc9c',
]

// prefix that signals a group-system reference (not a raw data column)
const GS_PREFIX     = '__gs__'
// prefix for strata layer grouping
const STRATA_PREFIX = '__strata__'

// ── Reference line helpers ────────────────────────────────────────────────────

const RL_TYPES = [
  { value: 'constant', label: 'Constant'   },
  { value: 'mean',     label: 'Mean'       },
  { value: 'median',   label: 'Median'     },
  { value: 'p10',      label: 'P10'        },
  { value: 'p25',      label: 'P25'        },
  { value: 'p75',      label: 'P75'        },
  { value: 'p90',      label: 'P90'        },
  { value: 'std+1',    label: '+1 Std Dev' },
  { value: 'std-1',    label: '-1 Std Dev' },
]

const RL_DRAFT_DEFAULT = {
  type: 'constant', axis: 'y', value: '', label: '',
  color: '#ef4444', dash: 'dash', width: 1.5,
}

/**
 * Compute the numeric position for a reference line from filtered row data.
 * Returns null when no valid values exist (line is not rendered).
 */
function computeRefLineValue(rl, filteredRows, xIdx, yIdx) {
  const idx = rl.axis === 'x' ? xIdx : yIdx
  if (idx < 0) return null
  const vals = filteredRows
    .map(r => r[idx])
    .filter(v => v != null && !isNaN(Number(v)))
    .map(Number)
  if (!vals.length) return null
  vals.sort((a, b) => a - b)
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length
  const pct  = p => vals[Math.floor(p * (vals.length - 1))]
  const std  = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length)
  return ({
    constant: Number(rl.value),
    mean,
    median:  pct(0.5),
    p10:     pct(0.1),
    p25:     pct(0.25),
    p75:     pct(0.75),
    p90:     pct(0.9),
    'std+1': mean + std,
    'std-1': mean - std,
  })[rl.type] ?? null
}

let _seq = 1

function newChart(overrides = {}) {
  return {
    id:        `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    name:      `Chart ${_seq++}`,
    queryName: '',
    chartType: 'scatter',
    xCol: '', yCol: '', zCol: '',
    xTitle: '', yTitle: '', zTitle: '',
    xLog: false, yLog: false,
    xInvert: false, yInvert: false, zInvert: false,
    xMin: '', xMax: '',
    yMin: '', yMax: '',
    groupCol:   '',
    lineBy:     '',   // column to split lines by  (line/mixed only)
    sortBy:     '',   // column to sort within line (line/mixed only)
    showStats:  true,
    markerSize: 5,
    lineWidth:  1.5,
    refLines:    [],  // array of reference line objects
    statsAxis:   'x', // persisted axis preference for the statistics table (defaults to X)
    boundaryIds: [],  // array of boundary IDs to overlay on the chart
    hoverCols:   [],  // extra columns to show in hover tooltip (2D only)
    // runtime only (not persisted)
    columns: [], rows: [], truncated: false, loading: false, error: '',
    ...overrides,
  }
}

function autoAxes(columns) {
  const lower    = columns.map(c => c.toLowerCase())
  const depthIdx = lower.findIndex(c => c === 'depth')
  const levelIdx = lower.findIndex(c => c === 'level')
  const pnoIdx   = lower.findIndex(c => c === 'pointno')
  const hasDepth = depthIdx > -1, hasLevel = levelIdx > -1
  const yIdx = hasDepth ? depthIdx : (hasLevel ? levelIdx : Math.min(1, columns.length - 1))
  const xIdx = (hasDepth || hasLevel) ? Math.min(2, columns.length - 1) : 0
  return {
    yCol:     columns[yIdx]    ?? '',
    xCol:     columns[xIdx]    ?? '',
    groupCol: pnoIdx > -1 ? columns[pnoIdx] : '',
    yInvert:  hasDepth || hasLevel,
  }
}

// ── Collapsible section ───────────────────────────────────────────────────────

function Section({ label, isOpen, onToggle, children }) {
  return (
    <div className="axis-section">
      <button className="axis-section-hdr" onClick={onToggle}>
        <span className={`axis-section-arrow${isOpen ? ' open' : ''}`}>▶</span>
        {label}
      </button>
      {isOpen && <div className="axis-section-body">{children}</div>}
    </div>
  )
}

// ── Axis settings panel ───────────────────────────────────────────────────────

function AxisSettings({ chart, queries, groupSystems, onUpdate, onLoad }) {
  const { columns, rows, xCol, yCol, zCol, groupCol, chartType } = chart
  const is3d = chartType === 'scatter3d'
  const { strataLayers } = useFilter()
  const { boundaries, colDict } = useApp()

  // Build a display label for a column: "ABBREV — Full Name (unit)" or just "ABBREV"
  const colOption = col => {
    const d = colDict[col]
    if (!d) return col
    return `${col} — ${d.fullName ?? col}${d.unit ? ` (${d.unit})` : ''}`
  }

  // Auto-title when a column is selected: "Full Name [unit]" or raw col name
  const autoTitle = col => {
    const d = colDict[col]
    return d?.fullName ? `${d.fullName}${d.unit ? ` [${d.unit}]` : ''}` : col
  }

  const [open, setOpen] = useState({ data: false, xAxis: false, yAxis: false, zAxis: false, display: false, lines: false, refLines: false, boundaries: false, hoverCols: false })
  const toggle = key => setOpen(o => ({ ...o, [key]: !o[key] }))

  // Reference lines add/edit form state
  const [addingLine, setAddingLine] = useState(false)
  const [editingId,  setEditingId]  = useState(null)
  const [lineDraft,  setLineDraft]  = useState(RL_DRAFT_DEFAULT)

  const missingQuery = chart.queryName && !queries.find(q => q.fname === chart.queryName)
  const missingX     = xCol && columns.length > 0 && !columns.includes(xCol)
  const missingY     = yCol && columns.length > 0 && !columns.includes(yCol)
  const isGSGroup    = groupCol?.startsWith(GS_PREFIX)
  const missingGS    = isGSGroup && !groupSystems.find(gs => gs.id === groupCol.slice(GS_PREFIX.length))
  const hasStrataLayers = (strataLayers.primary.length > 0 || strataLayers.secondary.length > 0)

  const numFmt = v => v.toLocaleString()

  return (
    <>
      {/* ── Data ── */}
      <Section label="Data" isOpen={open.data} onToggle={() => toggle('data')}>
        <label>Source query</label>
        <select value={chart.queryName} onChange={e => onUpdate({ queryName: e.target.value })}>
          <option value="">— select —</option>
          {queries.map(q => <option key={q.fname} value={q.fname}>{q.fname}</option>)}
        </select>
        {missingQuery && <span className="axis-hint warn">⚠ Query not found</span>}

        <label style={{ marginTop: '.4rem' }}>Chart type</label>
        <select value={chartType} onChange={e => onUpdate({ chartType: e.target.value })}>
          {CHART_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>

        <button
          className="btn-primary btn-sm"
          style={{ marginTop: '.6rem' }}
          onClick={onLoad}
          disabled={chart.loading || !chart.queryName}
        >
          {chart.loading ? '⏳ Loading…' : columns.length > 0 ? '↺ Refresh data' : '▶ Load data'}
        </button>

        {chart.truncated && <span className="axis-hint warn">⚠ First 100 000 rows shown</span>}
        {chart.error     && <span className="axis-hint err">{chart.error}</span>}
        {rows.length > 0 && (
          <span className="axis-hint muted">{numFmt(rows.length)} rows loaded</span>
        )}
      </Section>

      {/* ── X Axis ── */}
      <Section label="X Axis" isOpen={open.xAxis} onToggle={() => toggle('xAxis')}>
        <label>Column</label>
        <select value={xCol} onChange={e => {
          const col = e.target.value
          onUpdate({ xCol: col, xTitle: col ? autoTitle(col) : '' })
        }}>
          <option value="">— none —</option>
          {columns.map(c => <option key={c} value={c} title={colDict[c]?.description ?? ''}>{colOption(c)}</option>)}
        </select>
        {missingX && <span className="axis-hint warn">⚠ Column not available</span>}

        <label>Axis title</label>
        <input type="text" value={chart.xTitle}
               onChange={e => onUpdate({ xTitle: e.target.value })}
               placeholder={xCol || 'auto'} />

        <label className="checkbox-row" style={{ marginTop: '.4rem' }}>
          <input type="checkbox" checked={chart.xLog}
                 onChange={e => onUpdate({ xLog: e.target.checked })} />
          Logarithmic scale
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={chart.xInvert}
                 onChange={e => onUpdate({ xInvert: e.target.checked })} />
          Invert axis
        </label>

        <div className="axis-range-row">
          <div className="range-field">
            <label>Min</label>
            <input type="number" value={chart.xMin}
                   onChange={e => onUpdate({ xMin: e.target.value })} placeholder="auto" />
          </div>
          <div className="range-field">
            <label>Max</label>
            <input type="number" value={chart.xMax}
                   onChange={e => onUpdate({ xMax: e.target.value })} placeholder="auto" />
          </div>
        </div>
      </Section>

      {/* ── Y Axis ── */}
      <Section label="Y Axis" isOpen={open.yAxis} onToggle={() => toggle('yAxis')}>
        <label>Column</label>
        <select value={yCol} onChange={e => {
          const col = e.target.value
          onUpdate({ yCol: col, yTitle: col ? autoTitle(col) : '' })
        }}>
          <option value="">— none —</option>
          {columns.map(c => <option key={c} value={c} title={colDict[c]?.description ?? ''}>{colOption(c)}</option>)}
        </select>
        {missingY && <span className="axis-hint warn">⚠ Column not available</span>}

        <label>Axis title</label>
        <input type="text" value={chart.yTitle}
               onChange={e => onUpdate({ yTitle: e.target.value })}
               placeholder={yCol || 'auto'} />

        <label className="checkbox-row" style={{ marginTop: '.4rem' }}>
          <input type="checkbox" checked={chart.yLog}
                 onChange={e => onUpdate({ yLog: e.target.checked })} />
          Logarithmic scale
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={chart.yInvert}
                 onChange={e => onUpdate({ yInvert: e.target.checked })} />
          Invert axis (depth)
        </label>

        <div className="axis-range-row">
          <div className="range-field">
            <label>Min</label>
            <input type="number" value={chart.yMin}
                   onChange={e => onUpdate({ yMin: e.target.value })} placeholder="auto" />
          </div>
          <div className="range-field">
            <label>Max</label>
            <input type="number" value={chart.yMax}
                   onChange={e => onUpdate({ yMax: e.target.value })} placeholder="auto" />
          </div>
        </div>
      </Section>

      {/* ── Z Axis (3D only) ── */}
      {is3d && (
        <Section label="Z Axis" isOpen={open.zAxis} onToggle={() => toggle('zAxis')}>
          <label>Column</label>
          <select value={zCol} onChange={e => {
            const col = e.target.value
            onUpdate({ zCol: col, zTitle: col ? autoTitle(col) : '' })
          }}>
            <option value="">— none —</option>
            {columns.map(c => <option key={c} value={c} title={colDict[c]?.description ?? ''}>{colOption(c)}</option>)}
          </select>

          <label>Axis title</label>
          <input type="text" value={chart.zTitle}
                 onChange={e => onUpdate({ zTitle: e.target.value })}
                 placeholder={zCol || 'auto'} />

          <label className="checkbox-row" style={{ marginTop: '.4rem' }}>
            <input type="checkbox" checked={chart.zInvert}
                   onChange={e => onUpdate({ zInvert: e.target.checked })} />
            Invert axis
          </label>
        </Section>
      )}

      {/* ── Display ── */}
      <Section label="Display" isOpen={open.display} onToggle={() => toggle('display')}>
        <label>Group / colour by</label>
        <select value={groupCol} onChange={e => onUpdate({ groupCol: e.target.value })}>
          <option value="">— none —</option>
          {columns.length > 0 && (
            <optgroup label="Columns">
              {columns.map(c => <option key={c} value={c}>{c}</option>)}
            </optgroup>
          )}
          {groupSystems.length > 0 && (
            <optgroup label="Group Systems">
              {groupSystems.map(gs => (
                <option key={gs.id} value={`${GS_PREFIX}${gs.id}`}>🏷 {gs.name}</option>
              ))}
            </optgroup>
          )}
          {hasStrataLayers && (
            <optgroup label="Strata Layers">
              {strataLayers.primary.length   > 0 && <option value={`${STRATA_PREFIX}primary`}>🪨 Primary Layer</option>}
              {strataLayers.secondary.length > 0 && <option value={`${STRATA_PREFIX}secondary`}>🪨 Secondary Layer</option>}
            </optgroup>
          )}
        </select>
        {missingGS && <span className="axis-hint warn">⚠ Group system not found</span>}

        <label style={{ marginTop: '.4rem' }}>
          Marker size&nbsp;<span style={{ fontWeight: 400 }}>({chart.markerSize}px)</span>
        </label>
        <input type="range" min="2" max="20" step="1"
               value={chart.markerSize}
               onChange={e => onUpdate({ markerSize: Number(e.target.value) })} />

        {(chartType === 'line' || chartType === 'mixed') && (
          <>
            <label>
              Line width&nbsp;<span style={{ fontWeight: 400 }}>({chart.lineWidth}px)</span>
            </label>
            <input type="range" min="0.5" max="6" step="0.5"
                   value={chart.lineWidth}
                   onChange={e => onUpdate({ lineWidth: Number(e.target.value) })} />
          </>
        )}
      </Section>

      {/* ── Lines (line/mixed only) ── */}
      {(chartType === 'line' || chartType === 'mixed') && (
        <Section label="Lines" isOpen={open.lines} onToggle={() => toggle('lines')}>
          <label>Split lines by</label>
          <select value={chart.lineBy} onChange={e => onUpdate({ lineBy: e.target.value })}>
            <option value="">— none (one line per colour group) —</option>
            {columns.map(c => <option key={c} value={c}>{c}</option>)}
          </select>

          <label style={{ marginTop: '.4rem' }}>Sort data within each line by</label>
          <select value={chart.sortBy} onChange={e => onUpdate({ sortBy: e.target.value })}>
            <option value="">— unsorted (data order) —</option>
            {columns.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </Section>
      )}

      {/* ── Reference Lines ── */}
      {!is3d && (
        <Section label="Reference Lines" isOpen={open.refLines} onToggle={() => toggle('refLines')}>
          {/* List of existing lines */}
          {(chart.refLines ?? []).length > 0 && (
            <div className="ref-line-list">
              {(chart.refLines ?? []).map(rl => {
                const hidden = rl.visible === false
                const typeLabel = rl.type === 'constant'
                  ? `${rl.axis.toUpperCase()} = ${rl.value}`
                  : `${rl.type} ${rl.axis.toUpperCase()}`
                return (
                  <div key={rl.id} className="ref-line-row">
                    <div
                      className="ref-line-swatch"
                      style={{
                        background: rl.color,
                        opacity: hidden ? 0.3 : 1,
                        borderTop: `2.5px ${rl.dash === 'solid' ? 'solid' : rl.dash === 'dot' ? 'dotted' : 'dashed'} ${rl.color}`,
                      }}
                    />
                    <span style={{ flex: 1, opacity: hidden ? 0.4 : 1, fontSize: 11 }}>
                      {rl.label || <em className="axis-hint muted">no label</em>}
                    </span>
                    <span className="axis-hint muted" style={{ fontSize: 10 }}>{typeLabel}</span>
                    <button
                      className="btn-icon btn-sm"
                      title={hidden ? 'Show' : 'Hide'}
                      onClick={() => {
                        const updated = (chart.refLines ?? []).map(r =>
                          r.id === rl.id ? { ...r, visible: hidden } : r
                        )
                        onUpdate({ refLines: updated })
                      }}
                    >{hidden ? '○' : '●'}</button>
                    <button
                      className="btn-icon btn-sm"
                      title="Edit"
                      onClick={() => {
                        setEditingId(rl.id)
                        setLineDraft({
                          type:  rl.type,  axis:  rl.axis,
                          value: rl.value ?? '', label: rl.label ?? '',
                          color: rl.color, dash: rl.dash, width: rl.width,
                        })
                        setAddingLine(true)
                      }}
                    >✎</button>
                    <button
                      className="btn-icon btn-sm"
                      style={{ color: '#991b1b' }}
                      title="Delete"
                      onClick={() =>
                        onUpdate({ refLines: (chart.refLines ?? []).filter(r => r.id !== rl.id) })
                      }
                    >✕</button>
                  </div>
                )
              })}
            </div>
          )}

          {/* Add / edit inline form */}
          {addingLine ? (
            <div className="ref-line-form">
              <label>Type</label>
              <select value={lineDraft.type}
                onChange={e => setLineDraft(d => ({ ...d, type: e.target.value }))}>
                {RL_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>

              <label>Axis</label>
              <div style={{ display: 'flex', gap: 4 }}>
                {['y', 'x'].map(a => (
                  <button key={a}
                    className={`btn-sm ${lineDraft.axis === a ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setLineDraft(d => ({ ...d, axis: a }))}
                  >{a.toUpperCase()}</button>
                ))}
              </div>

              {lineDraft.type === 'constant' && (
                <>
                  <label>Value</label>
                  <input type="number" value={lineDraft.value}
                    onChange={e => setLineDraft(d => ({ ...d, value: e.target.value }))} />
                </>
              )}

              <label>Label <span className="axis-hint muted">(optional)</span></label>
              <input type="text" value={lineDraft.label} placeholder="e.g. Upper limit"
                onChange={e => setLineDraft(d => ({ ...d, label: e.target.value }))} />

              <label>Colour</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="color" value={lineDraft.color}
                  onChange={e => setLineDraft(d => ({ ...d, color: e.target.value }))}
                  style={{ width: 36, height: 24, padding: 0, border: 'none', cursor: 'pointer' }} />
                <span className="axis-hint muted" style={{ fontSize: 10 }}>{lineDraft.color}</span>
              </div>

              <label>Dash</label>
              <div style={{ display: 'flex', gap: 4 }}>
                {[['solid', 'Solid'], ['dash', 'Dashed'], ['dot', 'Dotted']].map(([val, lbl]) => (
                  <button key={val}
                    className={`btn-sm ${lineDraft.dash === val ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setLineDraft(d => ({ ...d, dash: val }))}
                  >{lbl}</button>
                ))}
              </div>

              <label>Width</label>
              <input type="number" min="0.5" max="4" step="0.5" value={lineDraft.width}
                onChange={e => setLineDraft(d => ({ ...d, width: Number(e.target.value) }))} />

              <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                <button className="btn-primary btn-sm" onClick={() => {
                  const newRl = {
                    id:      editingId ?? `rl_${Date.now()}`,
                    type:    lineDraft.type,
                    axis:    lineDraft.axis,
                    value:   lineDraft.type === 'constant' ? Number(lineDraft.value) : undefined,
                    label:   lineDraft.label,
                    color:   lineDraft.color,
                    dash:    lineDraft.dash,
                    width:   lineDraft.width,
                    visible: true,
                  }
                  const current = chart.refLines ?? []
                  const updated = editingId
                    ? current.map(r => r.id === editingId ? newRl : r)
                    : [...current, newRl]
                  onUpdate({ refLines: updated })
                  setAddingLine(false); setEditingId(null); setLineDraft(RL_DRAFT_DEFAULT)
                }}>{editingId ? 'Save' : 'Add'}</button>
                <button className="btn-secondary btn-sm" onClick={() => {
                  setAddingLine(false); setEditingId(null); setLineDraft(RL_DRAFT_DEFAULT)
                }}>Cancel</button>
              </div>
            </div>
          ) : (
            <button
              className="btn-secondary btn-sm"
              style={{ marginTop: (chart.refLines ?? []).length > 0 ? 4 : 0 }}
              onClick={() => { setLineDraft(RL_DRAFT_DEFAULT); setAddingLine(true) }}
            >＋ Add Line</button>
          )}

          {(chart.refLines ?? []).length === 0 && !addingLine && (
            <p className="axis-hint muted" style={{ marginTop: 4 }}>No reference lines yet.</p>
          )}
        </Section>
      )}

      {/* ── Boundaries (2D only) ── */}
      {!is3d && boundaries.length > 0 && (
        <Section label="Boundaries" isOpen={open.boundaries} onToggle={() => toggle('boundaries')}>
          {boundaries.map(b => {
            const checked = (chart.boundaryIds ?? []).includes(b.id)
            return (
              <label key={b.id} className="checkbox-row" style={{ alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={e => {
                    const ids = chart.boundaryIds ?? []
                    onUpdate({
                      boundaryIds: e.target.checked
                        ? [...ids, b.id]
                        : ids.filter(id => id !== b.id)
                    })
                  }}
                />
                <span
                  style={{
                    display: 'inline-block', width: 22, height: 3,
                    background: b.color,
                    borderRadius: 2,
                    borderTop: `2.5px ${b.dash === 'solid' ? 'solid' : b.dash === 'dot' ? 'dotted' : 'dashed'} ${b.color}`,
                    flexShrink: 0,
                  }}
                />
                {b.name}
                <span className="axis-hint muted" style={{ fontSize: 10 }}>{b.points.length}pt</span>
              </label>
            )
          })}
          {boundaries.length === 0 && (
            <p className="axis-hint muted">No boundaries defined yet.</p>
          )}
        </Section>
      )}

      {/* ── Hover Columns (2D only) ── */}
      {!is3d && (
        <Section label="Hover Columns" isOpen={open.hoverCols} onToggle={() => toggle('hoverCols')}>
          {/* Always-on defaults */}
          <div className="hover-defaults-row">
            {columns.findIndex(c => /^point_?no$/i.test(c)) >= 0 && (
              <span className="hover-default-chip">🔒 PointNo</span>
            )}
            <span className="hover-default-chip">🔒 {chart.xTitle || xCol || 'X'}</span>
            <span className="hover-default-chip">🔒 {chart.yTitle || yCol || 'Y'}</span>
          </div>

          {/* Extra column chips */}
          {(chart.hoverCols ?? []).length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, marginBottom: 4 }}>
              {(chart.hoverCols ?? []).map(col => (
                <span key={col} className="hover-col-chip">
                  {col}
                  <button
                    onClick={() => onUpdate({ hoverCols: chart.hoverCols.filter(c => c !== col) })}
                    title={`Remove ${col}`}
                  >×</button>
                </span>
              ))}
            </div>
          )}

          {/* Add column dropdown */}
          {(() => {
            const available = (columns ?? []).filter(
              c => c !== xCol && c !== yCol && !/^point_?no$/i.test(c) &&
                   !(chart.hoverCols ?? []).includes(c)
            )
            return available.length > 0 ? (
              <select
                value=""
                onChange={e => {
                  if (!e.target.value) return
                  const next = [...new Set([...(chart.hoverCols ?? []), e.target.value])]
                  onUpdate({ hoverCols: next })
                }}
              >
                <option value="">＋ Add column…</option>
                {available.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : (
              <p className="axis-hint muted" style={{ marginTop: 2 }}>
                {(chart.hoverCols ?? []).length > 0
                  ? 'All available columns added.'
                  : 'No extra columns available.'}
              </p>
            )
          })()}
        </Section>
      )}

      {/* ── Statistics toggle ── */}
      <label
        className="checkbox-row"
        style={{ borderTop: '1px solid var(--border)', marginTop: '.6rem', paddingTop: '.6rem' }}
      >
        <input
          type="checkbox"
          checked={chart.showStats !== false}
          onChange={e => onUpdate({ showStats: e.target.checked })}
        />
        Show statistics table
      </label>
    </>
  )
}

// ── Group-key helper (pure — shared by ChartPlot traces & StatsTable) ────────

/**
 * Return the group-key string for a single data row, replicating the same
 * bucketing logic used inside ChartPlot's trace builder.
 *
 * @param {object} chart          – chart config (groupCol, etc.)
 * @param {Array}  row            – one raw data row (parallel to `columns`)
 * @param {Array}  columns        – column-name array
 * @param {object} groupAssignments – { pointId: { systemId: groupName } }
 */
function buildGroupKey(chart, row, columns, groupAssignments) {
  const { groupCol } = chart
  const isGS     = groupCol?.startsWith(GS_PREFIX)
  const isStrata = groupCol?.startsWith(STRATA_PREFIX)

  if (isGS) {
    const gsId   = groupCol.slice(GS_PREFIX.length)
    const pidIdx = columns.findIndex(c => c.toLowerCase() === 'pointid')
    if (pidIdx >= 0)
      return groupAssignments?.[String(row[pidIdx])]?.[gsId] || 'Unknown'
    return 'Unknown'
  }

  if (isStrata) {
    const strataType   = groupCol.slice(STRATA_PREFIX.length)   // 'primary'|'secondary'
    const layerColName = strataType === 'primary' ? 'Primary Layer' : 'Secondary Layer'
    const layColIdx    = columns.findIndex(c => c === layerColName)
    return layColIdx >= 0 ? (row[layColIdx] || 'Unknown') : '__all__'
  }

  const gIdx = groupCol ? columns.indexOf(groupCol) : -1
  return gIdx >= 0 ? String(row[gIdx] ?? '—') : '__all__'
}

// ── Statistics helpers ────────────────────────────────────────────────────────

/**
 * Compute per-group statistics for `axisCol` over the filtered rows.
 *
 * @param {object} chart
 * @param {string} axisCol            – column name to summarise (e.g. chart.yCol)
 * @param {Set|null} filteredPtIds
 * @param {Set|null} checkedStrataPrimary
 * @param {Set|null} checkedStrataSecondary
 * @param {object} groupAssignments
 * @returns {{ groups: Array, totalCount: number }}
 */
function computeStats(chart, axisCol, filteredPtIds, checkedStrataPrimary, checkedStrataSecondary, groupAssignments) {
  const { columns, rows } = chart
  if (!rows.length || !columns.length || !axisCol) return { groups: [], totalCount: 0 }

  const pidIdx    = columns.findIndex(c => c.toLowerCase() === 'pointid')
  const priLayIdx = columns.findIndex(c => c === 'Primary Layer')
  const secLayIdx = columns.findIndex(c => c === 'Secondary Layer')
  const axisIdx   = columns.indexOf(axisCol)
  if (axisIdx < 0) return { groups: [], totalCount: 0 }

  // Apply same row filters as ChartPlot
  const activeRows = rows.filter(row => {
    if (filteredPtIds          !== null && pidIdx    >= 0 && !filteredPtIds.has(String(row[pidIdx])))                          return false
    if (checkedStrataPrimary   !== null && priLayIdx >= 0 && !checkedStrataPrimary.has(row[priLayIdx] || 'Unknown'))   return false
    if (checkedStrataSecondary !== null && secLayIdx >= 0 && !checkedStrataSecondary.has(row[secLayIdx] || 'Unknown')) return false
    return true
  })

  // Bucket numeric axis values by group key, preserving encounter order
  const buckets = {}
  const order   = []
  for (const row of activeRows) {
    const key = buildGroupKey(chart, row, columns, groupAssignments)
    if (!buckets[key]) { buckets[key] = []; order.push(key) }
    const v = row[axisIdx]
    if (v !== null && v !== undefined && v !== '' && !Number.isNaN(Number(v)))
      buckets[key].push(Number(v))
  }

  const pct = (vals, p) => {
    const pos = p * (vals.length - 1)
    const lo = Math.floor(pos), hi = Math.ceil(pos)
    return lo === hi ? vals[lo] : vals[lo] + (vals[hi] - vals[lo]) * (pos - lo)
  }

  const groups = order.map(key => {
    const vals = buckets[key]
    if (!vals.length) return null
    vals.sort((a, b) => a - b)
    const n        = vals.length
    const mean     = vals.reduce((a, b) => a + b, 0) / n
    const variance = n > 1 ? vals.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1) : 0
    return {
      group: key, n,
      min: vals[0], max: vals[n - 1], mean, std: Math.sqrt(variance),
      median: pct(vals, 0.5), p10: pct(vals, 0.1), p90: pct(vals, 0.9),
    }
  }).filter(Boolean)

  return { groups, totalCount: activeRows.length }
}

// ── Statistics table ──────────────────────────────────────────────────────────

function StatsTable({ chart, statsAutoStatus, statsAxis, onAxisChange, onOpenExcel, hasOutputFolder }) {
  const { filteredPtIds, checkedStrataPrimary, checkedStrataSecondary, groupAssignments } = useFilter()
  const { xCol, yCol, zCol, chartType, rows } = chart
  const is3d  = chartType === 'scatter3d'
  const showZ = is3d && zCol

  const [openingExcel, setOpeningExcel] = useState(false)
  const [openExcelMsg, setOpenExcelMsg] = useState('')

  const handleOpenExcel = async () => {
    if (!hasOutputFolder) { setOpenExcelMsg('No output folder configured'); setTimeout(() => setOpenExcelMsg(''), 3000); return }
    setOpeningExcel(true); setOpenExcelMsg('')
    try {
      await onOpenExcel?.()
      setOpenExcelMsg('Opened ✓')
    } catch {
      setOpenExcelMsg('Error opening file')
    } finally {
      setOpeningExcel(false)
      setTimeout(() => setOpenExcelMsg(''), 3000)
    }
  }

  const axis     = statsAxis ?? 'y'
  const axisCol   = axis === 'x' ? xCol : axis === 'z' ? zCol : yCol
  const axisLabel = axis === 'x' ? 'X axis' : axis === 'z' ? 'Z axis' : 'Y axis'

  const { groups, totalCount } = useMemo(
    () => computeStats(chart, axisCol, filteredPtIds, checkedStrataPrimary, checkedStrataSecondary, groupAssignments),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chart.columns, chart.rows, chart.groupCol, axisCol,
     filteredPtIds, checkedStrataPrimary, checkedStrataSecondary, groupAssignments]
  )

  // #248: Excel-style filter on the Group column (hook must run before the
  // early return below — hooks are unconditional).
  const { filters: statColFilters, setColFilter: setStatColFilter, filteredItems: groupsFiltered } =
    useColumnFilters(groups)

  // Hide entirely when no data passes the filters or all groups have no numeric values
  if (!rows.length || groups.length === 0) return null

  const fmt = (v, dp = 3) => v == null ? '—' : Number(v.toFixed(dp)).toLocaleString(undefined, { maximumFractionDigits: dp })

  return (
    <div className="stats-table-wrap">
      <div className="stats-table-header">
        <div className="stats-axis-selector">
          {['x', 'y', ...(showZ ? ['z'] : [])].map(a => (
            <button
              key={a}
              className={`stats-axis-btn${axis === a ? ' active' : ''}`}
              onClick={() => onAxisChange?.(a)}
            >{a.toUpperCase()}</button>
          ))}
        </div>
        <span className="stats-table-title">
          Statistics — {axisLabel}{axisCol ? ` (${axisCol})` : ''} · {totalCount.toLocaleString()} row{totalCount !== 1 ? 's' : ''}
        </span>
        {statsAutoStatus !== 'idle' && (
          <span className={`stats-autostatus stats-autostatus--${statsAutoStatus}`}>
            {statsAutoStatus === 'saving' && '📊 Saving stats…'}
            {statsAutoStatus === 'saved'  && '📊 Stats saved'}
            {statsAutoStatus === 'error'  && '📊 Stats error'}
          </span>
        )}
        {openExcelMsg && (
          <span className={`stats-autostatus stats-autostatus--${openExcelMsg.startsWith('Error') || openExcelMsg.startsWith('No') ? 'error' : 'saved'}`}>
            {openExcelMsg}
          </span>
        )}
        <button
          className="stats-open-excel-btn"
          onClick={handleOpenExcel}
          disabled={openingExcel}
          title={hasOutputFolder ? 'Save & open statistics.xlsx in Excel' : 'Configure an output folder in Settings first'}
        >
          {openingExcel ? '…' : '📂 Open in Excel'}
        </button>
      </div>

      <table className="stats-table">
        <thead>
          <tr>{['Group','N','Min','Max','Mean','Std Dev','Median','P10','P90'].map(h =>
            <th key={h}>
              {h}
              {h === 'Group' && (
                <ColumnFilterButton col="group" label="Group" items={groups}
                                    filters={statColFilters} setColFilter={setStatColFilter} />
              )}
            </th>)}
          </tr>
        </thead>
        <tbody>
          {groupsFiltered.map(s => (
            <tr key={s.group}>
              <td>{s.group === '__all__' ? 'All' : s.group}</td>
              <td>{s.n.toLocaleString()}</td>
              <td>{fmt(s.min)}</td>
              <td>{fmt(s.max)}</td>
              <td>{fmt(s.mean)}</td>
              <td>{fmt(s.std)}</td>
              <td>{fmt(s.median)}</td>
              <td>{fmt(s.p10)}</td>
              <td>{fmt(s.p90)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Chart plot ────────────────────────────────────────────────────────────────

function ChartPlot({ chart }) {
  const { columns, rows, xCol, yCol, zCol, groupCol, chartType } = chart
  const is3d = chartType === 'scatter3d'
  const { filteredPtIds, groupSystems, groupAssignments, checkedStrataPrimary, checkedStrataSecondary } = useFilter()
  const { typeStyles, strataLayerColors, boundaries, colDict } = useApp()

  // Full label for a column: "Full Name (unit)" if known, else raw name
  const colLabel = col => {
    const d = colDict[col]
    return d?.fullName ? `${d.fullName}${d.unit ? ` (${d.unit})` : ''}` : col
  }

  // Notify Plotly whenever the wrapper div changes size (e.g. stats panel toggle)
  const plotWrapRef = useRef(null)
  useEffect(() => {
    const el = plotWrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => window.dispatchEvent(new Event('resize')))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Filtered rows shared with reference line computation (depends on filter state)
  const filteredRowsForRefLines = useMemo(() => {
    if (!rows.length) return []
    const pidIdx    = columns.findIndex(c => c.toLowerCase() === 'pointid')
    const priLayIdx = columns.findIndex(c => c === 'Primary Layer')
    const secLayIdx = columns.findIndex(c => c === 'Secondary Layer')
    return rows.filter(row => {
      if (filteredPtIds          !== null && pidIdx    >= 0 && !filteredPtIds.has(String(row[pidIdx])))            return false
      if (checkedStrataPrimary   !== null && priLayIdx >= 0 && !checkedStrataPrimary.has(row[priLayIdx] || 'Unknown'))   return false
      if (checkedStrataSecondary !== null && secLayIdx >= 0 && !checkedStrataSecondary.has(row[secLayIdx] || 'Unknown')) return false
      return true
    })
  }, [rows, columns, filteredPtIds, checkedStrataPrimary, checkedStrataSecondary])

  const traces = useMemo(() => {
    if (!rows.length || !xCol || !yCol) return []

    // Apply cross-chart point filter
    const pidIdx     = columns.findIndex(c => c.toLowerCase() === 'pointid')
    // Strata layer row filters
    const priLayIdx  = columns.findIndex(c => c === 'Primary Layer')
    const secLayIdx  = columns.findIndex(c => c === 'Secondary Layer')

    const activeRows = rows.filter(row => {
      if (filteredPtIds !== null && pidIdx >= 0 && !filteredPtIds.has(String(row[pidIdx]))) return false
      if (checkedStrataPrimary   !== null && priLayIdx >= 0 &&
          !checkedStrataPrimary.has(row[priLayIdx] || 'Unknown')) return false
      if (checkedStrataSecondary !== null && secLayIdx  >= 0 &&
          !checkedStrataSecondary.has(row[secLayIdx] || 'Unknown')) return false
      return true
    })
    const xIdx = columns.indexOf(xCol)
    const yIdx = columns.indexOf(yCol)
    const zIdx = columns.indexOf(zCol)
    if (xIdx < 0 || yIdx < 0) return []

    // ── Hover tooltip helpers (2D only) ───────────────────────────────────────
    const ptNoIdx   = columns.findIndex(c => /^point_?no$/i.test(c))
    const hoverCols = chart.hoverCols ?? []
    const hoverIdxs = hoverCols.map(col => columns.indexOf(col)).filter(i => i >= 0)

    const htLines = [
      `<b>${colLabel(xCol)}:</b> %{x}`,
      `<b>${colLabel(yCol)}:</b> %{y}`,
    ]
    if (ptNoIdx >= 0) htLines.push('<b>PointNo:</b> %{customdata[0]}')
    hoverCols.forEach((col, i) => htLines.push(`<b>${col}:</b> %{customdata[${i + 1}]}`))
    htLines.push('<extra></extra>')
    const hovertemplate = htLines.join('<br>')

    function rowCustomdata(row) {
      return [ptNoIdx >= 0 ? row[ptNoIdx] : null, ...hoverIdxs.map(i => row[i])]
    }

    // ── Determine grouping strategy ───────────────────────────────────────────
    let getKey, getStyle
    const isGS     = groupCol?.startsWith(GS_PREFIX)
    const isStrata = groupCol?.startsWith(STRATA_PREFIX)
    let   gsRef    = null   // the group system definition (when isGS)

    if (isGS) {
      const gsId = groupCol.slice(GS_PREFIX.length)
      gsRef      = groupSystems?.find(g => g.id === gsId) ?? null
      const pidIdx2 = columns.findIndex(c => c.toLowerCase() === 'pointid')

      if (gsRef && pidIdx2 >= 0) {
        const byName = {}
        gsRef.groups.forEach(g => { byName[g.name] = g })

        getKey   = row => groupAssignments?.[String(row[pidIdx2])]?.[gsId] || 'Unknown'
        getStyle = name => byName[name] ?? null
      }
    } else if (isStrata) {
      const strataType   = groupCol.slice(STRATA_PREFIX.length)   // 'primary' | 'secondary'
      const layerColName = strataType === 'primary' ? 'Primary Layer' : 'Secondary Layer'
      const layColIdx    = columns.findIndex(c => c === layerColName)
      const styleMap     = strataLayerColors?.[strataType] ?? {}   // { layerName: StyleObj }
      const DEFAULT_LAYER_COLORS = [
        '#3b82f6','#ef4444','#22c55e','#f59e0b','#8b5cf6',
        '#06b6d4','#f97316','#ec4899','#84cc16','#6366f1',
      ]
      // Assign default palette colours to values that have no saved style yet
      const uniqueVals = [...new Set(activeRows.map(r => r[layColIdx] || 'Unknown'))]
      const paletteMap = {}
      uniqueVals.forEach((v, i) => { paletteMap[v] = DEFAULT_LAYER_COLORS[i % DEFAULT_LAYER_COLORS.length] })

      getKey = row => layColIdx >= 0 ? (row[layColIdx] || 'Unknown') : '__all__'
      // Return a full style object — same shape as a group-system group definition
      getStyle = name => {
        const s = styleMap[name] || {}
        return {
          color:         s.color         ?? paletteMap[name] ?? PALETTE[0],
          symbol:        s.symbol        ?? 'circle',
          markerSize:    s.markerSize    ?? chart.markerSize,
          lineType:      s.lineType      ?? 'solid',
          lineThickness: s.lineThickness ?? chart.lineWidth,
        }
      }
    }

    if (!getKey) {
      const gIdx = groupCol && !isGS && !isStrata ? columns.indexOf(groupCol) : -1
      getKey = row => gIdx >= 0 ? String(row[gIdx] ?? '—') : '__all__'
      // Look up group key in typeStyles (handles PointType grouping automatically).
      // Falls back to null so the palette is used for unrecognised values.
      getStyle = name => typeStyles?.[name.toUpperCase()] ?? null
    }

    // ── Line / mixed: two-level bucketing (colorKey → lineKey → sorted pts) ───
    const isLineLike = chartType === 'line' || chartType === 'mixed'
    const lineByIdx  = isLineLike && chart.lineBy ? columns.indexOf(chart.lineBy) : -1
    const sortByIdx  = isLineLike && chart.sortBy ? columns.indexOf(chart.sortBy) : -1

    if (isLineLike) {
      // colorKey → { lineKey → [{x, y, sortVal}] }
      const colorGroups = {}
      for (const row of activeRows) {
        const colorKey = getKey(row)
        const lineKey  = lineByIdx >= 0 ? String(row[lineByIdx] ?? '') : '__single__'
        const xv = row[xIdx], yv = row[yIdx]
        if (xv === null || xv === '' || yv === null || yv === '') continue
        if (!colorGroups[colorKey])           colorGroups[colorKey] = {}
        if (!colorGroups[colorKey][lineKey])  colorGroups[colorKey][lineKey] = []
        colorGroups[colorKey][lineKey].push({
          x: xv, y: yv,
          sortVal: sortByIdx >= 0 ? row[sortByIdx] : null,
          row,
        })
      }

      // Sort within each line
      if (sortByIdx >= 0) {
        for (const lineMap of Object.values(colorGroups)) {
          for (const pts of Object.values(lineMap)) {
            pts.sort((a, b) => {
              const av = a.sortVal, bv = b.sortVal
              if (av === null || av === undefined) return 1
              if (bv === null || bv === undefined) return -1
              return typeof av === 'number' && typeof bv === 'number'
                ? av - bv
                : String(av).localeCompare(String(bv))
            })
          }
        }
      }

      // Draw-order sort (same gsRef logic as scatter path)
      let colorEntries = Object.entries(colorGroups)
      if (gsRef) {
        const orderMap = {}
        gsRef.groups.forEach((g, i) => { orderMap[g.name] = i })
        colorEntries = colorEntries.sort(([a], [b]) => (orderMap[b] ?? -1) - (orderMap[a] ?? -1))
      }

      // Build one trace per (colorKey, lineKey) pair
      const result = []
      colorEntries.forEach(([colorKey, lineMap], colorGroupIdx) => {
        const grpDef = getStyle(colorKey)
        const color  = grpDef?.color ?? PALETTE[colorGroupIdx % PALETTE.length]
        let firstInGroup = true

        for (const [lineKey, pts] of Object.entries(lineMap)) {
          result.push({
            type:        'scatter',
            mode:        chartType === 'line' ? 'lines' : 'lines+markers',
            name:        colorKey === '__all__' ? lineKey : colorKey,
            legendgroup: colorKey,
            showlegend:  firstInGroup,   // one legend entry per colour group
            x: pts.map(p => p.x),
            y: pts.map(p => p.y),
            customdata:    pts.map(p => rowCustomdata(p.row)),
            hovertemplate,
            marker: {
              size:   grpDef?.markerSize ?? chart.markerSize,
              color,
              symbol: grpDef?.symbol ?? 'circle',
            },
            line: {
              color,
              width: grpDef?.lineThickness ?? chart.lineWidth,
              dash:  grpDef?.lineType      ?? 'solid',
            },
          })
          firstInGroup = false
        }
      })

      // Boundary overlays on line/mixed charts
      const selectedBoundaries2d = (chart.boundaryIds ?? [])
        .map(id => (boundaries ?? []).find(b => b.id === id))
        .filter(Boolean)
        .filter(b => b.points.length >= 2)
      for (const b of selectedBoundaries2d) {
        result.push({
          type: 'scatter', mode: 'lines', name: b.name,
          x: b.points.map(p => p.x), y: b.points.map(p => p.y),
          line: { color: b.color, width: b.width, dash: b.dash },
        })
      }
      return result
    }

    // ── Scatter / 3D: original bucket + build logic (unchanged) ──────────────

    // ── Bucket rows by group key ──────────────────────────────────────────────
    const groups = {}
    for (const row of activeRows) {
      const key = getKey(row)
      if (!groups[key]) groups[key] = { x: [], y: [], z: [], rows: [] }
      const xv = row[xIdx], yv = row[yIdx]
      if (xv === null || xv === '' || yv === null || yv === '') continue
      groups[key].x.push(xv)
      groups[key].y.push(yv)
      if (is3d && zIdx >= 0) groups[key].z.push(row[zIdx])
      groups[key].rows.push(row)
    }

    // ── Sort for draw order: bottom of groups list drawn first (behind) ───────
    let entries = Object.entries(groups)
    if (gsRef) {
      const orderMap = {}
      gsRef.groups.forEach((g, i) => { orderMap[g.name] = i })
      // Descending order index → bottom of list goes first into Plotly (drawn behind)
      entries = entries.sort(([a], [b]) => (orderMap[b] ?? -1) - (orderMap[a] ?? -1))
    }

    // ── Build traces ──────────────────────────────────────────────────────────
    const dataTraces = entries.map(([name, data], i) => {
      const grpDef = getStyle(name)
      const color  = grpDef?.color ?? PALETTE[i % PALETTE.length]

      if (is3d) {
        return {
          type: 'scatter3d', mode: 'markers', name,
          x: data.x, y: data.y, z: data.z,
          marker: {
            size:    grpDef?.markerSize ?? chart.markerSize,
            color,
            symbol:  grpDef?.symbol    ?? 'circle',
            opacity: 0.85,
          },
        }
      }

      // scatter → markers only.  #266: WebGL above a few thousand rows —
      // SVG scatter chokes long before 100k points; scattergl stays smooth.
      return {
        type:   (rows?.length ?? 0) > 5000 ? 'scattergl' : 'scatter',
        mode:   'markers',
        name,
        x: data.x, y: data.y,
        customdata:    data.rows.map(rowCustomdata),
        hovertemplate,
        marker: {
          size:   grpDef?.markerSize ?? chart.markerSize,
          color,
          symbol: grpDef?.symbol    ?? 'circle',
        },
        line: {
          color,
          width: grpDef?.lineThickness ?? chart.lineWidth,
          dash:  grpDef?.lineType      ?? 'solid',
        },
      }
    })

    // ── Overlay boundary traces (2D only) ──────────────────────────────────────
    if (!is3d) {
      const selectedBoundaries = (chart.boundaryIds ?? [])
        .map(id => (boundaries ?? []).find(b => b.id === id))
        .filter(Boolean)
        .filter(b => b.points.length >= 2)

      for (const b of selectedBoundaries) {
        dataTraces.push({
          type: 'scatter',
          mode: 'lines',
          name: b.name,
          x:    b.points.map(p => p.x),
          y:    b.points.map(p => p.y),
          line: { color: b.color, width: b.width, dash: b.dash },
        })
      }
    }

    return dataTraces
  }, [rows, columns, xCol, yCol, zCol, groupCol, chartType, is3d,
      chart.markerSize, chart.lineWidth, chart.lineBy, chart.sortBy,
      chart.boundaryIds, chart.hoverCols,
      groupSystems, groupAssignments,
      filteredPtIds, typeStyles, strataLayerColors,
      checkedStrataPrimary, checkedStrataSecondary, boundaries, colDict])

  const layout = useMemo(() => {
    // axisTitle: uses the stored custom title, falls back to the dictionary
    // full-name + unit, then falls back to the raw column name.
    function axisTitle(custom, col) {
      const d    = colDict[col]
      const text = custom || (d?.fullName ? `${d.fullName}${d.unit ? ` [${d.unit}]` : ''}` : col) || ''
      return text ? { text, standoff: 12 } : undefined
    }

    const base = {
      autosize: true,
      // Extra bottom/left margin so axis titles are never clipped.
      margin:   { l: 80, r: 160, t: 40, b: 80 },
      legend:   { orientation: 'v', x: 1.02, y: 0.5, xanchor: 'left', yanchor: 'middle' },
      paper_bgcolor: '#fff', plot_bgcolor: '#f8fafc',
      font: { family: 'system-ui, sans-serif', size: 12 },
    }

    function axisRange(min, max, invert) {
      const hasMin = min !== '', hasMax = max !== ''
      if (!hasMin && !hasMax) return {}
      const lo = hasMin ? Number(min) : null
      const hi = hasMax ? Number(max) : null
      return { range: invert ? [hi, lo] : [lo, hi], autorange: false }
    }

    if (is3d) return { ...base, scene: {
      xaxis: { title: axisTitle(chart.xTitle, xCol), type: chart.xLog ? 'log' : 'linear',
               autorange: chart.xInvert ? 'reversed' : true,
               ...axisRange(chart.xMin, chart.xMax, chart.xInvert) },
      yaxis: { title: axisTitle(chart.yTitle, yCol), type: chart.yLog ? 'log' : 'linear',
               autorange: chart.yInvert ? 'reversed' : true,
               ...axisRange(chart.yMin, chart.yMax, chart.yInvert) },
      zaxis: { title: axisTitle(chart.zTitle, zCol),
               autorange: chart.zInvert ? 'reversed' : true },
    }}

    const xRng  = axisRange(chart.xMin, chart.xMax, chart.xInvert)
    const yRng  = axisRange(chart.yMin, chart.yMax, chart.yInvert)
    const xIdx2 = columns.indexOf(xCol)
    const yIdx2 = columns.indexOf(yCol)

    // When boundary lines are overlaid, Plotly's autorange would zoom out to
    // include the boundary extents.  Fix the initial range to data-only values
    // so that "reset axes" (double-click) stays anchored to the scatter data.
    // Only applied when no explicit user min/max is set for that axis.
    const hasBoundaryOverlay = (chart.boundaryIds ?? []).length > 0

    function dataOnlyRange(colIdx, invert) {
      if (!hasBoundaryOverlay || colIdx < 0 || !filteredRowsForRefLines.length) return null
      const vals = filteredRowsForRefLines
        .map(r => r[colIdx])
        .filter(v => v != null && v !== '' && !isNaN(Number(v)))
        .map(Number)
      if (!vals.length) return null
      const lo  = Math.min(...vals)
      const hi  = Math.max(...vals)
      const pad = (hi - lo) * 0.05 || Math.abs(hi || lo) * 0.05 || 1
      return { range: invert ? [hi + pad, lo - pad] : [lo - pad, hi + pad], autorange: false }
    }

    const xAxisRange = Object.keys(xRng).length ? xRng
      : (dataOnlyRange(xIdx2, chart.xInvert) ?? { autorange: chart.xInvert ? 'reversed' : true })
    const yAxisRange = Object.keys(yRng).length ? yRng
      : (dataOnlyRange(yIdx2, chart.yInvert) ?? { autorange: chart.yInvert ? 'reversed' : true })

    // Build Plotly shapes + annotations from reference lines
    const rlArr = chart.refLines ?? []
    const shapes = rlArr
      .filter(rl => rl.visible !== false)
      .map(rl => {
        const v = computeRefLineValue(rl, filteredRowsForRefLines, xIdx2, yIdx2)
        if (v == null) return null
        return {
          type: 'line',
          xref: rl.axis === 'x' ? 'x'  : 'paper',
          yref: rl.axis === 'y' ? 'y'  : 'paper',
          x0:   rl.axis === 'x' ? v    : 0,
          x1:   rl.axis === 'x' ? v    : 1,
          y0:   rl.axis === 'y' ? v    : 0,
          y1:   rl.axis === 'y' ? v    : 1,
          line: { color: rl.color || '#555', dash: rl.dash || 'dash', width: rl.width || 1.5 },
        }
      }).filter(Boolean)

    const annotations = rlArr
      .filter(rl => rl.visible !== false && rl.label)
      .map(rl => {
        const v = computeRefLineValue(rl, filteredRowsForRefLines, xIdx2, yIdx2)
        if (v == null) return null
        return {
          xref:      rl.axis === 'x' ? 'x'      : 'paper',
          yref:      rl.axis === 'y' ? 'y'      : 'paper',
          x:         rl.axis === 'x' ? v        : 1,
          y:         rl.axis === 'y' ? v        : 0,
          text:      rl.label,
          showarrow: false,
          xanchor:   rl.axis === 'x' ? 'center' : 'right',
          yanchor:   rl.axis === 'y' ? 'bottom' : 'middle',
          font:      { size: 10, color: rl.color || '#555' },
        }
      }).filter(Boolean)

    return { ...base,
      xaxis: {
        title: axisTitle(chart.xTitle, xCol), type: chart.xLog ? 'log' : 'linear',
        showgrid: true, gridcolor: '#e5e7eb', zeroline: false,
        ...xAxisRange,
      },
      yaxis: {
        title: axisTitle(chart.yTitle, yCol), type: chart.yLog ? 'log' : 'linear',
        showgrid: true, gridcolor: '#e5e7eb', zeroline: false,
        ...yAxisRange,
      },
      shapes,
      annotations,
    }
  }, [is3d, xCol, yCol, zCol, columns,
      chart.xTitle, chart.yTitle, chart.zTitle,
      chart.xLog, chart.yLog,
      chart.xInvert, chart.yInvert, chart.zInvert,
      chart.xMin, chart.xMax, chart.yMin, chart.yMax,
      chart.refLines, chart.boundaryIds,
      filteredRowsForRefLines, colDict])

  const missing = !columns.length
    ? (chart.queryName ? 'Load data to render the chart' : 'Select a query and load data')
    : (!xCol || !yCol ? 'Select X and Y axes to render the chart' : null)

  return (
    <div ref={plotWrapRef} className="chart-plot">
      {traces.length > 0 ? (
        <Plot
          data={traces}
          layout={layout}
          useResizeHandler={true}
          style={{ width: '100%', height: '100%' }}
          config={{ responsive: true, displayModeBar: true, scrollZoom: true }}
        />
      ) : (
        <div className="chart-empty">{missing ?? 'No data to display'}</div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ChartsPage() {
  const { selectedProjects, selectedPoints, refreshKey } = useApp()

  // #266: drop shared chart-query results when data may have changed.
  useEffect(() => { chartQueryCache.clear() }, [refreshKey])
  useDataChanged('datasheets', () => chartQueryCache.clear(), { includeSelf: true })
  const { groupSystems, groupAssignments, filteredPtIds, checkedStrataPrimary, checkedStrataSecondary } = useFilter()

  const [charts,   setCharts]   = useState(() => [newChart()])
  const [activeId, setActiveId] = useState(() => charts[0]?.id ?? '')
  const [queries,  setQueries]  = useState([])

  // 'idle' | 'saving' | 'saved' | 'error'
  const [statsAutoStatus, setStatsAutoStatus] = useState('idle')

  // Tab rename
  const [renamingId,   setRenamingId]   = useState(null)
  const [renamingText, setRenamingText] = useState('')

  // Auto-load after session restore
  const [readyToAutoLoad, setReadyToAutoLoad] = useState(false)

  const saveTimer          = useRef(null)
  const chartsRef          = useRef(charts)
  const statsAutoSaveTimer = useRef(null)
  const saveStatisticsRef  = useRef(null)
  const dragSrcId          = useRef(null)
  useEffect(() => { chartsRef.current = charts }, [charts])

  const projectId = selectedProjects[0]?.ProjectId

  // ── Persist chart configs ─────────────────────────────────────────────────

  function toClean(chartList) {
    return chartList.map(({
      name, queryName, chartType,
      xCol, yCol, zCol,
      xTitle, yTitle, zTitle,
      xLog, yLog,
      xInvert, yInvert, zInvert,
      xMin, xMax, yMin, yMax,
      groupCol, lineBy, sortBy, showStats, markerSize, lineWidth,
      refLines, statsAxis, boundaryIds, hoverCols,
    }) => ({
      name, queryName, chartType,
      xCol, yCol, zCol,
      xTitle, yTitle, zTitle,
      xLog, yLog,
      xInvert, yInvert, zInvert,
      xMin, xMax, yMin, yMax,
      groupCol, lineBy, sortBy, showStats, markerSize, lineWidth,
      refLines:    refLines    ?? [],
      statsAxis:   statsAxis   ?? 'x',
      boundaryIds: boundaryIds ?? [],
      hoverCols:   hoverCols   ?? [],
    }))
  }

  const persist = useCallback((chartList) => {
    if (!projectId) return
    const clean = toClean(chartList)
    localStorage.setItem(`girtool_charts_${projectId}`, JSON.stringify(clean))
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      invoke('patch_session', { projectId, patch: { charts: clean } }).catch(() => {})
    }, 500)
  }, [projectId])

  // ── Load queries ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!projectId) return
    setQueries([])
    invoke('list_queries', { projectId })
      .then(r => setQueries(r))
      .catch(() => {})
  }, [projectId, refreshKey])

  // ── Restore charts from session ───────────────────────────────────────────

  useEffect(() => {
    if (!projectId) return
    setReadyToAutoLoad(false)

    function applyRestored(saved) {
      if (!Array.isArray(saved) || !saved.length) return false
      _seq = saved.length + 1
      const restored = saved.map(c => newChart({
        ...c, columns: [], rows: [], truncated: false, loading: false, error: '',
      }))
      setCharts(restored)
      setActiveId(restored[0].id)
      setReadyToAutoLoad(true)
      return true
    }

    invoke('get_session', { projectId })
      .then(r => { if (!applyRestored(r?.charts)) throw new Error('no charts') })
      .catch(() => {
        const raw = localStorage.getItem(`girtool_charts_${projectId}`)
        if (raw) try { applyRestored(JSON.parse(raw)) } catch {}
      })
  }, [projectId])

  // ── Auto-load when queries + restored charts are both ready ───────────────

  useEffect(() => {
    if (!readyToAutoLoad || !queries.length || !projectId) return
    setReadyToAutoLoad(false)
    chartsRef.current
      .filter(c => c.queryName && !c.loading && !c.columns.length)
      .forEach(c => fetchData(c.id))
  }, [readyToAutoLoad, queries, projectId])  // eslint-disable-line

  // ── Chart CRUD ────────────────────────────────────────────────────────────

  function updateChart(id, updates) {
    setCharts(prev => {
      const next = prev.map(c => c.id === id ? { ...c, ...updates } : c)
      persist(next)
      return next
    })
  }

  function addChart() {
    const c = newChart()
    setCharts(prev => { const next = [...prev, c]; persist(next); return next })
    setActiveId(c.id)
  }

  function removeChart(id) {
    if (charts.length === 1) return
    const idx  = charts.findIndex(c => c.id === id)
    const next = charts.filter(c => c.id !== id)
    if (id === activeId) setActiveId(next[Math.max(0, idx - 1)].id)
    setCharts(next)
    persist(next)
  }

  function reorderCharts(fromId, toId) {
    if (fromId === toId) return
    setCharts(prev => {
      const next    = [...prev]
      const fromIdx = next.findIndex(c => c.id === fromId)
      const toIdx   = next.findIndex(c => c.id === toId)
      const [moved] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, moved)
      persist(next)
      return next
    })
  }

  // ── Data fetch ────────────────────────────────────────────────────────────

  async function fetchData(id) {
    const chart = chartsRef.current.find(c => c.id === id)
    if (!chart || !projectId || !chart.queryName) return
    const needsAutoAxes = !chart.xCol && !chart.yCol

    updateChart(id, { loading: true, error: '', columns: [], rows: [] })
    try {
      // Issue #124: send project_ids / point_ids in per-DB form when the
      // upstream rows carry db_id (post-#71 / #78) so the backend can fan
      // out across every configured database.  Falls back to the legacy
      // flat shape for older session restores.
      const hasProjDb = selectedProjects.some(p => p?.db_id)
      const hasPtDb   = selectedPoints.some(p => p?.db_id)
      // #266: identical query + selection across charts -> one shared fetch.
      const selKey = [
        projectId,
        chart.queryName,
        selectedProjects.map(p => `${p.db_id ?? '?'}|${p.ProjectId}`).join(','),
        selectedPoints.map(p => `${p.db_id ?? '?'}|${p.PointId}`).join(','),
      ].join('||')
      const res = await cachedChartQuery(selKey, () => invoke('run_chart_query', {
        projectId,
        query: {
          project_ids: hasProjDb
            ? selectedProjects.map(p => ({ db_id: p.db_id, ProjectId: p.ProjectId }))
            : selectedProjects.map(p => p.ProjectId),
          point_ids:   hasPtDb
            ? selectedPoints.map(p => ({ db_id: p.db_id, PointId: p.PointId }))
            : selectedPoints.map(p => p.PointId),
          // #267: downloaded datasheets identify points by DB + PointNo —
          // used when the chart sources the curated xlsx instead of the DB.
          point_nos:   selectedPoints.map(p => ({
            db_id: p.db_id ?? null,
            point_no: String(p.PointNo ?? ''),
          })),
          query_name:  chart.queryName,
        },
      }))
      const axisUpdates = needsAutoAxes ? autoAxes(res.columns) : {}
      updateChart(id, {
        columns:   res.columns,
        rows:      res.rows,
        truncated: res.truncated,
        loading:   false,
        ...axisUpdates,
      })
    } catch (err) {
      updateChart(id, {
        loading: false,
        error:   err || 'Failed to load data',
      })
    }
  }

  // ── Statistics auto-save ─────────────────────────────────────────────────
  // Always saves Y-axis stats (the primary measurement). The UI axis selector
  // is for interactive exploration only. Fires automatically via debounced
  // useEffect whenever charts data or filters change.

  const saveStatistics = useCallback(async () => {
    if (!projectId) return
    setStatsAutoStatus('saving')
    try {
      const chartsData = chartsRef.current
        .filter(c => c.rows.length > 0 && c.columns.length > 0 && c.showStats !== false)
        .map(c => {
          const ax      = c.statsAxis ?? 'y'
          const axisCol = ax === 'x' ? c.xCol : ax === 'z' ? c.zCol : c.yCol
          const { groups } = computeStats(
            c, axisCol,
            filteredPtIds, checkedStrataPrimary, checkedStrataSecondary,
            groupAssignments,
          )
          return {
            name:       c.name,
            query_name: c.queryName,
            axis_col:   axisCol,
            stats:      groups,
          }
        })
      const res = await invoke('save_statistics', { projectId, stats: { charts: chartsData } })
      if (res?.skipped) {
        setStatsAutoStatus('idle')   // no output folder — nothing written, no indicator needed
      } else {
        setStatsAutoStatus('saved')
        setTimeout(() => setStatsAutoStatus(s => s === 'saved' ? 'idle' : s), 3000)
      }
    } catch {
      setStatsAutoStatus('error')
      setTimeout(() => setStatsAutoStatus(s => s === 'error' ? 'idle' : s), 3000)
    }
  }, [projectId, filteredPtIds, checkedStrataPrimary, checkedStrataSecondary, groupAssignments])

  // Open statistics.xlsx in the OS default app, focused on the active chart's sheet.
  const openStatisticsInExcel = useCallback(async (chart) => {
    if (!projectId || !chart) return
    const ax      = chart.statsAxis ?? 'y'
    const axisCol = ax === 'x' ? chart.xCol : ax === 'z' ? chart.zCol : chart.yCol
    const { groups } = computeStats(
      chart, axisCol,
      filteredPtIds, checkedStrataPrimary, checkedStrataSecondary, groupAssignments,
    )
    const chartPayload = {
      name:       chart.name,
      query_name: chart.queryName,
      axis_col:   axisCol,
      stats:      groups,
    }
    // Also include all other charts so statistics.xlsx stays complete.
    const allChartsData = chartsRef.current
      .filter(c => c.rows.length > 0 && c.columns.length > 0 && c.showStats !== false)
      .map(c => {
        const cAx      = c.statsAxis ?? 'y'
        const cAxCol   = cAx === 'x' ? c.xCol : cAx === 'z' ? c.zCol : c.yCol
        const { groups: g } = computeStats(
          c, cAxCol,
          filteredPtIds, checkedStrataPrimary, checkedStrataSecondary, groupAssignments,
        )
        return { name: c.name, query_name: c.queryName, axis_col: cAxCol, stats: g }
      })
    // Ensure the active chart is included even if rows=0 (so we still navigate to its sheet)
    const chartsForSave = allChartsData.find(c => c.name === chart.name)
      ? allChartsData
      : [chartPayload, ...allChartsData]
    await invoke('open_statistics', {
      projectId,
      stats: {
        sheet_name: chart.name,
        charts:     chartsForSave,
      },
    })
  }, [projectId, filteredPtIds, checkedStrataPrimary, checkedStrataSecondary, groupAssignments])

  // Keep ref current so the debounced timer always calls the latest version
  useEffect(() => { saveStatisticsRef.current = saveStatistics }, [saveStatistics])

  // Auto-save statistics 2 s after any chart data or filter change
  useEffect(() => {
    if (!projectId) return
    clearTimeout(statsAutoSaveTimer.current)
    statsAutoSaveTimer.current = setTimeout(() => {
      if (chartsRef.current.some(c => c.rows.length > 0))
        saveStatisticsRef.current?.()
    }, 2000)
    return () => clearTimeout(statsAutoSaveTimer.current)
  }, [charts, filteredPtIds, checkedStrataPrimary, checkedStrataSecondary, projectId]) // eslint-disable-line

  // ── Tab rename ────────────────────────────────────────────────────────────

  function startRename(id, name) { setRenamingId(id); setRenamingText(name) }
  function commitRename(id) {
    if (renamingText.trim()) updateChart(id, { name: renamingText.trim() })
    setRenamingId(null)
  }

  // ── Open Datasheet ────────────────────────────────────────────────────────

  async function openDatasheet() {
    if (!projectId || !activeChart?.queryName) return
    try {
      await invoke('open_datasheet', { path: activeChart.queryName })
    } catch (err) {
      console.error(err)
      alert('Could not open datasheet.')
    }
  }

  // ── Guard ────────────────────────��────────────────────────────────���───────

  if (!selectedProjects.length) {
    return (
      <div className="page">
        <h2 className="page-title">Charts</h2>
        <p className="hint">Select a project first.</p>
      </div>
    )
  }

  const activeChart = charts.find(c => c.id === activeId) ?? charts[0]
  const showStats   = activeChart?.showStats ?? true

  return (
    <div className="charts-page">

      {/* ── Chart tab bar ── */}
      <div className="chart-tabs">
        {charts.map(c => {
          const isActive   = c.id === activeId
          const isRenaming = renamingId === c.id
          return (
            <div
              key={c.id}
              className={`chart-tab ${isActive ? 'active' : ''}`}
              onClick={() => { if (!isActive) setActiveId(c.id) }}
              draggable
              onDragStart={() => { dragSrcId.current = c.id }}
              onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('drag-over') }}
              onDragLeave={e => e.currentTarget.classList.remove('drag-over')}
              onDrop={e => { e.currentTarget.classList.remove('drag-over'); reorderCharts(dragSrcId.current, c.id) }}
            >
              {isRenaming ? (
                <input
                  className="chart-tab-rename"
                  value={renamingText}
                  autoFocus
                  onChange={e => setRenamingText(e.target.value)}
                  onBlur={() => commitRename(c.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter')  commitRename(c.id)
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <span
                  className={`chart-tab-name${isActive ? ' editable' : ''}`}
                  title={isActive ? 'Click to rename' : 'Switch to this chart'}
                  onClick={e => { if (isActive) { e.stopPropagation(); startRename(c.id, c.name) } }}
                >
                  {c.name}
                  {isActive && <span className="chart-tab-pencil">✎</span>}
                </span>
              )}
              {charts.length > 1 && (
                <button
                  className="chart-tab-close"
                  title="Close chart"
                  onClick={e => { e.stopPropagation(); removeChart(c.id) }}
                >×</button>
              )}
            </div>
          )
        })}
        <button className="chart-tab-add" onClick={addChart} title="New chart">＋</button>
      </div>

      {/* ── Upper: sidebar + plot ── */}
      <div className="charts-top">
        <div className="chart-layout">

          {/* Left panel — settings only */}
          <div className="axis-panel">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
              <div className="chart-panel-title" style={{ flex: 1, marginBottom: 0 }}>{activeChart?.name}</div>
              <button
                className="btn-secondary btn-sm"
                onClick={openDatasheet}
                disabled={!activeChart?.queryName}
                title={activeChart?.queryName
                  ? `Open ${activeChart.queryName}.xlsx in Excel`
                  : 'Select a query first'}
              >
                📂 Open Datasheet
              </button>
            </div>
            {activeChart && (
              <AxisSettings
                key={activeChart.id}
                chart={activeChart}
                queries={queries}
                groupSystems={groupSystems}
                onUpdate={updates => updateChart(activeChart.id, updates)}
                onLoad={() => fetchData(activeChart.id)}
              />
            )}
          </div>

          {/* Plot area */}
          {activeChart && (
            <ChartPlot
              key={activeChart.id}
              chart={activeChart}
              style={{ width: '100%', height: '100%' }}
            />
          )}
        </div>
      </div>

      {/* ── Lower: statistics panel ── */}
      <div className={`charts-stats-panel${showStats ? '' : ' hidden'}`}>
        {activeChart && (
          <StatsTable
            key={activeChart.id}
            chart={activeChart}
            statsAutoStatus={statsAutoStatus}
            statsAxis={activeChart.statsAxis ?? 'y'}
            onAxisChange={a => updateChart(activeChart.id, { statsAxis: a })}
            onOpenExcel={() => openStatisticsInExcel(activeChart)}
            hasOutputFolder={!!projectId}
          />
        )}
      </div>

    </div>
  )
}
