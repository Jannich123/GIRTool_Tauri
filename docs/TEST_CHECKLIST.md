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

### 6u. Background project re-index on folder connect (#240)

- [ ] Opening a project folder enters the app instantly (CSV-served list), while the DB re-index runs in the background — the Projects list reflects newly added DB projects shortly after open WITHOUT pressing ↻ Refresh list.
- [ ] Same for the Settings → connect-folder flow.
- [ ] Map parent-project lookups work for projects created since the last session (index refreshed via the 'databases' announce).

### 6v. Project list follows database-set changes (#242)

- [ ] Add a database (Settings → Database → ⧉/＋ → **Save & connect all**) → shortly after, the Projects list shows the new database's projects WITHOUT pressing ↻ Refresh (also when Projects is open in another window).
- [ ] Remove a database + Save & connect all → its projects drop out of the list the same way.
- [ ] Map parent-project selection works for points of the newly added database after the re-index lands.

### 6w. Collapsible sidebar (#244)

- [ ] **«** button next to the logo collapses the menu to icons only (~64 px); **»** expands it back.
- [ ] Collapsed: hovering an icon shows the page name; clicking navigates as usual; active page stays highlighted.
- [ ] Collapsed: logo text, project-folder name (dot stays), pop-out ↗ arrows hidden; Refresh + Settings show as icons.
- [ ] The collapsed/expanded choice survives an app restart (and is per-window — a pop-out can differ).

### 6x. Excel-style column filters (#248)

- [ ] Every filterable header shows a small **▾** funnel; clicking opens a dropdown with a search box, Select all / Clear, and a checkbox per unique value with counts; `(blank)` covers empty cells; funnel turns blue when a filter is active.
- [ ] **Projects** (#252): each table filters INDEPENDENTLY — a funnel on Selected does not narrow Available (and vice versa); dropdowns list only that table's values; "Select all" in the Available header only selects its filtered rows.
- [ ] **Points** (#252): same per-table independence; works with the existing search boxes (they compose).
- [ ] **Data → preview**: filters on any column of a big datasheet open instantly and compose with the search; columns with thousands of values show "type to narrow".
- [ ] **CPT point table**: filter PointNo/DB/Project; editing a value on a FILTERED view updates the right row (saved xlsx correct).
- [ ] **CPT layer table**: Strata column filter; edits land on the right layer.
- [ ] **Charts statistics**: Group column filter trims the rows.
- [ ] Dropdown closes on outside click / Escape; opening near the screen edge stays on screen; sort-by-header still works (the funnel doesn't trigger sorting).
- [ ] (#250) The dropdown always renders ON TOP — e.g. the Selected table's filter is not covered by the Available table's sticky header below.

### 6y. Points above addon layers + clickable addons + remove-projects action (#254, #256)

- [ ] Add a shapefile/CSV polygon or point addon overlapping your data points → DB points, Jupiter markers and selection rings render ON TOP of it, on both maps; restyling/reloading the addon keeps them on top.
- [ ] Addon polygons are hoverable (tooltip) and **clickable as selection boundaries** again (#209 regression from the first fix attempt).
- [ ] During hand-drawing, clicks over addon shapes still drop vertices.
- [ ] New **🗑 Remove projects** polygon action: every project with points inside the polygon leaves the selection together with ALL its points (status line reports the count); ⬇ Load / ✚ Select / ✖ Remove unchanged.

### 6z. CPT picker mirrors the calculation-selection sheet (#258)

- [ ] Groups read Basic / Normalized / **Estimation Plots 1–8** in sheet order; descriptions, units, rounding and "CPT Guide 2022 p. N" references match the sheet (engine names kept: the sheet's OCR_2013/OCR_2019 are OCR_2009/OCR_2013 here — noted in their descriptions).
- [ ] (#260) The **group select-all tick sits in the column-header row's checkbox column**; the group name + (x/y) counter sit as plain text above the table.
- [ ] First open in a FRESH project: exactly the sheet's green rows are pre-selected (Basic + Normalized + Estimation 1–3).
- [ ] Intermediate/QA columns (Sigma_eff_v0, n, Cn, Zone…, graph flags, alpha_E, Dr Bray & Olaya) are **hidden** by default; ticking "Show hidden columns (20)" reveals them red-tinted and selectable; untick hides them again.
- [ ] Selection, Round edits and the show-hidden toggle survive app restarts (per project folder) and sync to other windows ('cpt' domain).
- [ ] `cargo test` still 2/2 (engine untouched — catalogue metadata only).

### 6aa. Project-map grouping mode (#262)

- [ ] With a group system as the colour mode, a **🏷 Assign groups** button appears in the map toolbar (absent in Type mode); entering shows the group dropdown (+ "Unknown (clear)").
- [ ] Clicking individual points assigns the chosen group — markers recolour immediately; popups suppressed while in the mode.
- [ ] **✏️ Draw polygon** → vertices → **🏷 Assign inside** assigns every visible point inside; Cancel aborts.
- [ ] Clicking an **addon polygon** (shapefile etc.) stages it as the boundary → Assign inside works on it.
- [ ] "Unknown (clear)" removes the assignment (points fall back to the Unknown colour).
- [ ] Assignments persist (Grouping.xlsx / saved grouping) and show up in the Grouping page + other windows ('grouping' sync); cross-filter groups update.
- [ ] Exiting the mode (or switching colour mode to Type) restores normal popups/behaviour.

### 6ab. Grouping saves live-update + visible-only polygon select (#264)

- [ ] Assign a group from the Project map (click or polygon) → markers **recolour immediately**; open the Grouping tab → the assignment is there; other windows follow.
- [ ] Grouping.xlsx contains the change (incl. for points that never had a row before — PointNo/Type/Project filled).
- [ ] Selection map ✚ **Select inside** only selects points actually VISIBLE on the map (loaded ∪ project points, hidden sources excluded) — nothing invisible gets selected, no parent projects of unseen points; status suggests ⬇ Load when the polygon contains none.
- [ ] ⬇ Load still queries the databases (that's how points get onto the map).

### 6ac. Charts at 100k rows (#266 — test branch feature/charts-100k)

- [ ] A 100k-row datasheet charts FULLY (no 10k truncation); the ⚠ truncation hint only appears beyond 100k.
- [ ] Big charts pan/zoom smoothly (WebGL traces above 5k rows; small charts keep SVG + symbols).
- [ ] 10 charts on the SAME datasheet load fast after the first (one shared query result, one in-memory copy).
- [ ] Statistics table reflects the full row set.
- [ ] ↺ Refresh data / new downloads re-fetch (shared cache cleared).
### 6ad. Excel-slicer filter panel (#268)

- [ ] Side filter (Points / group systems / strata tabs): **clicking a row filters to ONLY that item**; clicking another switches to it.
- [ ] **Ctrl(/Cmd)+click** adds/removes items one by one.
- [ ] **Shift+click** selects the whole range from the last clicked row (in the visible searched/sorted order); **Ctrl+Shift+click** ADDS the range.
- [ ] The row checkbox still works as a plain additive toggle; master select-all row, search, sort and Reset unchanged.
- [ ] Selecting every item ends as "no filter" (badge disappears); filters persist + sync as before.

### 6ae. New / Copy project from Settings (#272)

- [ ] Settings → Project selection: **🆕 New project…** browses to an (empty) folder, seeds Datasheets/ + GIRTool_settings.json and connects to it (full flow: DB config, multi-DB, restore, background re-index).
- [ ] **⧉ Copy project to…** copies the CURRENT folder (all data) to a chosen empty location and switches to the copy; refuses a non-empty destination with a clear error.
- [ ] Both appear in recent folders afterwards; the sidebar project name updates.

### 6af. Editable DB IDs + named defaults + wider Project card (#274)

- [ ] Project selection card is as wide as the Database / Query Config cards.
- [ ] Expanded DB row: the **ID is editable** (e.g. rename DB1 → GeoGIS2020); duplicates / invalid characters / empty IDs turn the field red and **Save & connect all** refuses with a clear message; the expanded panel stays open through the rename.
- [ ] Renamed IDs survive a restart (no auto-rewrite back to DB&lt;N&gt;); collapsed row + DB pills show the new name everywhere.
- [ ] Fresh install (no saved databases): the list seeds **GeoGIS2020** and **GeoGIS2020aalborg** (both DKLYDB08, Windows auth, GeoGIS query type).
- [ ] ⚠ Renaming an ID changes the db_id tag on NEW data — existing cached/downloaded data keeps the old tag until refreshed/re-downloaded.

### 6ag. New-project reset + CPT visible-only calc (#276)

- [ ] 🆕 New project → the tool is a clean slate: no selected projects/points carried over (empty projects.xlsx/points.xlsx seeded in the new folder), filters reset, selection-map empty, charts refetch fresh; the OLD project's files are untouched.
- [ ] ⧉ Copy project keeps its data (selection restores from the copied xlsx) — only New resets.
- [ ] ▶ Run calculation writes ONLY the columns currently ticked AND visible in the picker — with "Show hidden" off, a stale hidden selection (old config) is not written.

### 6ah. Data import wizard (#278)

- [ ] Data -> **Import** tab: **Choose file...** opens a CSV/Excel picker, **Choose folder...** a folder picker; after picking, the matched file list + a preview grid of the FIRST file appear at the top.
- [ ] Clicking a row number in the preview marks it as the header row (highlighted); rows above the first data row are dimmed; the header/data-row number inputs stay in sync.
- [ ] Column mappings prefill from the header row (source column -> target name); rows can be added/removed/edited; **Reset from header row** re-derives them.
- [ ] PointNo source offers **File name** and every column; when a header is literally `PointNo` that column is preselected.
- [ ] Import into a NEW datasheet name creates `Datasheets/<name>.xlsx` with DB=`imported` + PointNo + mapped columns; import into an EXISTING sheet appends rows and unions new columns (old rows blank there); Data preview + charts pick the sheet up immediately (sidecar cache refreshed).
- [ ] Folder import applies the same header/data-row + mapping to every CSV/Excel file inside (Excel `~$` lock files skipped); with PointNo = file name, each file becomes one point.
- [ ] Rows whose PointNo cell is empty are skipped and reported; an all-empty trailing row is ignored silently.
- [ ] points.xlsx upsert: brand-new PointNos appear as points with db `imported` (PointId `imported_<PointNo>`, X1/Y1/Z1/Projection1 from mapped columns when present); an EXISTING PointNo only gets its MISSING coordinate fields filled - never overwritten - and the live selection (all windows) reflects the change without a restart.
- [ ] Danish CSVs import correctly: `;` delimiter and decimal commas parsed as numbers, ae/oe/aa intact (Windows-1252 fallback), leading-zero PointNos like `007` stay text.

### 6ai. Import wizard v2 - headerless files, query-driven mapping, ID sources (#280)

- [ ] **No header**: untick "file has a header row" -> the first data row defaults to 1, source columns are addressed by letter only (A, B, C...), and the mapping/ID dropdowns show plain letters; clicking a row number in the preview re-enables the header at that row.
- [ ] **Destination-driven mapping**: typing/choosing a target datasheet loads its column list - left side = datasheet columns (read-only), right side = source column dropdown with a "- skip -" option. For an EXISTING sheet the hint says "existing sheet - N columns".
- [ ] **Generated table from query**: choosing a datasheet name that does not exist on disk but matches a datasheet query (e.g. WaterLevels, SPTData) shows "new sheet generated from the <name> query - N columns" and lists exactly the query's SELECT aliases (+ DB); importing creates the sheet with ALL those columns in query order - unmapped ones exist but stay blank.
- [ ] Sources auto-match by name (header text == datasheet column, case-insensitive); "+ Add destination column" appends a free-text target that is created as a new column on import.
- [ ] **ID block**: DB / ProjectId / PointId / PointNo each offer Custom text / File name / any source column. Defaults: DB+ProjectId = text "imported", PointId = text "imported_{PointNo}", PointNo = the column literally headed PointNo else File name; headers named db/db_id/projectid/pointid auto-select their column.
- [ ] Custom-text IDs left empty turn the field red, the Import button stays disabled and a "Fill in: ..." message lists the missing ones; `{PointNo}` in custom text is replaced per row.
- [ ] Importing into an existing DOWNLOADED sheet reuses its `db_id` column for the DB value (no duplicate DB column); a sheet with a PointId/ProjectId column gets those filled from the ID block on every imported row.
- [ ] points.xlsx upsert uses the chosen IDs for NEW points (db_id/ProjectId/PointId as configured); existing PointNos still only get missing coordinates filled.

### 6aj. Import wizard - file name / custom text for every column (#282)

- [ ] Every row in the column mapping (e.g. CPTData's TestId) offers the full source list: "- skip -", **File name**, **Custom text...**, and every source column - not just columns.
- [ ] Choosing Custom text shows a text input; leaving it empty turns it red, disables Import and lists the column in the "Fill in: ..." message together with any empty IDs.
- [ ] `{PointNo}` in a column's custom text is replaced per row (e.g. TestId = `CPT_{PointNo}`); purely numeric custom text (e.g. `5`) is written as a number, leading-zero text like `007` stays text.
- [ ] File name as a column source writes the file's stem on every row of that file (folder import: each file its own value).
- [ ] Column-sourced cells still keep their original type (numbers stay numbers); auto-matched mappings and skip behaviour are unchanged.

### 6ak. Import wizard - derive Level from point Z1 (#284)

- [ ] Importing into a sheet that has both **Level** and **Depth** columns (e.g. SPTData / WaterLevels generated from their query) with the Level column left on "- skip -": each row's Level is filled as `Z1 - Depth`, where Z1 is the point's value looked up in points.xlsx by (DB id, ProjectId, PointId), falling back to PointNo.
- [ ] When the point has no Z1 anywhere (no match), Level = `-Depth` (surface treated as 0).
- [ ] If the file DOES provide a Level value for a row (Level column mapped to a source/text), that value is kept - not overwritten.
- [ ] If the file carries its own Z1 column per row, that Z1 is used for the row's Level before falling back to the points.xlsx lookup.
- [ ] Computed Level is rounded to 3 decimals (matches downloaded data); rows with no parseable Depth get no Level.
- [ ] No Level/Depth columns in the sheet -> nothing changes (feature only triggers when both exist).

### 6al. Data-selection map: legend actions, point date, corner Map-layers dropdown (#286)

- [ ] Bottom-left legend header reads **Data sources (Selectable)** ("(Selectable)" in grey).
- [ ] Below the data-source list: grey line **click = select point · double-click = whole project**; below the Jupiter (GEUS) list: grey line **click -> borerapport**. Neither hint appears inside the hover tooltips any more.
- [ ] Hovering a data-source point (project point or polygon-loaded point) shows a **Date:** line from the Points **DateEnd** column - date only, no time (blank/absent DateEnd -> no line). Jupiter hover is unchanged (still shows info + cyklogram).
- [ ] Map layers box sits in the **top-right corner** at the same inset as the +/- zoom buttons (top-left); collapsed it shows only **Map layers (N)**.
- [ ] Clicking the header expands the dropdown to the full layer list (checkbox, name, up/down reorder, opacity slider); clicking again collapses it. Collapse state is independent per map (Data selection vs Project map).
- [ ] Project map (MapPage) Map-layers box behaves the same (shared control); nothing else top-right collides with it.

### 6am. Import wizard - per-column unit conversion (#288)

- [ ] In the column mapping, every numeric column with a unit in the Column Reference (qc MPa, fs/u2 kPa, Depth m, UW kN/m3, BDen Mg/m3, MC %, Slope degrees, V1 m/s, Duration min, StressRate MPa/min) shows its **destination unit** and an "in [unit]" dropdown. Columns with unit '-' (E, CA, IL...), counts (SPT N 'blows/300 mm'), or text/no unit show **no** unit control.
- [ ] The dropdown default is "<unit> - no conversion"; options are the other units of the same dimension (e.g. for MPa: kPa, Pa, bar, atm, psi, ksf, tsf, kgf/cm²; for m: cm, mm, µm, ft, in; for %: fraction, ‰) plus **Custom factor...**.
- [ ] Selecting a source unit converts each imported value to the destination unit (verify e.g. qc imported in psi -> divided into MPa; Depth in ft -> m; MC as a 0-1 fraction -> %). With "no conversion" the value is written unchanged.
- [ ] **Custom factor...** shows a "x [factor] -> unit" input; empty/zero/non-numeric turns it red, disables Import and lists "<col> factor" in the Fill in: message. The value is multiplied by the factor.
- [ ] Conversion applies only to numeric values - a blank or text cell in a converted column passes through unchanged; a converted Depth feeds the derived Level (#284) correctly (Level = Z1 - Depth in metres).
- [ ] Units track the reference sheet: they come from GIRTool_Column_Reference.xlsx via the column dictionary, so editing a unit there (and reloading) changes what the wizard shows - only the conversion factors are coded.

### 6an. Data preview - Reload refreshes the row-count pills (#290)

- [ ] Change a datasheet's row count out-of-band (edit the .xlsx in Excel and save, or reduce/append it in another window), then click **↻ Reload data**: the count on that datasheet's pill updates to match the file (previously it stayed stale because list_datasheets trusts the persisted meta).
- [ ] The active preview still re-reads correctly; switching between datasheet pills after a reload shows the right rows and counts.

### 6ao. Charts + statistics refresh on datasheet changes (#292)

- [ ] With a chart open showing data, change the underlying datasheet (↻ Reload data after an external Excel edit, or download/append/reduce/import that sheet) -> the plot AND its statistics table update without re-touching an axis.
- [ ] A multi-file download fires one coalesced refetch (debounced), not one per file; charts don't flicker repeatedly.
- [ ] Cross-window: editing data in one window refreshes a chart open in another window.
- [ ] Charts with no data loaded yet are not force-loaded by the refresh; opening them still loads fresh data. Only charts that already show data re-pull.

### 6ap. Address / place search on both maps (#294)

- [ ] Data Selection map and Project map each show a search box top-left, beside the +/- zoom buttons.
- [ ] Typing >=2 chars autocompletes Danish addresses (house icon) and place names (pin icon); results appear within ~1 s (Dataforsyningen / DAWA).
- [ ] Clicking a suggestion - or pressing Enter (picks the highlighted / first hit) - flies the map to the location and drops a 📍 pin with the address as a tooltip; arrow keys move the highlight, Esc closes the list, ✕ clears.
- [ ] Fly-to lands correctly whether the map is on the Danish grid (EPSG:25832) or a web-mercator base (OSM/Esri) - the zoom is picked from a ~600 m box, not a fixed level.
- [ ] Typing / clicking in the box does NOT pan, zoom, or select points on the map underneath; scrolling the suggestion list doesn't zoom the map.
- [ ] A search with no matches shows nothing; with no internet the box just returns no results (no crash). Danish letters æøå in the query work.
- [ ] The pin and box clear when leaving the map; opening a pop-out map window has its own working search.

### 6aq. Map search - global addresses via Photon fallback (#296)

- [ ] A Danish query still returns DAWA results first (addresses 🏠 + places 📍), unchanged from #294.
- [ ] An international query (e.g. "Bahnhofstrasse Zurich", "10 Downing Street London", "Hamburg") returns global hits with readable labels (street housenr, postcode city, country) and flies the map there.
- [ ] A Danish query with few DAWA matches is topped up with global hits (DAWA ones stay on top); a query DAWA covers well shows DAWA only (Photon not called).
- [ ] No key / config needed; Danish letters and non-ASCII (ü, ø) render correctly. Offline -> "unavailable" message, no crash.

## 7. Quick regression sweep

- [ ] Startup screen → open project → lands on Data Selection; selection restored.
- [ ] Points table + points.xlsx still show converted coordinates (target CRS).
- [ ] Download / Append / datasheet preview unchanged for non-CPT sheets.
- [ ] WMS/file map addons + layer panel still render on both maps.

---

*Generated 2026-06-11 (PRs #175–#183). The fixture generator is `scripts/gen_cpt_fixture.py`;
re-run it + `cargo test` after any change to the CPT engine.*
