import { useState, useEffect } from 'react'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'

export default function DataPage() {
  const { selectedProjects, selectedPoints, connection } = useApp()

  // ── Query list (read-only — editing moved to Settings → Query Config in #47) ─
  const [queries, setQueries]   = useState([])
  const [loadingQ, setLoadingQ] = useState(false)

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
  useEffect(() => { if (projectId) fetchQueries() }, [projectId])  // eslint-disable-line react-hooks/exhaustive-deps

  // Select all queries by default when list loads
  useEffect(() => {
    const all = {}
    queries.forEach(q => { all[q.fname] = true })
    setSelected(all)
  }, [queries])

  async function fetchQueries() {
    setLoadingQ(true); setError('')
    try {
      const res = await invoke('list_queries', { projectId })
      setQueries(res)
    } catch (err) {
      console.error(err)
      setError(err || 'Failed to load queries')
    } finally { setLoadingQ(false) }
  }

  // ── Data save ─────────────────────────────────────────────────────────────

  const [appendResult, setAppendResult] = useState(null)
  const [appending,    setAppending]    = useState(false)

  function buildPayload(queryNames) {
    // Issue #105: send project_ids / point_ids in per-DB form so the
    // backend can fan out across every database.  Each entry carries
    // the db_id of the source database so download_data groups them
    // correctly.  Falls back to the legacy ProjectId-only shape when
    // the upstream rows don't have db_id (shouldn't happen post-#51).
    const hasProjDb = selectedProjects.some(p => p?.db_id)
    const hasPtDb   = selectedPoints.some(p => p?.db_id)
    return {
      // Primary project — used by the backend for strata lookup.
      project_id:    selectedProjects[0]?.ProjectId ?? '',
      project_ids:   hasProjDb
        ? selectedProjects.map(p => ({ db_id: p.db_id, ProjectId: p.ProjectId }))
        : selectedProjects.map(p => p.ProjectId),
      point_ids:     hasPtDb
        ? selectedPoints.map(p => ({ db_id: p.db_id, PointId: p.PointId }))
        : selectedPoints.map(p => p.PointId),
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
      const res = await invoke('download_data', { projectId, query: buildPayload(queryNames) })
      setSaveResult(res)
    } catch (err) {
      console.error(err)
      setError(err || 'Save failed — check the backend log.')
    } finally { setSavingData(false) }
  }

  async function handleAppend() {
    setAppending(true); setSaveResult(null); setAppendResult(null); setReaddResult(null); setError('')
    const queryNames = Object.entries(selected).filter(([, v]) => v).map(([k]) => k)
    try {
      const res = await invoke('append_data', { projectId, query: buildPayload(queryNames) })
      setAppendResult(res)
    } catch (err) {
      console.error(err)
      setError(err || 'Append failed — check the backend log.')
    } finally { setAppending(false) }
  }

  async function handleReaddStrata() {
    setReaddingStrata(true); setSaveResult(null); setAppendResult(null); setReaddResult(null); setError('')
    try {
      const res = await invoke('readd_strata', { projectId, query: buildPayload([]) })
      setReaddResult(res)
    } catch (err) {
      console.error(err)
      setError(err || 'Re-add strata failed — check the backend log.')
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
        {/*
          The legacy in-page "Query config" tab moved to Settings → Query Config
          in issue #47.  The Save data tab is the only one left here.
        */}
      </div>

      <p className="hint" style={{ marginBottom: '1.25rem' }}>
        Project: <strong>{selectedProjects.map(p => p.ProjectNo).join(', ')}</strong>
        {selectedPoints.length > 0
          ? <> · <strong>{selectedPoints.length} point{selectedPoints.length > 1 ? 's' : ''}</strong> selected</>
          : <> · <em>all points</em></>}
      </p>

      {error && <p className="msg err" style={{ marginBottom: '1rem' }}>{error}</p>}

      {/* ══ SAVE DATA ═════════════════════════════════════════════════════ */}
      {(
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
                    {savingData ? '⏳ Downloading…' : `⬇ Download ${numSelected} datasheet${numSelected !== 1 ? 's' : ''}`}
                  </button>
                  <button className="btn-secondary" onClick={handleAppend}
                          disabled={savingData || appending || readdingStrata || numSelected === 0} style={{ minWidth: 180 }}
                          title="Append only rows whose ID is not already in the file">
                    {appending ? '⏳ Appending…' : `⊕ Append ${numSelected} datasheet${numSelected !== 1 ? 's' : ''}`}
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

      {/* The in-page Query Config tab moved to Settings → Query Config (issue #47). */}
    </div>
  )
}
