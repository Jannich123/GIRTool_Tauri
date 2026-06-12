# GIRTool (Tauri) — working rules

Rust + Tauri 2 backend (`src-tauri/`), React 18 + Vite frontend (`frontend/`).
One shared backend process serves every window (main + `popout-*`).

## Workflow

- GitHub issue first → `feature/<slug>` or `fix/<slug>` branch from main →
  implement → PR (`Closes #N`) → squash-merge with `--delete-branch` → sync main.
- Build gates before every PR: `cargo check` + `cargo test` (in `src-tauri/`)
  and `npm run build` (in `frontend/`).
- Append manual verification steps for each feature to `docs/TEST_CHECKLIST.md`.

## Cross-window sync — MANDATORY for every feature

All windows share the Rust backend but hold separate React state. Follow
`docs/CROSS_WINDOW_SYNC.md`:

- Any command call that WRITES shared/persisted state goes through
  `invokeAndNotify('<domain>', '<command>', args)` from
  `frontend/src/lib/dataChanged.js` — never bare `invoke` for writes.
- Any context/page that CACHES shared state subscribes with
  `useDataChanged('<domain>', refetch)`.
- Point/project selection uses the dedicated `selection:updated` bus in
  `AppContext` (don't add new state there without reason).
- Per-window view state (zoom, tabs, sort, scroll) is deliberately NOT synced.

## CPT engine

The Rust CPT engine (`src-tauri/src/commands/cpt.rs`) is pinned to the Python
reference by oracle fixtures. After ANY engine change: re-run
`python scripts/gen_cpt_fixture.py`, then `cargo test`. Reference quirks are
kept faithfully — changing one means changing engine + fixtures together.

## Quirks

- `src-tauri/Cargo.toml` shows phantom CRLF-only diffs — `git checkout` it
  before committing unless dependencies actually changed.
- Danish data (æøå): keep ODBC on wide APIs (no `narrow` feature); CSVs get a
  UTF-8 BOM.
- Frontend invoke args are camelCase; commands needing it use
  `#[tauri::command(rename_all = "camelCase")]` — don't drop that attribute.
- Register every new command in `src-tauri/src/lib.rs` `invoke_handler`.
