import { useEffect, useRef, useState } from 'react'
import { useApp } from '../context/AppContext'

// #218: shared by AddonControl (transparency slider) and MapAddonsTab (colour
// picker).  Continuous inputs used to call saveMapAddons on EVERY input tick —
// each one a context update that re-renders every map marker, plus a
// settings.json write and a cross-window event (~20× per slider drag).
//
// This hook batches: the UI renders a local draft instantly, commits go out
// leading-edge and then at most every 250 ms while dragging, and a pending
// draft is flushed on unmount so a fast tab-switch can't lose the last value.
export function useThrottledAddons() {
  const { mapAddons, saveMapAddons } = useApp()
  const [draft, setDraft] = useState(null)
  const timerRef      = useRef(null)
  const pendingRef    = useRef(null)
  const lastCommitRef = useRef(0)
  const saveRef       = useRef(saveMapAddons)
  saveRef.current = saveMapAddons

  const addons = draft ?? (Array.isArray(mapAddons) ? mapAddons : [])

  const commit = (next) => {
    lastCommitRef.current = Date.now()
    pendingRef.current = null
    setDraft(null)
    saveRef.current(next)
  }

  // Throttled (leading + trailing) — for sliders / colour pickers.
  const updateThrottled = (next) => {
    setDraft(next)
    pendingRef.current = next
    clearTimeout(timerRef.current)
    const since = Date.now() - lastCommitRef.current
    if (since >= 250) commit(next)
    else timerRef.current = setTimeout(() => commit(next), 250 - since)
  }

  // Immediate — for discrete actions (checkboxes, reorder, add/remove).
  const updateNow = (next) => {
    clearTimeout(timerRef.current)
    commit(next)
  }

  useEffect(() => () => {
    clearTimeout(timerRef.current)
    if (pendingRef.current) saveRef.current(pendingRef.current)
  }, [])

  return { addons, updateThrottled, updateNow }
}
