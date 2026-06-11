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

## 7. Quick regression sweep

- [ ] Startup screen → open project → lands on Data Selection; selection restored.
- [ ] Points table + points.xlsx still show converted coordinates (target CRS).
- [ ] Download / Append / datasheet preview unchanged for non-CPT sheets.
- [ ] WMS/file map addons + layer panel still render on both maps.

---

*Generated 2026-06-11 (PRs #175–#183). The fixture generator is `scripts/gen_cpt_fixture.py`;
re-run it + `cargo test` after any change to the CPT engine.*
