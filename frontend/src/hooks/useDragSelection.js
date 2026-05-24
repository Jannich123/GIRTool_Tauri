import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

/**
 * useDragSelection
 * ----------------
 * Reusable row-selection hook supporting:
 *   - Plain click   → toggle the row (add if missing, remove if already selected).
 *   - Click + drag  → ADD every row the mouse passes over while the button is held
 *                     (add-only; existing selections never get removed by a drag).
 *   - Shift + click → ADD every row between the previously clicked row and the
 *                     newly clicked row, based on the current visible order of `items`.
 *
 * Selection is stored as a Set of ids. The hook is intentionally controlled
 * loosely: you can call `setSelected` from outside to sync with external state
 * (e.g. the AppContext "already chosen" list).
 *
 * Usage on a row:
 *   <tr
 *     onMouseDown={e => onRowMouseDown(id, e)}
 *     onMouseEnter={() => onRowMouseEnter(id)}
 *     onMouseUp={() => onRowMouseUp(id)}
 *   />
 *
 * @param {Array<object>} items   Items in current visible order (filtering/sort already applied).
 * @param {(item:any)=>any} getId Extracts the stable id of an item.
 * @param {Iterable<any>} [initial] Optional initial selected ids.
 */
export function useDragSelection(items, getId, initial) {
  const [selected, setSelected] = useState(() => new Set(initial || []))

  // Drag state lives in a ref so changing it doesn't re-render the whole table.
  //   active : a mousedown happened on a row and no mouseup yet
  //   isDrag : the mouse moved to a different row while held (so it's a drag, not a click)
  //   startId: the row the press started on
  const dragRef = useRef({ active: false, isDrag: false, startId: null })

  // Anchor for shift-click range selection.
  const lastClickedRef = useRef(null)

  // Always end any in-progress drag on a global mouseup, even if it happens
  // outside a row (e.g. on the page header or scrollbar).
  useEffect(() => {
    const end = () => { dragRef.current = { active: false, isDrag: false, startId: null } }
    window.addEventListener('mouseup', end)
    return () => window.removeEventListener('mouseup', end)
  }, [])

  // ids in current visible order — needed for range selection.
  const orderedIds = useMemo(() => items.map(getId), [items, getId])

  const selectRange = useCallback((fromId, toId) => {
    const fromIdx = orderedIds.indexOf(fromId)
    const toIdx   = orderedIds.indexOf(toId)
    if (fromIdx < 0 || toIdx < 0) return
    const [a, b] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx]
    setSelected(prev => {
      const next = new Set(prev)
      for (let i = a; i <= b; i++) next.add(orderedIds[i])
      return next
    })
  }, [orderedIds])

  const onRowMouseDown = useCallback((id, e) => {
    // Only react to primary button.
    if (e.button !== 0) return

    // Shift-click → range select; do NOT start a drag.
    if (e.shiftKey && lastClickedRef.current != null) {
      e.preventDefault()
      selectRange(lastClickedRef.current, id)
      lastClickedRef.current = id
      return
    }

    // Begin potential drag. We don't toggle yet — we wait for mouseup
    // on the same row (= click) or mouseenter on another row (= drag).
    dragRef.current = { active: true, isDrag: false, startId: id }
    // Prevent text selection during drag.
    e.preventDefault()
  }, [selectRange])

  const onRowMouseEnter = useCallback((id) => {
    const st = dragRef.current
    if (!st.active) return

    // The first time the mouse enters a *different* row, this becomes a drag.
    if (!st.isDrag) {
      if (id === st.startId) return
      st.isDrag = true
      setSelected(prev => {
        const next = new Set(prev)
        if (st.startId != null) next.add(st.startId)
        next.add(id)
        return next
      })
      return
    }

    // Already dragging → keep adding rows the mouse touches.
    setSelected(prev => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  const onRowMouseUp = useCallback((id) => {
    const st = dragRef.current
    dragRef.current = { active: false, isDrag: false, startId: null }
    if (!st.active) return

    // Drag ended on a row → don't toggle; the drag already added rows.
    if (st.isDrag) {
      lastClickedRef.current = id
      return
    }

    // Plain click on the same row → toggle add/remove.
    if (st.startId === id) {
      setSelected(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      lastClickedRef.current = id
    }
  }, [])

  const selectAll = useCallback(() => {
    setSelected(new Set(orderedIds))
  }, [orderedIds])

  const clear = useCallback(() => {
    setSelected(new Set())
    lastClickedRef.current = null
  }, [])

  const isSelected = useCallback((id) => selected.has(id), [selected])

  return {
    selected,
    setSelected,
    isSelected,
    onRowMouseDown,
    onRowMouseEnter,
    onRowMouseUp,
    selectAll,
    clear,
  }
}
