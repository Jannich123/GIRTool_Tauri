# Cross-window sync (#213)

GIRTool runs ONE Rust backend shared by every window (main + pop-outs), but
each window is its own webview with its own React state. Anything a user can
SEE in two windows at once must therefore be kept in sync explicitly. This
document is the contract for how that happens — **every new feature must
follow it**.

## The two mechanisms

### 1. `data:changed` bus — persisted/document state (the default)

For anything stored on disk (GIRTool_settings.json, xlsx files, datasheets):

- **Writes announce.** Call the mutating command through
  `invokeAndNotify(domain, command, args)` (`frontend/src/lib/dataChanged.js`)
  instead of `invoke(...)`. It emits `data:changed {domain, src}` *after* the
  write resolves, so readers always see the completed write.
- **Readers re-fetch.** Any context/page that caches that domain subscribes:
  `useDataChanged('grouping', refetch)`. Events from the OWN window are
  skipped by default — the originator already holds what it wrote, and this
  rules out refetch-clobbers-pending-edit races.
- Backend-originated writes (no frontend invoke) emit the same event from
  Rust — see `session.rs::patch_session` for the pattern
  (`app.emit("data:changed", json!({"domain": ..., "src": "backend"}))`).

| Domain              | Written by                                                | Re-fetched by |
|---------------------|-----------------------------------------------------------|---------------|
| `coordinate_system` | CoordinateSystemTab                                        | AppContext |
| `map_addons`        | AppContext.saveMapAddons (Settings → Map addons)           | AppContext |
| `colors`            | AppContext.scheduleColorsXlsxSave                          | AppContext (re-reads shared localStorage) |
| `grouping`          | GroupingPage, ColorsPage (save_grouping)                   | FilterContext, GroupingPage, ColorsPage |
| `strata`            | StrataPage (update/transfer/download_strata)               | FilterContext, StrataPage corrections tab |
| `datasheets`        | DataPage (download/append/readd/reduce), CptCalcPage (run) | DataPage (list + preview cache), FilterContext (strata layers) |
| `cpt`               | CptCalcPage (config/point/layer), DataPage (reduction cfg) | CptCalcPage, DataPage |
| `query_configs`     | QueryConfigTab                                             | QueryConfigTab |
| `boundaries`        | BoundariesPage commands                                    | AppContext (charts overlay etc.) |
| `databases`         | SettingsPage (save_databases, connect_all_databases)       | — (Settings re-fetches on mount; backend caches are shared) |

Conflicts resolve as **last writer wins** — a remote change replaces local
unsaved edits in the re-fetching window.

### 2. `selection:updated` bus — fast in-memory state (special case)

The point/project selection changes many times a minute and lives in memory,
so it has a dedicated payload-carrying bus in `AppContext` (debounced 150 ms,
src-labelled, content-key deduped, plus a `selection:sync-request` handshake
so freshly opened windows pull the live selection). Don't add new state here
unless it has the same fast-changing in-memory character.

### Already-synced backend events (predate the bus)

`session:boundaries:updated` and `session:filters:updated` are emitted from
`patch_session` in Rust and consumed by AppContext / FilterContext. They stay.

## Deliberately NOT synced

Per-window view state: map zoom/center, active tab/subtab, table sort &
search, scroll positions, in-progress polygon draws, expand/collapse state.
Windows are independent workspaces over the same data.

## Checklist for any new feature (copy into the PR if unsure)

1. Does it WRITE shared state? → save through `invokeAndNotify('<domain>', …)`
   (reuse a domain above or add a new one — the bus is generic).
2. Does it CACHE shared state in React? → add `useDataChanged('<domain>', refetch)`.
3. Is it fast-changing in-memory state every window must mirror instantly?
   → extend the selection-bus pattern in AppContext instead.
4. Is it per-window view state? → leave it alone, and don't sync it.
5. Add a line to TEST_CHECKLIST: "change X in one window → other window follows".
