import { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { invoke, listen } from '../tauri-api'
import { useApp } from './AppContext'

// ── Serialisation helpers ─────────────────────────────────────────────────────
//
// Filter state uses native Sets (and `null` to mean "all pass").  Sets can't
// be JSON-serialised, so persistence + cross-window events shuttle plain
// arrays through GIRTool_settings.json under the `filters` key.

const setToArr = (s) => (s === null || s === undefined ? null : [...s])
const arrToSet = (a) => (a === null || a === undefined ? null : new Set(a))

function serializeFilters({ checkedPtIds, checkedGroups, checkedStrataPrimary, checkedStrataSecondary }) {
  return {
    points: setToArr(checkedPtIds),
    groups: Object.fromEntries(
      Object.entries(checkedGroups || {}).map(([k, v]) => [k, setToArr(v)])
    ),
    strataPrimary:   setToArr(checkedStrataPrimary),
    strataSecondary: setToArr(checkedStrataSecondary),
  }
}

function deserializeFilters(payload) {
  if (!payload || typeof payload !== 'object') return null
  return {
    checkedPtIds:             arrToSet(payload.points ?? null),
    checkedGroups:            Object.fromEntries(
      Object.entries(payload.groups || {}).map(([k, v]) => [k, arrToSet(v)])
    ),
    checkedStrataPrimary:     arrToSet(payload.strataPrimary ?? null),
    checkedStrataSecondary:   arrToSet(payload.strataSecondary ?? null),
  }
}

const FilterContext = createContext(null)

export function FilterProvider({ children }) {
  const { selectedProjects, setStrataLayersList } = useApp()
  const projectId = selectedProjects[0]?.ProjectId

  const [filterOpen,       setFilterOpen]       = useState(false)
  const [allPoints,        setAllPoints]        = useState([])
  const [groupSystems,     setGroupSystems]     = useState([])
  const [groupAssignments, setGroupAssignments] = useState({})

  // null = no filter (all pass); Set<string> = explicit include list
  const [checkedPtIds, setCheckedPtIds] = useState(null)
  // { [systemId]: null | Set<groupName> }  null means "all groups in that system"
  const [checkedGroups, setCheckedGroups] = useState({})

  // Strata layer filter
  // strataLayers: unique values { primary: string[], secondary: string[] }
  // pointStrataLayers: per-point membership { [pointId]: { primary: string[], secondary: string[] } }
  const [strataLayers,         setStrataLayers]         = useState({ primary: [], secondary: [] })
  const [pointStrataLayers,    setPointStrataLayers]    = useState({})
  const [checkedStrataPrimary,   setCheckedStrataPrimary]   = useState(null) // null = all pass
  const [checkedStrataSecondary, setCheckedStrataSecondary] = useState(null)

  // ── Load data whenever project changes ────────────────────────────────────

  const fetchGroupData = useCallback(() => {
    if (!projectId) return
    invoke('get_grouping', { projectId }).then(r => {
      setGroupSystems(r.systems     || [])
      setGroupAssignments(r.assignments || {})
    }).catch(() => {})
  }, [projectId])

  const fetchStrataLayers = useCallback(() => {
    invoke('get_strata_layers', { projectId })
      .then(r => {
        const layers = r || { primary: [], secondary: [] }
        setStrataLayers(layers)
        setStrataLayersList(layers)   // push to AppContext for xlsx save
      })
      .catch(() => {})
    invoke('get_strata_point_layers', { projectId })
      .then(r => setPointStrataLayers(r?.point_layers || {}))
      .catch(() => {})
  }, [projectId, setStrataLayersList])

  // ── Cross-window sync bookkeeping ─────────────────────────────────────────
  // lastSavedFiltersRef stores the JSON form of the filters we last either
  // wrote OR loaded from disk.  The save effect compares against this to
  // avoid scheduling a write when the change came from a remote update, and
  // the listener uses it to skip applying state we already have.
  const lastSavedFiltersRef = useRef(null)

  // Apply a deserialised filter snapshot to local state.
  const applyFilterSnapshot = useCallback((f) => {
    setCheckedPtIds(f.checkedPtIds)
    setCheckedGroups(f.checkedGroups || {})
    setCheckedStrataPrimary(f.checkedStrataPrimary)
    setCheckedStrataSecondary(f.checkedStrataSecondary)
  }, [])

  useEffect(() => {
    if (!selectedProjects.length) {
      setAllPoints([]); setGroupSystems([]); setGroupAssignments({})
      setCheckedPtIds(null); setCheckedGroups({})
      setStrataLayers({ primary: [], secondary: [] }); setPointStrataLayers({})
      setStrataLayersList({ primary: [], secondary: [] })
      setCheckedStrataPrimary(null); setCheckedStrataSecondary(null)
      lastSavedFiltersRef.current = null
      return
    }
    const ids = selectedProjects.map(p => p.ProjectId)
    invoke('get_points', { projectIds: ids }).then(r => setAllPoints(r)).catch(() => {})
    fetchGroupData()
    fetchStrataLayers()

    // Restore persisted filter state from GIRTool_settings.json.
    // If none saved, fall back to "no filter" (null / {}).
    invoke('get_session', { projectId }).then(r => {
      const filters = deserializeFilters(r?.filters)
      if (filters) {
        lastSavedFiltersRef.current = JSON.stringify(serializeFilters(filters))
        applyFilterSnapshot(filters)
      } else {
        lastSavedFiltersRef.current = null
        setCheckedPtIds(null); setCheckedGroups({})
        setCheckedStrataPrimary(null); setCheckedStrataSecondary(null)
      }
    }).catch(() => {
      lastSavedFiltersRef.current = null
      setCheckedPtIds(null); setCheckedGroups({})
      setCheckedStrataPrimary(null); setCheckedStrataSecondary(null)
    })
  }, [projectId])   // eslint-disable-line

  // ── Debounced save: any filter change persists to GIRTool_settings.json ────
  // The lastSavedFiltersRef check prevents a save loop when the change came
  // from a remote window via the `session:filters:updated` event handler.
  const filterSaveTimerRef = useRef(null)
  useEffect(() => {
    if (!projectId) return
    const payload = serializeFilters({
      checkedPtIds, checkedGroups, checkedStrataPrimary, checkedStrataSecondary,
    })
    const payloadStr = JSON.stringify(payload)
    if (payloadStr === lastSavedFiltersRef.current) return

    clearTimeout(filterSaveTimerRef.current)
    filterSaveTimerRef.current = setTimeout(() => {
      invoke('patch_session', { projectId, patch: { filters: payload } }).catch(() => {})
      lastSavedFiltersRef.current = payloadStr
    }, 150)
    return () => clearTimeout(filterSaveTimerRef.current)
  }, [projectId, checkedPtIds, checkedGroups, checkedStrataPrimary, checkedStrataSecondary])

  // ── Live cross-window sync: refresh local state when another window saves ──
  useEffect(() => {
    if (!projectId) return
    let unlisten = null
    ;(async () => {
      try {
        unlisten = await listen('session:filters:updated', (event) => {
          const evPid = event?.payload?.projectId
          if (evPid && evPid !== projectId) return
          invoke('get_session', { projectId }).then(r => {
            const filters = deserializeFilters(r?.filters)
            if (!filters) return
            const payloadStr = JSON.stringify(serializeFilters(filters))
            if (payloadStr === lastSavedFiltersRef.current) return
            lastSavedFiltersRef.current = payloadStr
            applyFilterSnapshot(filters)
          }).catch(() => {})
        })
      } catch { /* event API unavailable — ignore */ }
    })()
    return () => { if (typeof unlisten === 'function') unlisten() }
  }, [projectId, applyFilterSnapshot])

  // ── Derived: which pointIds pass all active filters ───────────────────────

  const filteredPtIds = useMemo(() => {
    const anyGrp = Object.values(checkedGroups).some(s => s !== null)
    // Strata point-level filter is only meaningful when point-layers data is loaded
    const strataLoaded = Object.keys(pointStrataLayers).length > 0
    const anyStrata = strataLoaded && (checkedStrataPrimary !== null || checkedStrataSecondary !== null)
    if (checkedPtIds === null && !anyGrp && !anyStrata) return null   // nothing filtered

    let ids = new Set(allPoints.map(p => String(p.PointId)))

    // Group filter: for each system with an active set, keep only points
    // whose assignment is in the checked set
    for (const [sysId, checked] of Object.entries(checkedGroups)) {
      if (checked === null) continue
      const keep = new Set()
      for (const pt of allPoints) {
        const ptId   = String(pt.PointId)
        const grpName = groupAssignments[ptId]?.[sysId] ?? 'Unknown'
        if (checked.has(grpName)) keep.add(ptId)
      }
      ids = new Set([...ids].filter(id => keep.has(id)))
    }

    // Point filter
    if (checkedPtIds !== null) {
      ids = new Set([...ids].filter(id => checkedPtIds.has(id)))
    }

    // Strata point-level filter: keep points that have at least one matching layer
    if (anyStrata) {
      ids = new Set([...ids].filter(ptId => {
        if (checkedStrataPrimary !== null) {
          const layers = pointStrataLayers[ptId]?.primary ?? []
          if (!layers.some(l => checkedStrataPrimary.has(l))) return false
        }
        if (checkedStrataSecondary !== null) {
          const layers = pointStrataLayers[ptId]?.secondary ?? []
          if (!layers.some(l => checkedStrataSecondary.has(l))) return false
        }
        return true
      }))
    }

    return ids
  }, [allPoints, groupAssignments, checkedGroups, checkedPtIds, checkedStrataPrimary, checkedStrataSecondary, pointStrataLayers])

  // ── Point toggle helpers ──────────────────────────────────────────────────

  const togglePt = useCallback((ptId) => {
    const strId = String(ptId)
    setCheckedPtIds(prev => {
      const allIds = new Set(allPoints.map(p => String(p.PointId)))
      const current = prev === null ? new Set(allIds) : new Set(prev)
      if (current.has(strId)) current.delete(strId)
      else current.add(strId)
      // Reset to null (no filter) if all are checked again
      return current.size === allIds.size ? null : current
    })
  }, [allPoints])

  const selectAllPts    = useCallback(() => setCheckedPtIds(null),        [])
  const deselectAllPts  = useCallback(() => setCheckedPtIds(new Set()),   [])

  // ── Group toggle helpers ──────────────────────────────────────────────────

  const getAllGroupNames = useCallback((systemId) => {
    const sys = groupSystems.find(s => s.id === systemId)
    // 'Unknown' is always present as a real group in sys.groups (injected by backend)
    return sys ? sys.groups.map(g => g.name) : []
  }, [groupSystems])

  const toggleGroup = useCallback((systemId, groupName) => {
    setCheckedGroups(prev => {
      // 'Unknown' is always present in groups — no need to add it conditionally
      const allNames = new Set(
        groupSystems.find(s => s.id === systemId)?.groups.map(g => g.name) ?? []
      )
      const current = prev[systemId] === null || prev[systemId] === undefined
        ? new Set(allNames)
        : new Set(prev[systemId])
      if (current.has(groupName)) current.delete(groupName)
      else current.add(groupName)
      // Reset to null if all selected again
      const val = current.size === allNames.size ? null : current
      return { ...prev, [systemId]: val }
    })
  }, [groupSystems])

  const selectAllGroups   = useCallback((sysId) =>
    setCheckedGroups(p => ({ ...p, [sysId]: null })), [])
  const deselectAllGroups = useCallback((sysId) =>
    setCheckedGroups(p => ({ ...p, [sysId]: new Set() })), [])

  const resetFilters = useCallback(() => {
    setCheckedPtIds(null)
    setCheckedGroups({})
    setCheckedStrataPrimary(null)
    setCheckedStrataSecondary(null)
  }, [])

  // ── Strata layer toggle helpers ───────────────────────────────────────────

  function _makeStrataToggle(values, setter) {
    return (name) => {
      setter(prev => {
        const all = new Set(values)
        const cur = prev === null ? new Set(all) : new Set(prev)
        if (cur.has(name)) cur.delete(name); else cur.add(name)
        return cur.size === all.size ? null : cur
      })
    }
  }

  const toggleStrataPrimary   = useCallback(_makeStrataToggle(strataLayers.primary,   setCheckedStrataPrimary),   [strataLayers.primary])   // eslint-disable-line
  const toggleStrataSecondary = useCallback(_makeStrataToggle(strataLayers.secondary, setCheckedStrataSecondary), [strataLayers.secondary]) // eslint-disable-line

  const selectAllStrataPrimary    = useCallback(() => setCheckedStrataPrimary(null),    [])
  const deselectAllStrataPrimary  = useCallback(() => setCheckedStrataPrimary(new Set()), [])
  const selectAllStrataSecondary    = useCallback(() => setCheckedStrataSecondary(null),    [])
  const deselectAllStrataSecondary  = useCallback(() => setCheckedStrataSecondary(new Set()), [])

  // ── Dim helpers (used by FilterPanel to grey out excluded items) ──────────

  // Points dimmed because they fail the current group filter
  const groupDimmedPtIds = useMemo(() => {
    const dim = new Set()
    for (const [sysId, checked] of Object.entries(checkedGroups)) {
      if (checked === null) continue
      for (const pt of allPoints) {
        const ptId    = String(pt.PointId)
        const grpName = groupAssignments[ptId]?.[sysId] ?? 'Unknown'
        if (!checked.has(grpName)) dim.add(ptId)
      }
    }
    return dim
  }, [allPoints, groupAssignments, checkedGroups])

  // Is a specific group dimmed? (no checked points belong to it)
  const isGroupDimmed = useCallback((systemId, groupName) => {
    if (checkedPtIds === null) return false
    for (const ptId of checkedPtIds) {
      const grpName = groupAssignments[ptId]?.[systemId] ?? 'Unknown'
      if (grpName === groupName) return false
    }
    return true
  }, [groupAssignments, checkedPtIds])

  return (
    <FilterContext.Provider value={{
      filterOpen, setFilterOpen,
      allPoints, groupSystems, groupAssignments,
      refreshGroupData: fetchGroupData,
      refreshStrataLayers: fetchStrataLayers,
      checkedPtIds, checkedGroups,
      filteredPtIds,
      togglePt, selectAllPts, deselectAllPts,
      toggleGroup, selectAllGroups, deselectAllGroups,
      getAllGroupNames,
      resetFilters,
      groupDimmedPtIds, isGroupDimmed,
      // Strata layer filter
      strataLayers, pointStrataLayers,
      checkedStrataPrimary,   checkedStrataSecondary,
      toggleStrataPrimary,    toggleStrataSecondary,
      selectAllStrataPrimary, deselectAllStrataPrimary,
      selectAllStrataSecondary, deselectAllStrataSecondary,
    }}>
      {children}
    </FilterContext.Provider>
  )
}

export function useFilter() { return useContext(FilterContext) }
