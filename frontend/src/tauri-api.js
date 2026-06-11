/**
 * Tauri API bridge.
 *
 * In the original GIRTool the frontend talks to FastAPI over HTTP (axios).
 * In the Tauri edition every backend call goes through window.__TAURI__.invoke().
 *
 * This module exports a thin wrapper so the rest of the frontend code
 * can be migrated call-by-call without changing import paths everywhere.
 *
 * Usage:
 *   import { invoke } from './tauri-api'
 *   const result = await invoke('get_grouping', { projectId: '...' })
 *
 * TODO (issue #2): Replace all axios calls in pages/ with invoke() calls,
 *                  mapping each /api/<route> to its Tauri command equivalent.
 */

const { invoke: _invoke } = window.__TAURI_INTERNALS__ ?? window.__TAURI__ ?? {};

export async function invoke(command, args = {}) {
  if (!_invoke) {
    // Running in a plain browser (dev without Tauri shell) — fall back to HTTP
    throw new Error(`Tauri not available. Command: ${command}`);
  }
  return _invoke(command, args);
}

/**
 * Subscribe to a Tauri event emitted from the Rust backend (e.g.
 * `boundaries:updated`).  Returns an async unlisten function — call it from
 * the cleanup of a useEffect to stop receiving events.
 *
 *   useEffect(() => {
 *     const off = listen('boundaries:updated', e => refetch())
 *     return () => { off.then(fn => fn()) }
 *   }, [])
 */
export function listen(eventName, handler) {
  const ev = window.__TAURI__?.event ?? window.__TAURI_INTERNALS__?.event;
  if (!ev || typeof ev.listen !== 'function') {
    // Plain browser dev — no-op unlisten.
    return Promise.resolve(() => {});
  }
  return ev.listen(eventName, handler);
}

/**
 * Broadcast a Tauri event to ALL windows of the app — including the sender,
 * so payloads should carry a `src` window label letting the sender ignore
 * its own echo.  No-op in plain-browser dev.
 */
export function emit(eventName, payload) {
  const ev = window.__TAURI__?.event ?? window.__TAURI_INTERNALS__?.event;
  if (!ev || typeof ev.emit !== 'function') return Promise.resolve();
  return ev.emit(eventName, payload);
}

/**
 * Label of the current Tauri window (`main` or `popout-<page>`).  Falls back
 * to deriving it from the ?page= query parameter — which mirrors how
 * windows.rs labels pop-outs — when the window API is unavailable.
 */
export function windowLabel() {
  try {
    const w = window.__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.()
           ?? window.__TAURI__?.window?.getCurrentWindow?.();
    if (w?.label) return w.label;
  } catch { /* fall through to the URL heuristic */ }
  try {
    const page = new URLSearchParams(window.location.search).get('page');
    return page ? `popout-${page}` : 'main';
  } catch {
    return 'main';
  }
}
