import { useState, useEffect } from 'react'
import ProjectsPage from './ProjectsPage'
import PointsPage from './PointsPage'
import SelectionMap from './SelectionMap'

// Session-scoped memory of the active subtab so leaving Data Selection and
// returning reopens the same subtab (issue: restore where you left off).
let savedSub = 'projects'

// Issue #151 (M3) — Data Selection shell.  Merges the former top-level Projects
// + Points tabs into one tab with subtabs [ Map | Projects | Points ] (#200).
// Projects/Points are the existing pages embedded unchanged; the Map subtab is
// the new selection map (#153, M4.1+).
//
// `setPage` is the real top-level navigator.  Children receive an intercepting
// `navigate`: requests to projects/points/map switch the SUBTAB; anything else
// (e.g. strata) falls through to the top-level navigator — so ProjectsPage's
// `setPage('points')` switches subtab while PointsPage's `setPage('strata')`
// leaves the tab.

const SUBTABS = [
  { key: 'map',      label: '🗺️ Map' },
  { key: 'projects', label: '📁 Projects' },
  { key: 'points',   label: '📍 Points' },
]

export default function DataSelectionPage({ setPage }) {
  const [sub, setSub] = useState(() => savedSub)
  useEffect(() => { savedSub = sub }, [sub]) // remember across unmount/remount

  // Intercept in-tab navigation; everything else goes to the top-level router.
  const navigate = (target) => {
    if (target === 'projects' || target === 'points' || target === 'map') setSub(target)
    else setPage(target)
  }

  return (
    <>
      <div className="settings-tabs" style={{ maxWidth: '100%', marginBottom: '1rem' }}>
        {SUBTABS.map(({ key, label }) => (
          <button
            key={key}
            className={`settings-tab ${sub === key ? 'active' : ''}`}
            onClick={() => setSub(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {sub === 'projects' && <ProjectsPage setPage={navigate} />}
      {sub === 'points'   && <PointsPage   setPage={navigate} />}
      {sub === 'map'      && <SelectionMap />}
    </>
  )
}
