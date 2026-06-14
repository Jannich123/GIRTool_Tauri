# Geotechnical Chart Setup System — design & recommended plots

*A design proposal for a **chart preset/template layer** on top of GIRTool's existing
chart engine, plus a curated catalogue of the plots that matter in geotechnical
parameter analysis — CPT, classification/index tests, in-situ vane, and more.
Danish project context first, then international practice.*

Grounded in:
- the **CPT book in the RAG**: *Robertson & Cabal — Guide to Cone Penetration Testing,
  7th ed.* (`ai_knowledge/CPT-Guide-7th-Final-sm.pdf`, cited internally as "CPT Guide 2022"),
- the parameters GIRTool's CPT engine already computes (`src-tauri/src/commands/cpt.rs`, `CATALOG`),
- the **GeoGIS2020** table overview (`ai_knowledge/GeoGIS2020 TabelOversigt.pdf`) and GEUS **Jupiter**,
- the current chart engine (`frontend/src/pages/ChartsPage.jsx`).

---

## 1. What we are building

The Charts page already plots **any column against any column** as a scatter or line,
with grouping (colour/symbol by soil type or group), log axes, reference lines, polygon
boundaries and hover columns. That is a powerful *generic* engine — but a geotechnical
engineer should not have to hand-pick `Qtn` vs `Fr`, set both axes to log, and overlay the
nine Robertson zones every single time.

So the system we want is a **preset layer**: a library of named, reusable chart definitions
("plot qt, fs, Rf and u₂ against level as a CPT log", "plot Qtn–Fr with the SBTn zones") that
map onto the columns the tool produces, that a user applies in one click, and that ship with
sensible **Danish** and **international** defaults.

```
┌─────────────────────────────────────────────────────────────┐
│  Preset library  (built-in JSON + user/project presets)      │
│   • per TEST TYPE (CPT, classification, vane, oedometer…)     │
│   • per REGION    (Denmark / international)                   │
│   • each preset = chartType + X/Y + axis opts + overlays      │
└───────────────┬─────────────────────────────────────────────┘
                │ "Apply preset" / "Recommended charts"
                ▼
┌─────────────────────────────────────────────────────────────┐
│  Existing chart engine (ChartsPage)                          │
│   scatter / line · x/yCol · groupCol · log · invert ·        │
│   reference lines · boundaries · hover columns               │
└─────────────────────────────────────────────────────────────┘
```

### 1.1 Preset schema

A preset is just the existing chart config with a thin wrapper of metadata:

```jsonc
{
  "id": "cpt.sbtn_robertson_1990",
  "name": "SBTn chart — Qtn vs Fr (Robertson 1990)",
  "testType": "CPT",            // CPT | classification | vane | oedometer | triaxial | dmt | spt
  "region": "both",            // dk | international | both
  "chartType": "scatter",       // existing engine value
  "x": { "col": "Fr",  "log": true,  "title": "Normalised friction ratio Fr (%)", "range": [0.1, 10] },
  "y": { "col": "Qtn", "log": true,  "title": "Normalised cone resistance Qtn",   "range": [1, 1000] },
  "groupCol": "SBTn",          // colour by soil-behaviour zone (or by geol. unit)
  "overlays": [ { "kind": "sbtn-zones", "set": "robertson1990" } ],
  "hoverCols": ["Corr_Depth", "Ic", "qt", "Rf", "Bq"],
  "source": "CPT Guide 2022 p. 32"
}
```

For **depth/level plots** the convention is *Y = depth or level, increasing downward* —
i.e. `y.invert = true` (Denmark usually plots **level/kote**, see §6). Most geotechnical
charts are this shape; the SBT charts are the exception (both axes are parameters).

### 1.2 What the engine needs (small extensions)

The engine already has scatter/line, log axes, grouping, reference lines, boundaries and
hover columns. To cover the catalogue below it needs three modest additions:

1. **Named overlay sets** — reusable curve/zone overlays the preset can name instead of
   hand-drawing: the Robertson **SBTn zone boundaries** (1990 nine-zone and 2016 behaviour
   chart), **Ic cut-offs** (2.60 / 2.95), the **Casagrande A-line/U-line**, the **Bjerrum
   μ-correction** curve. These render through the existing reference-line / boundary code.
2. **Reverse/“depth” Y axis** as a first-class toggle (so level/kote reads top-down).
3. **Composite “log” presets** — a preset *group* that lays several depth-charts side by side
   (qt │ fs │ Rf │ u₂ │ Ic │ Su) to reproduce the classic one-page CPT log.

Everything else is configuration.

---

## 2. CPT — the core (grounded in the Robertson & Cabal guide)

GIRTool's CPT engine already computes the whole Robertson interpretation suite, organised in
`cpt.rs` into *Basic Plots → Normalized Plots → Estimation Plots 1–8*, every column cited to a
page of the guide. The presets below simply turn those columns into the plots the guide
recommends. Column names are the **engine names** (what you pick on the X/Y selectors).

### 2.1 The standard CPT log (always)

The first thing anyone looks at. One composite preset, several panels, shared inverted depth axis.

| Panel | X column | Y | Notes / overlay |
|---|---|---|---|
| Cone resistance | `qt` (corrected; `qc` raw as faint 2nd line) | Level/Depth ↓ | log-x optional in stiff till |
| Sleeve friction | `fs` | Level/Depth ↓ | |
| Friction ratio  | `Rf` | Level/Depth ↓ | typical 0–8 % |
| Pore pressure   | `u2` | Level/Depth ↓ | overlay `u0` (hydrostatic) — the gap = excess Δu |
| Soil index      | `Ic` | Level/Depth ↓ | vertical ref-lines at **Ic = 2.60 / 2.95** (sand↔silt↔clay) |

*Why:* `qt = qc + u₂·(1−a)` corrects the cone for pore pressure on the shoulder (Guide p. 23);
`Rf = fs/qt·100` (p. 27); `Ic` is the single best soil-type indicator (p. 32). Plotting `u₂`
against the hydrostatic `u0` instantly separates **drained sand** (u₂≈u0), **undrained clay**
(u₂≫u0, positive Δu) and **dilatant/stiff** material (u₂<u0).

### 2.2 Soil Behaviour Type charts (classification *from* the CPT)

These are the famous Robertson charts — the heart of "what soil is this?".

| Preset | chartType | X (log) | Y (log) | Overlay | Source |
|---|---|---|---|---|---|
| **SBTn — Qtn vs Fr (Robertson 1990)** | scatter | `Fr` | `Qtn` | 9-zone SBTn boundaries | Guide p. 32 |
| **SBTn — Qtn vs Bq** | scatter | `Bq` | `Qtn` | pore-pressure zones | Guide p. 31 |
| **SBT (non-normalised) — qc/pₐ vs Rf** | scatter | `Rf` | `qc/Pa` | 1986/2010 zones | Guide p. 27 |
| **Behaviour chart (Robertson 2016)** | scatter | `Fr` | `Qtn` | CD/CC/SC/SD/TC/TD contractive–dilative fields | Guide p. 33 |

Colour the points by `SBTn` (the engine writes the zone text) **or** by the project's
geological unit (the Colors & Symbols / grouping system) to check that the field log and the
CPT agree. The 2016 behaviour chart is the modern one — it speaks in *contractive/dilative,
clay/sand-like* terms, which is what actually governs behaviour.

### 2.3 Derived-parameter depth plots (design parameters)

One scatter/line each, X = parameter, Y = level/depth ↓. These are the plots that feed design.

| Plot | Column(s) | Typical region | Source |
|---|---|---|---|
| **Undrained shear strength Su** | `su_qt` (from qt), `Su_Delta_u` (from Δu) | clays/silts | p. 41–42 |
| Strength ratio Su/σ′v0 | `su_Ratio` | normally- vs over-consolidated check | p. 43 |
| Sensitivity St | `St` (with `su(Rem)`) | quick/soft clays, gytje | p. 43 |
| **Relative density Dr** | `Dr (Baldi, 1986)`, `Dr (Kulhawy & Mayne, 1990)` | sands | p. 49 |
| **Friction angle φ′** | `Phi_Rob_Cam`, `Phi_Kul_May`, `Phi_Jeff_Been` (sand); `Phi_Mayne_2006` (clay) | sands / clays | p. 53–54 |
| **OCR / preconsolidation** | `OCR_1992/2009/2013`, `sigma_eff_p` (σ′p) | over-consolidated clays & **till** | p. 44–45 |
| Constrained modulus M | `Ms`, `Ms/qc` | settlement | p. 67 |
| Stiffness Vs / G₀ | `Vs`, `Vs1`, `G_0`, `K_G` | dynamic, small-strain | p. 56–59 |
| Unit weight γ | `UW` | all (also feeds σ′v0) | p. 39 |
| Permeability k | `k` | drainage/consolidation | p. 60 |
| SPT-equivalent N60 | `N60` | cross-check vs SPT data | p. 39 |
| **State parameter ψ** | `Psi` (via `Qtn,cs`, `K_c`) | sand state / **liquefaction** | p. 115–138 |

*Tip:* plot **two or three correlations of the same parameter on one chart** (e.g. all four
φ′ curves, or both Dr curves) as separate series — the spread between published correlations
*is* the engineering judgement, and showing it is honest.

### 2.4 Worked example presets (concrete configs)

```jsonc
// Ic vs level with the sand/clay cut-offs
{ "id":"cpt.ic_depth", "name":"Ic vs level", "testType":"CPT", "region":"both",
  "chartType":"line", "x":{"col":"Ic","range":[0,4]}, "y":{"col":"Level","invert":true},
  "overlays":[{"kind":"vline","at":2.60,"label":"sand↔silt"},
              {"kind":"vline","at":2.95,"label":"silt↔clay"}],
  "hoverCols":["qt","Rf","SBTn"], "source":"CPT Guide 2022 p. 32" }

// Su vs level, two correlations + (optional) vane points overlaid
{ "id":"cpt.su_depth", "name":"Su vs level (CPT + vane)", "testType":"CPT", "region":"dk",
  "chartType":"scatter", "x":{"col":"su_qt","title":"Su (kPa)"}, "y":{"col":"Level","invert":true},
  "series":[{"col":"su_qt","name":"CPT (qt, Nkt)"},{"col":"Su_Delta_u","name":"CPT (Δu)"}],
  "overlays":[{"kind":"external","testType":"vane","col":"Su_field"}],
  "source":"CPT Guide 2022 p. 41" }
```

---

## 3. Classification & index tests

These describe *what the soil is* from lab samples — the complement to the CPT's *behaviour*.

| Preset | chartType | X | Y | Overlay / note |
|---|---|---|---|---|
| **Grain-size distribution** | line | grain size (mm), **log** | % passing | one series per sample; sieve/hydrometer; ISO/USCS fraction bands as vertical guides |
| **Casagrande plasticity chart** | scatter | Liquid limit `wL` (%) | Plasticity index `IP` | **A-line** `IP = 0.73(wL−20)` and **U-line** overlays; classify CL/CH/ML/MH/OL/OH |
| Atterberg + water content vs level | scatter | `wL`, `wP`, `w` (%) | Level ↓ | three series; w between wP and wL ⇒ firm; w≈wL ⇒ soft/sensitive |
| Plasticity index IP vs level | line | `IP` (%) | Level ↓ | low IP + high w ⇒ silt/sensitive |
| Bulk/dry unit weight vs level | scatter | γ / γd (kN/m³) | Level ↓ | sanity-check the CPT `UW` correlation |
| Water content / void ratio | scatter | `w` or `e` | Level ↓ | organics (gytje) plot far right |
| Organic / CaCO₃ content vs level | line | % | Level ↓ | flags gytje/tørv and limestone/chalk (DK relevance) |

*Why the plasticity chart matters in DK:* it is the fastest way to separate **low-plasticity
glacial silt/clay till** from **high-plasticity marine/post-glacial clay**, and to flag organic
soils (below the A-line, OL/OH). It pairs directly with the CPT `Ic`/SBTn classification.

---

## 4. In-situ vane test (FVT / *vingeforsøg*)

The Danish workhorse for **Su in soft clay, gytje and organic soils**. The guide and Danish
practice both stress that *field* vane strength must be **corrected** before design use.

| Preset | chartType | X | Y | Overlay |
|---|---|---|---|---|
| **Su (peak & remoulded) vs level** | scatter | `Su_field`, `Su_rem` (kPa) | Level ↓ | two series; the gap = sensitivity |
| **Sensitivity St vs level** | line | `St = Su_field/Su_rem` | Level ↓ | St>8 quick, St>30 extra-quick |
| **Bjerrum correction μ vs IP** | line | Plasticity index `IP` | μ (–) | the μ(IP) curve; μ≈1 at low IP, ↓ with IP |
| **Corrected Su = μ·Su,field vs level** | scatter | `Su_corr` | Level ↓ | this is the *design* Su |
| **Cross-method Su vs level** | scatter | Su (kPa) | Level ↓ | overlay **vane (corrected) + CPT `su_qt` + lab (triaxial/UCS)** — the key reconciliation plot |

The cross-method overlay is the single most valuable strength chart on a Danish job: it shows
whether the CPT `Nkt` you assumed reproduces the corrected vane and lab strengths, and lets you
*calibrate Nkt to the site* (the engine lets `Nkt` be set manually for exactly this).

---

## 5. Other tests worth presets

| Test | Recommended plots | Columns / note |
|---|---|---|
| **Oedometer (consolidation)** | e–log σ′ curve (per sample); σ′p, M, Cc, Cv vs level; **OCR vs level overlaid with CPT OCR** | validates `sigma_eff_p`, `Ms`, `OCR_*` |
| **Triaxial (CU/CD/UU)** | q–p′ stress paths; Su vs level; c′/φ′ envelope | feeds the Su cross-method plot |
| **SPT** | N (and N60) vs level; overlay CPT `N60` | only where SPT is used (rare in DK) |
| **Dilatometer (DMT)** | p0/p1, ID, KD, ED vs level; M, OCR, Su | alternative in-situ; compare to CPT |
| **Pressuremeter (PMT)** | pressure–volume curve; EM, pL vs level | stiff till / rock-like |

---

## 6. Danish project context (apply these defaults first)

**Standards & guidance**
- **Eurocode 7** — DS/EN 1997-1 + the **Danish National Annex (DK NA)**; design via
  *characteristic values* → partial factors. Charts should make it easy to read off a
  cautious characteristic trend (a trend line through the parameter cloud).
- **DS/EN ISO 22476-1** (CPTU), **DS/EN ISO 14688-1/-2 & 14689** (description & classification).
- **DGF (Dansk Geoteknisk Forening) Bulletins** — e.g. vane testing and *ingeniørgeologisk
  prøvebeskrivelse* (engineering-geological description); the legacy *Funderingsnorm* (DS 415).

**Danish soils — what the plots must reveal.** Danish stratigraphy is dominated by:
- **Glacial till / *moræneler*** (clay till) and sandy/gravelly till — heavily
  **over-consolidated**, stiff: high `qt`, **high OCR**, high `Ms`. The OCR-vs-level and
  Su/σ′v0 plots are what separate till from the softer clays.
- **Late-/post-glacial *marine clay*** — soft, normally- to lightly over-consolidated, low Su.
- **Meltwater sand & gravel (*smeltevandssand*)** — drained; use Dr and φ′ plots.
- **Organic soils — *gytje* (gyttja) and *tørv* (peat)** — very soft, high water content,
  high sensitivity; vane + water-content/organic-content plots are essential.

So the **default Danish presets** should: colour by **geological unit** (the Colors & Symbols
system), foreground **vane + corrected Su**, **OCR/σ′p**, and the **classification/water-content**
plots, and read depth as **level (kote)**.

**Presentation conventions**
- Plot **Y = level / kote (DVR90)**, increasing upward in metres — Danish *boreprofiler* and
  CPT logs are referenced to **terrænkote** and elevation, not raw depth. (The tool already
  carries level + coordinate-system conversion, so the preset just sets `y.col = "Level"`.)
- A4 borehole/CPT-log layout; symbols/colours per geological unit.
- Data lives in **GeoGIS2020** (see the table overview in the RAG) and the public **GEUS
  Jupiter** database — GIRTool already pulls Jupiter boreholes + *cyklogram* lithology, so
  Danish presets can cross-plot project CPTs against nearby Jupiter borings.

**Vane-first strength.** In Danish soft deposits the corrected vane is often the reference
strength; CPT `Nkt` is then *calibrated to it* per site rather than taken from the textbook
default. Make the cross-method Su plot (§4) a default Danish chart.

---

## 7. International context (then broaden)

**Standards**: ISO 22476-1 / **ASTM D5778** (CPTU); **ASTM D2487** USCS, **ASTM D4318**
Atterberg, ASTM D2166/D4767 (triaxial). The Robertson SBT/SBTn framework is universal and is
exactly what the engine already implements, so the SBT presets are region-agnostic.

**Regional flavours worth a `region:"international"` variant**
- **Norway (NGI)** — soft-clay-specific Su/OCR correlations and the NGI-ADP framework; relevant
  whenever you cross the Skagerrak.
- **Netherlands** — CPT's birthplace (Begemann); dense national CPT practice and classification.
- **North America (Mayne et al.)** — the correlations behind much of the guide; US units
  (tsf/psi) — a units toggle is useful.
- **Seismic regions** — **liquefaction triggering** (Robertson & Wride, Idriss-Boulanger):
  plot **Qtn,cs**, **state parameter ψ**, and CRR vs depth. *Not relevant to Denmark*
  (non-seismic), but a first-class international preset group. The engine already computes
  `Qtn,cs`, `K_c` and `Psi` for this.
- **Offshore** — different `Nkt`, remoulded-strength emphasis, T-bar/ball penetrometers; the
  guide's offshore sections apply.

**Default difference, in one line:** Denmark → *level/kote, geological-unit colouring,
vane-calibrated Su, OCR/till emphasis, no liquefaction*; international → *depth, SBT-zone
colouring, textbook Nkt, optional liquefaction/state, unit toggle*.

---

## 8. Implementation roadmap in GIRTool

1. **Preset catalogue** — ship `frontend/src/lib/chartPresets.js` (or a JSON resource) with the
   presets above, tagged by `testType` + `region`. User/project presets persist alongside the
   existing chart config so teams share them.
2. **"Recommended charts" picker** on the Charts page — filter by detected test type (from the
   active datasheet's columns) and region toggle; clicking a preset creates a chart with its
   config, mapping `x.col`/`y.col` onto the datasheet's columns and **warning on any missing
   column** (reuse the existing `missingX/missingY` handling).
3. **Named overlays** — implement the `overlays` kinds (`sbtn-zones`, `vline`, `casagrande`,
   `mu-correction`) on top of the existing reference-line / boundary rendering.
4. **Region toggle** — swaps Y (Level/kote ↔ Depth), units, and a few default correlations
   (e.g. default `Nkt`, default Su source). One switch, project-level.
5. **Composite log preset** — render a named *group* of depth-presets side by side
   (qt │ fs │ Rf │ u₂ │ Ic │ Su) as the one-click "CPT log".
6. **Cross-test overlays** — let a preset pull a column from *another* datasheet/test (vane Su,
   lab Su) onto a CPT depth chart — the reconciliation plots in §4/§5.

Start with #1–#2 (pure configuration on the existing engine) for immediate value; #3–#6 add the
geotechnical polish.

---

## 9. References

- **Robertson, P.K. & Cabal, K.L.** *Guide to Cone Penetration Testing for Geotechnical
  Engineering*, 7th ed. — the RAG "CPT book" (`ai_knowledge/CPT-Guide-7th-Final-sm.pdf`; cited
  in `cpt.rs` as "CPT Guide 2022", with the page numbers used throughout §2).
- **Robertson, P.K.** SBT/SBTn charts — 1986, **1990**, 2009, **2016** behaviour-based update.
- **Lunne, T., Robertson, P.K. & Powell, J.J.M.** *Cone Penetration Testing in Geotechnical
  Practice* (1997).
- **Bjerrum, L.** (1972/1973) — field-vane μ correction.
- **DGF — Dansk Geoteknisk Forening** Bulletins; **Eurocode 7** DS/EN 1997-1 + **DK NA**;
  DS/EN ISO 22476-1, 14688, 14689.
- **GeoGIS2020** table overview (`ai_knowledge/GeoGIS2020 TabelOversigt.pdf`); **GEUS Jupiter**.
- GIRTool internals: `src-tauri/src/commands/cpt.rs` (`CATALOG`), `frontend/src/pages/ChartsPage.jsx`.

*This document is a design proposal, not an implemented feature. The CPT parameter columns it
references are already produced by the engine; the preset layer, overlays and region toggle are
the new work.*
