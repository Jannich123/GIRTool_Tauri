import { useState } from 'react'
import { useApp } from '../context/AppContext'
import ProjectsPage from './ProjectsPage'
import PointsPage from './PointsPage'

// Issue #151 (M3) — Data Selection shell.
//
// Merges the former top-level Projects + Points tabs into one tab with subtabs
// [ Projects | Points | Map ].  Projects/Points are the existing pages, embedded
// unchanged.  The Map subtab is a scaffold until M4 builds the real selection
// map (polygon load, source toggles, red-ring, Jupiter WFS).
//
// `setPage` is the real top-level navigator.  Children receive an intercepting
// `navigate`: requests to projects/points/map switch the SUBTAB; anything else
// (e.g. strata) falls through to the top-level navigator — so ProjectsPage's
// `setPage('points')` switches subtab while PointsPage's `setPage('strata')`
// leaves the tab.

const SUBTABS = [
  { key: 'projects', label: '📁 Projects' },
  { key: 'points',   label: '📍 Points' },
  { key: 'map',      label: '🗺️ Map' },
]

function SelectionMapScaffold({ projectCount, pointCount }) {
  return (
    <div className="page page-wide">
      <h2 className="page-title">Selection map</h2>
      <p className="hint" style={{ maxWidth: 680 }}>
        The selection map — where you draw a polygon to load available points from your
        databases, toggle data sources, and see the live Jupiter reference layer — arrives in
        the next milestone (M4). For now, build your selection from the <strong>Projects</strong> and
        <strong> Points</strong> subtabs.
      </p>
      <div
        style={{
          marginTop: '1rem', padding: '2.5rem', borderRadius: 12,
          border: '1px dashed var(--border, #cbd5e1)', background: 'var(--surface, #f8fafc)',
          textAlign: 'center', color: 'var(--text-muted, #64748b)', maxWidth: 680,
        }}
      >
        <div style={{ fontSize: '2rem', marginBottom: '.5rem' }}>🗺️</div>
        <div style={{ fontWeight: 600, marginBottom: '.25rem' }}>Selection map — coming in M4</div>
        <div style={{ fontSize: '.85rem' }}>
          Current selection: <strong>{projectCount}</strong> project{projectCount === 1 ? '' : 's'} ·{' '}
          <strong>{pointCount}</strong> point{pointCount === 1 ? '' : 's'}
        </div>
      </div>
    </div>
  )
}

export default function DataSelectionPage({ setPage }) {
  const { selectedProjects, selectedPoints } = useApp()
  const [sub, setSub] = useState('projects')

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
      {sub === 'map'      && (
        <SelectionMapScaffold
          projectCount={selectedProjects.length}
          pointCount={selectedPoints.length}
        />
      )}
    </>
  )
}
