import { useState, useEffect } from 'react'
import { invoke } from './tauri-api'
import { AppProvider, useApp } from './context/AppContext'
import { FilterProvider }     from './context/FilterContext'
import Sidebar        from './components/Sidebar'
import FilterPanel    from './components/FilterPanel'
import ErrorBoundary  from './components/ErrorBoundary'
import SettingsPage   from './pages/SettingsPage'
import ProjectsPage   from './pages/ProjectsPage'
import PointsPage     from './pages/PointsPage'
import StrataPage     from './pages/StrataPage'
import DataPage       from './pages/DataPage'
import ChartsPage      from './pages/ChartsPage'
import GroupingPage    from './pages/GroupingPage'
import ColorsPage      from './pages/ColorsPage'
import MapPage         from './pages/MapPage'
import BoundariesPage  from './pages/BoundariesPage'
import './index.css'

function Placeholder({ title }) {
  return (
    <div className="page">
      <h2 className="page-title">{title}</h2>
      <p className="hint">Coming soon.</p>
    </div>
  )
}

function Shell() {
  // Pop-out windows are opened with /?page=<key> so each one lands on its
  // page directly.  The main window has no query string and defaults to:
  //   * 'projects'  — if we already have saved DB credentials (skip Settings
  //                    flash; the useEffect below refines to strata/points
  //                    once the saved selection is restored).
  //   * 'settings'  — first-time launch with no saved config.
  // We track `isMainWindow` separately so the auto-navigate logic only fires
  // in the main window (pop-outs must stay on their assigned page).
  const isMainWindow = (() => {
    try { return !new URLSearchParams(window.location.search).get('page') }
    catch { return true }
  })()
  const initialPage = (() => {
    try {
      const p = new URLSearchParams(window.location.search).get('page')
      if (p && p.length > 0) return p
      return localStorage.getItem('db_settings') ? 'projects' : 'settings'
    } catch { return 'settings' }
  })()
  const [page, setPage] = useState(initialPage)
  const { setConnected, setSelectedProjects, setSelectedPoints } = useApp()

  // On load, probe the backend and restore connection state.  After the DB
  // is back online, also restore the project / point selection saved in
  // GIRTool_settings.json so the user lands on their previous workspace.
  useEffect(() => {
    invoke('db_status').then(r => {
      if (r.configured) {
        const saved = localStorage.getItem('db_settings')
        if (saved) {
          const s = JSON.parse(saved)
          invoke('connect', {
            server:       s.server,
            database:     s.database,
            authMethod:   s.auth_method,
            username:     s.username,
            password:     s.password,
            outputFolder: s.output_folder,
          })
            .then(() => {
              setConnected(true)
              // Issue #95: selection no longer flows through
              // GIRTool_settings.json — projects.xlsx and points.xlsx
              // auto-load on their respective page mounts.  Main window
              // lands on the Projects tab and the user navigates from
              // there.  Pop-out windows stay on whatever page they were
              // opened to (no setPage call).
              if (isMainWindow) setPage('projects')
            })
            .catch(() => { if (isMainWindow) setPage('settings') })
        }
      }
    }).catch(() => {})
  }, [])

  function renderPage() {
    switch (page) {
      case 'settings': return <SettingsPage setPage={setPage} />
      case 'projects': return <ProjectsPage setPage={setPage} />
      case 'points':   return <PointsPage   setPage={setPage} />
      case 'strata':   return <StrataPage />
      case 'data':     return <DataPage />
      case 'grouping':    return <GroupingPage />
      case 'colors':      return <ColorsPage />
      case 'boundaries':  return <BoundariesPage />
      default:            return <Placeholder title={page} />
    }
  }

  const showFilter = page === 'map' || page === 'charts'

  return (
    <div className="layout">
      <Sidebar page={page} setPage={setPage} />
      <main className={`content${page === 'charts' ? ' content--charts' : ''}`}>
        {/* Standard pages — remount on each visit (state is cheap to rebuild) */}
        {page !== 'charts' && page !== 'map' && (
          <ErrorBoundary key={page}>
            {renderPage()}
          </ErrorBoundary>
        )}

        {/*
          ChartsPage stays mounted for the lifetime of the session so that
          fetched data (queries, group systems, chart rows) is preserved when
          the user switches tabs.  display:contents makes the wrapper invisible
          to the CSS layout so the inner .page div fills the content area.

          MapPage is NOT kept mounted because Leaflet initialises tile sizes
          from the container at mount time — inside display:none the container
          is zero-sized, causing a gray map.  Position is saved in
          sessionStorage so the view is restored on each remount.
        */}
        <div style={{ display: page === 'charts' ? 'contents' : 'none' }}>
          <ChartsPage />
        </div>
        {page === 'map' && <MapPage />}
      </main>
      {showFilter && <FilterPanel page={page} />}
    </div>
  )
}

export default function App() {
  return (
    <AppProvider>
      <FilterProvider>
        <Shell />
      </FilterProvider>
    </AppProvider>
  )
}
