import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import axios from 'axios'

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
  const [spConnected, setSpConnected]           = useState(false)
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
    axios.get('/api/columns/dictionary')
      .then(r => setColDict(r.data ?? {}))
      .catch(() => {})
  }, [])

  // Load boundaries from session whenever the active project changes.
  useEffect(() => {
    const pid = selectedProjects[0]?.ProjectId
    if (!pid) { setBoundaries([]); return }
    axios.get(`/api/session/${pid}`)
      .then(r => setBoundaries(Array.isArray(r.data?.boundaries) ? r.data.boundaries : []))
      .catch(() => setBoundaries([]))
  }, [selectedProjects])  // eslint-disable-line

  // Debounced boundaries save to GIRTool_settings.json.
  const boundariesTimerRef = useRef(null)
  useEffect(() => () => { clearTimeout(boundariesTimerRef.current) }, [])

  const saveBoundaries = useCallback((list) => {
    setBoundaries(list)
    const pid = selectedProjectsRef.current[0]?.ProjectId
    if (!pid) return
    boundariesRef.current = list   // keep ref in sync before the timer fires
    clearTimeout(boundariesTimerRef.current)
    boundariesTimerRef.current = setTimeout(() => {
      axios.patch(`/api/session/${pid}`, { boundaries: boundariesRef.current }).catch(() => {})
    }, 500)
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
        const url = pid
          ? `/api/colors/save?project_id=${encodeURIComponent(pid)}`
          : '/api/colors/save'
        await axios.post(url, {
          type_styles:         typeStylesRef.current,
          group_systems:       groupSystems,
          strata_layer_colors: {
            primary:   _buildFullStrataDict('primary'),
            secondary: _buildFullStrataDict('secondary'),
          },
        })
        setXlsxSaveStatus('saved')
        setTimeout(() => setXlsxSaveStatus('idle'), 2500)
      } catch {
        setXlsxSaveStatus('error')
      }
    }, 1000)
  }, [])

  // Poll SharePoint status once on mount so every page knows the connection state
  const refreshSpStatus = useCallback(() => {
    axios.get('/api/sharepoint/status')
      .then(r => setSpConnected(!!r.data.authenticated))
      .catch(() => setSpConnected(false))
  }, [])

  useEffect(() => { refreshSpStatus() }, [refreshSpStatus])

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

  return (
    <AppContext.Provider value={{
      connection, saveConnection,
      connected, setConnected,
      selectedProjects, setSelectedProjects,
      selectedPoints,  setSelectedPoints,
      refreshKey,      bumpRefresh: () => setRefreshKey(k => k + 1),
      typeStyles,      updateTypeStyle,
      strataLayerColors, updateStrataLayerStyle,
      scheduleColorsXlsxSave, xlsxSaveStatus, setStrataLayersList,
      spConnected, refreshSpStatus,
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
