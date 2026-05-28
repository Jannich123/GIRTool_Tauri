// Query Config tab — issues #47 + #52
//
// Model (issue #52):
//   ONE top-level dropdown selects the active query type for ALL five
//   sections simultaneously (replacing the per-section dropdowns from
//   #47).  The first option is the built-in `"GeoGIS"` flavour, which is
//   pre-populated with the hardcoded SQL constants the Rust backend
//   actually runs by default.  Users may add additional flavours
//   (e.g. `"fieldlab"`) via "+ Add new…".
//
// Storage layout (unchanged from #47):
//   `{output_folder}/GIRTool_settings.json` has a top-level `query_configs`
//   object — one bucket per section, keyed by query_type.  When no
//   override exists for a (section, query_type) pair, the backend falls
//   back to the hardcoded default in `commands/*.rs`.
//
// What the textarea shows for each section / query type:
//   1. Draft (in-progress edit), else
//   2. `configs[section][activeQt]` (user override), else
//   3. If `activeQt === "GeoGIS"`: the corresponding builtin SQL template
//      fetched from `get_builtin_sql_templates`, else
//   4. Empty (with a placeholder hint).
//
// Save semantics (#52):
//   For GeoGIS, only persist textareas whose value DIFFERS from the
//   builtin — so editing the SQL away from the hardcoded default writes
//   an override, but leaving it identical does NOT bloat the settings
//   file with a duplicate.  For other query types, any non-empty value
//   is saved.

import { useState, useEffect, useCallback, useMemo } from 'react'
import { invoke } from '../tauri-api'

// Section metadata — keep names in sync with the backend constants.
const SECTIONS = [
  {
    key:       'project_list',
    title:     'Project list',
    drives:    'list_projects',
    hint:      'Used by the Projects page to populate the project picker.  No SQL placeholders.',
    isMap:     false,
  },
  {
    key:       'points_list',
    title:     'Points list',
    drives:    'get_points',
    hint:      'Used by the Points page.  Must contain the literal {ids} placeholder — replaced with the selected project IDs.',
    isMap:     false,
  },
  {
    key:       'strata_series',
    title:     'Strata series selection',
    drives:    'get_strata_types',
    hint:      'Used by Strata → Select.  Must contain {project_ids} and {point_filter}.',
    isMap:     false,
  },
  {
    key:       'strata_download',
    title:     'Strata download',
    drives:    'download_strata / get_strata_data / transfer_strata',
    hint:      'Must contain {project_ids}, {point_filter}, {series}, {interpretation}.',
    isMap:     false,
  },
  {
    key:       'datasheet_queries',
    title:     'Datasheet queries',
    drives:    'download_data per query',
    hint:      'Per-query SQL.  Use #DB#, #projectid#, #pointfilter# placeholders.  Pick a query name to edit.',
    isMap:     true,
  },
]

// The built-in query type.  Always present, always first, never deletable.
const GEOGIS = 'GeoGIS'

// Frontend regex for validating user-added query-type names.
const QT_NAME_RE = /^[A-Za-z0-9_-]+$/

export default function QueryConfigTab() {
  const [configs,    setConfigs]    = useState(null)   // server-truth (Object)
  const [builtins,   setBuiltins]   = useState(null)   // { section: sql } from get_builtin_sql_templates
  const [builtinDs,  setBuiltinDs]  = useState(null)   // { fname: sql } from get_builtin_datasheet_queries (issue #60)
  const [drafts,     setDrafts]     = useState({})     // { sectionKey: { qt: text } } or { sectionKey: { qt: { qname: text } } }
  const [dirty,      setDirty]      = useState({})     // { "<section>/<qt>" or "<section>/<qt>/<qname>": true }
  const [busy,       setBusy]       = useState(false)
  const [msg,        setMsg]        = useState(null)   // { ok, text }
  const [openSec,    setOpenSec]    = useState(() => new Set(['project_list']))
  // ONE active query type for the whole tab (replaces the old per-section state).
  const [activeQt,   setActiveQt]   = useState(GEOGIS)
  // "+ Add new…" inline input visible flag.
  const [addingNew,  setAddingNew]  = useState(false)
  // For the Datasheet queries section: which query name (CPTData, …) is active.
  const [activeQname, setActiveQname] = useState({})

  // Load configs + builtin templates + builtin datasheet queries in parallel on mount.
  const reload = useCallback(async () => {
    try {
      const [cfgs, bts, bds] = await Promise.all([
        invoke('get_query_configs'),
        invoke('get_builtin_sql_templates'),
        invoke('get_builtin_datasheet_queries'),
      ])
      setConfigs(cfgs || {})
      setBuiltins(bts || {})
      setBuiltinDs(bds || {})
      setDrafts({})
      setDirty({})
      setMsg(null)
    } catch (err) {
      console.error('Query Config load failed:', err)
      setConfigs({})
      setBuiltins({})
      setBuiltinDs({})
      setMsg({ ok: false, text: String(err || 'Failed to load') })
    }
  }, [])
  useEffect(() => { reload() }, [reload])

  // ── Helpers ────────────────────────────────────────────────────────────

  // Union of query_type keys across every saved bucket AND the currently
  // active type (which may have just been added via "+ Add new…" but has
  // no overrides saved yet).  GeoGIS is always present.
  const knownQueryTypes = useMemo(() => {
    const set = new Set([GEOGIS])
    if (configs && typeof configs === 'object') {
      for (const sec of Object.values(configs)) {
        if (sec && typeof sec === 'object') {
          for (const k of Object.keys(sec)) set.add(k)
        }
      }
    }
    if (activeQt) set.add(activeQt)
    // Also pick up any in-flight drafts for unsaved query types.
    for (const perQt of Object.values(drafts)) {
      if (perQt && typeof perQt === 'object') {
        for (const k of Object.keys(perQt)) set.add(k)
      }
    }
    // GeoGIS first, then alphabetical for the rest.
    const rest = [...set].filter(t => t !== GEOGIS).sort((a, b) => a.localeCompare(b))
    return [GEOGIS, ...rest]
  }, [configs, drafts, activeQt])

  // Get the textarea value for a (section, qt) — or (section, qt, qname) for datasheet_queries.
  // Falls through: draft → user override → GeoGIS builtin (only for GeoGIS) → ''.
  const getValue = (section, qt, qname = null) => {
    if (qname == null) {
      // Draft wins (in-progress edit).
      const draft = drafts[section]?.[qt]
      if (draft != null) return draft
      const saved = configs?.[section]?.[qt]
      if (saved != null) return saved
      if (qt === GEOGIS && builtins && typeof builtins[section] === 'string') {
        return builtins[section]
      }
      return ''
    } else {
      const draftMap = drafts[section]?.[qt]
      if (draftMap && draftMap[qname] != null) return draftMap[qname]
      const saved = configs?.[section]?.[qt]?.[qname]
      if (saved != null) return saved
      // Builtin datasheet queries are GeoGIS-only (issue #60).
      if (section === 'datasheet_queries' && qt === GEOGIS
          && builtinDs && typeof builtinDs[qname] === 'string') {
        return builtinDs[qname]
      }
      return ''
    }
  }

  // Stash an edit (does NOT persist; user clicks Save).
  const setValue = (section, qt, value, qname = null) => {
    setDrafts(prev => {
      const next = { ...prev }
      if (qname == null) {
        next[section] = { ...(next[section] || {}), [qt]: value }
      } else {
        next[section] = { ...(next[section] || {}) }
        next[section][qt] = { ...(next[section][qt] || {}), [qname]: value }
      }
      return next
    })
    const key = qname == null ? `${section}/${qt}` : `${section}/${qt}/${qname}`
    setDirty(prev => ({ ...prev, [key]: true }))
  }

  // Merge drafts into a full configs object ready to send to save_query_configs.
  //
  // For GeoGIS specifically, a textarea whose value equals the builtin SQL is
  // a "no-override" — we deliberately do NOT persist it (prevents writing
  // redundant entries that exactly match the hardcoded default).  For other
  // query types, any non-empty value is saved.
  const mergedForSave = () => {
    const out = JSON.parse(JSON.stringify(configs || {}))
    for (const [section, perQt] of Object.entries(drafts)) {
      if (!out[section] || typeof out[section] !== 'object') out[section] = {}
      for (const [qt, value] of Object.entries(perQt)) {
        if (section === 'datasheet_queries' && typeof value === 'object') {
          // Per-query-name map.
          if (!out[section][qt] || typeof out[section][qt] !== 'object') out[section][qt] = {}
          for (const [qname, sql] of Object.entries(value)) {
            // Issue #60: for GeoGIS, don't persist entries that exactly equal
            // the hardcoded builtin SQL — same redundancy heuristic the other
            // 4 sections use, just keyed by qname.
            const builtinSql = qt === GEOGIS ? builtinDs?.[qname] : null
            const isRedundantBuiltin =
              qt === GEOGIS && typeof builtinSql === 'string' && sql === builtinSql
            if (sql === '' || sql == null || isRedundantBuiltin) {
              delete out[section][qt][qname]
            } else {
              out[section][qt][qname] = sql
            }
          }
          if (Object.keys(out[section][qt]).length === 0) {
            delete out[section][qt]
          }
        } else {
          // Scalar SQL string (one of the 4 non-map sections).
          const builtin = qt === GEOGIS ? builtins?.[section] : null
          const isRedundantBuiltin =
            qt === GEOGIS && typeof builtin === 'string' && value === builtin
          if (value === '' || value == null || isRedundantBuiltin) {
            delete out[section][qt]
          } else {
            out[section][qt] = value
          }
        }
      }
      // Don't leave an empty bucket behind.
      if (out[section] && Object.keys(out[section]).length === 0) {
        delete out[section]
      }
    }
    return out
  }

  // Save everything (all sections at once).
  const saveAll = async () => {
    setBusy(true); setMsg(null)
    try {
      const merged = mergedForSave()
      await invoke('save_query_configs', { configs: merged })
      setConfigs(merged)
      setDrafts({})
      setDirty({})
      setMsg({ ok: true, text: 'Saved.' })
      setTimeout(() => setMsg(m => m?.text === 'Saved.' ? null : m), 2500)
    } catch (err) {
      console.error(err)
      setMsg({ ok: false, text: String(err || 'Save failed') })
    } finally {
      setBusy(false)
    }
  }

  // Reset one override → backend hardcoded default.  For GeoGIS the textarea
  // will then re-render showing the builtin SQL; for other types it goes blank.
  const resetOverride = async (section, qt) => {
    setBusy(true); setMsg(null)
    try {
      await invoke('reset_query_config', { section, queryType: qt })
      // Drop any draft for this (section, qt) so getValue falls back cleanly.
      setDrafts(prev => {
        const next = { ...prev }
        if (next[section]) {
          const inner = { ...next[section] }
          delete inner[qt]
          if (Object.keys(inner).length === 0) delete next[section]
          else next[section] = inner
        }
        return next
      })
      setDirty(prev => {
        const next = { ...prev }
        for (const k of Object.keys(next)) {
          if (k === `${section}/${qt}` || k.startsWith(`${section}/${qt}/`)) {
            delete next[k]
          }
        }
        return next
      })
      await reload()
      setMsg({ ok: true, text: `Reset ${section} / ${qt} → backend default.` })
      setTimeout(() => setMsg(m => m?.ok ? null : m), 2500)
    } catch (err) {
      setMsg({ ok: false, text: String(err || 'Reset failed') })
    } finally {
      setBusy(false)
    }
  }

  // Delete a custom query type — wipes every `<section>.<qt>` entry then
  // switches the active type back to GeoGIS.  Refuses to touch GeoGIS itself.
  const deleteQueryType = async (qt) => {
    if (qt === GEOGIS) return
    if (!window.confirm(
      `Delete query type "${qt}"?\n\n` +
      `This removes every SQL override saved under this type (across all sections).  ` +
      `GeoGIS and other query types are unaffected.`
    )) return

    setBusy(true); setMsg(null)
    try {
      // For each section, drop the qt bucket via reset_query_config.
      for (const sec of SECTIONS) {
        try {
          await invoke('reset_query_config', { section: sec.key, queryType: qt })
        } catch (e) {
          console.warn(`reset_query_config failed for ${sec.key}/${qt}:`, e)
        }
      }
      // Drop drafts/dirty for this qt across every section.
      setDrafts(prev => {
        const next = {}
        for (const [section, perQt] of Object.entries(prev)) {
          const cleaned = { ...perQt }
          delete cleaned[qt]
          if (Object.keys(cleaned).length > 0) next[section] = cleaned
        }
        return next
      })
      setDirty(prev => {
        // dirty keys are of the form "<section>/<qt>" or "<section>/<qt>/<qname>" —
        // drop any whose second slash-separated component matches the deleted qt.
        const next = {}
        for (const [k, v] of Object.entries(prev)) {
          const parts = k.split('/')
          if (parts[1] !== qt) next[k] = v
        }
        return next
      })
      setActiveQt(GEOGIS)
      await reload()
      setMsg({ ok: true, text: `Deleted query type "${qt}".` })
      setTimeout(() => setMsg(m => m?.ok ? null : m), 2500)
    } catch (err) {
      setMsg({ ok: false, text: String(err || 'Delete failed') })
    } finally {
      setBusy(false)
    }
  }

  // Commit a "+ Add new…" entry.  Validates against QT_NAME_RE.
  const commitNewType = (raw) => {
    const v = (raw || '').trim()
    setAddingNew(false)
    if (!v) return
    if (!QT_NAME_RE.test(v)) {
      setMsg({ ok: false, text: `Invalid query-type name: "${v}".  Use letters, digits, _, - only.` })
      return
    }
    if (v === GEOGIS) {
      setActiveQt(GEOGIS)
      return
    }
    // The type only "exists" once it has at least one override saved.  Selecting
    // it now lets the user type in textareas; saving creates the bucket.
    setActiveQt(v)
  }

  // Datasheet-queries: list of known query names for the active qt.
  //
  // For GeoGIS we also include the 12 hardcoded builtin query names from
  // `get_builtin_datasheet_queries` (issue #60) so the dropdown is pre-filled
  // even when the user has no `queries.json` saved yet.
  const datasheetQueryNames = (() => {
    const bucket = configs?.datasheet_queries?.[activeQt] || {}
    const draftBucket = drafts.datasheet_queries?.[activeQt] || {}
    const builtinKeys = (activeQt === GEOGIS && builtinDs) ? Object.keys(builtinDs) : []
    return [...new Set([
      ...Object.keys(bucket),
      ...Object.keys(draftBucket),
      ...builtinKeys,
    ])].sort()
  })()

  const anyDirty = Object.keys(dirty).length > 0

  // Does the current (section, activeQt) actually have a saved override?
  // Used for the "● override" badge.
  const hasOverride = (sec) => {
    if (sec.isMap) {
      return Object.keys(configs?.[sec.key]?.[activeQt] || {}).length > 0
    }
    return !!(configs?.[sec.key]?.[activeQt])
  }

  // Used to decide whether the per-section "Reset" button should appear.
  const canReset = (sec) => hasOverride(sec)

  return (
    <div className="card" style={{ maxWidth: 920 }}>
      <h3 className="section-title">Query configuration</h3>
      <p className="hint" style={{ marginBottom: '0.75rem' }}>
        Override the SQL used by every "fetch from database" command in the
        app.  Pick a <strong>query type</strong> at the top — every section
        below shows the SQL associated with that type.  The built-in{' '}
        <strong>GeoGIS</strong> flavour comes pre-filled with the hardcoded
        backend defaults; edit any textarea + Save to override.  Use{' '}
        <em>+ Add new…</em> to create a separate flavour for a different
        database schema (e.g. <code>fieldlab</code>).
      </p>

      {/* ── Top-level query-type selector (issue #52) ─────────────────────── */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem',
          marginBottom: '1rem', padding: '0.6rem 0.8rem',
          background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 6,
        }}
      >
        <label style={{ marginBottom: 0, fontWeight: 600 }}>Query type:</label>
        {!addingNew ? (
          <select
            value={activeQt}
            onChange={e => {
              const v = e.target.value
              if (v === '__new__') {
                setAddingNew(true)
              } else {
                setActiveQt(v)
              }
            }}
            style={{ marginBottom: 0, width: 200 }}
          >
            {knownQueryTypes.map(t => (
              <option key={t} value={t}>{t}</option>
            ))}
            <option value="__new__">+ Add new…</option>
          </select>
        ) : (
          <input
            autoFocus
            placeholder="e.g. fieldlab"
            onBlur={e => commitNewType(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter')  { commitNewType(e.currentTarget.value); e.preventDefault() }
              if (e.key === 'Escape') { setAddingNew(false) }
            }}
            style={{ marginBottom: 0, width: 200 }}
          />
        )}

        {activeQt === GEOGIS && (
          <span
            title="GeoGIS is the built-in flavour, pre-populated with the SQL the backend runs by default.  Always present; not deletable."
            style={{
              display: 'inline-block',
              padding: '0.12rem 0.5rem',
              background: '#e0e7ff',
              color: '#3730a3',
              border: '1px solid #c7d2fe',
              borderRadius: 999,
              fontSize: '.7rem',
              fontWeight: 600,
              letterSpacing: '.02em',
            }}
          >
            built-in
          </span>
        )}

        {activeQt !== GEOGIS && !addingNew && (
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => deleteQueryType(activeQt)}
            disabled={busy}
            title={`Delete query type "${activeQt}" and clear all its overrides`}
            style={{ padding: '0.2rem 0.5rem', lineHeight: 1 }}
          >
            ✕
          </button>
        )}

        <span style={{ flex: 1 }} />
        <span style={{ color: '#6b7280', fontSize: '.78rem' }}>
          {activeQt === GEOGIS
            ? 'Built-in defaults shown below; edit to override.'
            : `Custom flavour — leave a section blank to fall back to the backend's hardcoded default.`}
        </span>
      </div>

      {SECTIONS.map(sec => {
        const isOpen = openSec.has(sec.key)
        const qt = activeQt
        const overridden  = hasOverride(sec)
        const isDirtySection = Object.keys(dirty).some(k => k.startsWith(`${sec.key}/${qt}`) || (sec.isMap && k.startsWith(`${sec.key}/${qt}/`)))

        return (
        <details
          key={sec.key}
          open={isOpen}
          onToggle={e => {
            const open = e.currentTarget.open
            setOpenSec(prev => {
              const next = new Set(prev)
              if (open) next.add(sec.key); else next.delete(sec.key)
              return next
            })
          }}
          style={{ marginBottom: '0.75rem', border: '1px solid #e5e7eb', borderRadius: 6 }}
        >
          <summary style={{
            cursor: 'pointer', padding: '0.55rem 0.8rem', background: '#f9fafb',
            borderRadius: 6, fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: '0.5rem',
          }}>
            <span>{sec.title}</span>
            {overridden && (
              <span title="Override active for current query type"
                style={{ color: '#16a34a', fontSize: '.8rem' }}>● override</span>
            )}
            {isDirtySection && (
              <span title="Unsaved edits"
                style={{ color: '#d97706', fontSize: '.8rem' }}>● unsaved</span>
            )}
            <span style={{ flex: 1 }} />
            <span style={{ color: '#6b7280', fontSize: '.78rem', fontWeight: 400 }}>
              {sec.drives}
            </span>
          </summary>

          <div style={{ padding: '0.75rem 0.8rem' }}>
            <p className="hint" style={{ marginBottom: '0.5rem', fontSize: '.78rem' }}>
              {sec.hint}
            </p>

            {/* Per-section Reset button (only when an override is actually saved). */}
            {canReset(sec) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => resetOverride(sec.key, qt)}
                  disabled={busy}
                  title="Delete this override — for GeoGIS the textarea will re-show the hardcoded default; for other types it goes blank."
                >
                  Reset {sec.key} for {qt}
                </button>
              </div>
            )}

            {/* SQL editor */}
            {sec.isMap ? (
              <>
                {/* Datasheet queries: extra picker for query name */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <label style={{ marginBottom: 0, fontSize: '.82rem' }}>Query name:</label>
                  <select
                    value={activeQname[qt] ?? (datasheetQueryNames[0] || '')}
                    onChange={e => setActiveQname(prev => ({ ...prev, [qt]: e.target.value }))}
                    style={{ marginBottom: 0, width: 180 }}
                  >
                    {datasheetQueryNames.length === 0 && (
                      <option value="">— no entries —</option>
                    )}
                    {datasheetQueryNames.map(name => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                  <input
                    placeholder="+ add new query name"
                    style={{ marginBottom: 0, width: 220 }}
                    onKeyDown={e => {
                      if (e.key !== 'Enter') return
                      const v = e.currentTarget.value.trim()
                      if (!v) return
                      setValue(sec.key, qt, '', v)   // create empty entry
                      setActiveQname(prev => ({ ...prev, [qt]: v }))
                      e.currentTarget.value = ''
                    }}
                  />
                </div>
                {(activeQname[qt] || datasheetQueryNames[0]) && (
                  <textarea
                    rows={10}
                    spellCheck={false}
                    style={sqlTextareaStyle}
                    value={getValue(sec.key, qt, activeQname[qt] ?? datasheetQueryNames[0])}
                    onChange={e =>
                      setValue(sec.key, qt, e.target.value,
                        activeQname[qt] ?? datasheetQueryNames[0])
                    }
                    placeholder="SELECT ... FROM #DB#[Table] WHERE ... IN (#projectid#) #pointfilter# ..."
                  />
                )}
              </>
            ) : (
              <textarea
                rows={10}
                spellCheck={false}
                style={sqlTextareaStyle}
                value={getValue(sec.key, qt)}
                onChange={e => setValue(sec.key, qt, e.target.value)}
                placeholder={
                  qt === GEOGIS
                    ? '-- (GeoGIS built-in SQL not loaded — see console)'
                    : '-- leave blank to use the hardcoded backend default'
                }
              />
            )}
          </div>
        </details>
        )
      })}

      {/* Global save bar */}
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '1rem' }}>
        <button
          type="button"
          onClick={saveAll}
          disabled={busy || !anyDirty}
          title={anyDirty ? 'Persist all edits to GIRTool_settings.json' : 'No unsaved edits'}
        >
          {busy ? 'Saving…' : `Save ${anyDirty ? 'changes' : '(no edits)'}`}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={reload}
          disabled={busy}
        >
          ↻ Reload
        </button>
        {msg && (
          <span className={`msg ${msg.ok ? 'ok' : 'err'}`}
                style={{ marginLeft: '0.5rem', padding: '0.3rem 0.7rem' }}>
            {msg.text}
          </span>
        )}
      </div>
    </div>
  )
}

// Plain monospace SQL textarea — CodeMirror upgrade is a follow-up.
const sqlTextareaStyle = {
  width: '100%',
  fontFamily: 'Consolas, Menlo, monospace',
  fontSize: '.82rem',
  lineHeight: 1.45,
  padding: '0.5rem 0.6rem',
  background: '#fafafa',
  border: '1px solid #d1d5db',
  borderRadius: 4,
  whiteSpace: 'pre',
  overflowX: 'auto',
}
