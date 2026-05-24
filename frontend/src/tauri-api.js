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
