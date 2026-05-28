// Query Config tab — issue #47
//
// Lets the user override the SQL used by every "fetch from database" command
// in the app.  Overrides are stored in `{output_folder}/GIRTool_settings.json`
// under the top-level `query_configs` key (one bucket per section, keyed by
// query_type).  When no override exists for a (section, query_type) pair,
// the backend falls back to the hardcoded default in `commands/*.rs`.

import { useState, useEffect, useCallback } from 'react'
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

// Always available; user-defined query types from configured databases get
// appended once #46 is merged (UI lets them type a custom one for now).
const BUILTIN_QUERY_TYPES = ['default']

export default function QueryConfigTab() {
  const [configs,  setConfigs]  = useState(null)   // server-truth (Object)
  const [drafts,   setDrafts]   = useState({})     // { sectionKey: { qt: text } } or { sectionKey: { qt: { qname: text } } }
  const [dirty,    setDirty]    = useState({})     // { "<section>/<qt>" or "<section>/<qt>/<qname>": true }
  const [busy,     setBusy]     = useState(false)
  const [msg,      setMsg]      = useState(null)   // { ok, text }
  const [openSec,  setOpenSec]  = useState(() => new Set(['project_list']))
  // Per-section state: which query type is currently being edited.
  const [activeQt, setActiveQt] = useState(() =>
    Object.fromEntries(SECTIONS.map(s => [s.key, 'default'])),
  )
  // For the Datasheet queries section: which query name (CPTData, …) is active.
  const [activeQname, setActiveQname] = useState({})

  // Load from backend once on mount (and on any output-folder change).
  const reload = useCallback(async () => {
    try {
      const r = await invoke('get_query_configs')
      setConfigs(r || {})
      setDrafts({})
      setDirty({})
      setMsg(null)
    } catch (err) {
      console.error('get_query_configs failed:', err)
      setConfigs({})
      setMsg({ ok: false, text: String(err || 'Failed to load') })
    }
  }, [])
  useEffect(() => { reload() }, [reload])

  // ── Helpers ────────────────────────────────────────────────────────────
  // Gather the union of query_type keys that exist in the loaded configs so
  // the dropdown picks them up automatically.  Always include 'default'.
  const knownQueryTypes = (() => {
    const set = new Set(BUILTIN_QUERY_TYPES)
    if (configs && typeof configs === 'object') {
      for (const sec of Object.values(configs)) {
        if (sec && typeof sec === 'object') {
          for (const k of Object.keys(sec)) set.add(k)
        }
      }
    }
    return [...set]
  })()

  // Get the value (override or empty string) for a (section, qt) — or
  // (section, qt, qname) for datasheet_queries.
  const getValue = (section, qt, qname = null) => {
    // Draft wins (in-progress edit).
    if (qname == null) {
      if (drafts[section]?.[qt] != null) return drafts[section][qt]
      return configs?.[section]?.[qt] ?? ''
    } else {
      const draftMap = drafts[section]?.[qt]
      if (draftMap && draftMap[qname] != null) return draftMap[qname]
      return configs?.[section]?.[qt]?.[qname] ?? ''
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
  const mergedForSave = () => {
    const out = JSON.parse(JSON.stringify(configs || {}))
    for (const [section, perQt] of Object.entries(drafts)) {
      if (!out[section] || typeof out[section] !== 'object') out[section] = {}
      for (const [qt, value] of Object.entries(perQt)) {
        if (section === 'datasheet_queries' && typeof value === 'object') {
          if (!out[section][qt] || typeof out[section][qt] !== 'object') out[section][qt] = {}
          for (const [qname, sql] of Object.entries(value)) {
            if (sql === '' || sql == null) {
              delete out[section][qt][qname]
            } else {
              out[section][qt][qname] = sql
            }
          }
          if (Object.keys(out[section][qt]).length === 0) {
            delete out[section][qt]
          }
        } else {
          if (value === '' || value == null) {
            delete out[section][qt]
          } else {
            out[section][qt] = value
          }
        }
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

  // Reset one override so the backend falls back to its hardcoded default.
  const resetOverride = async (section, qt) => {
    setBusy(true); setMsg(null)
    try {
      await invoke('reset_query_config', { section, queryType: qt })
      await reload()
      setMsg({ ok: true, text: `Reset ${section} / ${qt} → backend default.` })
      setTimeout(() => setMsg(m => m?.ok ? null : m), 2500)
    } catch (err) {
      setMsg({ ok: false, text: String(err || 'Reset failed') })
    } finally {
      setBusy(false)
    }
  }

  const toggleOpen = (key) => {
    setOpenSec(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  // Datasheet-queries: list of known query names (union of backend + draft).
  const datasheetQueryNames = (() => {
    const bucket = configs?.datasheet_queries?.[activeQt.datasheet_queries] || {}
    const draftBucket = drafts.datasheet_queries?.[activeQt.datasheet_queries] || {}
    return [...new Set([...Object.keys(bucket), ...Object.keys(draftBucket)])].sort()
  })()

  const anyDirty = Object.keys(dirty).length > 0

  return (
    <div className="card" style={{ maxWidth: 920 }}>
      <h3 className="section-title">Query configuration</h3>
      <p className="hint" style={{ marginBottom: '0.75rem' }}>
        Override the SQL used by every "fetch from database" command in the app.
        Settings are saved per <strong>query type</strong> (the label you give a
        database on the Database tab) — when no override exists, the backend
        falls back to its built-in default.
      </p>

      {SECTIONS.map(sec => {
        const isOpen = openSec.has(sec.key)
        const qt     = activeQt[sec.key]
        const hasOverride = sec.isMap
          ? Object.keys(configs?.[sec.key]?.[qt] || {}).length > 0
          : !!(configs?.[sec.key]?.[qt])
        const isDirtySection = Object.keys(dirty).some(k => k.startsWith(`${sec.key}/`))

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
            {hasOverride && (
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

            {/* Query type selector */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <label style={{ marginBottom: 0, fontSize: '.82rem' }}>Query type:</label>
              <select
                value={qt}
                onChange={e => setActiveQt(prev => ({ ...prev, [sec.key]: e.target.value }))}
                style={{ marginBottom: 0, width: 180 }}
              >
                {knownQueryTypes.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
                <option value="__new__">+ New type…</option>
              </select>
              {qt === '__new__' && (
                <input
                  autoFocus
                  placeholder="e.g. fieldlab"
                  onBlur={e => {
                    const v = e.target.value.trim()
                    if (v && /^[A-Za-z0-9_-]+$/.test(v)) {
                      setActiveQt(prev => ({ ...prev, [sec.key]: v }))
                    } else {
                      setActiveQt(prev => ({ ...prev, [sec.key]: 'default' }))
                    }
                  }}
                  style={{ marginBottom: 0, width: 180 }}
                />
              )}
              {hasOverride && qt !== '__new__' && (
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => resetOverride(sec.key, qt)}
                  disabled={busy}
                  title="Delete this override → use the hardcoded default"
                >
                  Reset
                </button>
              )}
            </div>

            {/* SQL editor (textarea — codemirror-style line numbers via CSS counter) */}
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
                placeholder="-- leave blank to use the hardcoded backend default"
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
