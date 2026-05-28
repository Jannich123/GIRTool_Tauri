import { useState } from 'react'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'
import Logo from './Logo'

const NAV_MAIN = [
  { key: 'projects',  label: '📁 Projects'         },
  { key: 'points',    label: '📍 Points'            },
  { key: 'strata',    label: '🪨 Strata'            },
  { key: 'data',      label: '📊 Data'              },
  { key: 'grouping',  label: '🏷️ Grouping'          },
  { key: 'colors',    label: '🎨 Colors & Symbols'  },
  { key: 'map',        label: '🗺️ Map'               },
  { key: 'charts',     label: '📈 Charts'            },
  { key: 'boundaries', label: '〰️ Boundaries'        },
]

const DATA_PAGES = new Set(['strata', 'data', 'grouping', 'colors', 'charts', 'map', 'boundaries'])

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
    <aside className="sidebar">
      <div className="sidebar-logo">
        <Logo size={32} />
        <span>GIRTool</span>
      </div>

      <div
        className="sidebar-status"
        title={folderActive
          ? `Project folder: ${connection.output_folder}`
          : 'Pick a project folder in Settings → Project folder'}
      >
        <span className={`dot ${folderActive ? 'green' : 'red'}`} />
        {folderActive ? folderName : 'No project folder'}
      </div>

      <nav className="sidebar-nav">
        {NAV_MAIN.map(({ key, label }) => (
          <div key={key} className="nav-row">
            <button
              className={`nav-item ${page === key ? 'active' : ''}`}
              onClick={() => setPage(key)}
            >
              {label}
            </button>
            <button
              className="nav-popout"
              title={`Open ${label.replace(/^\S+\s/, '')} in a new window`}
              onClick={(e) => {
                e.stopPropagation()
                invoke('open_window', { page: key, title: `GIRTool — ${label.replace(/^\S+\s/, '')}` })
                  .catch(err => console.warn('open_window failed:', err))
              }}
            >↗</button>
          </div>
        ))}

        {/* Spacer pushes Settings to the bottom */}
        <div style={{ flex: 1 }} />

        {/* Refresh button — only when a project is selected and on a data page */}
        {selectedProjects.length > 0 && DATA_PAGES.has(page) && (
          <button
            className="nav-item refresh-btn"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Re-read all project files and refresh the current view"
          >
            {refreshing ? '⏳ Refreshing…' : '↺ Refresh data'}
          </button>
        )}

        <div className="sidebar-divider" />
        <button
          className={`nav-item ${page === 'settings' ? 'active' : ''}`}
          onClick={() => setPage('settings')}
        >
          ⚙️ Settings
        </button>
      </nav>
    </aside>
  )
}
