import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Excel-style column set-filters (#248).
//
//   const { filters, setColFilter, filteredItems, anyActive, clearAll } =
//     useColumnFilters(rows)            // or useColumnFilters(items, it => it.row)
//   …render from filteredItems; put a button in each header:
//   <ColumnFilterButton col="PointNo" label="PointNo" items={rows}
//                       filters={filters} setColFilter={setColFilter} />
//
// Semantics mirror Excel: no entry for a column = everything passes; an entry
// is an INCLUDE set of stringified values ('(blank)' stands for null/empty).
// Unique values + counts are computed LAZILY when a dropdown opens and the
// listed values are capped (type to narrow) — so even 100k-row tables stay
// instant.  The dropdown renders position:fixed so scroll containers can't
// clip it.  Editable tables should pass items of shape {row, i} with a
// getRow accessor and route edits through the original index `i`.

export const BLANK = '(blank)'
const keyOf = (v) => (v == null || v === '' ? BLANK : String(v))
const LIST_CAP = 1000

export function useColumnFilters(items, getRow) {
  const [filters, setFilters] = useState({}) // col → Set<string> (include list)
  const accRef = useRef(getRow)
  accRef.current = getRow

  const setColFilter = useCallback((col, set) => {
    setFilters(prev => {
      const next = { ...prev }
      if (set == null) delete next[col]
      else next[col] = set
      return next
    })
  }, [])
  const clearAll = useCallback(() => setFilters({}), [])

  const filteredItems = useMemo(() => {
    const cols = Object.keys(filters)
    if (!cols.length) return items || []
    const acc = accRef.current || ((x) => x)
    return (items || []).filter(it => {
      const r = acc(it)
      for (const col of cols) {
        if (!filters[col].has(keyOf(r?.[col]))) return false
      }
      return true
    })
  }, [items, filters])

  return { filters, setColFilter, clearAll, filteredItems, anyActive: Object.keys(filters).length > 0 }
}

export function ColumnFilterButton({ col, label, items, getRow, filters, setColFilter }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)
  const popRef = useRef(null)

  const current = filters[col] ?? null // null = all pass
  const isActive = current != null

  // Lazy unique values + occurrence counts — only while the dropdown is open.
  const uniques = useMemo(() => {
    if (!open) return []
    const acc = getRow || ((x) => x)
    const counts = new Map()
    for (const it of (items || [])) {
      const k = keyOf(acc(it)?.[col])
      counts.set(k, (counts.get(k) || 0) + 1)
    }
    const arr = [...counts.entries()]
    const allNum = arr.every(([k]) => k === BLANK || isFinite(Number(k)))
    arr.sort((a, b) => {
      if (a[0] === BLANK) return -1
      if (b[0] === BLANK) return 1
      return allNum
        ? Number(a[0]) - Number(b[0])
        : a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' })
    })
    return arr
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, items, col])

  const needle = q.trim().toLowerCase()
  const matching = useMemo(
    () => (needle ? uniques.filter(([k]) => k.toLowerCase().includes(needle)) : uniques),
    [uniques, needle],
  )
  const visible = matching.slice(0, LIST_CAP)

  const toggleVal = (k) => {
    const all = new Set(uniques.map(([u]) => u))
    const cur = current ? new Set(current) : new Set(all)
    if (cur.has(k)) cur.delete(k)
    else cur.add(k)
    setColFilter(col, cur.size >= all.size ? null : cur)
  }

  const openPop = (e) => {
    e.stopPropagation() // header click usually sorts — don't trigger it
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      setPos({
        top: Math.min(r.bottom + 4, window.innerHeight - 340),
        left: Math.min(r.left - 8, window.innerWidth - 268),
      })
      setQ('')
    }
    setOpen(o => !o)
  }

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`colfilter-btn ${isActive ? 'active' : ''}`}
        title={isActive ? `Filtered — ${label || col}` : `Filter ${label || col}`}
        onClick={openPop}
      >
        ▾
      </button>
      {/* #250: portal to <body> — rendered inside the sticky <thead>, the
          popup is trapped in that header's stacking context and the NEXT
          table's sticky header paints over it regardless of z-index. */}
      {open && createPortal(
        <div
          ref={popRef}
          className="colfilter-pop"
          style={{ top: pos.top, left: pos.left }}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            autoFocus
            className="colfilter-search"
            placeholder="Search values…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="colfilter-actions">
            <button type="button" onClick={() => setColFilter(col, null)}>Select all</button>
            <button type="button" onClick={() => setColFilter(col, new Set())}>Clear</button>
            {isActive && <span className="colfilter-flag">filtered</span>}
          </div>
          <div className="colfilter-list">
            {visible.map(([k, n]) => (
              <label key={k} className="colfilter-row">
                <input
                  type="checkbox"
                  checked={current === null || current.has(k)}
                  onChange={() => toggleVal(k)}
                />
                <span className="colfilter-val" title={k}>{k}</span>
                <span className="colfilter-count">{n}</span>
              </label>
            ))}
            {matching.length > LIST_CAP && (
              <div className="colfilter-capnote">
                Showing {LIST_CAP} of {matching.length} values — type to narrow.
              </div>
            )}
            {matching.length === 0 && <div className="colfilter-capnote">No values match.</div>}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
