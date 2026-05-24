import { useState, useEffect } from 'react'
import axios from 'axios'
import { useApp } from '../context/AppContext'

const EMPTY_QUERY = { fname: '', SQLScript: '', pointfilter: '', apply_strata: 'No' }

export default function DataPage() {
  const { selectedProjects, selectedPoints, connection } = useApp()

  // ── Tab ───────────────────────────────────────────────────────────────────
  const [tab, setTab] = useState('download')

  // ── Query list ────────────────────────────────────────────────────────────
  const [queries, setQueries]       = useState([])
  const [loadingQ, setLoadingQ]     = useState(false)
  const [savingQuery, setSavingQuery] = useState(false)
  const [querySaved, setQuerySaved] = useState(false)
  const [editing, setEditing]       = useState(null)
  const [form, setForm]             = useState(EMPTY_QUERY)

  // ── Data save ─────────────────────────────────────────────────────────────
  const [selected, setSelected]     = useState({})   // fname -> bool
  const [savingData, setSavingData] = useState(false)
  const [saveResult, setSaveResult] = useState(null)

  // ── Re-add Strata ─────────────────────────────────────────────────────────
  const [readdingStrata, setReaddingStrata] = useState(false)
  const [readdResult,    setReaddResult]    = useState(null)

  // ── Shared error ──────────────────────────────────────────────────────────
  const [error, setError] = useState('')

  const projectId = selectedProjects[0]?.ProjectId

  // Load queries when project changes
  useEffect(() => { if (projectId) fetchQueries() }, [projectId])

  // Select all queries by default when list loads
  useEffect(() => {
    const all = {}
    queries.forEach(q => { all[q.fname] = true })
    setSelected(all)
  }, [queries])

  // ── Query CRUD ────────────────────────────────────────────────────────────

  async function fetchQueries() {
    setLoadingQ(true); setError('')
    try {
      const res = await axios.get(`/api/queries/${projectId}`)
      setQueries(res.data)
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to load queries')
    } finally { setLoadingQ(false) }
  }

  async function saveAllQueries(updated) {
    setSavingQuery(true); setQuerySaved(false)
    try {
      await axios.post(`/api/queries/${projectId}`, updated)
      setQuerySaved(true)
      setTimeout(() => setQuerySaved(false), 2500)
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to save queries')
    } finally { setSavingQuery(false) }
  }

  function openNew()    { setForm(EMPTY_QUERY); setEditing('new') }
  function cancelEdit() { setEditing(null); setForm(EMPTY_QUERY) }
  const handleFormChange = e => setForm(f => ({ ...f, [e.target.name]: e.target.value }))

  function commitEdit() {
    if (!form.fname.trim() || !form.SQLScript.trim()) return
    const updated = editing === 'new'
      ? [...queries, form]
      : queries.map((q, i) => i === editing ? form : q)
    setQueries(updated)
    saveAllQueries(updated)
    cancelEdit()
  }

  function deleteQuery(idx) {
    if (!window.confirm(`Delete query "${queries[idx].fname}"?`)) return
    const updated = queries.filter((_, i) => i !== idx)
    setQueries(updated)
    saveAllQueries(updated)
  }

  function moveUp(idx) {
    if (idx === 0) return
    const u = [...queries]; [u[idx-1], u[idx]] = [u[idx], u[idx-1]]
    setQueries(u); saveAllQueries(u)
  }

  function moveDown(idx) {
    if (idx === queries.length - 1) return
    const u = [...queries]; [u[idx], u[idx+1]] = [u[idx+1], u[idx]]
    setQueries(u); saveAllQueries(u)
  }

  function openEdit(idx) { setForm({ ...queries[idx] }); setEditing(idx) }

  // ── Data save ─────────────────────────────────────────────────────────────

  const [appendResult, setAppendResult] = useState(null)
  const [appending,    setAppending]    = useState(false)

  function buildPayload(queryNames) {
    return {
      project_ids:   selectedProjects.map(p => p.ProjectId),
      point_ids:     selectedPoints.map(p => p.PointId),
      query_names:   queryNames,
      projects_meta: selectedProjects.map(p => ({
        ProjectId: p.ProjectId, ProjectNo: p.ProjectNo, Title: p.Title,
      })),
      points_meta: selectedPoints.map(p => ({
        PointId: p.PointId, PointNo: p.PointNo, PointType: p.PointType,
      })),
    }
  }

  async function handleSave() {
    setSavingData(true); setSaveResult(null); setAppendResult(null); setReaddResult(null); setError('')
    const queryNames = Object.entries(selected).filter(([, v]) => v).map(([k]) => k)
    try {
      const res = await axios.post(`/api/download/${projectId}`, buildPayload(queryNames))
      setSaveResult(res.data)
    } catch (err) {
      setError(err.response?.data?.detail || 'Save failed — check the backend log.')
    } finally { setSavingData(false) }
  }

  async function handleAppend() {
    setAppending(true); setSaveResult(null); setAppendResult(null); setReaddResult(null); setError('')
    const queryNames = Object.entries(selected).filter(([, v]) => v).map(([k]) => k)
    try {
      const res = await axios.post(`/api/download/${projectId}/append`, buildPayload(queryNames))
      setAppendResult(res.data)
    } catch (err) {
      setError(err.response?.data?.detail || 'Append failed — check the backend log.')
    } finally { setAppending(false) }
  }

  async function handleReaddStrata() {
    setReaddingStrata(true); setSaveResult(null); setAppendResult(null); setReaddResult(null); setError('')
    try {
      const res = await axios.post(`/api/download/${projectId}/readd-strata`, buildPayload([]))
      setReaddResult(res.data)
    } catch (err) {
      setError(err.response?.data?.detail || 'Re-add strata failed — check the backend log.')
    } finally { setReaddingStrata(false) }
  }

  // ── Guard ─────────────────────────────────────────────────────────────────

  if (!selectedProjects.length) {
    return (
      <div className="page">
        <h2 className="page-title">Data</h2>
        <p className="hint">Select a project first.</p>
      </div>
    )
  }

  const numSelected = Object.values(selected).filter(Boolean).length
  const hasFolder   = !!connection?.output_folder

  return (
    <div className="page">
      <div className="page-header">
        <h2 className="page-title">Data</h2>
        <div className="tab-bar">
          <button className={`tab ${tab === 'download' ? 'active' : ''}`}
                  onClick={() => setTab('download')}>Save data</button>
          <button className={`tab ${tab === 'queries'  ? 'active' : ''}`}
                  onClick={() => setTab('queries')}>Query config</button>
        </div>
      </div>

      <p className="hint" style={{ marginBottom: '1.25rem' }}>
        Project: <strong>{selectedProjects.map(p => p.ProjectNo).join(', ')}</strong>
        {selectedPoints.length > 0
          ? <> · <strong>{selectedPoints.length} point{selectedPoints.length > 1 ? 's' : ''}</strong> selected</>
          : <> · <em>all points</em></>}
      </p>

      {error && <p className="msg err" style={{ marginBottom: '1rem' }}>{error}</p>}

      {/* ══ SAVE DATA TAB ══════════════════════════════════════════════════ */}
      {tab === 'download' && (
        <div className="card" style={{ maxWidth: 620, gap: '1rem' }}>

          {/* Query checklist */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>Select queries to save</strong>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn-secondary btn-sm"
                onClick={() => setSelected(Object.fromEntries(queries.map(q => [q.fname, true])))}>
                All
              </button>
              <button className="btn-secondary btn-sm" onClick={() => setSelected({})}>
                None
              </button>
            </div>
          </div>

          {loadingQ ? <p className="hint">Loading queries…</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {queries.map(q => (
                <label key={q.fname} className="query-check-row">
                  <input type="checkbox"
                    checked={!!selected[q.fname]}
                    onChange={() => setSelected(s => ({ ...s, [q.fname]: !s[q.fname] }))}
                  />
                  <span className="query-check-name">{q.fname}</span>
                  <span className={`strata-badge ${q.apply_strata === 'Yes' ? 'yes' : 'no'}`}>
                    {q.apply_strata === 'Yes' ? 'Strata' : 'No strata'}
                  </span>
                </label>
              ))}
            </div>
          )}

          {/* Save action */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
            {!hasFolder ? (
              <p className="msg err">
                No output folder configured — go to <strong>⚙ Settings</strong> and set a folder path first.
              </p>
            ) : (
              <>
                <p className="hint" style={{ marginBottom: '0.75rem' }}>
                  Saving to: <code>{connection.output_folder}</code>
                </p>
                <div style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap' }}>
                  <button className="btn-primary" onClick={handleSave}
                          disabled={savingData || appending || readdingStrata || numSelected === 0} style={{ minWidth: 180 }}>
                    {savingData ? '⏳ Saving…' : `💾 Save ${numSelected} file${numSelected !== 1 ? 's' : ''}`}
                  </button>
                  <button className="btn-secondary" onClick={handleAppend}
                          disabled={savingData || appending || readdingStrata || numSelected === 0} style={{ minWidth: 180 }}
                          title="Append only rows whose ID is not already in the file">
                    {appending ? '⏳ Appending…' : `⊕ Append ${numSelected} file${numSelected !== 1 ? 's' : ''}`}
                  </button>
                  <button className="btn-secondary" onClick={handleReaddStrata}
                          disabled={savingData || appending || readdingStrata}
                          title="Re-apply Primary Layer / Secondary Layer from strata.xlsx to all data files with Apply Strata = Yes">
                    {readdingStrata ? '⏳ Re-adding…' : '🪨 Re-add Strata'}
                  </button>
                </div>
              </>
            )}

            {saveResult && (
              <div className="save-result">
                <p className="save-result-folder">✓ Saved to: <strong>{saveResult.folder}</strong></p>
                <div className="save-result-list">
                  {saveResult.saved.map(f => (
                    <div key={f.file} className="save-result-row ok">
                      <span className="save-result-name">{f.file}</span>
                      <span className="save-result-rows">{f.rows.toLocaleString()} rows</span>
                      {f.sp_upload?.uploaded && (
                        <span style={{ marginLeft: 6, color: '#0369a1', fontSize: '.78rem' }} title="Uploaded to SharePoint">☁</span>
                      )}
                      {f.sp_upload?.error && (
                        <span style={{ marginLeft: 6, color: '#b91c1c', fontSize: '.78rem' }} title={`SharePoint upload failed: ${f.sp_upload.error}`}>☁⚠</span>
                      )}
                    </div>
                  ))}
                  {saveResult.errors.map(e => (
                    <div key={e.file} className="save-result-row err">
                      <span className="save-result-name">{e.file}</span>
                      <span className="save-result-rows" style={{ color: '#991b1b' }}>{e.error}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {appendResult && (
              <div className="save-result">
                <p className="save-result-folder">⊕ Appended to: <strong>{appendResult.folder}</strong></p>
                <div className="save-result-list">
                  {appendResult.results?.map(f => (
                    <div key={f.file} className="save-result-row ok">
                      <span className="save-result-name">{f.file}</span>
                      <span className="save-result-rows">
                        +{f.appended} appended · {f.skipped} already present
                      </span>
                      {f.sp_upload?.uploaded && (
                        <span style={{ marginLeft: 6, color: '#0369a1', fontSize: '.78rem' }} title="Uploaded to SharePoint">☁</span>
                      )}
                      {f.sp_upload?.error && (
                        <span style={{ marginLeft: 6, color: '#b91c1c', fontSize: '.78rem' }} title={`SharePoint upload failed: ${f.sp_upload.error}`}>☁⚠</span>
                      )}
                    </div>
                  ))}
                  {appendResult.errors?.map(e => (
                    <div key={e.file} className="save-result-row err">
                      <span className="save-result-name">{e.file}</span>
                      <span className="save-result-rows" style={{ color: '#991b1b' }}>{e.error}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {readdResult && (
              <div className="save-result">
                <p className="save-result-folder">🪨 Strata re-applied</p>
                <div className="save-result-list">
                  {readdResult.updated?.map(f => (
                    <div key={f.file} className="save-result-row ok">
                      <span className="save-result-name">{f.file}</span>
                      <span className="save-result-rows">{f.rows.toLocaleString()} rows updated</span>
                    </div>
                  ))}
                  {readdResult.errors?.map(e => (
                    <div key={e.file} className="save-result-row err">
                      <span className="save-result-name">{e.file}</span>
                      <span className="save-result-rows" style={{ color: '#991b1b' }}>{e.error}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══ QUERY CONFIG TAB ════════════════════════════════════════════════ */}
      {tab === 'queries' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginBottom: '1rem' }}>
            {querySaved && <span className="msg ok" style={{ padding: '0.3rem 0.75rem' }}>✓ Saved</span>}
            <button className="btn-secondary" onClick={fetchQueries}>↻ Reload</button>
            <button className="btn-primary"   onClick={openNew}>+ Add query</button>
          </div>

          <p className="hint" style={{ marginBottom: '1rem' }}>
            Placeholders: <code>#DB#</code> database prefix &nbsp;·&nbsp;
            <code>#projectid#</code> active project IDs &nbsp;·&nbsp;
            <code>#pointfilter#</code> selected point filter
          </p>

          {loadingQ ? <p className="hint">Loading…</p> : (
            <div className="table-wrap" style={{ marginBottom: '1.5rem' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 32 }}></th>
                    <th style={{ width: 160 }}>Sheet name</th>
                    <th>SQL (preview)</th>
                    <th style={{ width: 90 }}>Point filter</th>
                    <th style={{ width: 90 }}>Strata</th>
                    <th style={{ width: 110 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {queries.map((q, i) => (
                    <tr key={i}>
                      <td style={{ textAlign: 'center' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <button className="btn-icon" onClick={() => moveUp(i)}>▲</button>
                          <button className="btn-icon" onClick={() => moveDown(i)}>▼</button>
                        </div>
                      </td>
                      <td><strong>{q.fname}</strong></td>
                      <td className="sql-preview">{q.SQLScript.slice(0, 80)}…</td>
                      <td style={{ fontSize: '0.75rem', color: '#555' }}>{q.pointfilter ? '✓' : '—'}</td>
                      <td>
                        <span className={`strata-badge ${q.apply_strata === 'Yes' ? 'yes' : 'no'}`}>
                          {q.apply_strata}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn-secondary btn-sm" onClick={() => openEdit(i)}>Edit</button>
                          <button className="btn-danger btn-sm"    onClick={() => deleteQuery(i)}>✕</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {queries.length === 0 && (
                    <tr><td colSpan={6} className="no-data">No queries defined</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {editing !== null && (
            <div className="edit-panel">
              <h3 style={{ marginBottom: '1rem', color: 'var(--navy)' }}>
                {editing === 'new' ? 'Add query' : `Edit — ${queries[editing]?.fname}`}
              </h3>
              <div className="form-grid">
                <div className="form-field">
                  <label>Sheet name (fname)</label>
                  <input name="fname" value={form.fname} onChange={handleFormChange}
                         placeholder="e.g. CPTData" />
                </div>
                <div className="form-field">
                  <label>Apply Strata</label>
                  <select name="apply_strata" value={form.apply_strata} onChange={handleFormChange}>
                    <option value="No">No</option>
                    <option value="Yes">Yes</option>
                  </select>
                </div>
              </div>
              <div className="form-field" style={{ marginTop: '0.75rem' }}>
                <label>SQL Script</label>
                <textarea name="SQLScript" value={form.SQLScript} onChange={handleFormChange} rows={6}
                  placeholder="SELECT ... FROM #DB#[Table] WHERE ... IN (#projectid#) #pointfilter# ..." />
              </div>
              <div className="form-field" style={{ marginTop: '0.75rem' }}>
                <label>Point filter clause</label>
                <input name="pointfilter" value={form.pointfilter} onChange={handleFormChange}
                       placeholder="e.g. A.PointId IN (#pointid#)" />
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                <button className="btn-primary" onClick={commitEdit}
                        disabled={!form.fname.trim() || !form.SQLScript.trim()}>
                  {savingQuery ? 'Saving…' : 'Save query'}
                </button>
                <button className="btn-secondary" onClick={cancelEdit}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
