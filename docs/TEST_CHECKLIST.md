# Post-return Test Checklist

Everything merged autonomously while you were away (PRs #175, #177, #179, #181, #183).
Work through this top-to-bottom with `git checkout main && git pull && cargo tauri dev`.
Tick boxes as you go; anything broken → tell Claude which checkbox failed.

---

## 1. Jupiter boreholes (#174 / PR #175) — *you tested most of this; the figure is new*

- [ ] **Data Selection → Map** → `⬇ Load in view` (or polygon → Load) loads **DB points AND Jupiter boreholes** for the region in one click; status shows both counts.
- [ ] Only the three categories appear, colour-coded: **Geoteknik (amber, formaal G) · Vand (blue, V/VV/VP/VM) · Miljø (green, L)** — no shot holes / brønde / monitering etc.
- [ ] Legend has a **Jupiter (GEUS)** group with three working category checkboxes.
- [ ] **Hover** a Jupiter point → DGU nr · formål · **Ejer** · **Terræn [m]** · Dybde · år · status.
- [ ] **Cyklogram figure**: hover a borehole with lithology → small **SVG pie + colour legend** (sand yellow, ler brown, grus orange…). First hover says "henter cyklogram…", then cached.
   - *Background: GEUS's own cyklogram image is dead upstream (redirects to Google's retired Image Charts API) — we parse the data from the redirect and draw it ourselves.*
- [ ] No lithology → small muted *"Cyklogram: ingen data"* (no giant text).
- [ ] **Click** a Jupiter point → borerapport opens in the browser.
- [ ] Overlapping loads don't duplicate; **Clear loaded** also clears Jupiter; tab away/back keeps everything.
- ✏️ Optional tweaks to request: lithology colours, pie size, category mapping (VA afværge / M monitering are currently **excluded** — say the word to add them to Miljø).

## 2. M5 — Excel formula round-trip (#176 / PR #177)

- [ ] Download a datasheet → open it in Excel → **add a formula column** (e.g. `=F2*2`) → save & close.
- [ ] Run **Append** (Data tab) → reopen the file: your formula cells are **still live formulas** (click one — formula bar shows `=F2*2`, not a frozen number).
- [ ] Run **Re-add Strata** → formulas still live, **except** in Primary/Secondary Layer (values, by design).
- [ ] Charts / Data preview show the formula's **calculated value**.
- ⚠ Known Phase-1 limitation (per plan Q-F3): a formula referencing newly-appended rows shows its old value until you open + save in Excel.

## 3. M6 — Strata error clustering (#178 / PR #179)

- [ ] Strata → **Error Correction**: issues now appear as **whole-borehole clusters** — header shows DB pill + PointNo + per-borehole error/warning counts.
- [ ] Each cluster shows **±2 layers around every issue** (windows merge when issues are close), with "⋯ N layers hidden / above / below" separators; problem rows highlighted red/yellow.
- [ ] Boreholes without issues don't appear; **Errors only** filter hides warning-only boreholes.
- [ ] From/To editing, ✕ Delete, save gating (no save while errors), and the tab badge all work as before.

## 4. M7 — CPT data reduction (#180 / PR #181)

- [ ] Data tab → new **🔬 CPT reduction** view: pick CPTData, window (e.g. **10 cm**), method average/median → **Reduce data**.
- [ ] Result message shows `rows_before → rows_after`; preview reflects the reduced sheet.
- [ ] Spot-check one borehole in the xlsx: rows ≈ one per 10 cm window, Depth = window aggregate, numeric columns averaged, text columns kept, **Primary/Secondary Layer re-applied**.
- [ ] Boreholes are reduced independently; empty windows produce no row.
- [ ] Re-running **Download** restores the raw data (reduction is in-place by design).

## 5. M8 — CPT calculations (#182 / PR #183)

> Engine parity is machine-verified: `cd src-tauri && cargo test` runs the Rust engine against
> fixtures generated from the **unmodified python reference** (both Nkt methods, every column,
> 1e-6 tolerance) — green at merge time. Your checks below are the UI + real-data sanity pass.

- [ ] New **🧮 CPT – Calc** tab with subtabs *CPT calculations / CPT point data / CPT layer data*.
- [ ] **CPT point data**: one row per selected CPT point; defaults (area ratio 0.8, water level 0); edits auto-save to `cpt calc settings/cpt_point_data.xlsx` (open it in Excel to confirm).
- [ ] **CPT layer data**: rows seeded from your strata layers; enter Unit weight / Nkt for a couple; **Nkt method** dropdown (default Mayne & Peuchen 2022); auto-saves to `cpt_layer_data.xlsx`.
- [ ] **CPT calculations**: catalogue shows ~69 columns in three groups; UW + Nkt ticked by default; Round editable; selections persist across restart.
- [ ] Tick a handful (qt, Rf, Ic, Qtn, SBTn, su_qt…) → **▶ Run calculation** → message `CPTData.xlsx: N columns written`.
- [ ] Open CPTData.xlsx: new columns present with the configured decimals; SBTn holds Robertson class names; re-running overwrites in place (no duplicate columns).
- [ ] **Sanity-check a few values against the old GIRTool** on the same data (the real-world acceptance test, plan Q-E1).
- ⚠ One reference quirk to be aware of (faithfully ported, pinned by fixtures): the reference **overwrites a manually-entered Unit weight with the correlation wherever Rf/qt are valid** (manual only wins where the correlation can't compute) — Nkt manual values win always. If UW-manual-should-win is what you want, say so and Claude will change engine + oracle deliberately.

## 6. Performance: project-list cache + fast map select (#185)

- [ ] **Projects tab**: first open after app start queries the DB once; switching away and back is **instant** (served from the session cache). `↻ Refresh list` re-queries.
- [ ] **`projects_list.csv`** appears in the project folder after the first load — full list incl. Danish characters correct in Excel (semicolon-delimited, UTF-8 BOM).
- [ ] Offline fallback: with the DB unreachable, the Projects tab still shows the CSV snapshot.
- [ ] **Map click-select is fast now**: selecting an available (hollow) point adds it ± its project with only that ONE project's points fetched (previously it re-pulled everything or stalled on groups/strata). **Deselecting stays instant.**
- [ ] Selecting a point from a NEW project now also populates that project's other points (blue) on the map — previously they could silently never load.
- [ ] Sidebar `↺ Refresh data` still forces a full re-pull of points.

### 6b. Points = Projects layout + instant startup lists (#190)

- [ ] **Points subtab** now mirrors Projects exactly: Selected table (fixed window, own **search bar**, Clear all, count + "auto-saved to points.xlsx") above an Available table (own **search bar**, Select all visible, infinite scroll).
- [ ] Ticking/dragging rows **auto-saves** to points.xlsx after ~0.3 s (banner confirms) — no 💾 button needed anymore.
- [ ] **Second app start is instant**: the Projects list comes from `projects_list.csv` and the restored selection's points from `points_cache.json` — no DB wait. (`↻ Refresh list` / `↻ Refresh` / `↺ Refresh data` pull fresh from the DB.)
- [ ] Map: selecting a point from a project you've loaded before (even in a past session) adds instantly — its points come from the cache.

### 6c. Data tab polish (#192)

- [ ] With >3 projects selected, the Data header shows "Projects: **N selected**" (full list on hover) instead of every name.
- [ ] Data preview: **📂 Open in Excel** opens the currently selected datasheet's xlsx.
- [ ] Download / Append / Re-add Strata: each affected datasheet in the query list shows **⏳ … → ✓ rows / +appended·skipped / 🪨 ✓** (or the error) beside its name.

### 6d. Bulk fetch + live progress (#194)

- [ ] Large downloads are **dramatically faster** (the ODBC layer now fetches 1024-row batches instead of one call per cell).
- [ ] Danish characters (æøå) still correct in downloaded text columns; numeric columns still sort numerically in previews/tables.
- [ ] During ⬇ Download / ⊕ Append the per-datasheet badges now update **live, one sheet at a time** (⏳ queued… → ⏳ downloading… → ✓), and a failing sheet doesn't stop the rest.
- [ ] `cd src-tauri && cargo test` still green (CPT oracle).

### 6e. Map-first + multi-window live selection sync (#202, #203)

- [ ] Fresh app start → Data Selection opens on the **Map** subtab (after that, the last-used subtab is restored as before).
- [ ] Pop out a window (↗ arrow) **while points are selected** → the new window opens *with* the current selection (previously it started empty).
- [ ] Select/deselect points on the map in one window → the other window's Map **and** Points tables update live (≤ ~0.2 s).
- [ ] Change the project selection in one window → the other window follows (points reload for the new projects).
- [ ] No ping-pong: making one change produces ONE update in the other window, and points.xlsx is not rewritten by the receiving window unless you interact there.
- [ ] Two pop-outs + main: a change in any window reaches both others.

### 6f. Pop-out session attach + live selection apply (#205)

- [ ] Pop out any page (↗) → it attaches to the running session immediately (no stall): Projects/Points lists populate, coordinate system + map addons load.
- [ ] Pop out while a selection exists → the selection shows up right away (handshake no longer racy; one automatic retry after 0.7 s).
- [ ] **Untick a project row — no button press** → ~0.5 s later the own-window map drops its points AND every other window follows. Same for re-ticking.
- [ ] Untick/tick point rows — same live behaviour everywhere.
- [ ] "Use projects →" now only prunes points of deselected projects (no longer clears the whole point selection).
- [ ] Opening a pop-out never blanks the main window's selection.

### 6g. Explicit-only point selection (#207)

- [ ] Select a project, pick a FEW points on the map, then untick the project in the Projects list → the point selection keeps only what was picked (drops the removed project's picks) — never balloons to "all points".
- [ ] Select a project WITHOUT picking any points → the point selection stays **empty** (Data header shows no "N points selected").
- [ ] "Use points →" with nothing ticked selects **nothing** (the old behaviour selected everything).
- [ ] Pick points on the MAP only, restart the app → the map picks are restored (they now persist to points.xlsx).
- [ ] points.xlsx in the output folder mirrors the live selection after any change (map pick, table tick, project removal).

### 6h. Buttons removed + addon polygons as boundaries (#209)

- [ ] Projects: the "Load N projects →" button is gone — ticking rows IS the selection.
- [ ] Points: the "Use N points →" button is gone — same.
- [ ] Selection map: click a polygon from a Settings → Map addons layer (shapefile / Excel / CSV rendered as polygon) → it becomes the active boundary (dashed red) with ⬇ Load / ✚ Select inside / ✖ Remove inside / Cancel.
- [ ] MultiPolygon addon: the sub-polygon you clicked is used.
- [ ] While hand-drawing, clicking an addon polygon does NOT hijack the draw (clicks drop vertices as before).
- [ ] Clicking a different addon polygon while one is staged switches the boundary; Cancel clears it.
- [ ] Project map (top-level Map page): addon polygons unchanged — tooltip only.

### 6i. Map-addon edits sync across windows (#211)

- [ ] With a map open in another window, change an addon's **color** in Settings → Map addons → the other window's layer restyles immediately (no reconnect).
- [ ] Same for **opacity** slider and the **on/off** toggle.
- [ ] **Add** a new layer (WMS or file) → it appears on the other window's map; **remove** it → it disappears there.

### 6j. Everything syncs across windows (#213)

With a pop-out open next to the main window:

- [ ] Change the **coordinate system** in Settings → the other window's Points table / map coordinates re-convert.
- [ ] Edit a **group** (assignments or colors) → the other window's Grouping/Colors pages and map/filter groupings follow.
- [ ] Edit a **strata correction** and save → the other window's Strata tab reloads; strata-layer filters update.
- [ ] **Download / Append / CPT-reduce** in one window → the other window's Data tab re-lists datasheets and drops stale previews.
- [ ] Change **CPT calc settings / point / layer data** → the other window's CPT-Calc page reloads them; CPT-reduction settings (incl. Auto-apply) follow in Data.
- [ ] Edit **query configs** → the other window's Query config tab reloads.
- [ ] **Boundaries** edits propagate (was already live, still works).
- [ ] Editing in the SAME window never reloads under your hands (own-window events are skipped).

### 6k. Database list — expandable rows + copy connection (#215)

- [ ] Settings → Database: rows are compact — arrow, **ID**, **Type**, a grey connection summary, status icon, **Test**, ⧉, ×.
- [ ] Tap a row → it expands to roomy labelled fields (Type, Server/Database or Access file + 📁, Authentication ± credentials, Query type, full status message). Tap again to collapse.
- [ ] **⧉ Copy** duplicates the connection right below with a fresh DB&lt;N&gt; ID, opened for editing — change e.g. just the database name, then *Save & connect all*.
- [ ] + Add database opens the new row expanded.
- [ ] Test / × still work from the collapsed row without expanding it.

### 6l. CRS readout on maps + addon-edit performance (#217, #218)

With a target coordinate system saved (Settings → Coordinate system):

- [ ] Both maps show a **bottom-right cursor readout**: live X/Y in the target CRS, labelled with its name. No readout when no CRS is configured.
- [ ] Selection map: point tooltips get an extra line "X · Y — <CRS name>".
- [ ] Project map: point popups (click) get the same line.
- [ ] Changing the coordinate system updates readout + tooltip numbers (dots do NOT move — same physical location).

Performance (load a few thousand points first):

- [ ] Dragging an addon's **transparency slider** (map layer panel) is smooth — layer updates ~4×/s while dragging, final value sticks.
- [ ] Dragging the **colour picker** (Settings → Map addons) on a shapefile/GeoJSON layer restyles smoothly — no full-map stutter.
- [ ] Selecting/deselecting points on the map is still instant (marker memoisation didn't break click handlers — tooltips' select/deselect wording still flips).
- [ ] Jupiter hover tooltips + cyklogram still load; addon polygon click-as-boundary (#209) still works.

### 6m. Map batch (#222)

- [ ] **Single click** on a map point still toggles just that point (now fires after ~¼ s).
- [ ] **Double-click** on a point of an UNSELECTED project → project + ALL its points enter the selection (status line confirms).
- [ ] **Double-click** on a point of a selected project → project AND all its points leave the selection.
- [ ] Double-click does not zoom the map (suppressed on markers; plain map double-click still zooms).
- [ ] Layer panel (both maps): list reads top = drawn in front; **▲ Bring forward / ▼ Send backward** behave accordingly.
- [ ] Settings → Map addons: **Built-in background maps** table shows the fixed WMS/XYZ services with URL, layer, format + working Project/Selection/Visible toggles; user addons listed under "Your addons".
- [ ] Hovering a DB point (selection map) shows the Jupiter-style list: PointNo · type, ProjectNo, Project name, Database, Z1, **Depth (Bottom − Top)**, CRS line, click hints. Polygon-loaded points show Depth too (new Top/Bottom columns).
- [ ] Settings → Query config: new sections **Map — distinct coordinate systems** and **Map — points inside polygon** (override per query type; defaults shown from the builtin templates).

### 6n. Map batch follow-ups (#224)

- [ ] Double-click decides by the **clicked point**: dbl-click an UNSELECTED point of an already-selected project → the project's remaining points are bulk-added; dbl-click a SELECTED point → project + all its points removed.
- [ ] Layer panel arrows are the old **↑/↓ in black** and clearly visible; ↑ still brings forward (top of list = front).
- [ ] Add WMS overlay: new **Token** field — used for Connect (GetCapabilities) and stored on the addon; tiles from api.dataforsyningen.dk render with a valid token.
- [ ] Existing WMS rows: **Edit** opens a panel with Token + Layer inputs (typing is throttled, no lag).

### 6o. WMS transparent-case fix (#226)

- [ ] Dataforsyningen WMS layers (built-in Orthophoto/Topo AND user-added with token) now actually **render tiles** — the service was rejecting every request over lowercase `transparent=true`.
- [ ] Other WMS addons (e.g. GEUS) still render (uppercase TRUE/FALSE is the WMS-spec spelling, universally accepted).

### 6p. Project map shows downloaded points only (#228)

- [ ] With datasheets downloaded: the Project map shows **only points that appear in a downloaded datasheet**; the header counts "N points · with downloaded data".
- [ ] Points selected but never downloaded do NOT appear; after ⬇ Download / ⊕ Append (any window) the map updates by itself ('datasheets' sync).
- [ ] With selected points but NO downloaded data: map is empty with the hint "No downloaded data for the selected points — …".
- [ ] Selection map unchanged (still shows everything selectable).
- [ ] Legacy datasheets without a DB column still light their points up (wildcard match).

### 6q. WMTS addon support + layer selection (#230)

- [ ] Settings → Map addons → Add overlay: new **Service** select (WMS / WMTS).
- [ ] WMTS + Connect against `…/topo_skaermkort_wmts_DAF` (with token): finds the layers (`topo_skaermkort`, `topo_skaermkort_tls`) and **clearly states there is NO web-mercator grid** (View1 — EPSG:25832); Add addon refuses with the same message → use the WMS variant for these two Danish services (working since #227).
- [ ] WMTS + Connect against a service WITH a GoogleMapsCompatible/3857 grid: layer dropdown lists multiple layers, Add stores layer/format/style/grid, tiles render on both maps (token supported).
- [ ] WMS Connect flow unchanged (layer dropdown still works).

### 6r. Danish-grid maps + WMTS builtins + source CRS on hover (#232)

- [ ] Both maps open on the Danish grid: **Topo map (DK) WMTS** renders as default background (crisp cached tiles); Orthophoto (DK) WMTS toggles on in the layer panel.
- [ ] **OpenStreetMap / Esri are gone** (web-mercator-only tiles can't render on the 25832 grid) — old saved entries disappear by themselves.
- [ ] Settings → Map addons → Built-in table: the **Layer column is a dropdown** (topo_skaermkort / topo_skaermkort_tls; orto_foraar_wmts / _tls) — switching re-renders the layer; choice survives restart.
- [ ] GEUS/Jupiter WMS overlays still render (now requested in EPSG:25832 — their native CRS); GeoJSON/file addons + all markers unchanged.
- [ ] Zoom feels right: country → site (topo upsamples past level 13; ortho goes deeper); saved old zooms are clamped, then self-heal.
- [ ] Adding a user WMTS now requires an EPSG:25832 grid (message names what was found); WMS addons must support 25832.
- [ ] Hovering a point (selection map) / clicking (project map) shows **Source CRS: <original system>** (origin_Projection1/Projection1, labelled like the tables).

### 6s. OSM/Esri restored — dynamic grid (#234)

- [ ] **OpenStreetMap** and **Aerial (Esri)** are back in the layer panel + builtin table.
- [ ] Toggle OSM ON → map remounts in web-mercator: OSM renders, Danish base maps still render (via their WMS fallback), all markers stay in place.
- [ ] Toggle OSM/Esri OFF → map remounts on the Danish grid: Danish maps switch to WMTS tiles (faster).
- [ ] Settings hint under "Built-in background maps" explains the automatic grid choice.
- [ ] Points/Jupiter/polygon select/GeoJSON addons behave identically on both grids.

### 6t. Selection map survives folder switches (#238)

- [ ] Load points on the map, switch to another project folder, return to the map → old loaded/Jupiter points are **cleared** with a status line saying so; ⬇ Load in view works against the new folder.
- [ ] After the switch, single-click on a loaded point adds its parent project again; double-click adds/removes the whole project (project index refreshed via the 'databases' sync domain).
- [ ] Clicking a point whose project genuinely isn't in the list shows the explanatory status line (not silent).
- [ ] Normal single-folder sessions: tab away/back still restores view + loaded points as before.

## 7. Quick regression sweep

- [ ] Startup screen → open project → lands on Data Selection; selection restored.
- [ ] Points table + points.xlsx still show converted coordinates (target CRS).
- [ ] Download / Append / datasheet preview unchanged for non-CPT sheets.
- [ ] WMS/file map addons + layer panel still render on both maps.

---

*Generated 2026-06-11 (PRs #175–#183). The fixture generator is `scripts/gen_cpt_fixture.py`;
re-run it + `cargo test` after any change to the CPT engine.*
