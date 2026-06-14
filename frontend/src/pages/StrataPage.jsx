/**
 * StrataPage — issues #41, #42
 *
 * Workflow:
 *   Selection tab  → choose strata types → "Download Strata" appends sheets
 *                    to strata.xlsx (named {interpretation}_{series})
 *   Error tab      → "Load Strata" reads the "Strata" master sheet from the file
 *                    (user manually pastes rows there from the data sheets in Excel)
 *                  → correct gaps/overlaps/negative thickness in-app
 *                  → "Save Corrections" writes back to the Strata sheet
 *
 * Error logic mirrors the Strata_GIRTool Excel template formulas:
 *   I (Gap in boundary?)   : From > prev.To  (same ProjectId + PointId) → warning
 *   J (Overlapping?)       : From < prev.To  (same ProjectId + PointId) → error
 *   K (Negative thickness?): From >= To                                   → error
 */

import { useState, useEffect, useMemo } from 'react'
import { invoke } from '../tauri-api'
import { invokeAndNotify, useDataChanged } from '../lib/dataChanged'
import { useApp } from '../context/AppContext'
import { useFilter } from '../context/FilterContext'

// ── Key helpers ───────────────────────────────────────────────────────────────

// API returns Interpretation (capital I); selections use interpretation (lowercase).
// Support both so lookup keys always match the server response.
//
// Issue #79: get_strata_types now consolidates rows by (Interpretation, series)
// across every database that holds the combination — selKey drops `db_id` to
// match.  The list of contributing DBs travels alongside as `db_ids`.
const selKey = (s) =>
  `${s.series}||${s.Interpretation ?? s.interpretation}`

// Small monospace pill renderer for db_id chips inside the DB column.
function DbIdPill({ id }) {
  return (
    <code
      style={{
        fontSize: '.72rem',
        padding: '0.05rem 0.4rem',
        background: '#eef2ff',
        color: '#3730a3',
        border: '1px solid #c7d2fe',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        marginRight: '0.25rem',
      }}
    >
      {id || '?'}
    </code>
  )
}

// ── Error detection (matches Excel template column formulas exactly) ──────────
//
// Rows come from SQL sorted by PointNo ASC, From ASC.
// We group by ProjectId so the "same-project" guard in I/J works correctly.

const ERR_NEG     = 'negative'   // K: From >= To
const ERR_OVERLAP = 'overlap'    // J: From < prev.To  AND same ProjectId+PointId
const WARN_GAP    = 'gap'        // I: From > prev.To  AND same ProjectId+PointId

function detectErrors(rows) {
  const issues = []

  // Group rows by ProjectId+PointId composite key — mirrors the Excel formula
  // guards AND(A=prev.A, B=prev.B).  Gaps/overlaps between different boreholes
  // must NOT be flagged.  K (negative thickness) is per-row, unaffected.
  const byPoint = {}
  rows.forEach((r, globalIdx) => {
    const proj = String(r.ProjectId ?? r.ProjectID ?? '')
    const pt   = String(r.PointId   ?? r.PointID   ?? '')
    const k    = `${proj}||${pt}`
    if (!byPoint[k]) byPoint[k] = []
    byPoint[k].push({ ...r, _idx: globalIdx })
  })

  for (const ptRows of Object.values(byPoint)) {
    for (let i = 0; i < ptRows.length; i++) {
      const cur  = ptRows[i]
      const prev = ptRows[i - 1]

      const from = Number(cur.From)
      const to   = Number(cur.To)

      // K: Negative thickness — From >= To
      if (from >= to) {
        issues.push({ type: ERR_NEG, severity: 'error', rowIdx: cur._idx })
      }

      if (prev) {
        const prevTo = Number(prev.To)

        // J: Overlapping — From < prev.To (same project+point)  matches Excel J formula
        if (from < prevTo) {
          issues.push({ type: ERR_OVERLAP, severity: 'error', rowIdx: cur._idx })
        }
        // I: Gap — From > prev.To (same project+point)  matches Excel I formula
        // (From === prev.To is perfect alignment → no issue)
        else if (from > prevTo) {
          issues.push({ type: WARN_GAP, severity: 'warning', rowIdx: cur._idx })
        }
      }
    }
  }
  return issues
}

// ── Sub-tab 1: Selection & Preview ───────────────────────────────────────────

function SelectionTab({ selectedProjects, selectedPoints }) {
  const { refreshStrataLayers } = useFilter()

  const [types,        setTypes]        = useState([])
  const [checked,      setChecked]      = useState({})
  const [loadingTypes, setLoadingTypes] = useState(false)
  const [loadingData,  setLoadingData]  = useState(false)
  const [downloading,  setDownloading]  = useState(false)
  const [transferring, setTransferring] = useState(false)
  const [preview,      setPreview]      = useState({})
  const [dlMsg,        setDlMsg]        = useState(null)
  const [transferMsg,  setTransferMsg]  = useState(null)
  const [openMsg,      setOpenMsg]      = useState(null)
  const [typeErr,      setTypeErr]      = useState('')

  const projectIds  = selectedProjects.map(p => p.ProjectId)
  const pointIds    = selectedPoints.map(p => String(p.PointId))

  // Load available types on project/point change.
  // Backend accepts a body with project_ids and (optional) point_ids so the
  // returned list narrows when the user has filtered points.
  useEffect(() => {
    if (!projectIds.length) { setTypes([]); setChecked({}); setPreview({}); onDataLoaded({}); return }
    setLoadingTypes(true); setTypeErr('')
    invoke('get_strata_types', {
      body: {
        project_ids: projectIds,
        point_ids:   pointIds,
      },
    })
      .then(r => setTypes(r))
      .catch(e => setTypeErr(e || 'Failed to load strata types'))
      .finally(() => setLoadingTypes(false))
  }, [JSON.stringify(projectIds), JSON.stringify(pointIds)]) // eslint-disable-line

  const checkedSelections = useMemo(
    () => types.filter(t => checked[selKey(t)]),
    [types, checked],
  )

  // Fetch preview data whenever the checked selection changes
  useEffect(() => {
    if (!checkedSelections.length) { setPreview({}); return }
    setLoadingData(true)
    invoke('get_strata_data', {
      body: {
        project_ids: projectIds,
        point_ids:   pointIds,
        // Forward db_id so the backend (#48) can route each selection to the
        // database that returned it via get_strata_types.
        selections:  checkedSelections.map(t => ({
          interpretation: t.Interpretation,
          series:         t.series,
          // Issue #79: forward the consolidated list of contributing DBs so
          // the backend queries each one and concatenates the results.
          db_ids:         Array.isArray(t.db_ids) ? t.db_ids : (t.db_id ? [t.db_id] : []),
        })),
      },
    })
      .then(r => { setPreview(r) })
      .catch(() => {})
      .finally(() => setLoadingData(false))
  }, [JSON.stringify(checkedSelections.map(selKey))]) // eslint-disable-line

  function toggleAll(val) {
    const next = {}
    types.forEach(t => { next[selKey(t)] = val })
    setChecked(next)
  }

  async function handleDownload() {
    setDownloading(true); setDlMsg(null); setTransferMsg(null); setOpenMsg(null)
    try {
      const r = await invokeAndNotify('strata', 'download_strata', {
        body: {
          project_ids: projectIds,
          point_ids:   pointIds,
          // Forward db_id so the backend (#48) can route each selection to the
        // database that returned it via get_strata_types.
        selections:  checkedSelections.map(t => ({
          interpretation: t.Interpretation,
          series:         t.series,
          // Issue #79: forward the consolidated list of contributing DBs so
          // the backend queries each one and concatenates the results.
          db_ids:         Array.isArray(t.db_ids) ? t.db_ids : (t.db_id ? [t.db_id] : []),
        })),
        },
      })
      setDlMsg({ ok: true, text: `Saved to ${r.path}` })
    } catch (e) {
      console.error(e)
      setDlMsg({ ok: false, text: e || 'Download failed' })
    } finally {
      setDownloading(false)
    }
  }

  // Note: download only adds raw data sheets — the Strata master sheet is only
  // populated by Transfer, so we refresh layers after Transfer (not Download).

  async function handleTransfer() {
    setTransferring(true); setTransferMsg(null); setDlMsg(null); setOpenMsg(null)
    try {
      const r = await invokeAndNotify('strata', 'transfer_strata', {
        body: {
          project_ids: projectIds,
          point_ids:   pointIds,
          // Forward db_id so the backend (#48) can route each selection to the
        // database that returned it via get_strata_types.
        selections:  checkedSelections.map(t => ({
          interpretation: t.Interpretation,
          series:         t.series,
          // Issue #79: forward the consolidated list of contributing DBs so
          // the backend queries each one and concatenates the results.
          db_ids:         Array.isArray(t.db_ids) ? t.db_ids : (t.db_id ? [t.db_id] : []),
        })),
        },
      })
      const { transferred, skipped, total } = r
      const skipNote = skipped > 0 ? `, skipped ${skipped} (already in sheet)` : ''
      setTransferMsg({ ok: true, text: `Transferred ${transferred} new row${transferred !== 1 ? 's' : ''}${skipNote}. Strata sheet now has ${total} rows.` })
      // Refresh layer lists in FilterContext so Colors & Symbols shows the new values.
      refreshStrataLayers()
    } catch (e) {
      console.error(e)
      setTransferMsg({ ok: false, text: e || 'Transfer failed' })
    } finally {
      setTransferring(false)
    }
  }

  async function handleOpenFile() {
    setOpenMsg(null)
    try {
      await invoke('open_strata')
    } catch (e) {
      console.error(e)
      setOpenMsg({ ok: false, text: e || 'Could not open strata.xlsx' })
    }
  }

  const allChecked = types.length > 0 && types.every(t => checked[selKey(t)])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

      {/* Type selection table */}
      <div className="card" style={{ padding: '0.75rem 1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
          <h3 className="section-title" style={{ marginBottom: 0 }}>Available Strata Types</h3>
          <button className="btn-secondary btn-sm" onClick={() => toggleAll(true)}>Select all</button>
          <button className="btn-secondary btn-sm" onClick={() => toggleAll(false)}>Clear</button>
          <div style={{ flex: 1 }} />
          <button
            className="btn-primary"
            disabled={!checkedSelections.length || downloading}
            onClick={handleDownload}
          >
            {downloading
              ? '⏳ Downloading…'
              : `⬇ Download Strata${checkedSelections.length ? ` (${checkedSelections.length})` : ''}`}
          </button>
          <button
            className="btn-secondary"
            disabled={!checkedSelections.length || transferring}
            onClick={handleTransfer}
            title="Copy selected strata into the Strata master sheet (skips existing ProjectID+PointID)"
          >
            {transferring ? '⏳ Transferring…' : '📋 Transfer Strata'}
          </button>
          <button
            className="btn-secondary"
            onClick={handleOpenFile}
            title="Open strata.xlsx in Excel"
          >
            📂 Open Strata Sheet
          </button>
        </div>

        {dlMsg && (
          <p className={`msg ${dlMsg.ok ? 'ok' : 'err'}`} style={{ marginBottom: '0.5rem' }}>
            {dlMsg.text}
          </p>
        )}
        {transferMsg && (
          <p className={`msg ${transferMsg.ok ? 'ok' : 'err'}`} style={{ marginBottom: '0.5rem' }}>
            {transferMsg.text}
          </p>
        )}
        {openMsg && (
          <p className={`msg err`} style={{ marginBottom: '0.5rem' }}>
            {openMsg.text}
          </p>
        )}

        {loadingTypes ? (
          <p className="hint">Loading…</p>
        ) : typeErr ? (
          <p className="msg err">{typeErr}</p>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 260 }}>
            <table className="data-table">
              <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                <tr>
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={e => toggleAll(e.target.checked)}
                      title="Select / deselect all"
                    />
                  </th>
                  <th>Interpretation</th>
                  <th>Series</th>
                  <th>Description</th>
                  <th style={{ width: 140 }}>DB</th>
                  <th style={{ textAlign: 'right' }}>Points</th>
                  <th style={{ textAlign: 'right' }}>Layers</th>
                </tr>
              </thead>
              <tbody>
                {types.length === 0 && (
                  <tr><td colSpan={7} className="no-data">No strata found for this selection</td></tr>
                )}
                {types.map(t => {
                  const k = selKey(t)
                  // Normalise to an array — backend now sends `db_ids`, but a
                  // legacy session restore could still carry a single `db_id`.
                  const dbList = Array.isArray(t.db_ids)
                    ? t.db_ids
                    : (t.db_id ? [t.db_id] : [])
                  return (
                    <tr
                      key={k}
                      className={checked[k] ? 'selected' : ''}
                      onClick={() => setChecked(p => ({ ...p, [k]: !p[k] }))}
                    >
                      <td>
                        <input
                          type="checkbox"
                          checked={!!checked[k]}
                          onChange={() => {}}
                          onClick={e => e.stopPropagation()}
                        />
                      </td>
                      <td>{t.Interpretation}</td>
                      <td>{t.series}</td>
                      <td>{t.Description}</td>
                      <td>
                        {dbList.length === 0
                          ? <span style={{ color: '#9ca3af', fontSize: '.75rem' }}>—</span>
                          : dbList.map(id => <DbIdPill key={id} id={id} />)}
                      </td>
                      <td style={{ textAlign: 'right' }}>{t.Point_Count}</td>
                      <td style={{ textAlign: 'right' }}>{t.Layer_Count}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Preview panels — one collapsible section per selected type */}
      {checkedSelections.length > 0 && (
        <div>
          <h3 className="section-title">
            Preview{' '}
            {loadingData && <span className="hint" style={{ fontWeight: 400 }}>Loading…</span>}
          </h3>
          {checkedSelections.map(t => {
            const k    = selKey(t)
            const rows = preview[k] || []
            return (
              <details key={k} open style={{ marginBottom: '0.75rem' }}>
                <summary style={{ cursor: 'pointer', fontWeight: 600, padding: '0.3rem 0' }}>
                  {t.series} — {t.Interpretation}
                  <span className="hint" style={{ fontWeight: 400, marginLeft: 8 }}>
                    ({rows.length} row{rows.length !== 1 ? 's' : ''})
                  </span>
                </summary>
                <div className="table-wrap" style={{ maxHeight: 220 }}>
                  <table className="data-table">
                    <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                      <tr>
                        <th>PointNo</th>
                        <th style={{ textAlign: 'right' }}>Depth From [m]</th>
                        <th style={{ textAlign: 'right' }}>Depth To [m]</th>
                        <th>Primary Layer</th>
                        <th>Secondary Layer</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 && (
                        <tr><td colSpan={5} className="no-data">No data</td></tr>
                      )}
                      {rows.slice(0, 10).map((r, i) => (
                        <tr key={i}>
                          <td>{r.PointNo}</td>
                          <td style={{ textAlign: 'right' }}>{r.From}</td>
                          <td style={{ textAlign: 'right' }}>{r.To}</td>
                          <td>{r.Layer}</td>
                          <td>{r.Description}</td>
                        </tr>
                      ))}
                      {rows.length > 10 && (
                        <tr>
                          <td colSpan={5} className="no-data" style={{ fontStyle: 'italic' }}>
                            … {rows.length - 10} more rows not shown (download to see all)
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </details>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Sub-tab 2: Error Correction ───────────────────────────────────────────────
//
// Reads from / writes to the "Strata" master sheet in strata.xlsx.
// The user pastes rows from the downloaded data sheets into that Excel sheet,
// then clicks "Load Strata" here to inspect and fix them.

function ErrorTab({ onErrorCountChange }) {
  const { selectedProjects } = useApp()
  const { refreshStrataLayers } = useFilter()

  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(false)
  const [saving,  setSaving]  = useState(false)
  const [loadMsg, setLoadMsg] = useState(null)
  const [saveMsg, setSaveMsg] = useState(null)
  const [filter,  setFilter]  = useState('all')   // 'all' | 'errors'

  const issues        = useMemo(() => detectErrors(rows), [rows])
  const filteredIssues = useMemo(
    () => filter === 'errors' ? issues.filter(i => i.severity === 'error') : issues,
    [issues, filter],
  )
  const errorCount   = issues.filter(i => i.severity === 'error').length
  const warningCount = issues.filter(i => i.severity === 'warning').length

  // Bubble error count up so the tab badge stays current
  useEffect(() => { onErrorCountChange(errorCount) }, [errorCount]) // eslint-disable-line

  async function loadStrata() {
    setLoading(true); setLoadMsg(null); setSaveMsg(null)
    try {
      const r = await invoke('load_strata')
      setRows(r)
      setLoadMsg({ ok: true, text: `Loaded ${r.length} row${r.length !== 1 ? 's' : ''} from the Strata sheet` })
    } catch (e) {
      console.error(e)
      setLoadMsg({ ok: false, text: e || 'Failed to load Strata sheet' })
    } finally {
      setLoading(false)
    }
  }

  // #213: re-load when another window edits / re-downloads / transfers strata.
  useDataChanged('strata', loadStrata)

  async function saveCorrections() {
    setSaving(true); setSaveMsg(null)
    try {
      const r = await invokeAndNotify('strata', 'update_strata', { rows })
      setSaveMsg({ ok: true, text: `Saved ${r.rows} row${r.rows !== 1 ? 's' : ''} back to the Strata sheet` })
      // Re-read the Strata sheet so Colors & Symbols layer lists stay current.
      refreshStrataLayers()
    } catch (e) {
      console.error(e)
      setSaveMsg({ ok: false, text: e || 'Failed to save corrections' })
    } finally {
      setSaving(false)
    }
  }

  function deleteRow(rowIdx) {
    setRows(prev => prev.filter((_, i) => i !== rowIdx))
  }

  function editRow(rowIdx, field, value) {
    setRows(prev => prev.map((r, i) =>
      i === rowIdx ? { ...r, [field]: value === '' ? '' : Number(value) } : r
    ))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn-primary" onClick={loadStrata} disabled={loading}>
          {loading ? '⏳ Loading…' : '📂 Load Strata'}
        </button>

        {rows.length > 0 && (
          <button
            className="btn-secondary"
            onClick={saveCorrections}
            disabled={saving || errorCount > 0}
            title={errorCount > 0 ? 'Fix all errors before saving' : 'Write corrections back to strata.xlsx'}
          >
            {saving ? '⏳ Saving…' : '💾 Save Corrections'}
          </button>
        )}

        {/* Filter toggle — only relevant once rows are loaded */}
        {rows.length > 0 && (
          <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid var(--border)', fontSize: '0.82rem' }}>
            {[
              { value: 'all',    label: '⚠ Errors & warnings' },
              { value: 'errors', label: '🔴 Errors only' },
            ].map(opt => (
              <button
                key={opt.value}
                onClick={() => setFilter(opt.value)}
                style={{
                  padding: '3px 10px',
                  border: 'none',
                  cursor: 'pointer',
                  background: filter === opt.value ? 'var(--accent, #2563eb)' : 'transparent',
                  color:      filter === opt.value ? '#fff' : 'inherit',
                  fontWeight: filter === opt.value ? 600 : 400,
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Load / save messages */}
      {loadMsg && <p className={`msg ${loadMsg.ok ? 'ok' : 'err'}`} style={{ margin: 0 }}>{loadMsg.text}</p>}
      {saveMsg && <p className={`msg ${saveMsg.ok ? 'ok' : 'err'}`} style={{ margin: 0 }}>{saveMsg.text}</p>}

      {/* Empty state */}
      {rows.length === 0 && !loadMsg && (
        <div className="hint" style={{ padding: '1rem 0' }}>
          <p style={{ margin: '0 0 0.4rem' }}>
            Click <strong>Load Strata</strong> to read the <em>Strata</em> master sheet from strata.xlsx.
          </p>
          <p style={{ margin: 0, fontSize: '0.8rem' }}>
            Paste rows from the downloaded data sheets into that sheet in Excel first,
            then load here to check and fix gaps, overlaps, and negative thicknesses.
          </p>
        </div>
      )}

      {/* Issue summary + hint */}
      {rows.length > 0 && (
        <div style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>
          <strong>{rows.length}</strong> row{rows.length !== 1 ? 's' : ''} loaded &nbsp;·&nbsp;
          {issues.length === 0
            ? <span style={{ color: 'var(--ok-fg)' }}>✔ No issues found</span>
            : <>
                {errorCount > 0 && <span style={{ color: 'var(--err-fg)' }}>{errorCount} error{errorCount !== 1 ? 's' : ''}</span>}
                {errorCount > 0 && warningCount > 0 && ' · '}
                {warningCount > 0 && <span style={{ color: 'var(--warn-fg)' }}>{warningCount} warning{warningCount !== 1 ? 's' : ''}</span>}
                {filter === 'errors' && warningCount > 0 && <span style={{ color: 'var(--muted)' }}> (warnings hidden)</span>}
              </>
          }
          <span className="hint" style={{ marginLeft: 8 }}>
            🔴 J Overlap · 🔴 K Negative thickness · ⚠ I Gap in boundary
          </span>
        </div>
      )}

      {/* Error windows */}
      {rows.length > 0 && filteredIssues.length === 0 && issues.length > 0 && (
        <p style={{ color: 'var(--ok-fg)', margin: 0 }}>
          ✔ No errors — only warnings remain (switch to "Errors &amp; warnings" to view them).
        </p>
      )}
      {rows.length > 0 && issues.length === 0 && (
        <p style={{ color: 'var(--ok-fg)', margin: 0 }}>
          ✔ All layers are consistent — no gaps, overlaps, or negative thicknesses.
        </p>
      )}
      {filteredIssues.length > 0 && (
        <ErrorWindowList
          rows={rows}
          issues={filteredIssues}
          onDelete={deleteRow}
          onEdit={editRow}
        />
      )}
    </div>
  )
}

// ── Borehole error clusters (issue #178, M6 / plan Q-C1) ─────────────────────
//
// Issues are grouped by the WHOLE borehole (db_id, ProjectId, PointId):
//   • only boreholes containing at least one of the (filtered) issues appear;
//   • each cluster lists ALL of that borehole's rows — full context — with the
//     problem rows flagged/coloured;
//   • the cluster header carries the DB pill, PointNo, and per-borehole counts.

function ErrorWindowList({ rows, issues, onDelete, onEdit }) {
  const issueByRow = {}
  issues.forEach(iss => {
    if (!issueByRow[iss.rowIdx]) issueByRow[iss.rowIdx] = []
    issueByRow[iss.rowIdx].push(iss)
  })

  // Group every row index by its borehole; keep insertion (depth) order.
  const bhKey = (r) =>
    `${r.db_id ?? '?'}||${r.ProjectId ?? r.ProjectID ?? ''}||${r.PointId ?? r.PointID ?? ''}`
  const clusters = new Map() // key → { db_id, pointNo, rowIdxs }
  rows.forEach((r, idx) => {
    const k = bhKey(r)
    if (!clusters.has(k)) clusters.set(k, { key: k, db_id: r.db_id, pointNo: r.PointNo, rowIdxs: [] })
    clusters.get(k).rowIdxs.push(idx)
  })

  // Only boreholes that contain at least one of the (filtered) issues.
  const problemKeys = new Set(issues.map(i => rows[i.rowIdx] ? bhKey(rows[i.rowIdx]) : ''))
  const shown = [...clusters.values()].filter(c => problemKeys.has(c.key))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem', marginTop: '0.5rem' }}>
      {shown.map(cluster => {
        const clusterIssues = cluster.rowIdxs.flatMap(idx => issueByRow[idx] || [])
        const nErr  = clusterIssues.filter(x => x.severity === 'error').length
        const nWarn = clusterIssues.filter(x => x.severity === 'warning').length

        // Issue #192: show at most ±CONTEXT layers around each problem row —
        // overlapping windows within the borehole merge into one segment;
        // hidden stretches collapse into separator rows.
        const CONTEXT = 2
        const len = cluster.rowIdxs.length
        const probs = cluster.rowIdxs
          .map((ri, li) => (issueByRow[ri] ? li : -1))
          .filter(li => li >= 0)
        const segs = []
        {
          let i = 0
          while (i < probs.length) {
            let s = Math.max(0, probs[i] - CONTEXT)
            let e = Math.min(len - 1, probs[i] + CONTEXT)
            while (i + 1 < probs.length && probs[i + 1] - CONTEXT <= e + 1) {
              i++
              e = Math.min(len - 1, probs[i] + CONTEXT)
            }
            segs.push({ s, e })
            i++
          }
        }
        const sepRow = (key, text) => (
          <tr key={key}>
            <td colSpan={6} style={{ fontSize: '.72em', color: '#9ca3af', background: '#f9fafb', padding: '2px 8px' }}>
              {text}
            </td>
          </tr>
        )
        const renderClusterRow = (rowIdx) => {
          const row = rows[rowIdx]
          if (!row) return null
          const rowIssues = issueByRow[rowIdx] || []
          const isError   = rowIssues.some(x => x.severity === 'error')
          const isWarn    = rowIssues.some(x => x.severity === 'warning')
          const bg = isError ? '#fee2e2' : isWarn ? '#fef9c3' : undefined
          return (
            <tr key={rowIdx} style={{ background: bg }}>
              <td style={{ fontSize: '0.78em', lineHeight: 1.4 }}>
                {rowIssues.map(iss => (
                  <div key={iss.type} style={{ whiteSpace: 'nowrap' }}>
                    {iss.type === ERR_NEG     && '🔴 K: Negative thickness'}
                    {iss.type === ERR_OVERLAP && '🔴 J: Overlapping'}
                    {iss.type === WARN_GAP    && '⚠ I: Gap in boundary'}
                  </div>
                ))}
              </td>
              <td style={{ textAlign: 'right' }}>
                <input
                  type="number"
                  step="0.01"
                  value={row.From}
                  onChange={e => onEdit(rowIdx, 'From', e.target.value)}
                  style={{ width: 80, textAlign: 'right' }}
                />
              </td>
              <td style={{ textAlign: 'right' }}>
                <input
                  type="number"
                  step="0.01"
                  value={row.To}
                  onChange={e => onEdit(rowIdx, 'To', e.target.value)}
                  style={{ width: 80, textAlign: 'right' }}
                />
              </td>
              <td>{row.Layer}</td>
              <td>{row.Description}</td>
              <td
                style={{
                  position: 'sticky',
                  right: 0,
                  background: bg ?? '#fff',
                  zIndex: 1,
                  boxShadow: '-3px 0 4px rgba(0, 0, 0, 0.06)',
                }}
              >
                <button
                  className="btn-secondary btn-sm btn-danger"
                  style={{ padding: '1px 6px' }}
                  title="Delete this layer row"
                  onClick={() => onDelete(rowIdx)}
                >
                  ✕ Delete
                </button>
              </td>
            </tr>
          )
        }
        return (
          <div
            key={cluster.key}
            style={{
              border: '1px solid var(--border)',
              borderRadius: 4,
              width: '100%',
              overflowX: 'auto',
            }}
          >
            {/* Borehole header */}
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: '.5rem',
                padding: '4px 8px', background: '#f8fafc',
                borderBottom: '1px solid var(--border)',
                fontSize: '0.85em', fontWeight: 600,
              }}
            >
              <DbIdPill id={cluster.db_id} />
              <span>{cluster.pointNo}</span>
              <span style={{ fontWeight: 400, color: '#64748b' }}>
                · {cluster.rowIdxs.length} layer{cluster.rowIdxs.length !== 1 ? 's' : ''}
              </span>
              <span style={{ marginLeft: 'auto', fontWeight: 400 }}>
                {nErr > 0 && <span style={{ color: '#dc2626' }}>{nErr} error{nErr !== 1 ? 's' : ''}</span>}
                {nErr > 0 && nWarn > 0 && ' · '}
                {nWarn > 0 && <span style={{ color: '#d97706' }}>{nWarn} warning{nWarn !== 1 ? 's' : ''}</span>}
              </span>
            </div>
            <table className="data-table" style={{ margin: 0, minWidth: '100%' }}>
              <thead>
                <tr>
                  <th style={{ width: 130 }}>Issue</th>
                  <th style={{ textAlign: 'right' }}>Depth From [m]</th>
                  <th style={{ textAlign: 'right' }}>Depth To [m]</th>
                  <th>Primary Layer</th>
                  <th>Secondary Layer</th>
                  {/* Delete column pinned right (carried over from #99). */}
                  <th
                    style={{
                      width: 90,
                      position: 'sticky',
                      right: 0,
                      background: '#fff',
                      zIndex: 1,
                      boxShadow: '-3px 0 4px rgba(0, 0, 0, 0.06)',
                    }}
                  />
                </tr>
              </thead>
              <tbody>
                {segs.flatMap((seg, si) => {
                  const out = []
                  if (si === 0 && seg.s > 0) {
                    out.push(sepRow(`t${si}`, `↑ ${seg.s} layer${seg.s !== 1 ? 's' : ''} above not shown`))
                  }
                  if (si > 0) {
                    const hidden = seg.s - segs[si - 1].e - 1
                    if (hidden > 0) out.push(sepRow(`m${si}`, `⋯ ${hidden} layer${hidden !== 1 ? 's' : ''} hidden`))
                  }
                  for (let li = seg.s; li <= seg.e; li++) {
                    out.push(renderClusterRow(cluster.rowIdxs[li]))
                  }
                  if (si === segs.length - 1 && seg.e < len - 1) {
                    const below = len - 1 - seg.e
                    out.push(sepRow(`b${si}`, `↓ ${below} layer${below !== 1 ? 's' : ''} below not shown`))
                  }
                  return out
                })}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function StrataPage() {
  const { selectedProjects, selectedPoints } = useApp()
  const [subTab,      setSubTab]      = useState('selection')
  const [totalErrors, setTotalErrors] = useState(0)

  if (!selectedProjects.length) {
    return (
      <div className="page page-wide">
        <p className="hint">Select a project first.</p>
      </div>
    )
  }

  return (
    <div className="page page-wide">
      {/* Sub-tab bar */}
      <div className="grp-cs-tabs" style={{ marginBottom: '1rem' }}>
        <button
          className={`grp-cs-tab${subTab === 'selection' ? ' active' : ''}`}
          onClick={() => setSubTab('selection')}
        >
          Selection &amp; Preview
        </button>
        <button
          className={`grp-cs-tab${subTab === 'errors' ? ' active' : ''}`}
          onClick={() => setSubTab('errors')}
        >
          Error Correction
          {totalErrors > 0 && (
            <span style={{
              marginLeft: 6,
              background: '#dc2626', color: '#fff',
              borderRadius: 99, fontSize: '0.72em', padding: '1px 6px',
            }}>
              {totalErrors}
            </span>
          )}
        </button>
      </div>

      {/* Keep ErrorTab mounted so loaded rows survive tab switches */}
      <div style={{ display: subTab === 'selection' ? 'block' : 'none' }}>
        <SelectionTab
          selectedProjects={selectedProjects}
          selectedPoints={selectedPoints}
        />
      </div>
      <div style={{ display: subTab === 'errors' ? 'block' : 'none' }}>
        <ErrorTab onErrorCountChange={setTotalErrors} />
      </div>
    </div>
  )
}
