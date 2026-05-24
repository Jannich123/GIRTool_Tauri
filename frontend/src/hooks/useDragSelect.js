/**
 * useDragSelect — drag-to-add-select + shift-click range for any list.
 *
 * Performance strategy
 * ────────────────────
 * During a drag, we do NOT call onAdd/setState on every onMouseEnter —
 * that would trigger a full re-render of the host component for each row
 * crossed, which is visually laggy on large tables.
 *
 * Instead:
 *   • Accumulate dragged keys in a ref (zero React re-renders).
 *   • Give instant visual feedback by adding a CSS class directly to the
 *     DOM element (no React involved).
 *   • On mouseup anywhere, flush the accumulated keys via a single onAdd
 *     call → one React re-render for the whole drag gesture.
 *   • React's own reconciliation then replaces the temporary DOM class
 *     with the correct className from state.
 *
 * Usage:
 *   const { rowProps, tbodyStyle } = useDragSelect({
 *     items,       // ordered array being rendered
 *     getKey,      // (item) => unique string key
 *     onAdd,       // (keys: string[]) => void  — add these keys to selection
 *     onToggle,    // (key: string) => void      — toggle a single key
 *   })
 *
 *   <tbody style={tbodyStyle}>
 *     {items.map((item, idx) => (
 *       <tr {...rowProps(item, idx)}>…</tr>
 *     ))}
 *   </tbody>
 *
 * Behaviour:
 *  - Mouse-down on a row    → toggle that row, start drag session.
 *  - Mouse-enter (dragging) → add row to pending selection (visual only).
 *  - Mouse-up anywhere      → commit all pending keys via onAdd (one render).
 *  - Shift + mouse-down     → range-select anchor→current, start drag.
 */
import { useRef, useCallback, useEffect } from 'react'

const DRAG_CLASS = 'drag-pending'

export function useDragSelect({ items, getKey, onAdd, onToggle }) {
  const dragging  = useRef(false)
  const anchorIdx = useRef(null)
  const pending   = useRef(new Set())   // keys accumulating during this drag

  // Keep a ref to onAdd so the mouseup handler never closes over a stale value
  const onAddRef = useRef(onAdd)
  useEffect(() => { onAddRef.current = onAdd }, [onAdd])

  // Flush on mouse-up anywhere — one state update per drag gesture
  useEffect(() => {
    const flush = () => {
      dragging.current = false
      if (pending.current.size > 0) {
        onAddRef.current([...pending.current])
        pending.current = new Set()
      }
    }
    window.addEventListener('mouseup', flush)
    return () => window.removeEventListener('mouseup', flush)
  }, [])

  const rowProps = useCallback((item, idx) => {
    const key = getKey(item)
    return {
      // Prevent text selection while dragging
      onMouseDown(e) {
        if (e.button !== 0) return
        e.preventDefault()

        if (e.shiftKey && anchorIdx.current !== null) {
          // Range-select anchor → current (one setState)
          const lo   = Math.min(anchorIdx.current, idx)
          const hi   = Math.max(anchorIdx.current, idx)
          const keys = items.slice(lo, hi + 1).map(getKey)
          onAdd(keys)
          // Keep anchor for chained shift-clicks
        } else {
          // Single toggle + start drag
          onToggle(key)
          anchorIdx.current = idx
          dragging.current  = true
          pending.current   = new Set()
        }
      },

      onMouseEnter(e) {
        if (!dragging.current) return
        if (pending.current.has(key)) return   // already queued
        pending.current.add(key)
        // Direct DOM → instant highlight, zero React re-renders
        e.currentTarget.classList.add(DRAG_CLASS)
      },
    }
  }, [items, getKey, onAdd, onToggle])

  // Prevents text selection during drag
  const tbodyStyle = { userSelect: 'none' }

  return { rowProps, tbodyStyle }
}
