import { useState, useEffect } from 'react'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'
import QueryConfigTab from './QueryConfigTab'

// ── Multi-database tab (issue #46) ───────────────────────────────────────────
// Defaults for a brand-new row.
const DEFAULT_DB_ROW = () => ({
  id:          '',
  type:        'mssql',
  server:      '',
  database:    '',
  auth_method: 'windows',
  username:    '',
  password:    '',
  file_path:   '',
  // Default flavour for a brand-new row (issue #62 dropdown).  The legacy
  // value `"default"` is auto-migrated to `"GeoGIS"` on the backend so
  // existing saved rows still render correctly in the dropdown.
  query_type:  'GeoGIS',
})

// `[A-Za-z0-9_-]+` — same validation the backend enforces.
const ID_RE = /^[A-Za-z0-9_-]+$/

// Issue #73: per-row IDs are auto-generated and read-only.  Numbers start at
// `DB1` and grow as the user adds rows.  `nextDbId` returns the lowest unused
// `DB<N>` so deleting a middle row and re-adding fills the gap rather than
// always climbing.
function nextDbId(rows) {
  const used = new Set((rows || []).map(r => r.id))
  let n = 1
  while (used.has(`DB${n}`)) n += 1
  return `DB${n}`
}

// Issue #97: canonicalise legacy IDs (e.g. `primary`, `db_2`) to the
// `DB<N>` format on load.  Rows already matching the canonical pattern keep
// their number; the rest get assigned the lowest unused number in row order.
// Examples:
//   ['primary']             → ['DB1']
//   ['primary', 'db_2']     → ['DB1', 'DB2']
//   ['DB1', 'primary']      → ['DB1', 'DB2']     (DB1 kept; primary → next free)
//   ['DB5', 'primary']      → ['DB5', 'DB1']     (DB5 kept; primary → DB1)
const DB_ID_RE = /^DB\d+$/
function canonicaliseDbIds(rows) {
  const taken = new Set()
  // Pass 1: rows already canonical keep their id; record their number.
  const out = rows.map(r => {
    if (typeof r?.id === 'string' && DB_ID_RE.test(r.id)) {
      taken.add(parseInt(r.id.slice(2), 10))
      return r
    }
    return null
  })
  // Pass 2: fill the placeholders with the lowest unused DB<N>.
  let nextN = 1
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== null) continue
    while (taken.has(nextN)) nextN += 1
    out[i] = { ...rows[i], id: `DB${nextN}` }
    taken.add(nextN)
    nextN += 1
  }
  return out
}

export default function SettingsPage({ setPage }) {
  const { connection, saveConnection, setConnected, setSelectedProjects, setSelectedPoints } = useApp()
  const [form, setForm]                 = useState(connection)
  const [status, setStatus]             = useState(null)
  const [message, setMessage]           = useState('')
  const [folderStatus,   setFolderStatus]   = useState(null)
  const [folderMsg,      setFolderMsg]      = useState('')
  const [browsingFolder, setBrowsingFolder] = useState(false)
  // Issue #95: restoredSession state removed — selection no longer flows
  // through GIRTool_settings.json.  projects.xlsx / points.xlsx are the
  // source of truth and auto-load on their respective page mounts.
  const [recentFolders,   setRecentFolders]   = useState([])
  // Subtab: 'folder' (project folder picker), 'database' (DB connect), or
  // 'queryConfig' (SQL overrides — issue #47).  Folder is shown first because
  // it drives everything else (DB credentials are loaded FROM the folder).
  const [tab, setTab] = useState('folder')

  // ── Multi-DB state (loaded from list_databases on first tab open) ──────
  // `dbRows` is the in-memory edit buffer.  We load it from disk ONCE per
  // app session — subsequent tab switches reuse the buffer so unsaved row
  // additions / typed-in fields aren't blown away when the user pops over
  // to Project folder or Query Config and back.  Persistence to disk only
  // happens when the user clicks "Save & connect all" (issue #57).
  const [dbRows,     setDbRows]     = useState([])         // array of DB config rows
  const [dbStatus,   setDbStatus]   = useState({})         // id → { ok, message }
  const [dbBusy,     setDbBusy]     = useState(false)
  const [dbMsg,      setDbMsg]      = useState(null)       // { ok, text }
  const [dbLoaded,   setDbLoaded]   = useState(false)      // first-load guard
  // Query Type dropdown options (issue #62).  Always includes "GeoGIS" plus
  // any custom types discovered in `query_configs.<section>` keys.  Re-fetched
  // on every Database tab activation so a type the user just added in Query
  // Config shows up here without an app restart.
  const [availableQueryTypes, setAvailableQueryTypes] = useState(['GeoGIS'])

  // Load list the FIRST time the Database tab is opened in this session.
  // After that the in-memory buffer is the source of truth until the user
  // explicitly saves (which makes the buffer the new on-disk truth) or the
  // app restarts.
  useEffect(() => {
    if (tab !== 'database' || dbLoaded) return
    invoke('list_databases')
      .then(list => {
        const arr = Array.isArray(list) ? list : []
        // If the user has nothing saved yet, seed a single empty row from
        // the legacy `connection` form so they aren't staring at a blank table.
        if (arr.length === 0) {
          // Fresh install — seed with a single auto-numbered row (#73).
          setDbRows([{
            ...DEFAULT_DB_ROW(),
            id:          'DB1',
            server:      form.server      || '',
            database:    form.database    || '',
            auth_method: form.auth_method || 'windows',
            username:    form.username    || '',
            password:    form.password    || '',
          }])
        } else {
          // Issue #97: canonicalise legacy IDs (`primary`, `db_2`, …) to
          // the `DB<N>` format on load.  Rows already matching the
          // canonical pattern keep their number; the rest get the lowest
          // unused DB number in row order.  If anything changed, persist
          // the rewrite so future reads are no-ops.
          const canonical = canonicaliseDbIds(arr)
          const changed = canonical.some((d, i) => d.id !== arr[i].id)
          setDbRows(canonical.map(d => ({ ...DEFAULT_DB_ROW(), ...d })))
          if (changed) {
            invoke('save_databases', { body: { databases: canonical } })
              .catch(err => console.warn('canonicalise save_databases failed:', err))
          }
        }
        setDbStatus({})
        setDbMsg(null)
        setDbLoaded(true)
      })
      .catch(() => {
        // No saved settings + list_databases failed — start with one fresh row.
        setDbRows([{ ...DEFAULT_DB_ROW(), id: 'DB1' }])
        setDbLoaded(true)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, dbLoaded])

  // Refresh the Query Type dropdown options every time the Database tab is
  // activated (issue #62).  Picks up any query types the user just added
  // via Settings → Query Config without requiring a restart.  GeoGIS is
  // always first; user-added types sort alphabetically.
  useEffect(() => {
    if (tab !== 'database') return
    invoke('get_query_configs')
      .then(cfgs => {
        const set = new Set(['GeoGIS'])
        if (cfgs && typeof cfgs === 'object') {
          for (const sec of Object.values(cfgs)) {
            if (sec && typeof sec === 'object') {
              for (const k of Object.keys(sec)) set.add(k)
            }
          }
        }
        const rest = [...set].filter(t => t !== 'GeoGIS').sort((a, b) => a.localeCompare(b))
        setAvailableQueryTypes(['GeoGIS', ...rest])
      })
      .catch(() => setAvailableQueryTypes(['GeoGIS']))
  }, [tab])

  // Update a single field on one row.
  const updateRow = (idx, patch) =>
    setDbRows(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)))

  // Validate IDs uniquely within the list.
  const duplicateIds = (() => {
    const counts = {}
    dbRows.forEach(r => { counts[r.id] = (counts[r.id] || 0) + 1 })
    return new Set(Object.keys(counts).filter(k => k && counts[k] > 1))
  })()
  const invalidIds = new Set(
    dbRows.filter(r => r.id && !ID_RE.test(r.id)).map(r => r.id),
  )

  // Auto-generate the next available DB<N> id — gap-filling so deleting a
  // middle row and re-adding picks the freed number up again (issue #73).
  const addDbRow = () => {
    setDbRows(prev => [...prev, { ...DEFAULT_DB_ROW(), id: nextDbId(prev) }])
  }

  const removeDbRow = (idx) => {
    setDbRows(prev => prev.filter((_, i) => i !== idx))
    setDbStatus(prev => {
      const row = dbRows[idx]
      if (!row) return prev
      const next = { ...prev }
      delete next[row.id]
      return next
    })
  }

  const pickAccessPath = async (idx) => {
    try {
      const r = await invoke('pick_access_file', { initial: dbRows[idx]?.file_path || '' })
      if (r?.path) updateRow(idx, { file_path: r.path })
    } catch (err) {
      console.error('pick_access_file failed:', err)
    }
  }

  const testRow = async (idx) => {
    const row = dbRows[idx]
    if (!row) return
    setDbStatus(prev => ({ ...prev, [row.id]: { ok: null, message: 'Testing…' } }))
    try {
      const r = await invoke('test_database', { cfg: row })
      setDbStatus(prev => ({ ...prev, [row.id]: { ok: !!r.ok, message: r.message || '' } }))
    } catch (err) {
      setDbStatus(prev => ({ ...prev, [row.id]: { ok: false, message: String(err) } }))
    }
  }

  const saveAndConnectAll = async () => {
    setDbMsg(null)
    if (dbRows.length === 0) {
      setDbMsg({ ok: false, text: 'At least one database is required.' })
      return
    }
    if (duplicateIds.size > 0) {
      setDbMsg({ ok: false, text: `Duplicate ID(s): ${[...duplicateIds].join(', ')}` })
      return
    }
    if (invalidIds.size > 0) {
      setDbMsg({ ok: false, text: `Invalid ID(s) (use a-z 0-9 _ - only): ${[...invalidIds].join(', ')}` })
      return
    }
    setDbBusy(true)
    try {
      await invoke('save_databases', { body: { databases: dbRows } })
      const results = await invoke('connect_all_databases')
      const next = {}
      ;(results || []).forEach(r => { next[r.id] = { ok: !!r.ok, message: r.message || '' } })
      setDbStatus(next)
      const failed = (results || []).filter(r => !r.ok)
      if (failed.length === 0) {
        setDbMsg({ ok: true, text: `Saved & connected to ${results.length} database${results.length === 1 ? '' : 's'}.` })
        setConnected(true)
      } else {
        setDbMsg({
          ok: false,
          text: `Saved, but ${failed.length} of ${results.length} failed to connect — see per-row status below.`,
        })
        // The connected flag is true if at least the primary MSSQL succeeded.
        const firstMssql = results.find(r => {
          const row = dbRows.find(rr => rr.id === r.id)
          return row?.type === 'mssql'
        })
        setConnected(!!firstMssql?.ok)
      }
    } catch (err) {
      setDbMsg({ ok: false, text: String(err) })
    } finally {
      setDbBusy(false)
    }
  }

  // Load recent folders on mount + after every successful save.
  useEffect(() => {
    invoke('list_recent_folders')
      .then(list => setRecentFolders(Array.isArray(list) ? list : []))
      .catch(() => setRecentFolders([]))
  }, [folderStatus])

  const handle = e => setForm(f => ({ ...f, [e.target.name]: e.target.value }))

  // ── Database connect ──────────────────────────────────────────────────────────
  const connect = async () => {
    setStatus('testing'); setMessage('')
    try {
      const res = await invoke('connect', {
        server:       form.server,
        database:     form.database,
        authMethod:   form.auth_method,
        username:     form.username,
        password:     form.password,
        outputFolder: form.output_folder,
      })
      saveConnection(form)
      setConnected(true)
      setStatus('ok')
      setMessage(res.message)
    } catch (err) {
      console.error(err)
      setConnected(false)
      setStatus('error')
      setMessage(err || 'Connection failed')
    }
  }

  // ── Browse for folder using native OS dialog ──────────────────────────────────
  const browseFolder = async () => {
    setBrowsingFolder(true)
    try {
      const res = await invoke('browse_folder', { initial: form.output_folder || '' })
      if (res.path) {
        setForm(prev => ({ ...prev, output_folder: res.path }))
      }
    } catch (err) {
      console.error(err)
      alert(`Browse failed: ${err || 'Unknown error'}`)
    } finally {
      setBrowsingFolder(false)
    }
  }

  // ── Test & save folder — then auto-load DB config and restore session ────────
  const testFolder = async () => {
    setFolderStatus('testing'); setFolderMsg('')
    try {
      // 1. Verify the folder is accessible
      const folderRes = await invoke('test_folder', { path: form.output_folder })

      // 2. Look in {folder}/GIRTool_settings.json for stored DB credentials.
      //    If present, use those — they belong to this project.  Otherwise
      //    fall back to whatever is currently in the form (legacy or first-time).
      let dbCfg = { found: false, server: '', database: '', auth_method: '', username: '', password: '' }
      try {
        const r = await invoke('load_folder_db_config', { folder: form.output_folder })
        if (r) {
          dbCfg = {
            found:       !!r.found,
            server:      r.server      ?? '',
            database:    r.database    ?? '',
            auth_method: r.authMethod  ?? '',
            username:    r.username    ?? '',
            password:    r.password    ?? '',
          }
        }
      } catch { /* file may not exist yet — first-time setup */ }

      const merged = {
        server:        dbCfg.found ? dbCfg.server      : form.server,
        database:      dbCfg.found ? dbCfg.database    : form.database,
        auth_method:   dbCfg.found ? dbCfg.auth_method : form.auth_method,
        username:      dbCfg.found ? dbCfg.username    : form.username,
        password:      dbCfg.found ? dbCfg.password    : form.password,
        output_folder: form.output_folder,
      }
      if (dbCfg.found) setForm(merged)
      saveConnection(merged)

      // 3. Try to connect — but DON'T fail the whole flow if DB is down.
      //    The user can still load existing xlsx data (charts, grouping,
      //    strata, boundaries) without a live DB connection.
      let dbOk = false
      let dbErr = ''
      try {
        await invoke('connect', {
          server:       merged.server,
          database:     merged.database,
          authMethod:   merged.auth_method,
          username:     merged.username,
          password:     merged.password,
          outputFolder: merged.output_folder,
        })
        setConnected(true)
        dbOk = true
      } catch (err) {
        console.warn('DB connect failed; continuing in xlsx-only mode:', err)
        setConnected(false)
        dbErr = String(err || 'unknown error')
      }

      // 3b. Also connect every saved multi-DB entry (issue #75) — the backend
      //     reads GIRTool_settings.json::databases[] when its in-memory list
      //     is empty, so the user doesn't have to open the Database tab and
      //     hit "Save & connect all" to get points/strata flowing.  Silent
      //     on total failure; partial failure surfaces in the status line.
      let multiDb = { total: 0, okCount: 0, failCount: 0 }
      try {
        const results = await invoke('connect_all_databases')
        if (Array.isArray(results) && results.length > 0) {
          multiDb.total     = results.length
          multiDb.okCount   = results.filter(r => r && r.ok).length
          multiDb.failCount = multiDb.total - multiDb.okCount
          // If at least one multi-DB connected, flip the "connected" flag on
          // so downstream pages (Projects, Points, …) believe the app has a
          // working data source even if the legacy single-DB connect failed.
          if (multiDb.okCount > 0) setConnected(true)
        }
      } catch (err) {
        console.warn('connect_all_databases failed; multi-DB not wired up:', err)
      }

      // 4. Ensure strata.xlsx exists in this folder (fire and forget)
      invoke('ensure_strata_file').catch(() => {})

      // 5. Issue #103: hydrate the in-memory selection by cross-matching
      //    projects.xlsx / points.xlsx against the live DB contents.  After
      //    this the user can jump straight to Strata / Data / Charts
      //    without first walking the Projects → Points click path.
      const anyDbOk = dbOk || multiDb.okCount > 0
      let restoredProjects = 0
      let restoredPoints   = 0
      if (anyDbOk) {
        try {
          const [allProjects, xlsxProjects] = await Promise.all([
            invoke('list_projects').catch(() => []),
            invoke('load_projects_xlsx').catch(() => []),
          ])
          if (Array.isArray(allProjects) && Array.isArray(xlsxProjects) && xlsxProjects.length > 0) {
            const projKey = (p) => `${p?.db_id ?? '?'}||${p?.ProjectId ?? ''}`
            const xlsxKeys = new Set(xlsxProjects.map(projKey))
            const matched = allProjects.filter(p => xlsxKeys.has(projKey(p)))
            if (matched.length > 0) {
              setSelectedProjects(matched)
              restoredProjects = matched.length
              // Chain: pull points for those projects, then match against points.xlsx.
              try {
                const idArg = matched.some(p => p?.db_id)
                  ? matched.map(p => ({ db_id: p.db_id, ProjectId: p.ProjectId }))
                  : matched.map(p => p.ProjectId)
                const [allPoints, xlsxPoints] = await Promise.all([
                  invoke('get_points', { projectIds: idArg }).catch(() => []),
                  invoke('load_points_xlsx').catch(() => []),
                ])
                if (Array.isArray(allPoints) && Array.isArray(xlsxPoints) && xlsxPoints.length > 0) {
                  const ptKey = (p) => `${p?.db_id ?? '?'}||${p?.PointId ?? ''}`
                  const ptKeys = new Set(xlsxPoints.map(ptKey))
                  const ptMatched = allPoints.filter(p => ptKeys.has(ptKey(p)))
                  if (ptMatched.length > 0) {
                    setSelectedPoints(ptMatched)
                    restoredPoints = ptMatched.length
                  }
                }
              } catch (err) {
                console.warn('restore points failed:', err)
              }
            }
          }
        } catch (err) {
          console.warn('restore projects failed:', err)
        }
      }

      // 6. Compose a friendly status line covering folder + DB + restored.
      const dbBit = dbOk
        ? `connected to ${merged.database || 'database'}`
        : merged.server
            ? `DB offline (${dbErr || 'unreachable'}) — xlsx-only mode`
            : 'no DB configured for this folder yet'
      const multiBit = multiDb.total > 0
        ? ` · ${multiDb.okCount}/${multiDb.total} multi-DB${multiDb.failCount > 0 ? ` (${multiDb.failCount} failed)` : ''}`
        : ''
      const restoredBit = (restoredProjects > 0 || restoredPoints > 0)
        ? ` · restored ${restoredProjects} project${restoredProjects === 1 ? '' : 's'}` +
          (restoredPoints > 0 ? ` + ${restoredPoints} point${restoredPoints === 1 ? '' : 's'}` : '')
        : ''
      setFolderStatus(anyDbOk || !merged.server ? 'ok' : 'warn')
      setFolderMsg(`${folderRes.message} — ${dbBit}${multiBit}${restoredBit}`)

      // Issue #103: auto-navigate to the most relevant tab once selection
      // has been restored.  Strata if we restored points, Projects if only
      // projects were restored, else stay on Settings.
      if (anyDbOk && (restoredProjects > 0 || restoredPoints > 0) && setPage) {
        const target = restoredPoints > 0 ? 'strata' : 'projects'
        setTimeout(() => setPage(target), 1200)
      }
    } catch (err) {
      console.error(err)
      setFolderStatus('error')
      setFolderMsg(err || 'Folder not accessible')
    }
  }

  return (
    <div className="page">
      <h2 className="page-title">Settings</h2>

      {/* ── Subtab bar ── */}
      <div className="settings-tabs" style={{ maxWidth: 920, marginBottom: '1rem' }}>
        <button
          className={`settings-tab ${tab === 'folder' ? 'active' : ''}`}
          onClick={() => setTab('folder')}
        >
          📁 Project folder
        </button>
        <button
          className={`settings-tab ${tab === 'database' ? 'active' : ''}`}
          onClick={() => setTab('database')}
        >
          🗄 Database
        </button>
        <button
          className={`settings-tab ${tab === 'queryConfig' ? 'active' : ''}`}
          onClick={() => setTab('queryConfig')}
        >
          📝 Query Config
        </button>
      </div>

      {/* ── Query Config subtab (issue #47) ── */}
      {tab === 'queryConfig' && <QueryConfigTab />}

      {/* ── Database subtab — multi-DB connector (issue #46) ── */}
      {tab === 'database' && (
      <div className="card" style={{ maxWidth: 920, marginBottom: '1.5rem' }}>
        <h3 className="section-title">Database connections</h3>
        <p className="hint" style={{ marginBottom: '0.75rem' }}>
          Configure one or more databases for this project — typically several
          MSSQL/GeoGIS servers and/or Access files.  Settings are saved inside
          the project folder (<code>GIRTool_settings.json</code>) so opening
          the folder later restores everything.
        </p>
        {!form.output_folder && (
          <p className="hint" style={{ color: '#b45309', marginBottom: '0.75rem' }}>
            ⚠ Pick a project folder first on the <strong>Project folder</strong> tab —
            credentials are stored there, not in the registry.
          </p>
        )}

        {/* Header row */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '110px 90px 1fr 130px 110px 100px 90px 32px',
          gap: '0.4rem', alignItems: 'center',
          padding: '0.25rem 0.5rem', fontWeight: 600, fontSize: '.78rem',
          color: '#374151', borderBottom: '1px solid #e5e7eb',
        }}>
          <div>ID</div>
          <div>Type</div>
          <div>Connection</div>
          <div>Auth / user</div>
          <div>Query type</div>
          <div>Status</div>
          <div>Test</div>
          <div></div>
        </div>

        {dbRows.map((row, idx) => {
          const isDup = duplicateIds.has(row.id)
          const isBad = !!row.id && !ID_RE.test(row.id)
          const st    = dbStatus[row.id]
          return (
          <div key={idx} style={{
            display: 'grid',
            gridTemplateColumns: '110px 90px 1fr 130px 110px 100px 90px 32px',
            gap: '0.4rem', alignItems: 'start',
            padding: '0.4rem 0.5rem',
            borderBottom: '1px solid #f1f5f9',
            fontSize: '.82rem',
          }}>
            {/* Auto-generated read-only ID (issue #73) — DB1, DB2, …  Old
                rows saved with custom ids (e.g. "primary") still display
                their original value to preserve external references. */}
            <input
              value={row.id}
              readOnly
              style={{
                marginBottom: 0,
                background: '#f3f4f6',
                color: '#374151',
                cursor: 'default',
                borderColor: isDup || isBad ? '#ef4444' : undefined,
              }}
              title={isDup ? 'Duplicate ID — should not happen with auto-numbering'
                   : isBad ? 'Legacy ID outside the DB<N> format — kept for backwards compatibility'
                   : 'Auto-generated identifier (read-only)'}
            />
            <select
              value={row.type}
              onChange={e => updateRow(idx, { type: e.target.value })}
              style={{ marginBottom: 0 }}
            >
              <option value="mssql">MSSQL</option>
              <option value="access">Access</option>
            </select>

            {/* Connection — different fields per type */}
            {row.type === 'access' ? (
              <div style={{ display: 'flex', gap: '0.25rem' }}>
                <input
                  value={row.file_path}
                  onChange={e => updateRow(idx, { file_path: e.target.value })}
                  placeholder="C:\Projects\fieldlab\local.accdb"
                  style={{ flex: 1, marginBottom: 0 }}
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => pickAccessPath(idx)}
                  title="Browse for .accdb / .mdb"
                  style={{ flexShrink: 0 }}
                >
                  📁
                </button>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.25rem' }}>
                <input
                  value={row.server}
                  onChange={e => updateRow(idx, { server: e.target.value })}
                  placeholder="server"
                  style={{ marginBottom: 0 }}
                />
                <input
                  value={row.database}
                  onChange={e => updateRow(idx, { database: e.target.value })}
                  placeholder="database"
                  style={{ marginBottom: 0 }}
                />
              </div>
            )}

            {/* Auth / user (MSSQL only) */}
            {row.type === 'access' ? (
              <div style={{ color: '#9ca3af', fontStyle: 'italic', fontSize: '.78rem' }}>
                — file path —
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <select
                  value={row.auth_method}
                  onChange={e => updateRow(idx, { auth_method: e.target.value })}
                  style={{ marginBottom: 0 }}
                >
                  <option value="windows">Windows</option>
                  <option value="sql">SQL Server</option>
                </select>
                {row.auth_method === 'sql' && (
                  <>
                    <input
                      value={row.username}
                      onChange={e => updateRow(idx, { username: e.target.value })}
                      placeholder="username"
                      style={{ marginBottom: 0 }}
                    />
                    <input
                      type="password"
                      value={row.password}
                      onChange={e => updateRow(idx, { password: e.target.value })}
                      placeholder="password"
                      style={{ marginBottom: 0 }}
                    />
                  </>
                )}
              </div>
            )}

            {/* Query Type dropdown — options come from get_query_configs
                (issue #62).  If a row's saved query_type isn't in the list
                yet (stale entry, mid-migration, etc.), surface it as an
                extra option so the select stays valid. */}
            <select
              value={row.query_type || 'GeoGIS'}
              onChange={e => updateRow(idx, { query_type: e.target.value })}
              style={{ marginBottom: 0 }}
              title="Pick the SQL flavour for this database.  Add new flavours under Settings → Query Config."
            >
              {(availableQueryTypes.includes(row.query_type) || !row.query_type
                ? availableQueryTypes
                : [...availableQueryTypes, row.query_type]
              ).map(qt => (
                <option key={qt} value={qt}>{qt}</option>
              ))}
            </select>

            <div style={{ fontSize: '1.1rem', textAlign: 'center', lineHeight: '1.6' }}>
              {st === undefined ? '—' :
               st.ok === null    ? '…' :
               st.ok             ? <span title={st.message} style={{ color: '#16a34a' }}>✅</span>
                                 : <span title={st.message} style={{ color: '#dc2626' }}>⚠️</span>}
            </div>

            <button
              type="button"
              className="btn-secondary"
              onClick={() => testRow(idx)}
              style={{ padding: '0.25rem 0.5rem', fontSize: '.78rem' }}
              title="Test this connection"
            >
              Test
            </button>

            <button
              type="button"
              onClick={() => removeDbRow(idx)}
              title="Remove this database"
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: '#dc2626', fontSize: '1rem', padding: 0,
              }}
            >
              ×
            </button>
          </div>
          )
        })}

        {dbRows.length === 0 && (
          <p className="hint" style={{ padding: '1rem 0' }}>
            No databases configured yet — click <strong>+ Add database</strong>.
          </p>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={addDbRow}
          >
            + Add database
          </button>
          <button
            type="button"
            onClick={saveAndConnectAll}
            disabled={dbBusy || !form.output_folder}
            title={!form.output_folder ? 'Pick a project folder first' : 'Save list & test all connections'}
          >
            {dbBusy ? 'Saving…' : 'Save & Connect all'}
          </button>
        </div>

        {dbMsg && (
          <p className={`msg ${dbMsg.ok ? 'ok' : 'err'}`}>{dbMsg.text}</p>
        )}

        {/* Legacy single-DB compat hint */}
        <details style={{ marginTop: '1rem' }}>
          <summary style={{ cursor: 'pointer', color: '#6b7280', fontSize: '.78rem' }}>
            Older settings files (single <code>db</code> block)
          </summary>
          <p className="hint" style={{ marginTop: '0.5rem', fontSize: '.78rem' }}>
            Settings files written by previous versions of GIRTool stored a single
            <code> db </code> block.  When you open such a folder, that block is
            automatically migrated to a one-row <code>databases</code> list — you'll
            see it appear here as <code>primary</code>.  Save once to commit the
            migration.
          </p>
        </details>
      </div>
      )}

      {/* ── Project folder subtab ── */}
      {tab === 'folder' && (
      <>
      <div className="card" style={{ maxWidth: 520 }}>
        <h3 className="section-title">Project folder</h3>
        <p className="hint" style={{ marginBottom: '0.75rem' }}>
          Downloaded Excel files and session data will be saved here automatically.
          When you connect the project folder, the app looks for any existing
          session and restores your project selection automatically.
        </p>

        <label>Folder path</label>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            name="output_folder"
            value={form.output_folder}
            onChange={handle}
            placeholder="e.g. C:\GIRTool\Projects  or  S:\GIR\Projects"
            style={{ flex: 1, marginBottom: 0 }}
          />
          <button
            type="button"
            className="btn-secondary"
            onClick={browseFolder}
            disabled={browsingFolder}
            title="Browse for folder"
            style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            {browsingFolder ? '…' : '📁 Browse'}
          </button>
        </div>

        {/* Primary action — sits right under the folder path so it's the
            first thing the user sees after typing/browsing. */}
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
          <button
            onClick={testFolder}
            disabled={!form.output_folder || folderStatus === 'testing'}
            className="btn-secondary"
          >
            {folderStatus === 'testing' ? 'Connecting…' : 'Connect project folder'}
          </button>
        </div>

        {recentFolders.length > 0 && (
          <div className="recent-folders">
            <div className="recent-folders-label">Recent folders</div>
            <div className="recent-folders-list">
              {recentFolders.map(folder => (
                <div key={folder} className="recent-folder-chip">
                  <button
                    type="button"
                    className="recent-folder-path"
                    title={`Use ${folder}`}
                    onClick={() => setForm(prev => ({ ...prev, output_folder: folder }))}
                  >
                    📂 {folder}
                  </button>
                  <button
                    type="button"
                    className="recent-folder-remove"
                    title="Remove from recent list"
                    onClick={async () => {
                      try {
                        const updated = await invoke('forget_recent_folder', { path: folder })
                        setRecentFolders(updated || [])
                      } catch {}
                    }}
                  >✕</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {folderMsg && (
          <p className={`msg ${
            folderStatus === 'ok'   ? 'ok'
            : folderStatus === 'warn' ? 'warn'
            : 'err'
          }`}>{folderMsg}</p>
        )}

        {/* Issue #95: "Restored session" banner removed — selection now
            lives in projects.xlsx / points.xlsx and auto-loads on the
            relevant page mounts, not on folder-connect. */}

      </div>

      {/* ── SharePoint via OneDrive sync ── */}
      <div className="card" style={{ maxWidth: 520, marginTop: '1.5rem' }}>
        <h3 className="section-title">Working with a SharePoint folder</h3>
        <p className="hint" style={{ marginBottom: '0.5rem' }}>
          GIRTool reads and writes ordinary files in the output folder above.
          To put that folder on SharePoint, sync the SharePoint document library
          to your PC with <strong>OneDrive</strong> and pick the synced local
          path as your output folder. OneDrive then mirrors every save back to
          SharePoint in the background — typically within seconds.
        </p>

        <ol className="hint" style={{ marginLeft: '1.1em', lineHeight: 1.65 }}>
          <li>
            In a browser, open the SharePoint folder you want to work in
            (e.g. <code>https://cowi.sharepoint.com/sites/&lt;project&gt;</code>).
          </li>
          <li>
            On the toolbar, click <strong>Sync</strong>. OneDrive sets up
            a local mirror at a path like:
            <br />
            <code style={{ fontSize: '.78rem' }}>
              C:\Users\&lt;you&gt;\COWI\&lt;Project&gt; - Documents\&lt;subfolder&gt;
            </code>
          </li>
          <li>
            Back in GIRTool, click <strong>📁 Browse</strong> next to the output
            folder above and pick that local path. Hit <strong>Connect project folder</strong>.
          </li>
          <li>
            You're done. Everything GIRTool writes (xlsx files, settings, etc.)
            appears on SharePoint automatically. Colleagues with the same folder
            synced see your changes within a few seconds.
          </li>
        </ol>

        <p className="hint" style={{ marginTop: '0.6rem', fontSize: '.78rem' }}>
          <strong>Collaboration note:</strong> OneDrive uses last-write-wins.
          If two people edit the same project at the same moment, OneDrive
          will keep both versions (the second will be saved with
          <em> "&hellip;-Your-PC-Name's conflicted copy"</em> appended).
          For shared projects, coordinate via Teams/email so only one person
          actively edits at a time — same as you would with a Word document
          on SharePoint.
        </p>

        <p className="hint" style={{ marginTop: '0.5rem', fontSize: '.78rem' }}>
          <strong>No OneDrive?</strong> You can also map the SharePoint library
          as a network drive in Windows Explorer (e.g. <code>S:\Projects</code>)
          and pick that as the output folder. Slower than OneDrive sync but
          works the same way.
        </p>
      </div>
      </>
      )}
    </div>
  )
}
