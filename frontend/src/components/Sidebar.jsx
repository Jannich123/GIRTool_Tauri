import { useState, useEffect } from 'react'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'
import Logo from './Logo'

// Each entry: leading emoji is the icon (shown alone in collapsed mode, #244).
const NAV_MAIN = [
  { key: 'dataSelection', label: '🧭 Data Selection' },
  { key: 'strata',    label: '🪨 Strata'            },
  { key: 'data',      label: '📊 Data'              },
  { key: 'cpt',       label: '🧮 CPT – Calculations' },
  { key: 'grouping',  label: '🏷️ Grouping'          },
  { key: 'colors',    label: '🎨 Colors & Symbols'  },
  { key: 'map',        label: '🗺️ Project map'        },
  { key: 'charts',     label: '📈 Charts'            },
  { key: 'boundaries', label: '〰️ Boundaries'        },
]

const DATA_PAGES = new Set(['strata', 'data', 'grouping', 'colors', 'charts', 'map', 'boundaries'])

// Split "🧭 Data Selection" → { icon: '🧭', text: 'Data Selection' }.
function splitLabel(label) {
  const i = label.indexOf(' ')
  return i === -1 ? { icon: label, text: '' } : { icon: label.slice(0, i), text: label.slice(i + 1) }
}

// Extract the folder basename for display in the sidebar — e.g. for
// `C:\Users\jgry\Projects\MyProject` returns `"MyProject"`.  Handles both
// `\` and `/` separators and strips any trailing slashes.
function folderBasename(path) {
  if (!path) return ''
  const parts = String(path).split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || ''
}

export default function Sidebar({ page, setPage }) {
  const { connection, selectedProjects, bumpRefresh } = useApp()
  const [refreshing, setRefreshing] = useState(false)

  // #310: only enable the AI assistant button when the configured endpoint +
  // key actually work (checked once on mount). null = still checking.
  const [aiHealth, setAiHealth] = useState({ ok: null, reason: 'checking…' })
  useEffect(() => {
    let alive = true
    invoke('ai_health')
      .then(r => { if (alive) setAiHealth({ ok: !!r?.ok, reason: r?.reason || '' }) })
      .catch(() => { if (alive) setAiHealth({ ok: false, reason: 'unavailable' }) })
    return () => { alive = false }
  }, [])

  // #244: icon-only mode.  A per-window VIEW preference (deliberately not on
  // the sync bus); persisted so it survives restarts.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('girtool_sidebar_collapsed') === '1' } catch { return false }
  })
  const toggleCollapsed = () => setCollapsed(c => {
    try { localStorage.setItem('girtool_sidebar_collapsed', c ? '0' : '1') } catch { /* ignore */ }
    return !c
  })

  // Issue #68: the sidebar status reflects the active *project folder*, not
  // the database connection.  The folder is the user's workspace (holds
  // queries.json, strata.xlsx, settings, exports); the DB is just a data
  // source.  Green when `connection.output_folder` is set.
  const folderName     = folderBasename(connection?.output_folder)
  const folderActive   = !!folderName

  async function handleRefresh() {
    if (!selectedProjects.length) return
    setRefreshing(true)
    try {
      await invoke('refresh_project', { projectId: selectedProjects[0].ProjectId })
      bumpRefresh()
    } catch { /* ignore */ } finally {
      setRefreshing(false)
    }
  }

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-logo">
        <Logo size={32} />
        <span>GIRTool</span>
        <button
          className="sidebar-collapse-btn"
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand the menu' : 'Collapse the menu to icons'}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      <div
        className="sidebar-status"
        // Issue #137: clicking the project name opens the folder in Explorer.
        onClick={folderActive
          ? () => invoke('open_project_folder').catch(err => console.warn('open_project_folder failed:', err))
          : undefined}
        title={folderActive
          ? `Open project folder in Explorer: ${connection.output_folder}`
          : 'Pick a project folder in Settings → Project selection'}
        style={{ cursor: folderActive ? 'pointer' : 'default' }}
      >
        <span className={`dot ${folderActive ? 'green' : 'red'}`} />
        <span className="sidebar-status-text">{folderActive ? folderName : 'No project folder'}</span>
      </div>

      <nav className="sidebar-nav">
        {NAV_MAIN.map(({ key, label }) => {
          const { icon, text } = splitLabel(label)
          return (
            <div key={key} className="nav-row">
              <button
                className={`nav-item ${page === key ? 'active' : ''}`}
                onClick={() => setPage(key)}
                title={collapsed ? text : undefined}
              >
                <span className="nav-icon">{icon}</span>
                <span className="nav-label">{text}</span>
              </button>
              <button
                className="nav-popout"
                title={`Open ${text} in a new window`}
                onClick={(e) => {
                  e.stopPropagation()
                  invoke('open_window', { page: key, title: `GIRTool — ${text}` })
                    .catch(err => console.warn('open_window failed:', err))
                }}
              >↗</button>
            </div>
          )
        })}

        {/* Spacer pushes Settings to the bottom */}
        <div style={{ flex: 1 }} />

        {/* Refresh button — only when a project is selected and on a data page */}
        {selectedProjects.length > 0 && DATA_PAGES.has(page) && (
          <button
            className="nav-item refresh-btn"
            onClick={handleRefresh}
            disabled={refreshing}
            title={collapsed ? 'Refresh data' : 'Re-read all project files and refresh the current view'}
          >
            <span className="nav-icon">{refreshing ? '⏳' : '↺'}</span>
            <span className="nav-label">{refreshing ? 'Refreshing…' : 'Refresh data'}</span>
          </button>
        )}

        <div className="sidebar-divider" />
        {/* #300/#310: AI assistant — opens in its own window. Disabled + greyed
            when the API key is missing or not working. */}
        <button
          className="nav-item"
          disabled={aiHealth.ok !== true}
          onClick={() => {
            if (aiHealth.ok !== true) return
            invoke('open_window', { page: 'ai', title: 'GIRTool — AI assistant' })
              .catch(err => console.warn('open_window failed:', err))
          }}
          title={
            aiHealth.ok === true
              ? (collapsed ? 'AI assistant' : 'Open the AI assistant in its own window')
              : aiHealth.ok === null
                ? 'AI assistant — checking availability…'
                : `AI assistant unavailable — ${aiHealth.reason || 'not configured'}`
          }
          style={aiHealth.ok !== true ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
        >
          <span className="nav-icon">🤖</span>
          <span className="nav-label">AI assistant</span>
        </button>
        <button
          className={`nav-item ${page === 'settings' ? 'active' : ''}`}
          onClick={() => setPage('settings')}
          title={collapsed ? 'Settings' : undefined}
        >
          <span className="nav-icon">⚙️</span>
          <span className="nav-label">Settings</span>
        </button>
        {/* #314: Help — opens a window with a detailed tab per menu page. */}
        <button
          className="nav-item"
          onClick={() => invoke('open_window', { page: 'help', title: 'GIRTool — Help' })
            .catch(err => console.warn('open_window failed:', err))}
          title={collapsed ? 'Help' : 'Open the help guide in its own window'}
        >
          <span className="nav-icon">❓</span>
          <span className="nav-label">Help</span>
        </button>
      </nav>
    </aside>
  )
}
