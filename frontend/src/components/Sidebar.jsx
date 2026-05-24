import { useState } from 'react'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'

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

export default function Sidebar({ page, setPage }) {
  const { connected, selectedProjects, bumpRefresh, spConnected } = useApp()
  const [refreshing, setRefreshing] = useState(false)

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
      <div className="sidebar-logo">GIRTool</div>

      <div className="sidebar-status">
        <span className={`dot ${connected ? 'green' : 'red'}`} />
        {connected ? 'Connected' : 'Not connected'}
      </div>

      {spConnected && (
        <div className="sidebar-status" style={{ fontSize: '.72rem', color: '#0369a1', marginTop: 2 }}
          title="SharePoint sync is active — files upload automatically after each download">
          ☁ SharePoint active
        </div>
      )}

      {selectedProjects.length > 0 && (
        <div className="sidebar-projects">
          <div className="sidebar-section-label">Active projects</div>
          {selectedProjects.map(p => (
            <div key={p.ProjectId} className="sidebar-project-item">
              {p.ProjectNo} – {p.Title}
            </div>
          ))}
        </div>
      )}

      <nav className="sidebar-nav">
        {NAV_MAIN.map(({ key, label }) => (
          <button
            key={key}
            className={`nav-item ${page === key ? 'active' : ''}`}
            onClick={() => setPage(key)}
          >
            {label}
          </button>
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
