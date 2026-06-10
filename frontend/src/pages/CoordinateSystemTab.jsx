import { useState, useEffect, useMemo } from 'react'
import { invoke } from '../tauri-api'
import { useApp } from '../context/AppContext'

// Issue #145 — Coordinate system Settings subtab (plan §A5).
//
// This slice is UI + project-scoped persistence ONLY.  It lets the user choose:
//   • a target horizontal CRS (EPSG), and
//   • a per-elevation-system Z offset (one row per distinct LevelReference in
//     the current point selection).
// Actually reprojecting X1/Y1/Z1 into the chosen system (and creating the
// origin_* columns, applying to maps/datasheets/CPT) is a deliberate follow-up.
//
// Persisted top-level in GIRTool_settings.json under "coordinate_system" via
// get_coordinate_system / save_coordinate_system.

const TARGET_CRS_OPTIONS = [
  { value: 'EPSG:25832', label: 'EPSG:25832 — ETRS89 / UTM zone 32N' },
  { value: 'EPSG:25833', label: 'EPSG:25833 — ETRS89 / UTM zone 33N' },
  { value: 'EPSG:23032', label: 'EPSG:23032 — ED50 / UTM zone 32N' },
  { value: 'EPSG:4326',  label: 'EPSG:4326 — WGS 84 (lat/lon)' },
  { value: 'EPSG:3857',  label: 'EPSG:3857 — Web Mercator' },
]
const DEFAULT_EPSG = 'EPSG:25832'

export default function CoordinateSystemTab() {
  const { selectedPoints, connection } = useApp()
  const hasFolder = !!connection?.output_folder // need a project folder to persist

  const [targetEpsg, setTargetEpsg] = useState(DEFAULT_EPSG)
  const [customEpsg, setCustomEpsg] = useState('')    // free numeric entry (digits only)
  const [useCustom,  setUseCustom]  = useState(false)
  const [offsets,    setOffsets]    = useState({})    // { system: string|number }
  const [loaded,     setLoaded]     = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [msg,        setMsg]        = useState(null)  // { ok, text }

  // Distinct elevation systems present in the current selection (LevelReference
  // = VerticalRefId1 from the points query).
  const elevationSystems = useMemo(() => {
    const seen = new Set()
    for (const p of selectedPoints || []) {
      const v = p?.LevelReference
      if (v !== null && v !== undefined && String(v).trim() !== '') seen.add(String(v))
    }
    return [...seen].sort()
  }, [selectedPoints])

  // Load saved config on mount.
  useEffect(() => {
    let cancelled = false
    invoke('get_coordinate_system')
      .then(cfg => {
        if (cancelled || !cfg) return
        const epsg = cfg.target_epsg || DEFAULT_EPSG
        if (TARGET_CRS_OPTIONS.some(o => o.value === epsg)) {
          setTargetEpsg(epsg); setUseCustom(false)
        } else {
          setUseCustom(true)
          setCustomEpsg(String(epsg).replace(/^EPSG:/i, ''))
        }
        if (cfg.elevation_offsets && typeof cfg.elevation_offsets === 'object') {
          setOffsets(cfg.elevation_offsets)
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [])

  const effectiveEpsg = useCustom
    ? (customEpsg.trim() ? `EPSG:${customEpsg.trim()}` : '')
    : targetEpsg

  function setOffset(system, raw) {
    setOffsets(prev => ({ ...prev, [system]: raw }))
  }

  async function handleSave() {
    setMsg(null)
    if (!/^EPSG:\d+$/i.test(effectiveEpsg)) {
      setMsg({ ok: false, text: 'Enter a valid EPSG code (e.g. 25832).' })
      return
    }
    // Coerce offsets to numbers.  Retain offsets for systems not currently in
    // the selection so they survive selection changes.
    const cleanOffsets = {}
    for (const [k, v] of Object.entries(offsets)) {
      const n = parseFloat(v)
      cleanOffsets[k] = Number.isFinite(n) ? n : 0
    }
    setSaving(true)
    try {
      await invoke('save_coordinate_system', {
        config: { target_epsg: effectiveEpsg, elevation_offsets: cleanOffsets },
      })
      setMsg({ ok: true, text: 'Saved.' })
    } catch (err) {
      setMsg({ ok: false, text: String(err || 'Could not save') })
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return <p className="hint">Loading…</p>

  return (
    <div style={{ maxWidth: 920 }}>
      <h3 className="section-title">Coordinate system</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        Choose the target horizontal CRS and per-elevation-system Z offsets for this project.
        Point data is not converted yet — this saves your choices for a later update.
      </p>

      {/* ── Target horizontal CRS ── */}
      <div style={{ marginBottom: '1.25rem' }}>
        <label style={{ fontWeight: 600, display: 'block', marginBottom: '.4rem' }}>
          Target horizontal CRS
        </label>
        <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={useCustom ? '__custom__' : targetEpsg}
            onChange={e => {
              if (e.target.value === '__custom__') setUseCustom(true)
              else { setUseCustom(false); setTargetEpsg(e.target.value) }
            }}
            style={{ minWidth: 340 }}
          >
            {TARGET_CRS_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
            <option value="__custom__">Custom EPSG…</option>
          </select>
          {useCustom && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.35rem' }}>
              EPSG:
              <input
                type="text"
                inputMode="numeric"
                value={customEpsg}
                onChange={e => setCustomEpsg(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="25832"
                style={{ width: 100 }}
              />
            </span>
          )}
        </div>
      </div>

      {/* ── Elevation (vertical) offsets ── */}
      <div style={{ marginBottom: '1rem' }}>
        <label style={{ fontWeight: 600, display: 'block', marginBottom: '.4rem' }}>
          Elevation (vertical) offsets
        </label>
        {elevationSystems.length === 0 ? (
          <p className="hint" style={{ marginTop: 0 }}>
            Select points first — this table lists each distinct elevation system in your selection.
          </p>
        ) : (
          <table className="data-table" style={{ maxWidth: 480 }}>
            <thead>
              <tr>
                <th>Elevation system</th>
                <th style={{ width: 180 }}>Offset (m, added to Z)</th>
              </tr>
            </thead>
            <tbody>
              {elevationSystems.map(sys => (
                <tr key={sys}>
                  <td>{sys}</td>
                  <td>
                    <input
                      type="number"
                      step="0.001"
                      value={offsets[sys] ?? ''}
                      onChange={e => setOffset(sys, e.target.value)}
                      placeholder="0"
                      style={{ width: 140 }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">
          Z<sub>corrected</sub> = origin_Z1 + offset. Offsets for systems not in the current selection are kept.
        </p>
      </div>

      <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn-primary" onClick={handleSave} disabled={saving || !hasFolder}>
          {saving ? 'Saving…' : 'Save coordinate system'}
        </button>
        {!hasFolder && (
          <span className="hint">Connect a project folder first (Project selection tab).</span>
        )}
        {msg && <span className={`msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</span>}
      </div>
    </div>
  )
}
