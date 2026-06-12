import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { invoke, listen, emit, windowLabel } from '../tauri-api'
import { invokeAndNotify, useDataChanged } from '../lib/dataChanged'
import { mergeBuiltins } from '../lib/baseLayers'

const AppContext = createContext(null)

const DEFAULTS = {
  server: 'DKLYDB08',
  database: 'GeoGIS2020',
  auth_method: 'windows',
  username: '',
  password: '',
  output_folder: '',
}

const TYPE_STYLE_DEFAULTS = {
  CPT:   { color: '#e67e22', symbol: 'circle' },
  BH:    { color: '#2980b9', symbol: 'circle' },
  TP:    { color: '#27ae60', symbol: 'circle' },
  Other: { color: '#7f8c8d', symbol: 'circle' },
}

function loadTypeStyles() {
  try {
    const raw = localStorage.getItem('girtool_type_styles')
    return raw ? { ...TYPE_STYLE_DEFAULTS, ...JSON.parse(raw) } : { ...TYPE_STYLE_DEFAULTS }
  } catch {
    return { ...TYPE_STYLE_DEFAULTS }
  }
}

// strataLayerColors: { primary: { [layerName]: StyleObj }, secondary: { [layerName]: StyleObj } }
// StyleObj: { color, symbol, markerSize, lineType, lineThickness }
// Older localStorage entries may store just a hex string — normalise on load.
function _normaliseStyleEntry(v) {
  if (!v) return {}
  if (typeof v === 'string') return { color: v }   // legacy: bare hex string
  return v
}

function loadStrataLayerColors() {
  try {
    const raw = localStorage.getItem('girtool_strata_layer_colors')
    if (!raw) return { primary: {}, secondary: {} }
    const parsed = JSON.parse(raw)
    return {
      primary:   Object.fromEntries(Object.entries(parsed.primary   || {}).map(([k, v]) => [k, _normaliseStyleEntry(v)])),
      secondary: Object.fromEntries(Object.entries(parsed.secondary || {}).map(([k, v]) => [k, _normaliseStyleEntry(v)])),
    }
  } catch {
    return { primary: {}, secondary: {} }
  }
}

export function AppProvider({ children }) {
  const [connection, setConnection] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('db_settings')) || DEFAULTS
    } catch {
      return DEFAULTS
    }
  })
  const [connected, setConnected] = useState(false)
  const [selectedProjects, setSelectedProjects] = useState([])  // array of project objects
  const [selectedPoints, setSelectedPoints]     = useState([])  // array of point objects
  const [refreshKey, setRefreshKey]             = useState(0)   // increment to force re-fetch
  const [typeStyles, setTypeStyles]             = useState(loadTypeStyles)
  const [strataLayerColors, setStrataLayerColors] = useState(loadStrataLayerColors)
  const [xlsxSaveStatus, setXlsxSaveStatus]     = useState('idle')   // idle|saving|saved|error
  const [boundaries,    setBoundaries]           = useState([])       // project-level boundary definitions
  const [colDict,       setColDict]              = useState({})       // column abbreviation → {fullName, description, unit, datasheets}

  // Refs mirroring state — read at fire time to avoid stale closures in the debounced save.
  const typeStylesRef         = useRef(typeStyles)
  const strataLayerColorsRef  = useRef(strataLayerColors)
  const selectedProjectsRef   = useRef(selectedProjects)
  const boundariesRef         = useRef(boundaries)
  useEffect(() => { typeStylesRef.current        = typeStyles        }, [typeStyles])
  useEffect(() => { strataLayerColorsRef.current = strataLayerColors }, [strataLayerColors])
  useEffect(() => { selectedProjectsRef.current  = selectedProjects  }, [selectedProjects])
  useEffect(() => { boundariesRef.current        = boundaries        }, [boundaries])

  // Full list of strata layer values for the current project, pushed by FilterContext.
  // We need this so the xlsx save can include rows for layers the user has not yet
  // edited (the UI shows them with computed defaults).
  const strataLayersListRef = useRef({ primary: [], secondary: [] })
  const setStrataLayersList = useCallback((layers) => {
    strataLayersListRef.current = {
      primary:   Array.isArray(layers?.primary)   ? layers.primary   : [],
      secondary: Array.isArray(layers?.secondary) ? layers.secondary : [],
    }
  }, [])

  // Fetch column dictionary once on mount (cached server-side).
  useEffect(() => {
    invoke('get_column_dictionary')
      .then(r => setColDict(r ?? {}))
      .catch(() => {})
  }, [])

  // Load boundaries from session whenever the active project changes.
  useEffect(() => {
    const pid = selectedProjects[0]?.ProjectId
    if (!pid) { setBoundaries([]); return }
    invoke('get_session', { projectId: pid })
      .then(r => setBoundaries(Array.isArray(r?.boundaries) ? r.boundaries : []))
      .catch(() => setBoundaries([]))
  }, [selectedProjects])  // eslint-disable-line

  // Live cross-window sync: when ANY window writes boundaries via
  // patch_session, the Rust backend emits `session:boundaries:updated`.  We
  // listen for it and re-fetch — so a popped-out Boundaries window editing
  // shapes is reflected in the main window's charts immediately.
  useEffect(() => {
    let unlisten = null
    const subscribe = async () => {
      try {
        unlisten = await listen('session:boundaries:updated', (event) => {
          const evPid    = event?.payload?.projectId
          const localPid = selectedProjectsRef.current[0]?.ProjectId
          if (!localPid || (evPid && evPid !== localPid)) return
          invoke('get_session', { projectId: localPid })
            .then(r => setBoundaries(Array.isArray(r?.boundaries) ? r.boundaries : []))
            .catch(() => {})
        })
      } catch { /* event API unavailable — ignore */ }
    }
    subscribe()
    return () => { if (typeof unlisten === 'function') unlisten() }
  }, [])

  // ── Live cross-window selection sync (#203) ───────────────────────────────
  // Every window shares the same Rust backend, but each webview holds its own
  // React state — so the point/project selection is mirrored over the Tauri
  // event bus:
  //   selection:updated      {src, projects, points} — applied by every window
  //                                                    except the sender
  //   selection:sync-request "<label>"               — a freshly opened window
  //                                                    asking for the current
  //                                                    selection (pop-outs
  //                                                    start empty otherwise)
  const [winLabel] = useState(windowLabel)
  const applyingRemoteRef = useRef(false)  // suppress re-broadcast of a remote apply
  const syncMountedRef    = useRef(false)  // suppress the initial-mount broadcast
  const hadSelectionRef   = useRef(false)  // this window has held a non-empty selection
  const gotSnapshotRef    = useRef(false)  // a remote snapshot has been applied here
  const lastSyncKeysRef   = useRef(null)   // key-form of the last broadcast/applied snapshot
  const selectedPointsRef = useRef(selectedPoints)
  useEffect(() => { selectedPointsRef.current = selectedPoints }, [selectedPoints])

  // Content identity for echo suppression: cheap keys, not full objects, so a
  // content-identical re-apply (e.g. a page pushing back what it just
  // received) never re-broadcasts.  Project order matters (selectedProjects[0]
  // is the active project) — don't sort.
  const syncKeys = (projects, points) => JSON.stringify({
    pr: (projects || []).map(p => `${p?.db_id ?? '?'}||${p?.ProjectId ?? ''}`),
    pt: (points   || []).map(p => `${p?.db_id ?? '?'}||${p?.PointId   ?? ''}`),
  })

  useEffect(() => {
    let offUpdate = null
    let offRequest = null
    let retryTimer = null
    let disposed = false
    ;(async () => {
      try {
        offUpdate = await listen('selection:updated', (e) => {
          const p = e?.payload
          if (!p || p.src === winLabel) return
          gotSnapshotRef.current = true
          applyingRemoteRef.current = true
          const projects = Array.isArray(p.projects) ? p.projects : []
          const points   = Array.isArray(p.points)   ? p.points   : []
          lastSyncKeysRef.current = syncKeys(projects, points)
          if (projects.length || points.length) hadSelectionRef.current = true
          setSelectedProjects(projects)
          setSelectedPoints(points)
        })
        offRequest = await listen('selection:sync-request', (e) => {
          if (!e?.payload || e.payload === winLabel) return
          // Only windows actually holding a selection reply — an empty window
          // must not "sync" the requester back to nothing.
          if (!selectedProjectsRef.current.length && !selectedPointsRef.current.length) return
          emit('selection:updated', {
            src:      winLabel,
            projects: selectedProjectsRef.current,
            points:   selectedPointsRef.current,
          })
        })
      } catch { return /* event API unavailable (plain browser) */ }
      if (disposed) return
      // Both listeners are registered — only NOW is it safe to ask for the
      // live selection (an instant reply can no longer be missed).  One retry
      // covers a busy peer.
      emit('selection:sync-request', winLabel)
      retryTimer = setTimeout(() => {
        if (!disposed && !gotSnapshotRef.current) emit('selection:sync-request', winLabel)
      }, 700)
    })()
    return () => {
      disposed = true
      clearTimeout(retryTimer)
      if (typeof offUpdate  === 'function') offUpdate()
      if (typeof offRequest === 'function') offRequest()
    }
  }, [])  // eslint-disable-line

  // Broadcast local selection changes.  A remote apply lands here as ONE
  // batched render, where it consumes the suppress flag — so only user- and
  // restore-driven changes emit.  Debounced: rapid map clicks coalesce, and
  // large point selections aren't serialized over IPC once per click.
  const broadcastTimerRef = useRef(null)
  useEffect(() => () => { clearTimeout(broadcastTimerRef.current) }, [])
  useEffect(() => {
    if (!syncMountedRef.current) { syncMountedRef.current = true; return }
    if (applyingRemoteRef.current) { applyingRemoteRef.current = false; return }
    if (selectedProjects.length || selectedPoints.length) hadSelectionRef.current = true
    // A window that never held a selection must not broadcast "empty" — a
    // freshly opened pop-out would wipe every other window's selection.
    if (!hadSelectionRef.current) return
    clearTimeout(broadcastTimerRef.current)
    broadcastTimerRef.current = setTimeout(() => {
      const keys = syncKeys(selectedProjectsRef.current, selectedPointsRef.current)
      if (keys === lastSyncKeysRef.current) return  // identical content — no echo
      lastSyncKeysRef.current = keys
      emit('selection:updated', {
        src:      winLabel,
        projects: selectedProjectsRef.current,
        points:   selectedPointsRef.current,
      })
      // Persist alongside the broadcast (#207): projects.xlsx / points.xlsx
      // now track EVERY local selection change — including map picks and
      // project-removal prunes, which previously never reached the files and
      // let stale content resurrect old selections on restore.  Only the
      // originating window writes (remote applies never get here).
      const num = v => (v == null || v === '' || !isFinite(Number(v))) ? null : Number(v)
      invoke('save_projects_xlsx', {
        selected: selectedProjectsRef.current.map(p => ({
          db_id:     p.db_id ?? '',
          ProjectId: p.ProjectId,
          ProjectNo: p.ProjectNo ?? '',
          Title:     p.Title ?? '',
        })),
      }).catch(() => {})
      invoke('save_points_xlsx', {
        selected: selectedPointsRef.current.map(p => ({
          db_id:     p.db_id ?? '',
          ProjectId: p.ProjectId ?? '',
          PointId:   p.PointId ?? '',
          PointNo:   String(p.PointNo ?? ''),
          X1: num(p.X1), Y1: num(p.Y1), Z1: num(p.Z1),
          Projection1: p.Projection1 != null ? String(p.Projection1) : '',
          origin_X1: num(p.origin_X1), origin_Y1: num(p.origin_Y1), origin_Z1: num(p.origin_Z1),
          origin_Projection1: p.origin_Projection1 != null ? String(p.origin_Projection1) : '',
        })),
      }).catch(() => {})
    }, 150)
  }, [selectedProjects, selectedPoints])  // eslint-disable-line

  // Debounced boundaries save to GIRTool_settings.json.
  const boundariesTimerRef = useRef(null)
  useEffect(() => () => { clearTimeout(boundariesTimerRef.current) }, [])

  const saveBoundaries = useCallback((list) => {
    setBoundaries(list)
    const pid = selectedProjectsRef.current[0]?.ProjectId
    if (!pid) return
    boundariesRef.current = list   // keep ref in sync before the timer fires
    clearTimeout(boundariesTimerRef.current)
    // Short debounce so cross-window chart overlays update almost immediately
    // after each edit, while still coalescing rapid drag-style updates.
    boundariesTimerRef.current = setTimeout(() => {
      invoke('patch_session', { projectId: pid, patch: { boundaries: boundariesRef.current } }).catch(() => {})
    }, 150)
  }, [])

  // Debounced Colors_&_Symbols.xlsx save — shared across Colors & Grouping pages.
  const xlsxTimerRef = useRef(null)
  useEffect(() => () => { clearTimeout(xlsxTimerRef.current) }, [])

  // Must mirror ColorsPage rendering: rotating palette + per-style defaults.
  const STRATA_DEFAULT_COLORS = [
    '#3b82f6','#ef4444','#22c55e','#f59e0b','#8b5cf6',
    '#06b6d4','#f97316','#ec4899','#84cc16','#6366f1',
  ]

  function _buildFullStrataDict(kind) {
    const list   = strataLayersListRef.current[kind] || []
    const stored = strataLayerColorsRef.current[kind] || {}
    const result = {}
    list.forEach((name, idx) => {
      const s = stored[name] || {}
      result[name] = {
        color:         s.color         ?? STRATA_DEFAULT_COLORS[idx % STRATA_DEFAULT_COLORS.length],
        symbol:        s.symbol        ?? 'circle',
        markerSize:    s.markerSize    ?? 6,
        lineType:      s.lineType      ?? 'solid',
        lineThickness: s.lineThickness ?? 1.5,
      }
    })
    // Preserve any user-edited rows that are no longer in the data source.
    for (const [name, s] of Object.entries(stored)) {
      if (name in result) continue
      result[name] = {
        color:         s.color         ?? '#2980b9',
        symbol:        s.symbol        ?? 'circle',
        markerSize:    s.markerSize    ?? 6,
        lineType:      s.lineType      ?? 'solid',
        lineThickness: s.lineThickness ?? 1.5,
      }
    }
    // 'Unknown' is a synthetic fallback for unassigned rows — always include it
    // so it is always written to the xlsx and editable directly in Excel.
    if (!('Unknown' in result)) {
      const s = stored['Unknown'] || {}
      result['Unknown'] = {
        color:         s.color         ?? '#9ca3af',
        symbol:        s.symbol        ?? 'circle',
        markerSize:    s.markerSize    ?? 6,
        lineType:      s.lineType      ?? 'solid',
        lineThickness: s.lineThickness ?? 1.5,
      }
    }
    return result
  }

  const scheduleColorsXlsxSave = useCallback((groupSystems) => {
    clearTimeout(xlsxTimerRef.current)
    xlsxTimerRef.current = setTimeout(async () => {
      try {
        setXlsxSaveStatus('saving')
        const pid = selectedProjectsRef.current[0]?.ProjectId
        await invokeAndNotify('colors', 'save_colors', {
          projectId: pid,
          body: {
            type_styles:         typeStylesRef.current,
            group_systems:       groupSystems,
            strata_layer_colors: {
              primary:   _buildFullStrataDict('primary'),
              secondary: _buildFullStrataDict('secondary'),
            },
          },
        })
        setXlsxSaveStatus('saved')
        setTimeout(() => setXlsxSaveStatus('idle'), 2500)
      } catch {
        setXlsxSaveStatus('error')
      }
    }, 1000)
  }, [])

  function saveConnection(settings) {
    setConnection(settings)
    localStorage.setItem('db_settings', JSON.stringify(settings))
  }

  function updateTypeStyle(type, updates) {
    setTypeStyles(prev => {
      const current = prev[type] || TYPE_STYLE_DEFAULTS.Other
      const next = { ...prev, [type]: { ...current, ...updates } }
      localStorage.setItem('girtool_type_styles', JSON.stringify(next))
      return next
    })
  }

  // type: 'primary'|'secondary'; value: layer name; updates: Partial<StyleObj>
  function updateStrataLayerStyle(type, value, updates) {
    setStrataLayerColors(prev => {
      const existing = prev[type]?.[value] || {}
      const next = {
        ...prev,
        [type]: { ...prev[type], [value]: { ...existing, ...updates } },
      }
      localStorage.setItem('girtool_strata_layer_colors', JSON.stringify(next))
      return next
    })
  }

  // Coordinate-system config (issue #147, follow-up to #145): the project's
  // target CRS + per-elevation-system Z offsets, loaded from GIRTool_settings.json
  // whenever a project connects.  Point coordinates are converted to this system
  // for display/export.  `null` means "no conversion" (raw DB coordinates).
  const [coordinateSystem, setCoordinateSystem] = useState(null)
  useEffect(() => {
    if (!connected) { setCoordinateSystem(null); return }
    let cancelled = false
    invoke('get_coordinate_system')
      .then(cfg => { if (!cancelled) setCoordinateSystem(cfg && cfg.target_epsg ? cfg : null) })
      .catch(() => { if (!cancelled) setCoordinateSystem(null) })
    return () => { cancelled = true }
  }, [connected])

  // Map layers (M4.5): one unified list of background maps (built-ins) + user
  // WMS addons, loaded from GIRTool_settings.json on connect and seeded with the
  // built-in base maps via mergeBuiltins.
  const [mapAddons, setMapAddons] = useState([])
  useEffect(() => {
    if (!connected) { setMapAddons([]); return }
    let cancelled = false
    invoke('get_map_addons')
      .then(a => { if (!cancelled) setMapAddons(mergeBuiltins(a)) })
      .catch(() => { if (!cancelled) setMapAddons(mergeBuiltins([])) })
    return () => { cancelled = true }
  }, [connected])

  // Persist + update map addons in one call (used by the Settings subtab).
  // #211/#213: announced on the data:changed bus so every other window's maps
  // restyle live (colour / opacity / visibility edits, added/removed layers).
  const saveMapAddons = useCallback((next) => {
    setMapAddons(next)
    invokeAndNotify('map_addons', 'save_map_addons', { addons: next }).catch(() => {})
  }, [])

  // ── Cross-window re-fetchers (#213) ───────────────────────────────────────
  // Writes in OTHER windows announce a domain on the data:changed bus; this
  // window re-fetches whatever it caches locally for that domain.  (Own-window
  // writes are skipped — local state was already set by the saving code.)
  const connectedRef = useRef(connected)
  useEffect(() => { connectedRef.current = connected }, [connected])
  useDataChanged('map_addons', () => {
    if (!connectedRef.current) return
    invoke('get_map_addons').then(a => setMapAddons(mergeBuiltins(a))).catch(() => {})
  })
  useDataChanged('coordinate_system', () => {
    if (!connectedRef.current) return
    invoke('get_coordinate_system')
      .then(cfg => setCoordinateSystem(cfg && cfg.target_epsg ? cfg : null))
      .catch(() => {})
  })
  // Type / strata-layer styles live in localStorage, which all windows share —
  // a 'colors' announce just re-reads it.
  useDataChanged('colors', () => {
    setTypeStyles(loadTypeStyles())
    setStrataLayerColors(loadStrataLayerColors())
  })
  // Boundaries saved via the BoundariesPage commands (the patch_session path
  // already has its own session:boundaries:updated event).
  useDataChanged('boundaries', () => {
    const pid = selectedProjectsRef.current[0]?.ProjectId
    if (!pid) return
    invoke('get_session', { projectId: pid })
      .then(r => setBoundaries(Array.isArray(r?.boundaries) ? r.boundaries : []))
      .catch(() => {})
  })

  return (
    <AppContext.Provider value={{
      connection, saveConnection,
      connected, setConnected,
      coordinateSystem, setCoordinateSystem,
      mapAddons, saveMapAddons,
      selectedProjects, setSelectedProjects,
      selectedPoints,  setSelectedPoints,
      refreshKey,      bumpRefresh: () => setRefreshKey(k => k + 1),
      typeStyles,      updateTypeStyle,
      strataLayerColors, updateStrataLayerStyle,
      scheduleColorsXlsxSave, xlsxSaveStatus, setStrataLayersList,
      boundaries, saveBoundaries,
      colDict,
    }}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  return useContext(AppContext)
}
