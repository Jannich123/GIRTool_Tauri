/**
 * Cross-window data-changed bus (#213) — see docs/CROSS_WINDOW_SYNC.md.
 *
 * Every Tauri window holds its own React state over ONE shared Rust backend.
 * Any code that WRITES shared state must announce it so the OTHER windows can
 * re-fetch the affected domain (the originator already holds what it wrote —
 * own-window events are skipped by default, which also rules out
 * refetch-clobbers-pending-edit races):
 *
 *   await invokeAndNotify('grouping', 'save_grouping', { ... })   // save + announce
 *   useDataChanged('grouping', () => refetch())                   // re-fetch on remote change
 *
 * Domains: 'coordinate_system' | 'map_addons' | 'colors' | 'grouping' |
 * 'strata' | 'query_configs' | 'cpt' | 'datasheets' | 'boundaries' |
 * 'databases'.  Add new domains freely — the bus is generic.
 *
 * NOT on this bus (by design):
 *  - point/project selection → dedicated `selection:updated` bus in AppContext
 *    (payload-carrying + debounced, because it is fast-changing in-memory
 *    state, not a persisted document)
 *  - per-window view state (zoom, active subtab, sort, scroll) — never synced
 *  - backend-originated writes — emit `data:changed` from Rust instead, the
 *    way session.rs::patch_session emits its session:* events
 */
import { useEffect, useRef } from 'react'
import { invoke, listen, emit, windowLabel } from '../tauri-api'

/** Announce that a domain's persisted state changed (other windows re-fetch). */
export function notifyDataChanged(domain) {
  emit('data:changed', { domain, src: windowLabel() })
}

/**
 * invoke() a mutating command, then announce the domain change.  The emit
 * only happens after the command resolves, so re-fetchers always read the
 * completed write.  Use this INSTEAD of invoke() for every command that
 * writes shared state.
 */
export async function invokeAndNotify(domain, command, args = {}) {
  const result = await invoke(command, args)
  notifyDataChanged(domain)
  return result
}

/**
 * Re-run `onChange(domain)` whenever one of `domains` (string, array, or '*')
 * is announced by ANOTHER window (pass {includeSelf: true} to also react to
 * this window's own writes).  Callback and domains are read through refs, so
 * neither needs a stable identity.
 */
export function useDataChanged(domains, onChange, { includeSelf = false } = {}) {
  const cbRef = useRef(onChange)
  cbRef.current = onChange
  const domainsRef = useRef(domains)
  domainsRef.current = domains
  useEffect(() => {
    let off = null
    listen('data:changed', (e) => {
      const d = e?.payload?.domain
      if (!d) return
      if (!includeSelf && e?.payload?.src === windowLabel()) return
      const want = domainsRef.current
      if (want === '*' || want === d || (Array.isArray(want) && want.includes(d))) {
        cbRef.current?.(d)
      }
    }).then(fn => { off = fn })
    return () => { if (typeof off === 'function') off() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
