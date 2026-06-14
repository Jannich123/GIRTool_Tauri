import { useState, useRef, useCallback, useEffect } from 'react'
import { invoke } from '../tauri-api'
import { invokeAndNotify, useDataChanged } from '../lib/dataChanged'
import { useApp } from '../context/AppContext'

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return `bnd_${Date.now()}${Math.random().toString(36).slice(2, 7)}`
}

function newBoundary(overrides = {}) {
  return {
    id:     uid(),
    name:   'New Boundary',
    color:  '#2980b9',
    dash:   'solid',
    width:  2,
    points: [],
    ...overrides,
  }
}

// Parse a tab/comma-separated clipboard paste into [{x, y}] rows.
// Expects header row to be absent, OR first row to contain non-numeric values
// (in which case it is skipped).
function parsePaste(text) {
  const rows = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
  if (!rows.length) return []

  // Detect separator
  const sep = rows[0].includes('\t') ? '\t' : ','

  // Skip header if first row has non-numeric cells
  let start = 0
  const firstCells = rows[0].split(sep)
  if (firstCells.some(c => isNaN(Number(c.trim().replace(',', '.'))))) start = 1

  const result = []
  for (let i = start; i < rows.length; i++) {
    const cells = rows[i].split(sep).map(c => c.trim().replace(',', '.'))
    const x = Number(cells[0]), y = Number(cells[1])
    if (!isNaN(x) && !isNaN(y)) result.push({ x, y })
  }
  return result
}

// ── Coordinate table ──────────────────────────────────────────────────────────

function CoordTable({ points, onChange }) {
  const [editing, setEditing] = useState(null)   // { row, col }
  const [draft,   setDraft]   = useState('')
  const pasteRef = useRef(null)

  const commitEdit = useCallback(() => {
    if (!editing) return
    const { row, col } = editing
    const val = Number(draft)
    if (isNaN(val)) { setEditing(null); return }
    const next = points.map((p, i) =>
      i === row ? { ...p, [col]: val } : p
    )
    onChange(next)
    setEditing(null)
  }, [editing, draft, points, onChange])

  function handlePaste(e) {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    const parsed = parsePaste(text)
    if (parsed.length > 0) onChange([...points, ...parsed])
  }

  function addRow() {
    onChange([...points, { x: 0, y: 0 }])
  }

  function deleteRow(i) {
    onChange(points.filter((_, idx) => idx !== i))
  }

  return (
    <div className="bnd-coord-wrap">
      <div className="bnd-coord-toolbar">
        <span className="axis-hint muted">{points.length} point{points.length !== 1 ? 's' : ''}</span>
        <button
          className="btn-secondary btn-sm"
          title="Paste rows from clipboard (tab-separated or comma-separated, X in col 1, Y in col 2)"
          onClick={() => pasteRef.current?.focus()}
          onPaste={handlePaste}
          ref={pasteRef}
        >📋 Paste from clipboard</button>
        <button className="btn-secondary btn-sm" onClick={addRow}>＋ Add row</button>
        {points.length > 0 && (
          <button className="btn-secondary btn-sm btn-danger"
            onClick={() => onChange([])}>🗑 Clear all</button>
        )}
      </div>

      {points.length > 0 && (
        <div className="bnd-coord-table-wrap">
          <table className="bnd-coord-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th style={{ width: 88 }}>X</th>
                <th style={{ width: 88 }}>Y</th>
                <th style={{ width: 28 }} />
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={i}>
                  <td className="bnd-row-num">{i + 1}</td>
                  {['x', 'y'].map(col => (
                    <td key={col} className="bnd-cell"
                      onClick={() => {
                        setEditing({ row: i, col })
                        setDraft(String(p[col]))
                      }}
                    >
                      {editing?.row === i && editing?.col === col ? (
                        <input
                          className="bnd-cell-field"
                          value={draft}
                          autoFocus
                          onChange={e => setDraft(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={e => {
                            if (e.key === 'Enter')  commitEdit()
                            if (e.key === 'Escape') setEditing(null)
                          }}
                        />
                      ) : (
                        <span className="bnd-cell-field bnd-cell-field--display">{p[col]}</span>
                      )}
                    </td>
                  ))}
                  <td>
                    <button className="btn-icon btn-sm btn-danger"
                      onClick={() => deleteRow(i)} title="Delete row">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {points.length === 0 && (
        <p className="axis-hint muted" style={{ margin: '0.5rem 0' }}>
          No points yet — add rows manually or paste from Excel.
        </p>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BoundariesPage() {
  const { selectedProjects, boundaries, saveBoundaries } = useApp()
  const [selectedId, setSelectedId] = useState(null)

  // 'idle' | 'saving' | 'saved' | 'loading' | 'error'
  const [xlsxStatus, setXlsxStatus] = useState('idle')
  const xlsxTimerRef = useRef(null)

  const projectId = selectedProjects[0]?.ProjectId

  // ── Auto-save to Boundaries.xlsx whenever boundaries change ────────────────
  const boundariesRef = useRef(boundaries)
  useEffect(() => { boundariesRef.current = boundaries }, [boundaries])

  const xlsxSaveTimer = useRef(null)
  useEffect(() => {
    if (!projectId || !boundaries.length) return
    clearTimeout(xlsxSaveTimer.current)
    xlsxSaveTimer.current = setTimeout(() => {
      doSaveXlsx(boundariesRef.current)
    }, 1200)
    return () => clearTimeout(xlsxSaveTimer.current)
  }, [boundaries, projectId])  // eslint-disable-line

  async function doSaveXlsx(list) {
    if (!projectId) return
    try {
      setXlsxStatus('saving')
      await invokeAndNotify('boundaries', 'save_boundaries', { projectId, boundaries: list })
      setXlsxStatus('saved')
      clearTimeout(xlsxTimerRef.current)
      xlsxTimerRef.current = setTimeout(() => setXlsxStatus('idle'), 2500)
    } catch {
      setXlsxStatus('error')
      clearTimeout(xlsxTimerRef.current)
      xlsxTimerRef.current = setTimeout(() => setXlsxStatus('idle'), 3000)
    }
  }

  async function loadFromExcel() {
    if (!projectId) return
    try {
      setXlsxStatus('loading')
      const res = await invokeAndNotify('boundaries', 'load_boundaries_from_excel', { projectId })
      const merged = res.boundaries ?? []
      saveBoundaries(merged)
      // Select first new boundary added (if any)
      const existingIds = new Set(boundaries.map(b => b.id))
      const newBnd = merged.find(b => !existingIds.has(b.id))
      if (newBnd) setSelectedId(newBnd.id)
      setXlsxStatus('saved')
      clearTimeout(xlsxTimerRef.current)
      xlsxTimerRef.current = setTimeout(() => setXlsxStatus('idle'), 2500)
    } catch (err) {
      console.error(err)
      alert(err ?? 'Failed to load from Excel')
      setXlsxStatus('idle')
    }
  }

  async function openExcel() {
    if (!projectId) return
    try {
      await invoke('open_boundaries_excel', { projectId })
    } catch (err) {
      console.error(err)
      alert(err ?? 'Could not open file')
    }
  }

  const selected = boundaries.find(b => b.id === selectedId) ?? null

  function updateSelected(updates) {
    const next = boundaries.map(b => b.id === selectedId ? { ...b, ...updates } : b)
    saveBoundaries(next)
  }

  function addBoundary() {
    const b = newBoundary({ name: `Boundary ${boundaries.length + 1}` })
    saveBoundaries([...boundaries, b])
    setSelectedId(b.id)
  }

  function deleteBoundary(id) {
    const next = boundaries.filter(b => b.id !== id)
    saveBoundaries(next)
    if (selectedId === id) setSelectedId(next[0]?.id ?? null)
  }

  if (!selectedProjects.length) {
    return (
      <div className="page">
        <h2 className="page-title">Boundaries</h2>
        <p className="hint">Select a project first.</p>
      </div>
    )
  }

  const statusLabel = {
    saving:  '💾 Saving…',
    saved:   '✓ Saved',
    loading: '⏳ Loading…',
    error:   '⚠ Error',
  }[xlsxStatus]

  return (
    <div className="page bnd-page">
      <div className="bnd-page-header">
        <div>
          <h2 className="page-title" style={{ marginBottom: '.15rem' }}>Boundaries</h2>
          <p className="hint" style={{ margin: 0 }}>
            Define named line series from coordinate data. Select them in Charts to overlay them on plots.
          </p>
        </div>

        {/* Toolbar */}
        <div className="bnd-toolbar">
          {xlsxStatus !== 'idle' && (
            <span className={`bnd-status bnd-status--${xlsxStatus}`}>{statusLabel}</span>
          )}
          <button
            className="btn-secondary btn-sm"
            onClick={() => doSaveXlsx(boundaries)}
            disabled={xlsxStatus === 'saving' || xlsxStatus === 'loading' || !boundaries.length}
            title="Save all boundaries to Boundaries.xlsx (one sheet per boundary)"
          >💾 Save to Excel</button>
          <button
            className="btn-secondary btn-sm"
            onClick={loadFromExcel}
            disabled={xlsxStatus === 'saving' || xlsxStatus === 'loading'}
            title="Import boundaries from Boundaries.xlsx — new sheets are added, existing are updated"
          >↺ Load from Excel</button>
          <button
            className="btn-secondary btn-sm"
            onClick={openExcel}
            title="Open Boundaries.xlsx in Excel"
          >📂 Open in Excel</button>
        </div>
      </div>

      <div className="bnd-layout">

        {/* ── Left: boundary list ── */}
        <div className="bnd-list-panel">
          <div className="bnd-list-header">
            <span className="bnd-list-title">Boundaries</span>
            <button className="btn-primary btn-sm" onClick={addBoundary}>＋ New</button>
          </div>

          {boundaries.length === 0 && (
            <p className="axis-hint muted" style={{ padding: '0.5rem' }}>
              No boundaries yet.
            </p>
          )}

          {boundaries.map(b => (
            <div
              key={b.id}
              className={`bnd-list-item${selectedId === b.id ? ' active' : ''}`}
              onClick={() => setSelectedId(b.id)}
            >
              <span className="bnd-swatch" style={{ background: b.color }} />
              <span className="bnd-list-name">{b.name}</span>
              <span className="axis-hint muted bnd-list-count">
                {b.points.length}pt
              </span>
              <button
                className="btn-icon btn-sm btn-danger"
                style={{ marginLeft: 'auto' }}
                title="Delete boundary"
                onClick={e => { e.stopPropagation(); deleteBoundary(b.id) }}
              >✕</button>
            </div>
          ))}
        </div>

        {/* ── Right: editor ── */}
        {selected ? (
          <div className="bnd-editor">
            <div className="bnd-editor-section">
              <label>Name</label>
              <input
                type="text"
                className="bnd-name-input"
                value={selected.name}
                onChange={e => updateSelected({ name: e.target.value })}
              />
            </div>

            <div className="bnd-editor-section bnd-style-row">
              <div>
                <label>Colour</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="color"
                    value={selected.color}
                    onChange={e => updateSelected({ color: e.target.value })}
                    style={{ width: 36, height: 28, padding: 0, border: 'none', cursor: 'pointer', borderRadius: 4 }}
                  />
                  <span className="axis-hint muted" style={{ fontSize: 11 }}>{selected.color}</span>
                </div>
              </div>

              <div>
                <label>Dash</label>
                <div style={{ display: 'flex', gap: 4 }}>
                  {[['solid', 'Solid'], ['dash', 'Dashed'], ['dot', 'Dotted']].map(([val, lbl]) => (
                    <button key={val}
                      className={`btn-sm ${selected.dash === val ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => updateSelected({ dash: val })}
                    >{lbl}</button>
                  ))}
                </div>
              </div>

              <div>
                <label>Width&nbsp;<span style={{ fontWeight: 400 }}>({selected.width}px)</span></label>
                <input
                  type="range" min="0.5" max="6" step="0.5"
                  value={selected.width}
                  onChange={e => updateSelected({ width: Number(e.target.value) })}
                  style={{ width: 100 }}
                />
              </div>
            </div>

            <div className="bnd-editor-section">
              <label style={{ marginBottom: '0.4rem', display: 'block' }}>
                Coordinate points
                <span className="axis-hint muted" style={{ fontWeight: 400, marginLeft: 6 }}>
                  (X = horizontal axis, Y = vertical axis)
                </span>
              </label>
              <CoordTable
                points={selected.points}
                onChange={pts => updateSelected({ points: pts })}
              />
            </div>
          </div>
        ) : (
          <div className="bnd-editor bnd-editor--empty">
            <p className="axis-hint muted">
              {boundaries.length > 0
                ? 'Select a boundary to edit.'
                : 'Create a boundary to get started.'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
