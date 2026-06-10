import { useState, useEffect } from 'react'
import { invoke } from '../tauri-api'
import Logo from './Logo'

// Issue #139 — full-screen project startup screen.
//
// Shown (main window only) until a project is opened.  Three actions:
//   • New project   — pick/create a folder → scaffold → open
//   • Open project  — pick an existing project folder → open
//   • Copy project  — pick source + destination → clone whole project → open
// Plus a Recent-projects quick-open list.
//
// `onOpen(folder)` is supplied by App: it sets the connection's output_folder,
// connects every DB, and restores the saved selection, then dismisses this
// screen.

export default function StartupScreen({ onOpen }) {
  const [recent,  setRecent]  = useState([])
  const [busy,    setBusy]    = useState(false)
  const [error,   setError]   = useState('')

  useEffect(() => {
    invoke('list_recent_folders')
      .then(list => setRecent(Array.isArray(list) ? list : []))
      .catch(() => setRecent([]))
  }, [])

  async function pickFolder(title) {
    const r = await invoke('browse_folder', { initial: '' }).catch(() => null)
    return r?.path || null
  }

  async function handleNew() {
    setError(''); setBusy(true)
    try {
      const folder = await pickFolder()
      if (!folder) return
      const path = await invoke('create_project', { path: folder })
      await onOpen(path)
    } catch (err) {
      setError(String(err || 'Could not create project'))
    } finally { setBusy(false) }
  }

  async function handleOpen() {
    setError(''); setBusy(true)
    try {
      const folder = await pickFolder()
      if (!folder) return
      await onOpen(folder)
    } catch (err) {
      setError(String(err || 'Could not open project'))
    } finally { setBusy(false) }
  }

  async function handleCopy() {
    setError(''); setBusy(true)
    try {
      const src = await pickFolder()
      if (!src) return
      const dst = await pickFolder()
      if (!dst) return
      const path = await invoke('copy_project', { src, dst })
      await onOpen(path)
    } catch (err) {
      setError(String(err || 'Could not copy project'))
    } finally { setBusy(false) }
  }

  async function handleRecent(folder) {
    setError(''); setBusy(true)
    try { await onOpen(folder) }
    catch (err) { setError(String(err || 'Could not open project')) }
    finally { setBusy(false) }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: '1.5rem',
      background: '#f8fafc', padding: '2rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <Logo size={48} />
        <h1 style={{ margin: 0, fontSize: '1.8rem', fontWeight: 700 }}>GIRTool</h1>
      </div>
      <p className="hint" style={{ margin: 0 }}>Start a project to continue.</p>

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
        <button className="btn-primary"   onClick={handleNew}  disabled={busy} style={startBtn}>🆕 New project</button>
        <button className="btn-secondary" onClick={handleOpen} disabled={busy} style={startBtn}>📂 Open project</button>
        <button className="btn-secondary" onClick={handleCopy} disabled={busy} style={startBtn}>📑 Copy project</button>
      </div>

      {busy && <p className="hint">Working…</p>}
      {error && <p className="msg err" style={{ maxWidth: 520 }}>{error}</p>}

      {recent.length > 0 && (
        <div style={{ width: '100%', maxWidth: 560 }}>
          <div className="recent-folders-label" style={{ marginBottom: '.4rem' }}>Recent projects</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.35rem' }}>
            {recent.map(folder => (
              <button
                key={folder}
                type="button"
                className="btn-secondary"
                onClick={() => handleRecent(folder)}
                disabled={busy}
                title={`Open ${folder}`}
                style={{ textAlign: 'left', justifyContent: 'flex-start', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                📁 {folder}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const startBtn = {
  minWidth: 170, padding: '0.9rem 1rem', fontSize: '1rem', fontWeight: 600,
}
