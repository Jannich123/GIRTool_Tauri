# GIRTool — Phase 1 Plan: Project Startup, Data Selection & Data Processing

> Working document. Translated and mapped from the Danish feature list.
> We refine this together — see **Open Questions** at the bottom; inline `❓` marks
> decisions that change the layout.

## Status legend

| Mark | Meaning |
|------|---------|
| ✅ | Already built — keep |
| 🔧 | Exists but needs rework |
| 🆕 | New — build from scratch |
| ➡️ | Move / merge into another location |
| ❌ | Remove |
| ❓ | Needs a decision before building |

---

## 0. Big-picture restructure

The current app has **10 top-level tabs**. The plan collapses the data-selection
trio into one tab and adds a CPT-calculations area:

**Two distinct maps** (clarified):
- **Project map** = the *existing* 🗺️ Map tab — shows ONLY downloaded data. **Stays as a
  top-level tab.**
- **Selection map** = a *new* map inside Data Selection — shows AVAILABLE data you can
  select from. Brand new.
- Map addons (shapefile/Excel/CSV/WMS/WFS) are assigned per-addon to **which map** they
  appear in (project map, selection map, or both).

| Today (top-level tab) | Phase 1 target |
|---|---|
| 📁 Projects | ➡️ merged into **Data Selection › Projects** subtab |
| 📍 Points | ➡️ merged into **Data Selection › Points** subtab |
| 🗺️ Map | ✅ **stays** as the **Project map** (downloaded data only) |
| 🪨 Strata | ✅ stays (cluster change) |
| 📊 Data | 🔧 stays + new CPT-reduction subtab |
| — | 🆕 **Data Selection** (new tab: Map / Projects / Points subtabs) |
| — | 🆕 **CPT – Calculations** (new tab, 3 subtabs) |
| 🏷️ Grouping | ✅ keep as top-level tab |
| 🎨 Colors & Symbols | ✅ keep as top-level tab |
| 📈 Charts | ✅ keep as top-level tab |
| 〰️ Boundaries | ✅ keep as top-level tab |
| ⚙️ Settings | 🔧 reworked subtabs + startup flow |

Proposed Phase-1 tab bar:

```
[ Data Selection ] [ Strata ] [ Data Download ] [ CPT – Calc ] [ Map ] [ Grouping ] [ Colors ] [ Charts ] [ Boundaries ]   …  [ ⚙ Settings ]
        │                                                          │
        └ subtabs: [ Map (selection) ] [ Projects ] [ Points ]    └ Project map (downloaded data only)
```

---

## A. Project startup & settings

### A1. Startup flow 🆕
On every launch, present a **startup screen / dialog** with three actions:

1. **New project** — pick a target folder; scaffold an empty project (settings.json,
   `Datasheets/`, etc.).
2. **Copy existing project to a new location** — clone an existing project folder's
   config (and optionally its xlsx data) into a new folder.
3. **Open existing project** — folder picker + recent-folders list.

- Today the app silently auto-connects to the last `db_settings` and lands on Projects
  (`App.jsx`). That auto-open behaviour 🔧 becomes "open last project" inside the new flow.
- The **recent-folders** list already exists (`list_recent_folders` / `forget_recent_folder`) ✅ — reuse it.

✅ **Decided (Q-A1)**: Startup is a **full-screen route that blocks until a project is
chosen** (New / Copy / Open). The rest of the app does not render until a project is loaded.

✅ **Decided (Q-A2)**: Copy clones the **whole project — config + all data** (`Datasheets/`,
`strata.xlsx`, `projects.xlsx`, `points.xlsx`, `map addons/`, settings) into the new folder.

### A2. Project indicator + quick-open
- Sidebar already shows the **folder name** as the active project (issue #68) ✅.
- The **Settings button** behaves normally — it opens the **Settings tab** (no folder action).
- 🆕 Add: clicking the **project name** (the folder-name label in the sidebar) **opens the
  project folder in Explorer** so the user can see all the xlsx files etc. easily.

✅ **Decided (Q-A3)**: Only the **project name** reveals the folder in **Explorer** (via
`tauri_plugin_opener`); the Settings button just navigates to the Settings tab.

### A3. Settings subtabs

| Subtab | Status | Notes |
|---|---|---|
| **Project selection** | 🔧 (rework of "Project folder") | See selected project, open another, new/copy. Becomes the in-app twin of the startup flow. |
| **Databases** | ✅ | Multi-DB connector exists (DB1, DB2 …, MSSQL + Access). **Preset databases with fixed IDs** to be defined later (Q-A4, deferred). |
| **Query Config** | ✅ | Per-section SQL with GeoGIS preset; referenced by each DB's `query_type`. Already wired so Databases pick a valid query set. |
| **Map addons** | 🆕 | Load shapefile / Excel / CSV / WMS / WFS. Each addon targets a chosen map. See A4. |

🕓 **Deferred (Q-A4)**: HoleBase + the **preset databases and their fixed IDs** will be
defined later by the user.

✅ **Decided (Q-A5)**: Two maps. The **existing project map** (downloaded data only) stays as
its own tab. A **new selection map** (available data, selectable) lives in Data Selection.

### A4. Map addons 🆕
A list of overlay layers.  The subtab UI:
- A **list of addon layers** (each with a visibility toggle and a delete button).
- Adding an addon offers **two categories** (dropdown / segmented):
  1. **WMS / WFS** — enter the service URL + layer name.
  2. **Local file** — clicking it opens a **new window**:
     - select **file type** → browse + pick the file locally
     - **CSV / Excel**: user maps the **X column, Y column** (+ EPSG?) and picks the
       **info columns** to show on hover
     - **shapefile / other**: loaded with the info it already carries
- **On add**, the tool converts + **saves the layer as a GeoJSON file** under a
  `map addons/` subfolder of the project, and always loads from there afterwards.
- Each addon records **which map(s)** it shows in: project map, selection map, or both
  (so the selection map isn't polluted with every regional borehole, but boundaries /
  constructions can appear on both).
- **Delete** removes the addon (and its GeoJSON).

✅ **Decided (Q-A6)**: Local files are **converted to GeoJSON on import** and cached in
`map addons/`.  (Implementation: shapefile via a Rust `shapefile`→GeoJSON step; CSV/Excel
via the column-mapping window → GeoJSON points.)

---

## B. Data Selection (merged tab) 🔧

Merge **Projects + Points + Map** into one top-level tab with three subtabs.
Most building blocks already exist — this is mostly **relocation + a new Map selection UX**.

### B1. Map subtab 🔧 (biggest new work here)
Shows boreholes/CPTs/other geotechnical points from the **selected data sources**.

| Feature | Status | Notes |
|---|---|---|
| Render DB points on a map | ✅ | MapPage already does this, per-point EPSG projection (#122/#126). |
| Per-point hover info: source, point no., type, depth | 🔧 | Hover exists; add **data source (db_id)** + **depth** to the tooltip. |
| Toggle data sources on/off quickly | 🆕 | A source-list panel with checkboxes (DB1, DB2, HoleBase, addons). |
| **Polygon select** to add/remove points | 🆕 | Draw a polygon → points inside get added (or removed) from the selection. |
| Selected points get a **red ring** | 🆕 | Visual marker; selecting here updates the Projects + Points subtabs. |
| Source matching (Jupiter ↔ GeoGIS) | 🆕❓ | NOT deduplication — see **Cross-cutting** §F. |

✅ **Decided (Q-B2)**: A polygon selection adds the selected points **and their parent
projects** — both the Projects and Points subtabs populate.

✅ **Decided (Q-B1)**: Polygon workflow:
- User **activates polygon mode**, then clicks to drop vertices.
- **Scroll-to-zoom must NOT break** the in-progress polygon (zoom in/out freely while drawing).
- The polygon does **not** need to be explicitly closed — pressing **Add points** or
  **Remove points** auto-finishes the polygon and applies the action.
- (Implementation note: default `leaflet-draw` finishing-on-click conflicts with this; a
  custom draw handler or `leaflet.pm`/Geoman with a manual "finish on action" is likely needed.)

### B2. Projects subtab ✅ (already built — relocate)
- Selected-projects table (top) + available-projects table (bottom) + search — issue #81/#83 ✅.
- 🔧 Just move it under Data Selection and keep it in sync with map-polygon selection.

### B3. Points subtab ✅ (already built — relocate)
- Selected/available point tables + search + toggle — issue #77/#89 ✅.
- 🔧 Move under Data Selection; sync with map polygon + project selection.

---

## C. Strata ✅ 🔧

Keep the current Strata tab as-is **except**:
- 🔧 **Cluster errors/warnings per whole borehole.** Today the Error Correction tab shows
  per-issue context blocks (issue #99). Replace with borehole clusters.

✅ **Decided (Q-C1)**: 
- Group by **`(db_id, ProjectId, PointId)`** (the whole borehole).
- **Only show boreholes that contain at least one warning or error.**
- Within each borehole cluster, show **all rows for that borehole** (not just the
  problem rows) — with the error/warning rows flagged — so the user has full context to
  fix them.

---

## D. Data Download 🔧

Keep current behaviour (download / append / re-add strata / datasheet preview) ✅, and add:

### D1. CPT data-reduction subtab 🆕
Reduce CPT data volume while preserving the trend.

✅ **Decided (Q-D1)**: Apply the reduction **in place — overwrite the existing CPTData
sheet** with the reduced rows. (The JSON sidecar cache + `Re-add Strata` flow stay consistent.)

✅ **Decided (Q-D2)**: **Fixed depth window** (user picks e.g. 2 cm or 10 cm). For each CPT
borehole independently, bucket its own measure-points into windows of X cm **starting from
depth 0**. A window with **no measure-points produces no row** (no interpolation / no gap-fill).

✅ **Decided (Q-D3)**: Reduce **all numeric columns, including Depth** (each window emits one
aggregated row — moving average or median of the points in that window). **Strata is
re-applied afterwards** (the reduced rows get fresh `Primary/Secondary Layer` via the same
`(db_id, ProjectId, PointId, depth)` lookup).

- Methods: **moving average** / **moving median** (selectable). Wavelet / MRA = later stretch.
- ✅ **Decided (Q-D4)**: window on the **`Depth`** column (not `DepthC`).

---

## E. CPT – Calculations 🆕 (new tab, 3 subtabs)

Port the CPT calculations from the **old GIRTool** (CPT Guide 2022 / Robertson & Cabal,
7th ed.). Each result must be **tested & verified** against the old tool after implementation.

✅ **Decided (Q-E1)**: Source received and **vendored** into the repo at
`docs/cpt_reference/` (`cpt_calc.py` + the two Robertson SBT CSVs). This is the **golden
reference** — the Rust port is verified against it.

#### What `cpt_calc.py` reveals (the real spec)
`CPT_Calc(CPTData, fPath, net_area_ratio, ground_water_table_elevation, Nkt_values,
gamma_soil, γ_water=None, GSBLevel={}, Nkt_method="Mayne and Peuchen (2022)", round_col={})`
— a **29-step** pipeline producing ~50 columns. The function args map **exactly** to the
3 subtabs:

| `CPT_Calc` arg | Source subtab | Field |
|---|---|---|
| `net_area_ratio` (dict PointNo→) | CPT point data | Insert Cone Area Ratio (def 0.8) |
| `ground_water_table_elevation` (PointNo→) | CPT point data | Insert Water Level (def 0) |
| `GSBLevel` (PointNo→) | CPT point data | Ground/Seabed Level |
| `Nkt_values` (Primary Layer→) | CPT layer data | Nkt [-] |
| `gamma_soil` (Primary Layer→) | CPT layer data | Unit weight |
| `Nkt_method` | CPT layer data | "Robertson (2012)" or "Mayne and Peuchen (2022)" |
| `γ_water` | constant | default 10 kN/m³ |
| `round_col` (col→decimals) | CPT calculations | the `Round` column |

**Required input columns** (must be present on the CPTData sheet): `PointNo`, `qc` (MPa),
`u2`, `fs`, `Depth`, `Level`, `Primary Layer`, `TestId`, `PointId`. ✅ All already produced
by the CPTData query + strata injection.

**Pipeline-critical behaviours to replicate exactly:**
- **Per-borehole, depth-ordered, cumulative.** Stress integration uses
  `groupby(['PointNo','TestId','PointId'])` + `.shift(1)` + `.cumsum()`. The Rust port MUST
  process each borehole as an ordered sequence (effective overburden = running sum of
  per-interval `UW_eff`). Order = the sheet's existing row order (PointNo, Depth ASC).
- Unit handling: qc MPa→kPa at start, back to MPa at end; `Patm = 100 kPa`.
- `Dum_UW` back/forward-fill for missing unit weights within a borehole.
- The **Robertson 2010 SBT** classification does `searchsorted` on `-log10(Qtn)` (vertical)
  vs `log10(Fr)` / `Bq` (horizontal) into the CSV grids (note the exact slice offsets
  `[2:153,2]`, `[1][3:104]`, `[2:-1,3:-1]`).
- `Ic` is **iterative** (loop until Δ<1% or 100 iters) — must port the loop, not a closed form.
- Output: NaN / ±inf → empty string.

#### ✅ Decided (Q-E6) — calc engine: **Rust port + Python oracle (option 3)**
- The shipped app is **100% Rust** — Python never ships and never runs at runtime.
- Python is used **once, during development**, as a correctness oracle:
  1. Run the original `cpt_calc.py` on a real CPTData sample → save the result as a
     committed fixture (`docs/cpt_reference/fixtures/<sample>_expected.csv`).
  2. The Rust port runs on the same input in a test and **diffs** every column against the
     fixture within a tolerance (e.g. ±1e-3).
  3. Mismatch → fix the Rust until all columns match.
- **CI needs no Python** — it asserts against the committed fixtures. Python is only
  re-run by us if the formulas change (regenerate fixtures).
- Benefits: clean single binary for users, no Python packaging, exact-correctness
  guarantee, and the fixtures double as regression protection against future drift.

**M8 sub-steps implied:**
1. Generate the golden fixture(s) from `cpt_calc.py` on a representative CPTData export.
2. Build the Rust calc module mirroring the 29 steps (per-borehole ordered, cumulative).
3. Port the Robertson grid lookups + iterative `Ic`.
4. Test harness: Rust output vs. fixture, per column, with tolerance.
5. Wire the 3 subtabs' inputs into the calc; write results back into the CPTData sheet.

✅ **Decided (Q-E3)**: Calculated columns are written **back into the same `CPTData` sheet**
the calc reads from (then strata re-applied as usual).

✅ **Decided (Q-E2)**: Point/layer inputs are **entered manually** by the user for now
(groundwater-from-nearby-boreholes is a later enhancement).

### Subtab 1 — CPT calculations (column picker)
A table of derived columns (mirrors the attached spreadsheet).  Columns of the picker:
`Header (group) · Column Name · Description · Unit · Round · Selected · Calculation reference`.

Grouped into: **Basic Plots**, **Normalized Plots**, **Estimation Plots 1–8**.  ~50 derived
columns.  Examples: `Corr_Depth`, `qc/Pa`, `qt`, `Rf`, `u_n`, `Qt_n`, `Qtn`, `Fr`, `Bq`,
`Ic`, `SBTn`, `UW`, `N60`, `Es`, `Dr (Baldi/Kulhawy-Mayne)`, `Phi_*`, `Nkt`, `su_qt`,
`Su_Delta_u`, `St`, `su(Rem)`, `OCR_*`, `Ms`, `K_0_OCR_*`, `Qtn,cs`, `Psi`, `Vs`, `G_0`, …

- Each row has a **Selected** checkbox.  Defaults: **`UW`** and **`Nkt`** start TRUE.
- A **Round** column controls output decimals.
- Run button computes every selected column for the CPT data and writes them into `CPTData`.

#### ✅ Decided (Q-E4) — column-selection persistence (expanded design)
The CPT-calc configuration is **persisted per-project** in `GIRTool_settings.json` under a
new top-level `cpt_calc` key, so the user's choices survive restarts and travel with the
project (and its copies):

```jsonc
"cpt_calc": {
  "selected":   ["UW", "Nkt", "qt", "Ic", "su_qt"],   // which derived columns to compute
  "round":      { "qt": 3, "Ic": 1, "su_qt": 1 },      // per-column decimals (from the Round col)
  "nkt_method": "Mayne and Peuchen (2022)",            // or "Robertson (2012)"  (see Q-E5)
  "gamma_water": 10                                     // optional γ_water override (default 10)
}
```

Behaviour:
- **First run / no key**: seed `selected` with the spreadsheet defaults (**`UW`**, **`Nkt`**
  TRUE; everything else FALSE) and `round` from the reference table's Round column.
- The picker reads/writes this key; **Run** uses it; toggling a checkbox or editing a Round
  value persists immediately (fire-and-forget, same posture as the Query Config tab).
- The **column catalogue itself** (the ~50 rows: header group, name, description, unit,
  default round, calc reference) is a **static, code-side table** (it mirrors the reference
  spreadsheet and won't change per project) — only the *selection + rounds + method* are
  persisted.
- `cpt_calc` is copied with the project (Q-A2 copies everything), so a copied project keeps
  the same calc setup.

❓ **Q-E4a** (minor): the point-data (cone ratio / levels / water) and layer-data (UW / Nkt)
**tables the user fills in** — persist those in `GIRTool_settings.json` too (e.g.
`cpt_point_inputs` / `cpt_layer_inputs`), or in their own xlsx like projects/points? Lean:
settings.json keys, since they're small and project-scoped.

### Subtab 2 — CPT point data (per-point inputs)
Table keyed by **`PointNo`**, columns:
`Insert Cone Area Ratio [-]` (default **0.8**) · `Ground/Seabed Level [m]` ·
`Insert Water Level [m]` (default **0**).
- One row per CPT point in the selection; user fills / overrides defaults.
- Feeds the pore-pressure / normalisation formulas (u_n, Qt, Bq …).

### Subtab 3 — CPT layer data (per-strata inputs)
Table keyed by **`Strata`** code, columns: `Unit weight [kN/m^3]` · `Nkt [-]`.
- Rows are the strata codes present (e.g. `DG, DI, DL, DS, Fyld/Overjord, HG, HL, HP, HS,
  ML, MV, PL, TI, TL, TS, Unknown`).

#### ✅ Decided (Q-E5) — manual-vs-estimate precedence + Nkt method selector
- **Per cell**: if the user has entered a **manual value** for a strata's UW / Nkt, use it.
  Where a cell is **blank**, fall back to the **estimated value** from the correlation.
  (This is exactly how `cpt_calc.py` already behaves: `gamma_soil.get(layer)` / 
  `Nkt_values.get(layer)` first, then the formula where the dict has no entry.)
- **Nkt has two estimation methods** — the user picks which one the blank-cell fallback uses:
  - **"Mayne and Peuchen (2022)"** → `Nkt = 10.5 − 4.6·ln(Bq + 0.1)`
  - **"Robertson (2012)"** → `Nkt = 10.5 + 7·log10(Fr)`
  - A **method selector** (dropdown) lives on the CPT layer data subtab; it sets the
    `nkt_method` persisted in `cpt_calc` (Q-E4). Default: Mayne and Peuchen (2022).
- **UW** estimation (where a strata's UW cell is blank) uses the Robertson correlation
  `UW = 10·(0.27·log10(Rf) + 0.36·log10(qt/Pa) + 1.236)` (single method, no selector).

---

## F. Cross-cutting

### F1. Source matching — "rich" vs. "reference" sources 🆕❓ (design needed)
> Clarified: this is **NOT** duplicated data. A physical borehole can appear in a **rich**
> source (GeoGIS — has the actual test data) *and* in a **reference** source (Jupiter — the
> GEUS national database, which only carries the point + minimal metadata, no real data
> behind it). And Jupiter may show points that **don't exist in GeoGIS at all**.

So the map has two kinds of points:
1. **Rich points** — from GeoGIS / HoleBase: real data, downloadable, the working set.
2. **Reference-only points** — from Jupiter: location + metadata only, no test data.

Goals:
- When a borehole is present in **both** a rich source and Jupiter, show it **once**,
  attributed to the rich source (so the user works with the one that has data) — don't
  draw two overlapping markers for the same physical hole.
- Still surface **Jupiter-only** points (visible, flagged as "reference / no data"), so the
  user can see what exists in the area that GeoGIS doesn't have.

This is **spatial matching with source precedence**, not row deduplication:
- Match a Jupiter point to a rich point when they're within a small distance (and ideally a
  matching bore-name/DGU-number heuristic).
- Matched → render as the rich point (Jupiter is suppressed but linked).
- Unmatched Jupiter point → render as reference-only (distinct marker / greyed), not
  selectable for data download.

✅ **Decided (Q-F1a)**: **Jupiter via GEUS WFS** — fetch the boreholes shapefile from the
GEUS geusmap WFS (layer `jupiter_lithologi_over_10m_dybe`, `OUTPUTFORMAT=shape`, EPSG:25832).
- Example endpoint (provided): `https://data.geus.dk/geusmap/ows/25832.jsp?...REQUEST=GetFeature&LAYERS=jupiter_lithologi_over_10m_dybe&...&OUTPUTFORMAT=shape`
- **Refresh once a day on program open**; cache it **where GIRTool is installed** (app
  data dir, not per-project — it's national reference data shared across projects).
- The shape carries **RGB colour per point** (preserve it for marker colouring) + info
  fields (show on hover).
- 🆕 Backend: a `refresh_jupiter()` command (download → unzip → convert to GeoJSON →
  store in app dir, skip if today's copy already exists).

❓ **Q-F1b** (deferred): match key Jupiter↔GeoGIS — spatial only or shared DGU/boring-no.
❓ **Q-F1c** (deferred): are Jupiter reference-only points selectable, or map-only.

### F2. Data-source model
Today: `databases[]` (DB1, DB2 …) + map addons. The Map subtab's "toggle sources" needs a
single unified concept of a **data source** spanning DB connections *and* file/WxS addons.
🔧 Define a `DataSource` abstraction the map + selection consume.

---

## G. Suggested build order (milestones)

1. **M1 — Settings rework**: Project selection subtab + Map addons subtab + HoleBase type.
2. **M2 — Startup flow**: new / copy / open project screen.
3. **M3 — Data Selection shell**: merge Projects/Points/Map into one tab with subtabs
   (mostly relocation of existing pages).
4. **M4 — Map selection UX**: source toggles, polygon select, red-ring selection, richer hover.
5. **M5 — Cross-reference dedup**: pick a strategy from §F1, implement + review UI.
6. **M6 — Strata cluster view**: per-borehole error/warning clustering.
7. **M7 — CPT reduction subtab**: moving average / median (wavelet later).
8. **M8 — CPT calculations tab**: the 3 subtabs; verify against old GIRTool.

M1–M3 are low-risk (reuse existing pieces). M4–M5 and M8 are the real new engineering.

---

## H. Open questions (consolidated)

### ✅ Resolved
- **Q-tabs**: Grouping, Colors, Charts, Boundaries — **all stay** as top-level tabs.
- **Q-A1**: Startup — **full-screen, blocks until a project is chosen**.
- **Q-A2**: Copy project = **whole project incl. all data**.
- **Q-A3**: "Open project" = **reveal folder in Explorer**.
- **Q-A5**: **Two maps** — existing project map (downloaded data) stays its own tab; new
  selection map (available data) in Data Selection.
- **Q-A6**: Local-file addons **convert to GeoJSON on import**, cached in `map addons/`.
- **Q-B1**: Polygon mode → click vertices → zoom-safe → Add/Remove auto-finishes.
- **Q-B2**: Polygon selects **points + parent projects**.
- **Q-C1**: Strata clusters by `(db_id, ProjectId, PointId)`; only boreholes WITH an
  error/warning; show ALL rows of those boreholes.
- **Q-D1/D2/D3**: Reduce **in place**, **fixed depth window from 0**, **all numeric cols
  incl. depth**, empty window → no row, **re-apply strata after**.
- **Q-E1/E2/E3**: Source = `cpt_calc.py` + Robertson CSVs (✅ vendored to
  `docs/cpt_reference/`); inputs **manual** for now; output **into the same CPTData sheet**.
- **Q-F1 (reframed)**: Rich (GeoGIS/HoleBase) vs. reference (Jupiter) source matching.
- **Q-F1a**: Jupiter via **GEUS WFS**, daily refresh, cached in the install/app dir.

- **Q-E6**: Calc engine = **Rust port + Python oracle** (option 3). App ships pure Rust;
  Python only generates committed test fixtures during development.

### ❓ Still open (deferred by you — not blocking M1–M7)
- **Q-A4**: HoleBase type + the **preset databases and their fixed IDs**.
- **Q-F1b**: Jupiter↔GeoGIS match key (spatial vs DGU number).
- **Q-F1c**: Jupiter reference points selectable vs. map-only.

- **Q-D4**: window on **`Depth`**.
- **Q-E4**: CPT-calc config persisted per-project under `cpt_calc` in settings.json
  (selected columns + rounds + nkt_method + γ_water); column catalogue is static/code-side.
- **Q-E5**: manual cell wins; blank → estimate. **Nkt** has a user-selectable method
  (Mayne-Peuchen 2022 [default] / Robertson 2012); UW estimate is single-method.

### ❓ Secondary (decide during the relevant milestone)
- **Q-E4a**: persist the user-filled point-data / layer-data input tables in settings.json
  (`cpt_point_inputs` / `cpt_layer_inputs`) vs. their own xlsx. Lean: settings.json.

---

## Appendix — what already exists (so we don't rebuild it)

- Multi-DB connector, auto-numbered DB IDs, per-DB query_type (#46/#73/#97)
- Query Config tab with GeoGIS preset + 12 datasheet builtins (#47/#52/#60)
- Projects/Points split tables + search + xlsx persistence + pagination (#70/#77/#81/#83/#89)
- Map point rendering with per-point EPSG projection + diagnostics (#122/#126)
- Strata multi-DB grouping + error-correction tab + 12-col schema (#79/#93/#99)
- Data download / append (dedup by composite ID) / re-add strata (#105/#109/#111)
- Datasheet preview subtabs + filter + JSON sidecar cache (#113/#117/#128)
- Connect-folder restores selection from xlsx + connects all DBs (#75/#103/#107)
