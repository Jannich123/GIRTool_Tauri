import { useState, useEffect } from 'react'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'

export default function SettingsPage({ setPage }) {
  const { connection, saveConnection, setConnected, setSelectedProjects, setSelectedPoints } = useApp()
  const [form, setForm]                 = useState(connection)
  const [status, setStatus]             = useState(null)
  const [message, setMessage]           = useState('')
  const [folderStatus,   setFolderStatus]   = useState(null)
  const [folderMsg,      setFolderMsg]      = useState('')
  const [browsingFolder, setBrowsingFolder] = useState(false)
  const [restoredSession, setRestoredSession] = useState(null)
  const [recentFolders,   setRecentFolders]   = useState([])
  // Subtab: 'folder' (project folder picker) or 'database' (DB connect).
  // Folder is shown first because it now drives everything else (the DB
  // credentials are loaded FROM the folder).
  const [tab, setTab] = useState('folder')

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
    setFolderStatus('testing'); setFolderMsg(''); setRestoredSession(null)
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

      // 4. Ensure strata.xlsx exists in this folder (fire and forget)
      invoke('ensure_strata_file').catch(() => {})

      // 5. Restore the saved project / point selection from
      //    {output_folder}/GIRTool_settings.json (top-level
      //    selected_projects / selected_points keys).
      let restored = { selectedProjects: [], selectedPoints: [] }
      try {
        restored = await invoke('load_selection') || restored
      } catch {
        // folder may be empty — not an error
      }
      const projects = Array.isArray(restored.selectedProjects) ? restored.selectedProjects : []
      const points   = Array.isArray(restored.selectedPoints)   ? restored.selectedPoints   : []

      if (projects.length > 0 || points.length > 0) {
        if (projects.length) setSelectedProjects(projects)
        if (points.length)   setSelectedPoints(points)
        setRestoredSession({ selectedProjects: projects, selectedPoints: points })
      }

      // 6. Compose a friendly status line covering folder + DB + restored.
      const dbBit = dbOk
        ? `connected to ${merged.database || 'database'}`
        : merged.server
            ? `DB offline (${dbErr || 'unreachable'}) — xlsx-only mode`
            : 'no DB configured for this folder yet'
      const sessionBit = (projects.length || points.length)
        ? ` · restored ${projects.length} project${projects.length === 1 ? '' : 's'}${points.length ? ` + ${points.length} point${points.length === 1 ? '' : 's'}` : ''}`
        : ''
      setFolderStatus(dbOk || !merged.server ? 'ok' : 'warn')
      setFolderMsg(`${folderRes.message} — ${dbBit}${sessionBit}`)

      // 7. Auto-navigate ONLY if DB succeeded and we have a selection.
      if (dbOk && (projects.length || points.length) && setPage) {
        const target = points.length ? 'strata' : 'projects'
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
      <div className="settings-tabs" style={{ maxWidth: 520, marginBottom: '1rem' }}>
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
      </div>

      {/* ── Database subtab ── */}
      {tab === 'database' && (
      <div className="card" style={{ maxWidth: 520, marginBottom: '1.5rem' }}>
        <h3 className="section-title">Database Connection</h3>
        <p className="hint" style={{ marginBottom: '0.75rem' }}>
          Credentials are saved inside the project folder
          (<code>GIRTool_settings.json</code>). Opening the folder later
          auto-connects with these settings — no need to re-enter them.
        </p>

        <label>Server</label>
        <input name="server" value={form.server} onChange={handle}
               placeholder="e.g. DKLYDB08" />

        <label>Database</label>
        <input name="database" value={form.database} onChange={handle}
               placeholder="e.g. GeoGIS2020" />

        <label>Authentication</label>
        <select name="auth_method" value={form.auth_method} onChange={handle}>
          <option value="windows">Windows Authentication</option>
          <option value="sql">SQL Server Authentication</option>
        </select>

        {form.auth_method === 'sql' && (
          <>
            <label>Username</label>
            <input name="username" value={form.username} onChange={handle} />
            <label>Password</label>
            <input name="password" type="password" value={form.password} onChange={handle} />
          </>
        )}

        <button onClick={connect} disabled={status === 'testing' || !form.output_folder} style={{ marginTop: '1rem' }}>
          {status === 'testing' ? 'Connecting…' : 'Connect & Save'}
        </button>
        {!form.output_folder && (
          <p className="hint" style={{ marginTop: '0.5rem' }}>
            Pick a project folder first (on the <strong>Project folder</strong> tab) — credentials are stored there.
          </p>
        )}

        {message && (
          <p className={`msg ${status === 'ok' ? 'ok' : 'err'}`}>{message}</p>
        )}
      </div>
      )}

      {/* ── Project folder subtab ── */}
      {tab === 'folder' && (
      <>
      <div className="card" style={{ maxWidth: 520 }}>
        <h3 className="section-title">Project folder</h3>
        <p className="hint" style={{ marginBottom: '0.75rem' }}>
          Downloaded Excel files and session data will be saved here automatically.
          When you test &amp; save the folder, the app looks for any existing session
          and restores your project selection automatically.
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

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
          <button
            onClick={testFolder}
            disabled={!form.output_folder || folderStatus === 'testing'}
            className="btn-secondary"
          >
            {folderStatus === 'testing' ? 'Checking…' : 'Test & Save folder'}
          </button>
        </div>

        {folderMsg && (
          <p className={`msg ${
            folderStatus === 'ok'   ? 'ok'
            : folderStatus === 'warn' ? 'warn'
            : 'err'
          }`}>{folderMsg}</p>
        )}

        {/* Restored session summary */}
        {restoredSession && (
          <div style={{
            marginTop: '0.75rem', padding: '0.6rem 0.85rem',
            background: '#f0fdf4', border: '1px solid #bbf7d0',
            borderRadius: 6, fontSize: '.82rem', color: '#166534',
          }}>
            <strong>Session restored from:</strong>{' '}
            {restoredSession.database} on {restoredSession.server}
            {restoredSession.point_count != null && (
              <> · {restoredSession.point_count} point{restoredSession.point_count !== 1 ? 's' : ''} were selected</>
            )}
            <br />
            <span style={{ color: '#6b7280', fontSize: '.78rem' }}>
              Points must be re-selected on the Points page (they are not stored in the session for privacy).
            </span>
          </div>
        )}

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
            folder above and pick that local path. Hit <strong>Test &amp; Save folder</strong>.
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
