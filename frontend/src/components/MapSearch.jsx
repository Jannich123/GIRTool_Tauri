import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import { invoke } from '../tauri-api'

// On-map address / place search (issue #294).  A search box portaled into the
// Leaflet container (top-left, beside the zoom buttons) that autocompletes
// Danish addresses + place names through the backend `geocode_search`
// (Dataforsyningen / DAWA).  Enter or a suggestion click flies the map to the
// hit and drops a temporary pin.  Lives INSIDE <MapContainer> (uses useMap), so
// the same component drops onto both the selection map and the project map.
export default function MapSearch() {
  const map = useMap()
  const [host] = useState(() => document.createElement('div'))
  const [q, setQ]           = useState('')
  const [results, setResults] = useState([])
  const [open, setOpen]     = useState(false)
  const [active, setActive] = useState(-1)
  const [busy, setBusy]     = useState(false)
  const pinRef   = useRef(null)
  const timerRef = useRef(null)
  const seqRef   = useRef(0)

  // Mount the overlay into the map container and stop clicks / scrolls inside
  // it from reaching the map (so typing or picking a suggestion never pans or
  // zooms the map underneath).
  useEffect(() => {
    host.className = 'map-search-host'
    const parent = map.getContainer()
    parent.appendChild(host)
    L.DomEvent.disableClickPropagation(host)
    L.DomEvent.disableScrollPropagation(host)
    return () => {
      clearTimeout(timerRef.current)
      if (pinRef.current) { try { map.removeLayer(pinRef.current) } catch { /* gone */ } }
      try { parent.removeChild(host) } catch { /* gone */ }
    }
  }, [map, host])

  // Debounced autocomplete; a sequence guard drops out-of-order responses.
  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setResults([]); setOpen(false); return }
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      const seq = ++seqRef.current
      setBusy(true)
      try {
        const r = await invoke('geocode_search', { query: term })
        if (seq !== seqRef.current) return
        setResults(Array.isArray(r) ? r : [])
        setActive(-1); setOpen(true)
      } catch {
        if (seq === seqRef.current) { setResults([]); setOpen(false) }
      } finally {
        if (seq === seqRef.current) setBusy(false)
      }
    }, 250)
    return () => clearTimeout(timerRef.current)
  }, [q])

  function goTo(hit) {
    if (!hit) return
    setQ(hit.label); setOpen(false); setResults([])
    const ll = L.latLng(hit.lat, hit.lng)
    // flyToBounds with a small box picks a sensible zoom for whatever grid the
    // map is on (DK 25832 or web-mercator) — no per-grid zoom-number guessing.
    try { map.flyToBounds(ll.toBounds(600), { maxZoom: 17, duration: 0.6 }) }
    catch { try { map.setView(ll, 16) } catch { /* map gone */ } }
    if (pinRef.current) { try { map.removeLayer(pinRef.current) } catch { /* gone */ } }
    const icon = L.divIcon({
      className: 'map-search-pin',
      html: '📍',
      iconSize: [22, 22],
      iconAnchor: [11, 20],
    })
    try {
      pinRef.current = L.marker(ll, { icon, zIndexOffset: 1000 })
        .addTo(map)
        .bindTooltip(hit.label, { direction: 'top', offset: [0, -16] })
      pinRef.current.openTooltip()
    } catch { /* map gone */ }
  }

  function onKeyDown(e) {
    e.stopPropagation() // keep Leaflet's keyboard pan/zoom from reacting
    if (e.key === 'ArrowDown')      { e.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(a => Math.max(a - 1, -1)) }
    else if (e.key === 'Enter')     { e.preventDefault(); goTo(active >= 0 ? results[active] : results[0]) }
    else if (e.key === 'Escape')    { setOpen(false) }
  }

  const ui = (
    <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 1000, width: 280, fontSize: '.8rem' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '.3rem',
        background: 'rgba(255,255,255,0.96)', borderRadius: 6,
        boxShadow: '0 1px 4px rgba(0,0,0,.28)', padding: '0 .45rem',
      }}>
        <span style={{ opacity: 0.55 }}>🔍</span>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => { if (results.length) setOpen(true) }}
          placeholder="Search address or place…"
          spellCheck={false}
          style={{ border: 'none', outline: 'none', flex: 1, padding: '.42rem 0', background: 'transparent', color: '#111827' }}
        />
        {busy && <span style={{ opacity: 0.5 }}>⏳</span>}
        {q && !busy && (
          <span
            onMouseDown={(e) => { e.preventDefault(); setQ(''); setResults([]); setOpen(false) }}
            title="Clear"
            style={{ cursor: 'pointer', opacity: 0.5, padding: '0 .15rem' }}
          >✕</span>
        )}
      </div>
      {open && results.length > 0 && (
        <ul style={{
          listStyle: 'none', margin: '.25rem 0 0', padding: 0,
          background: '#fff', borderRadius: 6, boxShadow: '0 2px 8px rgba(0,0,0,.28)',
          maxHeight: 264, overflowY: 'auto',
        }}>
          {results.map((r, i) => (
            <li
              key={`${r.label}_${i}`}
              onMouseDown={(e) => { e.preventDefault(); goTo(r) }}
              onMouseEnter={() => setActive(i)}
              style={{
                padding: '.4rem .55rem', cursor: 'pointer',
                display: 'flex', gap: '.4rem', alignItems: 'center',
                background: i === active ? '#eff6ff' : 'transparent',
                borderTop: i === 0 ? 'none' : '1px solid #f1f5f9',
              }}
            >
              <span style={{ opacity: 0.7, flex: '0 0 auto' }}>{r.kind === 'address' ? '🏠' : '📍'}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  return createPortal(ui, host)
}
