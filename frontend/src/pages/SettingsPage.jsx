import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { useApp } from '../context/AppContext'

export default function SettingsPage({ setPage }) {
  const { connection, saveConnection, setConnected, setSelectedProjects, refreshSpStatus } = useApp()
  const [form, setForm]                 = useState(connection)
  const [status, setStatus]             = useState(null)
  const [message, setMessage]           = useState('')
  const [folderStatus,   setFolderStatus]   = useState(null)
  const [folderMsg,      setFolderMsg]      = useState('')
  const [browsingFolder, setBrowsingFolder] = useState(false)
  const [restoredSession, setRestoredSession] = useState(null)

  // SharePoint state
  const [spForm,       setSpForm]       = useState({ tenant_id: '', client_id: '', site_url: '', folder_path: '' })
  const [spAuthStatus, setSpAuthStatus] = useState('idle')  // idle|initiating|pending|authenticated|error
  const [spMsg,        setSpMsg]        = useState('')
  const [spUserCode,   setSpUserCode]   = useState('')
  const [spVerifyUrl,  setSpVerifyUrl]  = useState('')
  const [spFiles,      setSpFiles]      = useState([])
  const [spSyncStatus, setSpSyncStatus] = useState('')
  const spPollTimer = useRef(null)

  // Load saved SP config on mount
  useEffect(() => {
    axios.get('/api/sharepoint/status')
      .then(r => {
        if (r.data.site_url || r.data.tenant_id)
          setSpForm({
            tenant_id:   r.data.tenant_id   || '',
            client_id:   r.data.client_id   || '',
            site_url:    r.data.site_url    || '',
            folder_path: r.data.folder_path || '',
          })
        if (r.data.authenticated) setSpAuthStatus('authenticated')
      })
      .catch(() => {})
  }, [])

  // Clear polling on unmount
  useEffect(() => () => clearInterval(spPollTimer.current), [])

  const handle   = e => setForm(f => ({ ...f, [e.target.name]: e.target.value }))
  const handleSp = e => setSpForm(f => ({ ...f, [e.target.name]: e.target.value }))

  // ── SharePoint auth ───────────────────────────────────────────────────────────
  const spAuthenticate = async () => {
    setSpAuthStatus('initiating')
    setSpMsg(''); setSpUserCode(''); setSpVerifyUrl('')
    clearInterval(spPollTimer.current)
    try {
      const r = await axios.post('/api/sharepoint/initiate', spForm)

      // Silent re-auth (token still valid in cache)
      if (r.data.silent) {
        setSpAuthStatus('authenticated')
        setSpMsg('Re-authenticated from cached token.')
        refreshSpStatus()
        return
      }

      setSpUserCode(r.data.user_code)
      setSpVerifyUrl(r.data.verification_uri)
      setSpAuthStatus('pending')
      setSpMsg('')

      // Poll every 4 s until authenticated or error
      spPollTimer.current = setInterval(async () => {
        try {
          const poll = await axios.post('/api/sharepoint/poll')
          if (poll.data.status === 'authenticated') {
            clearInterval(spPollTimer.current)
            setSpAuthStatus('authenticated')
            setSpMsg('Authenticated successfully.')
            setSpUserCode('')
            refreshSpStatus()
          } else if (poll.data.status === 'error') {
            clearInterval(spPollTimer.current)
            setSpAuthStatus('error')
            setSpMsg(poll.data.message || 'Authentication failed')
          }
        } catch {
          clearInterval(spPollTimer.current)
          setSpAuthStatus('error')
          setSpMsg('Polling failed')
        }
      }, 4000)
    } catch (err) {
      setSpAuthStatus('error')
      setSpMsg(err.response?.data?.detail || 'Could not start authentication')
    }
  }

  const spDisconnect = async () => {
    clearInterval(spPollTimer.current)
    try {
      await axios.post('/api/sharepoint/disconnect')
    } catch { /* ignore */ }
    setSpAuthStatus('idle')
    setSpMsg('')
    setSpUserCode('')
    setSpVerifyUrl('')
    setSpFiles([])
    setSpSyncStatus('')
    refreshSpStatus()
  }

  const spListFiles = async () => {
    setSpSyncStatus('listing')
    try {
      const r = await axios.post('/api/sharepoint/list')
      setSpFiles(r.data.files || [])
      setSpSyncStatus(`Found ${r.data.count} file(s)`)
    } catch (err) {
      setSpSyncStatus('Error: ' + (err.response?.data?.detail || err.message))
    }
  }

  const spSyncDown = async () => {
    setSpSyncStatus('Downloading from SharePoint…')
    try {
      const r = await axios.post('/api/sharepoint/sync-down')
      const ok  = r.data.synced?.length || 0
      const err = r.data.errors?.length || 0
      setSpSyncStatus(`Downloaded ${ok} file(s)${err ? `, ${err} error(s)` : ''}`)
    } catch (err) {
      setSpSyncStatus('Error: ' + (err.response?.data?.detail || err.message))
    }
  }

  const spSyncUp = async () => {
    setSpSyncStatus('Uploading to SharePoint…')
    try {
      const r = await axios.post('/api/sharepoint/sync-up')
      const ok  = r.data.uploaded?.length || 0
      const err = r.data.errors?.length   || 0
      setSpSyncStatus(`Uploaded ${ok} file(s)${err ? `, ${err} error(s)` : ''}`)
    } catch (err) {
      setSpSyncStatus('Error: ' + (err.response?.data?.detail || err.message))
    }
  }

  // ── Database connect ──────────────────────────────────────────────────────────
  const connect = async () => {
    setStatus('testing'); setMessage('')
    try {
      const res = await axios.post('/api/database/connect', form)
      saveConnection(form)
      setConnected(true)
      setStatus('ok')
      setMessage(res.data.message)
    } catch (err) {
      setConnected(false)
      setStatus('error')
      setMessage(err.response?.data?.detail || 'Connection failed')
    }
  }

  // ── Browse for folder using native OS dialog ──────────────────────────────────
  const browseFolder = async () => {
    setBrowsingFolder(true)
    try {
      const res = await axios.get('/api/database/browse-folder', {
        params: { initialdir: form.output_folder || '' },
      })
      if (res.data.path) {
        setForm(prev => ({ ...prev, output_folder: res.data.path }))
      }
    } catch (err) {
      const detail = err?.response?.data?.detail || err?.message || 'Unknown error'
      alert(`Browse failed: ${detail}`)
    } finally {
      setBrowsingFolder(false)
    }
  }

  // ── Test & save folder — then restore latest session ─────────────────────────
  const testFolder = async () => {
    setFolderStatus('testing'); setFolderMsg(''); setRestoredSession(null)
    try {
      // 1. Verify the folder is accessible
      const folderRes = await axios.post('/api/database/test-folder', { path: form.output_folder })

      // 2. Persist settings (folder + rest of connection)
      const updated = { ...form }
      saveConnection(updated)
      await axios.post('/api/database/connect', updated)

      // 3. Ensure strata.xlsx exists in this folder (fire and forget)
      axios.post('/api/strata/ensure-file').catch(() => {})

      // 4. Look for sessions saved in this folder
      let sessions = []
      try {
        const sessRes = await axios.get('/api/download/sessions')
        sessions = sessRes.data || []
      } catch {
        // folder may be empty — not an error
      }

      if (sessions.length > 0) {
        // Sessions are already sorted newest-first by the backend
        const latest = sessions[0]
        const projects = latest.selected_projects || []

        // Restore selected projects into global app state
        setSelectedProjects(projects)
        setRestoredSession(latest)

        const names = projects.map(p => `${p.ProjectNo} – ${p.Title}`).join(', ')
        const when  = latest.saved_at ? ` (saved ${latest.saved_at.replace('T', ' ')})` : ''
        setFolderStatus('ok')
        setFolderMsg(`${folderRes.data.message} — session restored: ${names || 'no projects'}${when}`)

        // Navigate to Projects so the user can see/adjust the restored selection
        if (setPage) setTimeout(() => setPage('projects'), 1200)
      } else {
        setFolderStatus('ok')
        setFolderMsg(`${folderRes.data.message} — no saved sessions found in this folder yet`)
      }
    } catch (err) {
      setFolderStatus('error')
      setFolderMsg(err.response?.data?.detail || 'Folder not accessible')
    }
  }

  return (
    <div className="page">
      <h2 className="page-title">Settings</h2>

      {/* ── Database ── */}
      <div className="card" style={{ maxWidth: 520, marginBottom: '1.5rem' }}>
        <h3 className="section-title">Database Connection</h3>

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

        <button onClick={connect} disabled={status === 'testing'} style={{ marginTop: '1rem' }}>
          {status === 'testing' ? 'Connecting…' : 'Connect'}
        </button>

        {message && (
          <p className={`msg ${status === 'ok' ? 'ok' : 'err'}`}>{message}</p>
        )}
      </div>

      {/* ── Output folder ── */}
      <div className="card" style={{ maxWidth: 520 }}>
        <h3 className="section-title">Output Folder</h3>
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
          <p className={`msg ${folderStatus === 'ok' ? 'ok' : 'err'}`}>{folderMsg}</p>
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

        <p className="hint" style={{ marginTop: '0.75rem' }}>
          <strong>Tip:</strong> For read-only access without Azure registration, map your SharePoint
          library as a network drive in Windows Explorer (e.g. <code>S:\Projects</code>).
        </p>
      </div>

      {/* ── SharePoint ── */}
      <div className="card" style={{ maxWidth: 520, marginTop: '1.5rem' }}>
        <h3 className="section-title">SharePoint Connection</h3>
        <p className="hint" style={{ marginBottom: '0.75rem' }}>
          Authenticates via a one-time device-code flow — no password stored.
          Requires an Azure AD app registration with <code>Files.ReadWrite</code>{' '}
          and <code>Sites.ReadWrite.All</code> delegated permissions and{' '}
          <em>Allow public client flows</em> enabled.
          Access to SharePoint folders is controlled by SharePoint permissions —
          users can only reach folders they are already allowed to see.
        </p>

        <label>Tenant ID</label>
        <input
          name="tenant_id"
          value={spForm.tenant_id}
          onChange={handleSp}
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
        />

        <label style={{ marginTop: '.4rem' }}>Client ID (App Registration)</label>
        <input
          name="client_id"
          value={spForm.client_id}
          onChange={handleSp}
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
        />

        <label style={{ marginTop: '.4rem' }}>SharePoint Site URL</label>
        <input
          name="site_url"
          value={spForm.site_url}
          onChange={handleSp}
          placeholder="https://contoso.sharepoint.com/sites/MyProject"
        />

        <label style={{ marginTop: '.5rem' }}>
          Folder path{' '}
          <span style={{ fontWeight: 400, color: '#6b7280' }}>
            (relative to the site root)
          </span>
        </label>
        <input
          name="folder_path"
          value={spForm.folder_path}
          onChange={handleSp}
          placeholder="Shared Documents/GIRTool"
        />

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
          <button
            onClick={spAuthenticate}
            disabled={
              spAuthStatus === 'initiating' ||
              spAuthStatus === 'pending'    ||
              !spForm.tenant_id || !spForm.client_id || !spForm.site_url
            }
            className="btn-primary"
          >
            {spAuthStatus === 'initiating'   ? 'Starting…'
              : spAuthStatus === 'pending'   ? 'Waiting for login…'
              : spAuthStatus === 'authenticated' ? 'Re-authenticate'
              : 'Authenticate'}
          </button>

          {spAuthStatus === 'authenticated' && (
            <>
              <button onClick={spListFiles}  className="btn-secondary">List files</button>
              <button onClick={spSyncDown}   className="btn-secondary">↓ Download</button>
              <button onClick={spSyncUp}     className="btn-secondary">↑ Upload</button>
              <button onClick={spDisconnect} className="btn-secondary"
                style={{ color: '#dc2626', borderColor: '#fca5a5' }}>
                Disconnect
              </button>
            </>
          )}
        </div>

        {/* Device-code prompt — shown while waiting */}
        {spAuthStatus === 'pending' && spVerifyUrl && (
          <div style={{
            marginTop: '0.85rem', padding: '0.75rem',
            background: '#eff6ff', border: '1px solid #bfdbfe',
            borderRadius: 6, fontSize: '.85rem', lineHeight: 1.7,
          }}>
            <strong>Step 1 —</strong> Open this link in Edge:{' '}
            <a href={spVerifyUrl} target="_blank" rel="noreferrer"
               onClick={() => window.open(spVerifyUrl, '_blank')}>
              {spVerifyUrl}
            </a>
            <br />
            <strong>Step 2 —</strong> Enter the code:{' '}
            <code style={{ fontSize: '1.1em', letterSpacing: 3, fontWeight: 700 }}>
              {spUserCode}
            </code>
            <br />
            <span style={{ color: '#6b7280', fontSize: '.8em' }}>
              Your corporate account in Edge is often pre-selected — just click Continue.
              This page updates automatically once you approve.
            </span>
          </div>
        )}

        {spMsg && (
          <p className={`msg ${spAuthStatus === 'error' ? 'err' : 'ok'}`}>{spMsg}</p>
        )}

        {spSyncStatus && (
          <p className="hint" style={{ marginTop: '0.5rem' }}>{spSyncStatus}</p>
        )}

        {spFiles.length > 0 && (
          <ul style={{ marginTop: '0.5rem', paddingLeft: '1.2em', fontSize: '.82rem', color: '#374151' }}>
            {spFiles.map(f => (
              <li key={f.name}>
                {f.name}
                <span style={{ color: '#9ca3af', marginLeft: 6 }}>
                  ({Math.round((f.size || 0) / 1024)} KB · {f.modified?.slice(0, 10) || '—'})
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
