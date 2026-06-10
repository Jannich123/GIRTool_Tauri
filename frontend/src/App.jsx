import { useState, useEffect } from 'react'
import { invoke } from './tauri-api'
import { AppProvider, useApp } from './context/AppContext'
import { FilterProvider }     from './context/FilterContext'
import Sidebar        from './components/Sidebar'
import FilterPanel    from './components/FilterPanel'
import ErrorBoundary  from './components/ErrorBoundary'
import StartupScreen  from './components/StartupScreen'
import SettingsPage   from './pages/SettingsPage'
import DataSelectionPage from './pages/DataSelectionPage'
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
      return localStorage.getItem('db_settings') ? 'dataSelection' : 'settings'
    } catch { return 'settings' }
  })()
  const [page, setPage] = useState(initialPage)
  const { connection, saveConnection, setConnected, setSelectedProjects, setSelectedPoints } = useApp()

  // Issue #139: the main window gates on a full-screen StartupScreen until a
  // project is opened.  Pop-out windows (?page=…) skip the gate — they're
  // opened against the already-connected session of the main window.
  const [projectOpen, setProjectOpen] = useState(!isMainWindow)

  // Pop-out windows reconnect silently to the saved session on mount (they
  // don't show the startup screen).
  useEffect(() => {
    if (isMainWindow) return
    invoke('db_status').then(r => {
      if (!r.configured) return
      const saved = localStorage.getItem('db_settings')
      if (!saved) return
      const s = JSON.parse(saved)
      invoke('connect', {
        server: s.server, database: s.database, authMethod: s.auth_method,
        username: s.username, password: s.password, outputFolder: s.output_folder,
      }).then(() => setConnected(true)).catch(() => {})
    }).catch(() => {})
  }, [])

  // Open a project folder: persist it, connect every DB, restore the saved
  // selection from projects.xlsx / points.xlsx (mirrors the Settings
  // "Connect project folder" flow, #103), then enter the app.  Called by the
  // StartupScreen for New / Open / Copy / Recent.
  async function openProject(folder) {
    const merged = { ...connection, output_folder: folder }
    saveConnection(merged)

    // Legacy single-DB connect (best-effort — folder may have no DB yet).
    try {
      await invoke('connect', {
        server: merged.server, database: merged.database, authMethod: merged.auth_method,
        username: merged.username, password: merged.password, outputFolder: folder,
      })
      setConnected(true)
    } catch (err) {
      console.warn('legacy connect failed (continuing):', err)
    }

    // Multi-DB connect (reads GIRTool_settings.json::databases for this folder).
    let anyDbOk = false
    try {
      const results = await invoke('connect_all_databases')
      if (Array.isArray(results) && results.some(r => r && r.ok)) { anyDbOk = true; setConnected(true) }
    } catch (err) { console.warn('connect_all_databases failed:', err) }

    invoke('ensure_strata_file').catch(() => {})

    // Restore selection from xlsx (same matching as #103).
    if (anyDbOk) {
      try {
        const [allProjects, xlsxProjects] = await Promise.all([
          invoke('list_projects').catch(() => []),
          invoke('load_projects_xlsx').catch(() => []),
        ])
        if (Array.isArray(allProjects) && Array.isArray(xlsxProjects) && xlsxProjects.length) {
          const pk = p => `${p?.db_id ?? '?'}||${p?.ProjectId ?? ''}`
          const keys = new Set(xlsxProjects.map(pk))
          const matched = allProjects.filter(p => keys.has(pk(p)))
          if (matched.length) {
            setSelectedProjects(matched)
            const idArg = matched.some(p => p?.db_id)
              ? matched.map(p => ({ db_id: p.db_id, ProjectId: p.ProjectId }))
              : matched.map(p => p.ProjectId)
            const [allPoints, xlsxPoints] = await Promise.all([
              invoke('get_points', { projectIds: idArg }).catch(() => []),
              invoke('load_points_xlsx').catch(() => []),
            ])
            if (Array.isArray(allPoints) && Array.isArray(xlsxPoints) && xlsxPoints.length) {
              const tk = p => `${p?.db_id ?? '?'}||${p?.PointId ?? ''}`
              const ptKeys = new Set(xlsxPoints.map(tk))
              const ptMatched = allPoints.filter(p => ptKeys.has(tk(p)))
              if (ptMatched.length) setSelectedPoints(ptMatched)
            }
          }
        }
      } catch (err) { console.warn('selection restore failed:', err) }
    }

    setPage('dataSelection')
    setProjectOpen(true)
  }

  function renderPage() {
    switch (page) {
      case 'settings': return <SettingsPage setPage={setPage} />
      case 'dataSelection': return <DataSelectionPage setPage={setPage} />
      // Projects/Points kept routable for pop-out windows (open_window page=…).
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

  const showFilter = page === 'map' || page === 'charts' || page === 'data'

  // Issue #139: gate the main window behind the startup screen until a
  // project is opened.
  if (!projectOpen) {
    return <StartupScreen onOpen={openProject} />
  }

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
