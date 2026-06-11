// CPT calculations (M8, issue #182 / plan §E, Q-E1..E6).
//
// Rust port of the vendored golden reference `docs/cpt_reference/cpt_calc.py`
// (CPT Guide 2022 / Robertson & Cabal, 7th ed.) — a 29-step per-borehole
// pipeline producing ~55 derived columns, written back into the CPTData sheet
// (Q-E3).  The port follows the reference AS EXECUTED, including its quirks
// (python operator-precedence effects on three masks, the UW correlation
// overwrite, kPa-domain bounds in two late steps); parity is enforced by a
// fixture test against the python oracle (Q-E6, option 3) — see
// docs/cpt_reference/fixtures/ and `mod tests` below.
//
// Inputs (Q-E4a): per-point values from `cpt calc settings/cpt_point_data.xlsx`
// (cone area ratio, ground/seabed level, water level) and per-layer values from
// `cpt calc settings/cpt_layer_data.xlsx` (unit weight, Nkt).  Scalar config
// (selected columns, rounds, nkt_method, gamma_water) lives in
// GIRTool_settings.json::cpt_calc (Q-E4).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;

use calamine::{open_workbook_auto, Data, Reader as XlsxReader};
use rust_xlsxwriter::{Color, Format, FormatAlign, Workbook};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::commands::download::{
    datasheets_dir, persist_datasheet_meta, read_existing_datasheet, write_datasheet,
    write_datasheet_cache,
};
use crate::state::AppState;

const PATM: f64 = 100.0; // kPa

// ── Column catalogue (Q-E4: static, code-side) ────────────────────────────────

pub struct CatEntry {
    pub group: &'static str,
    pub name: &'static str,
    pub desc: &'static str,
    pub unit: &'static str,
    pub round: i32, // default decimals; -1 = text column (no rounding)
    pub default_selected: bool,
    /// Calculation reference (formula + source) shown in the picker — mirrors
    /// the reference spreadsheet's "Calculation reference" column (issue #198).
    pub reference: &'static str,
}

macro_rules! cat {
    ($g:expr, $n:expr, $d:expr, $u:expr, $r:expr, $f:expr) => {
        CatEntry { group: $g, name: $n, desc: $d, unit: $u, round: $r, default_selected: false, reference: $f }
    };
    ($g:expr, $n:expr, $d:expr, $u:expr, $r:expr, $f:expr, sel) => {
        CatEntry { group: $g, name: $n, desc: $d, unit: $u, round: $r, default_selected: true, reference: $f }
    };
}

pub static CATALOG: &[CatEntry] = &[
    // ── Basic Plots ──
    cat!("Basic Plots", "Water Level", "Groundwater table elevation mapped per point", "m", 2, "User input (CPT point data)"),
    cat!("Basic Plots", "Corr_Depth", "Depth corrected to ground/seabed level", "m", 3, "GSB − Level (or Depth)"),
    cat!("Basic Plots", "qc/Pa", "Cone resistance normalised by atmospheric pressure", "-", 3, "qc / Pa, Pa = 100 kPa"),
    cat!("Basic Plots", "u0", "Hydrostatic pore pressure", "kPa", 2, "(WL − Level)·γw below the water table"),
    cat!("Basic Plots", "qt", "Corrected cone resistance", "MPa", 4, "qt = qc + u2·(1−a) — CPT Guide 2022"),
    cat!("Basic Plots", "Rf", "Friction ratio fs/qt", "%", 2, "Rf = fs/qt·100"),
    cat!("Basic Plots", "UW", "Unit weight (manual per layer or Robertson correlation)", "kN/m³", 2, "γ/γw = 0.27·logRf + 0.36·log(qt/Pa) + 1.236 — Robertson & Cabal (2010)", sel),
    cat!("Basic Plots", "UW_eff", "Per-interval effective overburden contribution", "kPa", 3, "ΔLevel · γ' per interval"),
    cat!("Basic Plots", "Sigma_eff_v0", "Effective vertical stress (cumulative)", "kPa", 2, "σ'v0 = Σ UW_eff per borehole"),
    cat!("Basic Plots", "Sigma_t_v0", "Total vertical stress", "kPa", 2, "σv0 = σ'v0 + u0"),
    cat!("Basic Plots", "Stress_Ratio", "σv0 / σ'v0", "-", 3, "σv0 / σ'v0"),
    cat!("Basic Plots", "Delta_u", "Excess pore pressure u2 − u0", "kPa", 2, "Δu = u2 − u0"),
    cat!("Basic Plots", "qn", "Net cone resistance qt − σv0", "kPa", 2, "qn = qt − σv0"),
    // ── Normalized Plots ──
    cat!("Normalized Plots", "Qt_n", "Normalised cone resistance (n = 1)", "-", 2, "Qt = (qt − σv0)/σ'v0 — Robertson (1990)"),
    cat!("Normalized Plots", "Fr", "Normalised friction ratio", "%", 3, "Fr = fs/(qt − σv0)·100 — Robertson (1990)"),
    cat!("Normalized Plots", "Bq", "Pore pressure parameter", "-", 3, "Bq = Δu/qn — Robertson (1990)"),
    cat!("Normalized Plots", "n", "Stress exponent (iterative)", "-", 3, "n = 0.381·Ic + 0.05·(σ'v0/Pa) − 0.15 ≤ 1 — Robertson (2009)"),
    cat!("Normalized Plots", "Cn", "Stress normalisation factor", "-", 3, "Cn = (Pa/σ'v0)^n — Robertson (2009)"),
    cat!("Normalized Plots", "Qtn", "Normalised cone resistance (iterative n)", "-", 2, "Qtn = ((qt − σv0)/Pa)·Cn — Robertson (2009)"),
    cat!("Normalized Plots", "Ic", "Soil behaviour type index (iterative)", "-", 3, "Ic = √[(3.47 − logQtn)² + (logFr + 1.22)²] — Robertson (2009)"),
    cat!("Normalized Plots", "Ligne", "Robertson 2010 Qt–Fr grid row", "-", 0, "Robertson (2010) Qt–Fr chart lookup"),
    cat!("Normalized Plots", "Colonne", "Robertson 2010 Qt–Fr grid column", "-", 0, "Robertson (2010) Qt–Fr chart lookup"),
    cat!("Normalized Plots", "Zone", "Robertson 2010 Qt–Fr zone (1–9)", "-", 0, "Robertson (2010) SBTn zones"),
    cat!("Normalized Plots", "SBTn", "Soil behaviour type (Qt–Fr)", "text", -1, "Robertson (2010) zone description"),
    cat!("Normalized Plots", "Ligne_2", "Robertson 2010 Qt–Bq grid row", "-", 0, "Robertson (2010) Qt–Bq chart lookup"),
    cat!("Normalized Plots", "Colonne_2", "Robertson 2010 Qt–Bq grid column", "-", 0, "Robertson (2010) Qt–Bq chart lookup"),
    cat!("Normalized Plots", "Zone_2", "Robertson 2010 Qt–Bq zone (1–9)", "-", 0, "Robertson (2010) SBTn zones"),
    cat!("Normalized Plots", "Type_2", "Soil behaviour type (Qt–Bq)", "text", -1, "Robertson (2010) zone description"),
    cat!("Normalized Plots", "Robertson 2010", "Outside Robertson 2010 graph? 0 = no, 1 = yes", "-", 0, "0.1 ≤ Fr ≤ 10 and 1 ≤ Qtn ≤ 1000"),
    cat!("Normalized Plots", "Robertson 1986", "Outside Robertson 1986 graph? 0 = no, 1 = yes", "-", 0, "0 ≤ Rf ≤ 8 and 0.1 ≤ qc ≤ 100"),
    cat!("Normalized Plots", "Schmertmann 1978", "Outside Schmertmann 1978 graph? 0 = no, 1 = yes", "-", 0, "0 ≤ Rf ≤ 7 and 0.1 ≤ qc ≤ 100"),
    // ── Estimation Plots ──
    cat!("Estimation Plots", "Nkt", "Cone factor (manual per layer or selected method)", "-", 2, "Mayne & Peuchen (2022): Nkt = 10.5 − 4.6·ln(Bq + 0.1) · Robertson (2012): Nkt = 10.5 + 7·logFr", sel),
    cat!("Estimation Plots", "su_qt", "Undrained shear strength from qt and Nkt", "kPa", 2, "su = (qt − σv0)/Nkt"),
    cat!("Estimation Plots", "N_Delta_u", "Nkt·Bq", "-", 2, "NΔu = Nkt·Bq"),
    cat!("Estimation Plots", "Su_Delta_u", "Undrained shear strength from Δu", "kPa", 2, "su = Δu/NΔu"),
    cat!("Estimation Plots", "su(Rem)", "Remoulded shear strength (= fs)", "kPa", 2, "su(rem) ≈ fs — CPT Guide 2022"),
    cat!("Estimation Plots", "St", "Sensitivity su/su(rem) for Ic < 2.6", "-", 2, "St = su/su(rem) — CPT Guide 2022"),
    cat!("Estimation Plots", "su_Ratio", "Undrained strength ratio", "-", 3, "σ'v0·Qt/Nkt ratio form"),
    cat!("Estimation Plots", "su(Rem)_Ratio", "Remoulded strength ratio", "-", 3, "su(rem)/σ'v0"),
    cat!("Estimation Plots", "OCR_2013", "Overconsolidation ratio (Robertson 2013)", "-", 2, "OCR = (2.625 + 1.75·logFr)^−1.25 · Qt^1.25 — Robertson (2013)"),
    cat!("Estimation Plots", "OCR_2009", "Overconsolidation ratio (Robertson 2009)", "-", 2, "OCR = 0.25·Qt^1.25 — Robertson (2009)"),
    cat!("Estimation Plots", "m", "Yield stress exponent (Mayne)", "-", 3, "m = 1 − 0.28/(1 + (Ic/2.65)^25)… — Mayne et al. (2009)"),
    cat!("Estimation Plots", "sigma_eff_p", "Preconsolidation stress (Mayne 1992)", "kPa", 2, "σ'p = 0.33·(qt − σv0)^m — Mayne (1992)"),
    cat!("Estimation Plots", "OCR_1992", "Overconsolidation ratio (Mayne 1992)", "-", 2, "OCR = σ'p/σ'v0 — Mayne (1992)"),
    cat!("Estimation Plots", "alpha_E", "Young's modulus factor", "-", 3, "αE = 0.015·10^(0.55·Ic + 1.68) — Robertson (2009)"),
    cat!("Estimation Plots", "Es", "Drained Young's modulus (sands)", "MPa", 2, "E = αE·(qt − σv0) — Robertson (2009)"),
    cat!("Estimation Plots", "alpha_M", "Constrained modulus factor", "-", 3, "αM per Ic/Qt — Robertson (2009)"),
    cat!("Estimation Plots", "Ms", "1D constrained modulus", "MPa", 2, "M = αM·(qt − σv0) — Robertson (2009)"),
    cat!("Estimation Plots", "Ms/qc", "Constrained modulus over qc", "-", 2, "M/qc"),
    cat!("Estimation Plots", "Dr (Baldi, 1986)", "Relative density (Baldi 1986)", "-", 3, "Dr = (1/2.41)·ln(Qtn/15.7) — Baldi et al. (1986)"),
    cat!("Estimation Plots", "Dr (Kulhawy & Mayne, 1990)", "Relative density (Kulhawy & Mayne 1990)", "-", 3, "Dr = √(Qtn/350) — Kulhawy & Mayne (1990)"),
    cat!("Estimation Plots", "Dr (Bray and Olaya, 2022)", "Relative density (Bray & Olaya 2022)", "-", 3, "Dr = √(Qtn·Ic^3.5/1500) for 1.6 < Ic ≤ 2.6 — Bray & Olaya (2022)"),
    cat!("Estimation Plots", "K_c", "Grain characteristic correction (Robertson 2022)", "-", 2, "Kc = 15 − 14/(1 + (Ic/2.95)^11) — Robertson (2022)"),
    cat!("Estimation Plots", "Qtn,cs", "Clean-sand equivalent normalised resistance", "-", 2, "Qtn,cs = Kc·Qtn — Robertson & Wride (1998)"),
    cat!("Estimation Plots", "Psi", "State parameter", "-", 3, "ψ = 0.56 − 0.33·log(Qtn,cs) — Robertson (2010)"),
    cat!("Estimation Plots", "Phi_Rob_Cam", "Peak friction angle (Robertson & Campanella)", "°", 1, "tanφ' = (1/2.68)·[log(qc/σ'v0) + 0.29] — Robertson & Campanella (1983)"),
    cat!("Estimation Plots", "Phi_Kul_May", "Peak friction angle (Kulhawy & Mayne)", "°", 1, "φ' = 17.6 + 11·log(Qtn) — Kulhawy & Mayne (1990)"),
    cat!("Estimation Plots", "Phi_Jeff_Been", "Peak friction angle (Jefferies & Been)", "°", 1, "φ' = 3 + 15.84·log(Qtn,cs) − 26.88 — Jefferies & Been (2006)"),
    cat!("Estimation Plots", "Phi_Mayne_2006", "Friction angle clays/silts (Mayne 2006)", "°", 1, "φ' = 29.5·Bq^0.121·(0.256 + 0.336·Bq + logQt) — Mayne (2006)"),
    cat!("Estimation Plots", "K_0_OCR_2013", "In-situ stress ratio from OCR 2013", "-", 3, "K0 = (1 − sinφ')·OCR^sinφ' — Mayne & Kulhawy (1982)"),
    cat!("Estimation Plots", "K_0_OCR_2009", "In-situ stress ratio from OCR 2009", "-", 3, "K0 = (1 − sinφ')·OCR^sinφ' — Mayne & Kulhawy (1982)"),
    cat!("Estimation Plots", "K_0_OCR_1992", "In-situ stress ratio from OCR 1992", "-", 3, "K0 = (1 − sinφ')·OCR^sinφ' — Mayne & Kulhawy (1982)"),
    cat!("Estimation Plots", "alpha_vs", "Shear-wave velocity factor", "-", 2, "αvs = 10^(0.55·Ic + 1.68) — Robertson (2009)"),
    cat!("Estimation Plots", "Vs", "Shear wave velocity", "m/s", 1, "Vs = √(αvs·(qt − σv0)/100) — Robertson (2009)"),
    cat!("Estimation Plots", "Vs1", "Stress-normalised shear wave velocity", "m/s", 1, "Vs1 = Vs·(100/σ'v0)^0.25"),
    cat!("Estimation Plots", "G_0", "Small-strain shear modulus", "MPa", 2, "G0 = ρ·Vs² — CPT Guide 2022"),
    cat!("Estimation Plots", "K_G", "Small-strain rigidity index", "-", 1, "KG = (G0/qn)·Qtn^0.75 — Robertson (2016)"),
    cat!("Estimation Plots", "k", "Hydraulic conductivity (from Ic)", "m/s", 8, "k = 10^(0.952 − 3.04·Ic) for 1 < Ic ≤ 3.27 — Robertson (2010)"),
    cat!("Estimation Plots", "N60", "SPT N60 equivalent (Robertson 2012)", "-", 1, "(qt/Pa)/(10^(1.1268 − 0.2817·Ic)) — Robertson (2012)"),
];

// ── Robertson 2010 grids (embedded; identical files to the python oracle) ─────

static GRID_FR: OnceLock<Vec<Vec<String>>> = OnceLock::new();
static GRID_BQ: OnceLock<Vec<Vec<String>>> = OnceLock::new();

fn parse_csv(text: &str) -> Vec<Vec<String>> {
    text.lines()
        .map(|l| l.split(',').map(|s| s.trim().to_string()).collect())
        .collect()
}

/// Qt–Fr grid: pandas read WITH header, so the first file line is dropped.
fn grid_fr() -> &'static Vec<Vec<String>> {
    GRID_FR.get_or_init(|| {
        let all = parse_csv(include_str!(
            "../../../docs/cpt_reference/Robertson classification_2010_Qt_Fr.csv"
        ));
        all.into_iter().skip(1).collect()
    })
}

/// Qt–Bq grid: pandas read with header=None — all lines kept.
fn grid_bq() -> &'static Vec<Vec<String>> {
    GRID_BQ.get_or_init(|| {
        parse_csv(include_str!(
            "../../../docs/cpt_reference/Robertson classification_2010_Qt_Bq.csv"
        ))
    })
}

fn pf(s: &str) -> f64 {
    s.parse::<f64>().unwrap_or(f64::NAN)
}

/// numpy searchsorted side='right' on an ascending slice.
fn ss_right(a: &[f64], v: f64) -> usize {
    a.partition_point(|&x| x <= v)
}
/// numpy searchsorted side='left'.
fn ss_left(a: &[f64], v: f64) -> usize {
    a.partition_point(|&x| x < v)
}

fn soil_class(zone: i64) -> &'static str {
    match zone {
        1 => "Sensitive, fine grained",
        2 => "Organic soils - clay",
        3 => "Clay - silty clay to clay",
        4 => "Silt mixtures - clayey silt to silty clay",
        5 => "Sand mixtures - silty sand to sandy silt",
        6 => "Sands - clean sand to silty sand",
        7 => "Gravelly sand to dense sand",
        8 => "Very stiff sand to clayey sand",
        9 => "Very stiff fine grained",
        _ => " ",
    }
}

// ── Engine ────────────────────────────────────────────────────────────────────

pub struct CptInputs {
    pub point_no: Vec<String>,
    pub test_id: Vec<String>,
    pub point_id: Vec<String>,
    pub primary_layer: Vec<String>,
    pub depth: Vec<f64>,
    pub level: Vec<f64>,
    pub qc_mpa: Vec<f64>,
    pub u2: Vec<f64>,
    pub fs: Vec<f64>,
}

pub struct CptParams {
    pub area_ratio: HashMap<String, f64>,    // PointNo → α (UI default 0.8)
    pub water_level: HashMap<String, f64>,   // PointNo → m (UI default 0)
    pub gsb_level: HashMap<String, f64>,     // PointNo → ground/seabed level
    pub gamma_soil: HashMap<String, f64>,    // Primary Layer → kN/m³
    pub nkt_values: HashMap<String, f64>,    // Primary Layer → Nkt
    pub nkt_robertson: bool,                 // false = Mayne & Peuchen (2022)
    pub gamma_water: f64,
}

pub enum Col {
    F(Vec<f64>),
    S(Vec<String>),
}

/// The full 29-step pipeline.  Returns every derived column, in catalogue
/// order, as parallel vectors (NaN = blank).  Mirrors the python reference as
/// executed — see the module header for the deliberate quirks.
pub fn cpt_calc(inp: &CptInputs, p: &CptParams) -> Vec<(&'static str, Col)> {
    let n = inp.depth.len();
    let nan = f64::NAN;
    let gw = p.gamma_water;

    // Per-borehole groups, first-appearance order (groupby PointNo,TestId,PointId).
    let mut group_of: Vec<usize> = vec![0; n];
    let mut groups: Vec<Vec<usize>> = Vec::new();
    {
        let mut idx: HashMap<String, usize> = HashMap::new();
        for i in 0..n {
            let k = format!("{}\u{1}{}\u{1}{}", inp.point_no[i], inp.test_id[i], inp.point_id[i]);
            let g = *idx.entry(k).or_insert_with(|| {
                groups.push(Vec::new());
                groups.len() - 1
            });
            groups[g].push(i);
            group_of[i] = g;
        }
    }

    let wl: Vec<f64> = (0..n)
        .map(|i| *p.water_level.get(&inp.point_no[i]).unwrap_or(&0.0))
        .collect();

    // qc MPa → kPa
    let qc: Vec<f64> = inp.qc_mpa.iter().map(|v| v * 1000.0).collect();
    let qc_pa: Vec<f64> = qc.iter().map(|v| v / PATM).collect();

    // Corr_Depth
    let corr: Vec<f64> = (0..n)
        .map(|i| {
            let c = match p.gsb_level.get(&inp.point_no[i]) {
                Some(g) => g - inp.level[i],
                None => inp.depth[i],
            };
            if c.is_nan() || c < 0.0 { nan } else { c }
        })
        .collect();

    // 1. u0
    let u0: Vec<f64> = (0..n)
        .map(|i| {
            if corr[i].is_nan() { nan }
            else if inp.level[i] > wl[i] { 0.0 }
            else { (wl[i] - inp.level[i]) * gw }
        })
        .collect();

    // 2. qt, Rf  (qt in kPa until the end)
    let qt: Vec<f64> = (0..n)
        .map(|i| {
            if !corr[i].is_nan() {
                let a = *p.area_ratio.get(&inp.point_no[i]).unwrap_or(&0.8);
                qc[i] + inp.u2[i] * (1.0 - a)
            } else { nan }
        })
        .collect();
    let rf: Vec<f64> = (0..n)
        .map(|i| if corr[i].is_nan() || qt[i] <= 0.0 { nan } else { inp.fs[i] / qt[i] * 100.0 })
        .collect();

    // 3. UW — faithful to the reference: the correlation OVERWRITES the
    // per-layer value except where (invalid data AND no per-layer value).
    let uw_map: Vec<f64> = (0..n)
        .map(|i| *p.gamma_soil.get(&inp.primary_layer[i]).unwrap_or(&nan))
        .collect();
    let uw: Vec<f64> = (0..n)
        .map(|i| {
            let bad = corr[i].is_nan() || qt[i] <= 0.0 || rf[i] <= 0.0 || qt[i].is_nan() || rf[i].is_nan();
            if bad && uw_map[i].is_nan() { nan }
            else { 10.0 * (0.27 * rf[i].log10() + 0.36 * (qt[i] / PATM).log10() + 1.236) }
        })
        .collect();

    // 4. Dum_UW per group: 0→NaN, bfill, ffill, first element NaN.
    let mut dum_uw = vec![nan; n];
    for g in &groups {
        let mut vals: Vec<f64> = g.iter().map(|&i| if uw[i] == 0.0 { nan } else { uw[i] }).collect();
        // bfill
        let mut next = nan;
        for j in (0..vals.len()).rev() {
            if vals[j].is_nan() { vals[j] = next } else { next = vals[j] }
        }
        // ffill
        let mut prev = nan;
        for v in vals.iter_mut() {
            if v.is_nan() { *v = prev } else { prev = *v }
        }
        if !vals.is_empty() { vals[0] = nan; }
        for (j, &i) in g.iter().enumerate() { dum_uw[i] = vals[j]; }
    }

    // Global shift(1) of Level — exactly like the reference (NOT per group).
    let lp: Vec<f64> = (0..n).map(|i| if i == 0 { nan } else { inp.level[i - 1] }).collect();

    // UW_eff pass 1
    let mut uw_eff: Vec<f64> = (0..n)
        .map(|i| {
            if corr[i].is_nan() { nan }
            else if inp.level[i] > wl[i] { (lp[i] - inp.level[i]) * dum_uw[i] }
            else if inp.level[i] < wl[i] && lp[i] > wl[i] {
                (lp[i] - inp.level[i]) * dum_uw[i] - (wl[i] - inp.level[i]).abs() * gw
            } else {
                (lp[i] - inp.level[i]) * (dum_uw[i] - gw)
            }
        })
        .collect();
    // pass 2 — first cone value fallback
    for i in 0..n {
        uw_eff[i] = if corr[i].is_nan() { nan }
        else if !uw_eff[i].is_nan() || corr[i] == 0.0 { uw_eff[i] }
        else if inp.level[i] > wl[i] { corr[i] * 20.0 }
        else if inp.level[i] < wl[i] && (wl[i] - inp.level[i]) < corr[i] {
            corr[i] * 20.0 - (wl[i] - inp.level[i]).abs() * gw
        } else {
            corr[i] * (20.0 - gw)
        };
        if uw_eff[i] < 0.0 { uw_eff[i] = 0.0; }
    }

    // 5. Sigma_eff_v0 — per-group cumsum, skipna (pandas semantics).
    let mut sig_eff = vec![nan; n];
    for g in &groups {
        let mut run = 0.0;
        for &i in g {
            if uw_eff[i].is_nan() { sig_eff[i] = nan } else { run += uw_eff[i]; sig_eff[i] = run }
        }
    }

    // 6. Sigma_t_v0
    let sig_t: Vec<f64> = (0..n).map(|i| sig_eff[i] + u0[i]).collect();

    // 7. Stress ratio
    let stress_ratio: Vec<f64> = (0..n)
        .map(|i| {
            if corr[i].is_nan() { nan }
            else if sig_eff[i] == 0.0 { nan }
            else { sig_t[i] / sig_eff[i] }
        })
        .collect();

    // 8. Qt_n & Fr — NOTE: the reference's mask parses as
    // `(isna | isna | sigma) <= 0` (python precedence), i.e. NaN ONLY where
    // σ'v0 == 0 exactly (non-NaN).  Replicated literally; the oracle fixture
    // pins this behaviour.
    let prec_mask = |i: usize| -> bool {
        // truthiness of (corr.isna() | sig.isna() | sig) compared <= 0
        let or_truthy = corr[i].is_nan() || sig_eff[i].is_nan() || sig_eff[i] != 0.0;
        !or_truthy // (bool as int) <= 0  ⇔  or_truthy == false
    };
    let mut qt_n: Vec<f64> = (0..n)
        .map(|i| if prec_mask(i) { nan } else { (qt[i] - sig_t[i]) / sig_eff[i] })
        .collect();
    for v in qt_n.iter_mut() { if *v < 0.0 { *v = 0.0; } }
    let fr: Vec<f64> = (0..n)
        .map(|i| if prec_mask(i) { nan } else { inp.fs[i] / (qt[i] - sig_t[i]) * 100.0 })
        .collect();

    // 9. Bq
    let delta_u: Vec<f64> = (0..n).map(|i| if corr[i].is_nan() { nan } else { inp.u2[i] - u0[i] }).collect();
    let qn: Vec<f64> = (0..n).map(|i| if corr[i].is_nan() { nan } else { qt[i] - sig_t[i] }).collect();
    let bq: Vec<f64> = (0..n).map(|i| if corr[i].is_nan() { nan } else { delta_u[i] / qn[i] }).collect();

    // 10. Nkt — manual per layer wins; blanks use the selected method.
    let nkt: Vec<f64> = (0..n)
        .map(|i| {
            let manual = *p.nkt_values.get(&inp.primary_layer[i]).unwrap_or(&nan);
            if !manual.is_nan() { return manual; }
            let filt = corr[i].is_nan() || fr[i] == 0.0 || fr[i].is_nan();
            if p.nkt_robertson {
                if filt { nan } else { 10.5 + 7.0 * fr[i].log10() }
            } else {
                // Mayne & Peuchen (2022) — uses Bq, gated by the same Fr filter
                // exactly like the reference.
                if filt { nan } else { 10.5 - 4.6 * (bq[i] + 0.1).ln() }
            }
        })
        .collect();

    // 11. su_qt — reference mask parses as `(corrna | nktna | Nkt) == 0`
    // (python precedence): NaN ONLY where Nkt == 0 exactly.
    let su_qt: Vec<f64> = (0..n)
        .map(|i| {
            let or_truthy = corr[i].is_nan() || nkt[i].is_nan() || nkt[i] != 0.0;
            if !or_truthy { nan } else { (qt[i] - sig_t[i]) / nkt[i] }
        })
        .collect();

    // 12. Su from Δu
    let n_delta_u: Vec<f64> = (0..n).map(|i| if corr[i].is_nan() { nan } else { nkt[i] * bq[i] }).collect();
    let su_delta_u: Vec<f64> = (0..n).map(|i| if corr[i].is_nan() { nan } else { delta_u[i] / n_delta_u[i] }).collect();

    // 13. Iterative n, Cn, Qtn, Ic
    let mut nn = vec![nan; n];
    let mut cn = vec![nan; n];
    let mut qtn = vec![nan; n];
    let mut ic = vec![nan; n];
    for i in 0..n {
        let mask = !fr[i].is_nan() && qt[i] > 0.0 && sig_eff[i] > 0.0 && sig_t[i] > 0.0 && fr[i] > 0.0 && !corr[i].is_nan();
        if !mask { continue; }
        let (qti, se, st, fri) = (qt[i], sig_eff[i], sig_t[i], fr[i]);
        if qti > 0.0 && fri > 0.0 && se > 0.0 && st > 0.0 {
            let mut qtn_v = (qti - st) / se;
            let t1 = (3.47 - qtn_v.log10()).powi(2);
            let t2 = (1.22 + fri.log10()).powi(2);
            let mut ic_new = (t1 + t2).sqrt();
            let mut n_v = nan;
            let mut cn_v = nan;
            let mut it = 0;
            loop {
                n_v = f64::min(1.0, 0.381 * ic_new + 0.05 * (se / PATM) - 0.15);
                cn_v = (PATM / se).powf(n_v);
                qtn_v = ((qti - st) / PATM) * cn_v;
                let t1 = (3.47 - qtn_v.log10()).powi(2);
                let t2 = (1.22 + fri.log10()).powi(2);
                let ic_old = ic_new;
                ic_new = (t1 + t2).sqrt();
                it += 1;
                if (ic_new - ic_old).abs() / ic_old < 0.01 || it == 100 {
                    break;
                }
            }
            nn[i] = n_v; cn[i] = cn_v; qtn[i] = qtn_v; ic[i] = ic_new;
        }
    }

    // 14. Robertson 2010 classifications
    let gfr = grid_fr();
    let fr_vert: Vec<f64> = (2..153.min(gfr.len())).map(|r| pf(&gfr[r][2])).collect();
    let fr_horiz: Vec<f64> = gfr[1][3..104.min(gfr[1].len())].iter().map(|s| pf(s)).collect();
    let gbq = grid_bq();
    let bq_vert: Vec<f64> = (2..153.min(gbq.len())).map(|r| pf(&gbq[r][1])).collect();
    let bq_horiz: Vec<f64> = gbq[0][3..104.min(gbq[0].len())].iter().map(|s| pf(s)).collect();

    let mut ligne = vec![nan; n];
    let mut colonne = vec![nan; n];
    let mut zone = vec![nan; n];
    let mut sbtn: Vec<String> = vec![String::new(); n];
    let mut ligne2 = vec![nan; n];
    let mut colonne2 = vec![nan; n];
    let mut zone2 = vec![nan; n];
    let mut type2: Vec<String> = vec![String::new(); n];
    for i in 0..n {
        let d = inp.depth[i];
        // python truthiness: NaN passes `if Depth`, 0.0 fails; gated by Fr/Qtn.
        let depth_ok = d != 0.0; // NaN != 0 → true, matching the reference
        if depth_ok && fr[i] > 0.0 && qtn[i] > 0.0 {
            let l = ss_right(&fr_vert, -qtn[i].log10());
            let c = ss_right(&fr_horiz, fr[i].log10());
            if l > 0 && l < fr_vert.len() && c > 0 && c < fr_horiz.len() {
                // grid = rows 2..len-1, cols 3..len-1 of the (header-skipped) array
                let cell = pf(&gfr[2 + (l - 1)][3 + (c - 1)]);
                if cell.is_finite() {
                    let z = cell as i64;
                    ligne[i] = l as f64;
                    colonne[i] = c as f64;
                    zone[i] = z as f64;
                    sbtn[i] = soil_class(z).trim().to_string();
                    if sbtn[i].is_empty() { sbtn[i] = " ".trim().to_string(); }
                    sbtn[i] = soil_class(z).to_string();
                }
            }
        }
        if depth_ok && qtn[i] > 0.0 {
            let l = ss_left(&bq_vert, -qtn[i].log10());
            let c = ss_left(&bq_horiz, bq[i]);
            if l > 0 && l < bq_vert.len() && c > 0 && c < bq_horiz.len() {
                let cell = pf(&gbq[2 + (l - 1)][3 + (c - 1)]);
                if cell.is_finite() {
                    let z = cell as i64;
                    ligne2[i] = l as f64;
                    colonne2[i] = c as f64;
                    zone2[i] = z as f64;
                    type2[i] = if soil_class(z) == " " { String::new() } else { soil_class(z).to_string() };
                }
            }
        }
    }
    // Colonne/Zone (+_2): NaN → 0, int (the reference casts with fillna(0)).
    for v in colonne.iter_mut().chain(zone.iter_mut()).chain(colonne2.iter_mut()).chain(zone2.iter_mut()) {
        if v.is_nan() { *v = 0.0 } else { *v = v.round() }
    }

    // 15. Sensitivity
    let su_rem: Vec<f64> = (0..n).map(|i| if corr[i].is_nan() { nan } else { inp.fs[i] }).collect();
    let st_: Vec<f64> = (0..n)
        .map(|i| {
            if !corr[i].is_nan() && ic[i] < 2.6 && su_rem[i] != 0.0 { su_qt[i] / su_rem[i] } else { nan }
        })
        .collect();
    let su_ratio: Vec<f64> = (0..n)
        .map(|i| {
            if nkt[i] != 0.0 {
                // reference: value where (corrna | Ic > 2.6), else NaN — literal.
                if corr[i].is_nan() || ic[i] > 2.6 { sig_eff[i] * qt_n[i] / nkt[i] } else { nan }
            } else { nan }
        })
        .collect();
    let su_rem_ratio: Vec<f64> = (0..n)
        .map(|i| if !corr[i].is_nan() || ic[i] < 2.6 { su_rem[i] / sig_eff[i] } else { nan })
        .collect();

    // 16. OCR 2013 — note qt is in kPa here, so `qt >= 20` is nearly always
    // true (reference behaviour, kept).
    let ocr_2013: Vec<f64> = (0..n)
        .map(|i| {
            if corr[i].is_nan() || sig_eff[i].is_nan() || sig_eff[i] == 0.0 || qt[i] >= 20.0 { nan }
            else { (2.625 + 1.75 * fr[i].log10()).powf(-1.25) * qt_n[i].powf(1.25) }
        })
        .collect();

    // 17. OCR 2009
    let ocr_2009: Vec<f64> = (0..n)
        .map(|i| {
            if corr[i].is_nan() || sig_eff[i].is_nan() || sig_eff[i] == 0.0 || st_[i] < 15.0 { nan }
            else { 0.25 * qt_n[i].powf(1.25) }
        })
        .collect();

    // 18. OCR 1992 (Mayne)
    let m_: Vec<f64> = (0..n)
        .map(|i| {
            if corr[i].is_nan() { nan }
            else if ic[i] > 2.8 { 1.0 }
            else { 1.0 - 0.28 / (1.0 + (ic[i] / 2.65).powi(15)) }
        })
        .collect();
    let sig_p: Vec<f64> = (0..n)
        .map(|i| if corr[i].is_nan() { nan } else { 0.33 * (qt[i] - sig_t[i]).powf(m_[i]) * (PATM / 100.0).powf(1.0 - m_[i]) })
        .collect();
    let ocr_1992: Vec<f64> = (0..n)
        .map(|i| if corr[i].is_nan() || sig_eff[i] == 0.0 { nan } else { sig_p[i] / sig_eff[i] })
        .collect();

    // 19. Drained Young's modulus
    let alpha_e: Vec<f64> = (0..n)
        .map(|i| {
            if !corr[i].is_nan() {
                if ic[i] < 2.6 { 0.015 * 10f64.powf(0.55 * ic[i] + 1.68) } else { nan }
            } else { nan }
        })
        .collect();
    let es: Vec<f64> = (0..n)
        .map(|i| {
            if !corr[i].is_nan() {
                if ic[i] < 2.6 { alpha_e[i] * (qt[i] - sig_t[i]) / 1000.0 } else { nan }
            } else { nan }
        })
        .collect();

    // 20. Constrained modulus
    let alpha_m: Vec<f64> = (0..n)
        .map(|i| {
            if !corr[i].is_nan() {
                if ic[i] <= 2.2 {
                    f64::min(0.0188 * 10f64.powf(0.55 * ic[i] + 1.68), 8.0)
                } else if qt_n[i] <= 8.0 { qt_n[i] } else { 8.0 }
            } else { nan }
        })
        .collect();
    let ms: Vec<f64> = (0..n)
        .map(|i| if !corr[i].is_nan() { alpha_m[i] * (qt[i] - sig_t[i]) / 1000.0 } else { nan })
        .collect();
    let ms_qc: Vec<f64> = (0..n)
        .map(|i| if !corr[i].is_nan() { ms[i] / (qc[i] / 1000.0) } else { nan })
        .collect();

    // 21. Relative density
    let dr_baldi: Vec<f64> = (0..n)
        .map(|i| if !corr[i].is_nan() && ic[i] < 1.6 { (1.0 / 2.41) * (qtn[i] / 15.7).ln() } else { nan })
        .collect();
    let dr_km: Vec<f64> = (0..n)
        .map(|i| if !corr[i].is_nan() && ic[i] < 1.6 { (qtn[i] / 350.0).sqrt() } else { nan })
        .collect();
    let dr_bo: Vec<f64> = (0..n)
        .map(|i| {
            if !corr[i].is_nan() {
                if ic[i] < 1.6 { (qtn[i] / 350.0).sqrt() }
                else if ic[i] <= 2.6 { ((qtn[i] * ic[i].powf(3.5)) / 1500.0).sqrt() }
                else { nan }
            } else { nan }
        })
        .collect();

    // 22. State parameters
    let k_c: Vec<f64> = (0..n)
        .map(|i| {
            if !corr[i].is_nan() && ic[i] <= 3.0 {
                if ic[i] <= 1.7 { 1.0 } else { 15.0 - 14.0 / (1.0 + (ic[i] / 2.95).powi(11)) }
            } else { nan }
        })
        .collect();
    let qtn_cs: Vec<f64> = (0..n)
        .map(|i| {
            if !corr[i].is_nan() {
                if ic[i] >= 2.7 { nan } else { k_c[i] * qtn[i] }
            } else { nan }
        })
        .collect();
    let psi: Vec<f64> = (0..n)
        .map(|i| {
            if corr[i].is_nan() { nan }
            else if ic[i] >= 2.7 { nan }
            else { 0.56 - 0.33 * qtn_cs[i].log10() }
        })
        .collect();

    // 23. Peak friction angle in sands
    let phi_rc: Vec<f64> = (0..n)
        .map(|i| {
            if corr[i].is_nan() || sig_eff[i] == 0.0 || qc[i] == 0.0 { nan }
            else if ic[i] < 2.6 {
                ((1.0 / 2.68) * ((qc[i] / sig_eff[i]).log10() + 0.29)).atan() * (180.0 / std::f64::consts::PI)
            } else { nan }
        })
        .collect();
    let phi_km: Vec<f64> = (0..n)
        .map(|i| {
            if corr[i].is_nan() || qtn[i] == 0.0 { nan }
            else if ic[i] < 2.6 { 17.6 + 11.0 * qtn[i].log10() } else { nan }
        })
        .collect();
    let phi_jb: Vec<f64> = (0..n)
        .map(|i| {
            if corr[i].is_nan() || qtn_cs[i] == 0.0 { nan }
            else if ic[i] < 2.6 { 3.0 + 15.84 * qtn_cs[i].log10() - 26.88 } else { nan }
        })
        .collect();

    // 24. Friction angle clays/silts + K0
    let phi_mayne: Vec<f64> = (0..n)
        .map(|i| {
            if !corr[i].is_nan() {
                if ic[i] >= 2.6 && bq[i] > 0.1 {
                    29.5 * bq[i].powf(0.121) * (0.256 + 0.336 * bq[i] + qt_n[i].log10())
                } else { nan }
            } else { nan }
        })
        .collect();
    let k0 = |ocr: &Vec<f64>| -> Vec<f64> {
        (0..n)
            .map(|i| {
                if !corr[i].is_nan() {
                    let s = (phi_mayne[i] * std::f64::consts::PI / 180.0).sin();
                    (1.0 - s) * ocr[i].powf(s)
                } else { nan }
            })
            .collect()
    };
    let k0_2013 = k0(&ocr_2013);
    let k0_2009 = k0(&ocr_2009);
    let k0_1992 = k0(&ocr_1992);

    // 25. Shear wave velocity
    let alpha_vs: Vec<f64> = (0..n)
        .map(|i| if corr[i].is_nan() { nan } else { 10f64.powf(0.55 * ic[i] + 1.68) })
        .collect();
    let vs: Vec<f64> = (0..n)
        .map(|i| if corr[i].is_nan() { nan } else { (alpha_vs[i] * (qt[i] - sig_t[i]) / 100.0).sqrt() })
        .collect();
    let vs1: Vec<f64> = (0..n)
        .map(|i| if corr[i].is_nan() { nan } else { vs[i] * (100.0 / sig_eff[i]).powf(0.25) })
        .collect();

    // 26. Small-strain shear modulus
    let g0: Vec<f64> = (0..n)
        .map(|i| if corr[i].is_nan() { nan } else { uw[i] / gw * vs[i].powi(2) / 1000.0 })
        .collect();
    let k_g: Vec<f64> = (0..n)
        .map(|i| if corr[i].is_nan() { nan } else { (g0[i] * 1000.0 / (qt[i] - sig_t[i])) * qtn[i].powf(0.75) })
        .collect();

    // 27. Hydraulic conductivity
    let k_: Vec<f64> = (0..n)
        .map(|i| {
            if !corr[i].is_nan() {
                if ic[i] > 1.0 && ic[i] <= 3.27 { 10f64.powf(0.952 - 3.04 * ic[i]) }
                else if ic[i] > 3.27 && ic[i] < 4.0 { 10f64.powf(-4.52 - 1.37 * ic[i]) }
                else { nan }
            } else { nan }
        })
        .collect();

    // 28. N60
    let n60: Vec<f64> = (0..n)
        .map(|i| if !corr[i].is_nan() { (qt[i] / 101.325) / 10f64.powf(1.1268 - 0.2817 * ic[i]) } else { nan })
        .collect();

    // 29. Outside-graph flags (qc/qt still kPa here — reference behaviour).
    let rob2010: Vec<f64> = (0..n)
        .map(|i| {
            if corr[i].is_nan() { nan }
            else if qtn[i].is_nan() { 0.0 }
            else if fr[i] >= 0.1 && fr[i] <= 10.0 && qtn[i] >= 1.0 && qtn[i] <= 1000.0 { 0.0 }
            else { 1.0 }
        })
        .collect();
    let rob1986: Vec<f64> = (0..n)
        .map(|i| {
            if corr[i].is_nan() { nan }
            else if rf[i] >= 0.0 && rf[i] <= 8.0 && qc[i] >= 0.1 && qc[i] <= 100.0 { 0.0 }
            else { 1.0 }
        })
        .collect();
    let schm1978: Vec<f64> = (0..n)
        .map(|i| {
            if corr[i].is_nan() { nan }
            else if rf[i] >= 0.0 && rf[i] <= 7.0 && qc[i] >= 0.1 && qc[i] <= 100.0 { 0.0 }
            else { 1.0 }
        })
        .collect();

    // qt back to MPa (qc is an input column — not re-emitted).
    let qt_mpa: Vec<f64> = qt.iter().map(|v| v / 1000.0).collect();

    vec![
        ("Water Level", Col::F(wl)),
        ("Corr_Depth", Col::F(corr)),
        ("qc/Pa", Col::F(qc_pa)),
        ("u0", Col::F(u0)),
        ("qt", Col::F(qt_mpa)),
        ("Rf", Col::F(rf)),
        ("UW", Col::F(uw)),
        ("UW_eff", Col::F(uw_eff)),
        ("Sigma_eff_v0", Col::F(sig_eff)),
        ("Sigma_t_v0", Col::F(sig_t)),
        ("Stress_Ratio", Col::F(stress_ratio)),
        ("Delta_u", Col::F(delta_u)),
        ("qn", Col::F(qn)),
        ("Qt_n", Col::F(qt_n)),
        ("Fr", Col::F(fr)),
        ("Bq", Col::F(bq)),
        ("n", Col::F(nn)),
        ("Cn", Col::F(cn)),
        ("Qtn", Col::F(qtn)),
        ("Ic", Col::F(ic)),
        ("Ligne", Col::F(ligne)),
        ("Colonne", Col::F(colonne)),
        ("Zone", Col::F(zone)),
        ("SBTn", Col::S(sbtn)),
        ("Ligne_2", Col::F(ligne2)),
        ("Colonne_2", Col::F(colonne2)),
        ("Zone_2", Col::F(zone2)),
        ("Type_2", Col::S(type2)),
        ("Robertson 2010", Col::F(rob2010)),
        ("Robertson 1986", Col::F(rob1986)),
        ("Schmertmann 1978", Col::F(schm1978)),
        ("Nkt", Col::F(nkt)),
        ("su_qt", Col::F(su_qt)),
        ("N_Delta_u", Col::F(n_delta_u)),
        ("Su_Delta_u", Col::F(su_delta_u)),
        ("su(Rem)", Col::F(su_rem)),
        ("St", Col::F(st_)),
        ("su_Ratio", Col::F(su_ratio)),
        ("su(Rem)_Ratio", Col::F(su_rem_ratio)),
        ("OCR_2013", Col::F(ocr_2013)),
        ("OCR_2009", Col::F(ocr_2009)),
        ("m", Col::F(m_)),
        ("sigma_eff_p", Col::F(sig_p)),
        ("OCR_1992", Col::F(ocr_1992)),
        ("alpha_E", Col::F(alpha_e)),
        ("Es", Col::F(es)),
        ("alpha_M", Col::F(alpha_m)),
        ("Ms", Col::F(ms)),
        ("Ms/qc", Col::F(ms_qc)),
        ("Dr (Baldi, 1986)", Col::F(dr_baldi)),
        ("Dr (Kulhawy & Mayne, 1990)", Col::F(dr_km)),
        ("Dr (Bray and Olaya, 2022)", Col::F(dr_bo)),
        ("K_c", Col::F(k_c)),
        ("Qtn,cs", Col::F(qtn_cs)),
        ("Psi", Col::F(psi)),
        ("Phi_Rob_Cam", Col::F(phi_rc)),
        ("Phi_Kul_May", Col::F(phi_km)),
        ("Phi_Jeff_Been", Col::F(phi_jb)),
        ("Phi_Mayne_2006", Col::F(phi_mayne)),
        ("K_0_OCR_2013", Col::F(k0_2013)),
        ("K_0_OCR_2009", Col::F(k0_2009)),
        ("K_0_OCR_1992", Col::F(k0_1992)),
        ("alpha_vs", Col::F(alpha_vs)),
        ("Vs", Col::F(vs)),
        ("Vs1", Col::F(vs1)),
        ("G_0", Col::F(g0)),
        ("K_G", Col::F(k_g)),
        ("k", Col::F(k_)),
        ("N60", Col::F(n60)),
    ]
}

// ── Settings / input-file plumbing ────────────────────────────────────────────

fn settings_path(folder: &str) -> PathBuf {
    PathBuf::from(folder).join("GIRTool_settings.json")
}

fn read_settings_obj(folder: &str) -> Map<String, Value> {
    std::fs::read_to_string(settings_path(folder))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn cpt_dir(folder: &str) -> PathBuf {
    PathBuf::from(folder).join("cpt calc settings")
}

// Issue #198: DB + Project columns identify each borehole in Excel; the reader
// below matches by HEADER NAME, so files written with the old 4-column layout
// still load fine.
const POINT_HEADERS: &[&str] = &[
    "PointNo",
    "DB",
    "Project",
    "Insert Cone Area Ratio [-]",
    "Ground/Seabed Level [m]",
    "Insert Water Level [m]",
];
const LAYER_HEADERS: &[&str] = &["Strata", "Unit weight [kN/m^3]", "Nkt [-]"];

/// Columns that must stay text on read (labels — never numeric-parsed).
const TEXT_HEADERS: &[&str] = &["PointNo", "DB", "Project", "Strata"];

fn cell_str(c: &Data) -> String {
    match c {
        Data::String(s) => s.trim().to_string(),
        Data::Float(f) => {
            if f.fract() == 0.0 { format!("{}", *f as i64) } else { f.to_string() }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::Empty => String::new(),
        other => format!("{other}"),
    }
}

fn cell_f64(c: &Data) -> Option<f64> {
    match c {
        Data::Float(f) => Some(*f),
        Data::Int(i) => Some(*i as f64),
        Data::String(s) => {
            let t = s.trim();
            if t.is_empty() { None } else { t.replace(',', ".").parse::<f64>().ok() }
        }
        _ => None,
    }
}

/// Read a simple header+rows xlsx into row objects keyed by the given headers.
/// Columns are matched by HEADER NAME (issue #198), so column order — and
/// files written before new columns existed — don't matter.  Headers listed in
/// `TEXT_HEADERS` stay strings; everything else is numeric-parsed.
fn read_simple_xlsx(path: &PathBuf, headers: &[&str]) -> Vec<Map<String, Value>> {
    let mut out = Vec::new();
    let Ok(mut wb) = open_workbook_auto(path) else { return out };
    let Some(name) = wb.sheet_names().first().cloned() else { return out };
    let Ok(range) = wb.worksheet_range(&name) else { return out };

    let mut rows_iter = range.rows();
    let Some(header_row) = rows_iter.next() else { return out };
    // Actual column index per requested header (case-insensitive name match).
    let col_of: Vec<Option<usize>> = headers
        .iter()
        .map(|h| {
            header_row
                .iter()
                .position(|c| cell_str(c).eq_ignore_ascii_case(h))
        })
        .collect();

    for row in rows_iter {
        let mut obj = Map::new();
        let mut any = false;
        for (hi, h) in headers.iter().enumerate() {
            let cell = col_of[hi].and_then(|j| row.get(j));
            let is_text = TEXT_HEADERS.iter().any(|t| t.eq_ignore_ascii_case(h));
            let v = match cell {
                Some(c) => {
                    if is_text {
                        let s = cell_str(c);
                        if s.is_empty() { Value::Null } else { Value::String(s) }
                    } else {
                        match cell_f64(c) {
                            Some(f) => json!(f),
                            None => Value::Null,
                        }
                    }
                }
                None => Value::Null,
            };
            if !matches!(v, Value::Null) {
                any = true;
            }
            obj.insert((*h).to_string(), v);
        }
        if any {
            out.push(obj);
        }
    }
    out
}

fn write_simple_xlsx(path: &PathBuf, headers: &[&str], rows: &[Value]) -> Result<(), String> {
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    let header_fmt = Format::new()
        .set_font_name("Verdana")
        .set_font_size(9.0)
        .set_bold()
        .set_align(FormatAlign::Center)
        .set_background_color(Color::RGB(0x_D6_DE_E4));
    let body_fmt = Format::new().set_font_name("Verdana").set_font_size(9.0);
    for (j, h) in headers.iter().enumerate() {
        ws.write_string_with_format(0, j as u16, *h, &header_fmt)
            .map_err(|e| format!("Header write error: {e}"))?;
        ws.set_column_width(j as u16, if j == 0 { 22.0 } else { 24.0 })
            .map_err(|e| format!("Width error: {e}"))?;
    }
    for (i, row) in rows.iter().enumerate() {
        let r = (i + 1) as u32;
        for (j, h) in headers.iter().enumerate() {
            match row.get(*h) {
                Some(Value::Number(n)) => {
                    if let Some(f) = n.as_f64() {
                        let _ = ws.write_number_with_format(r, j as u16, f, &body_fmt);
                    }
                }
                Some(Value::String(s)) if !s.is_empty() => {
                    let _ = ws.write_string_with_format(r, j as u16, s, &body_fmt);
                }
                _ => {}
            }
        }
    }
    ws.set_freeze_panes(1, 0).ok();
    wb.save(path).map_err(|e| format!("Failed to save {}: {e}", path.display()))
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Static column catalogue for the picker (Subtab 1).
#[tauri::command]
pub fn get_cpt_catalog() -> Value {
    json!(CATALOG
        .iter()
        .map(|c| json!({
            "group": c.group, "name": c.name, "desc": c.desc,
            "unit": c.unit, "round": c.round, "default_selected": c.default_selected,
            "reference": c.reference,
        }))
        .collect::<Vec<_>>())
}

/// Per-project calc config (Q-E4) — seeded with catalogue defaults when unset.
#[tauri::command]
pub async fn get_cpt_calc_config(state: State<'_, AppState>) -> Result<Value, String> {
    let folder = state.output_folder().unwrap_or_default();
    let saved = if folder.is_empty() {
        Value::Null
    } else {
        read_settings_obj(&folder).get("cpt_calc").cloned().unwrap_or(Value::Null)
    };
    if saved.is_object() {
        return Ok(saved);
    }
    // Seed: defaults from the catalogue.
    let selected: Vec<&str> = CATALOG.iter().filter(|c| c.default_selected).map(|c| c.name).collect();
    let round: Map<String, Value> = CATALOG
        .iter()
        .filter(|c| c.round >= 0)
        .map(|c| (c.name.to_string(), json!(c.round)))
        .collect();
    Ok(json!({
        "selected": selected,
        "round": round,
        "nkt_method": "Mayne and Peuchen (2022)",
        "gamma_water": 10.0,
    }))
}

#[tauri::command]
pub async fn save_cpt_calc_config(config: Value, state: State<'_, AppState>) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let mut settings = read_settings_obj(&folder);
    settings.insert("cpt_calc".to_string(), config);
    let text = serde_json::to_string_pretty(&Value::Object(settings))
        .map_err(|e| format!("Serialise error: {e}"))?;
    std::fs::write(settings_path(&folder), text).map_err(|e| format!("Write error: {e}"))
}

#[tauri::command]
pub async fn load_cpt_point_data(state: State<'_, AppState>) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = cpt_dir(&folder).join("cpt_point_data.xlsx");
    Ok(json!(read_simple_xlsx(&path, POINT_HEADERS)))
}

#[tauri::command]
pub async fn save_cpt_point_data(rows: Vec<Value>, state: State<'_, AppState>) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let dir = cpt_dir(&folder);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create cpt settings dir: {e}"))?;
    write_simple_xlsx(&dir.join("cpt_point_data.xlsx"), POINT_HEADERS, &rows)
}

/// Open one of the cpt-calc settings workbooks in the OS xlsx handler (issue
/// #198) — `which` = "point" | "layer".  Creates an empty header-only file
/// first when it doesn't exist yet, so the user always gets a template.
#[tauri::command]
pub async fn open_cpt_settings_xlsx(
    which: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let dir = cpt_dir(&folder);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create cpt settings dir: {e}"))?;
    let (file, headers): (&str, &[&str]) = match which.as_str() {
        "layer" => ("cpt_layer_data.xlsx", LAYER_HEADERS),
        _       => ("cpt_point_data.xlsx", POINT_HEADERS),
    };
    let path = dir.join(file);
    if !path.exists() {
        write_simple_xlsx(&path, headers, &[])?;
    }
    app.opener()
        .open_path(path.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| format!("Failed to open {file}: {e}"))
}

#[tauri::command]
pub async fn load_cpt_layer_data(state: State<'_, AppState>) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = cpt_dir(&folder).join("cpt_layer_data.xlsx");
    Ok(json!(read_simple_xlsx(&path, LAYER_HEADERS)))
}

#[tauri::command]
pub async fn save_cpt_layer_data(rows: Vec<Value>, state: State<'_, AppState>) -> Result<(), String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let dir = cpt_dir(&folder);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create cpt settings dir: {e}"))?;
    write_simple_xlsx(&dir.join("cpt_layer_data.xlsx"), LAYER_HEADERS, &rows)
}

fn col_idx(columns: &[String], name: &str) -> Option<usize> {
    columns.iter().position(|c| c.eq_ignore_ascii_case(name))
}

fn round_to(v: f64, d: i32) -> f64 {
    let m = 10f64.powi(d);
    (v * m).round() / m
}

/// Run the CPT calculation on a datasheet (default CPTData) and write the
/// selected derived columns back into the same sheet (Q-E3).  Upserts columns
/// (overwrite when present from an earlier run, append otherwise); other
/// columns and user formulas outside the calc columns are preserved.
#[tauri::command]
pub async fn run_cpt_calc(fname: String, state: State<'_, AppState>) -> Result<Value, String> {
    let folder = state.output_folder().ok_or("No output folder configured.")?;
    let path = datasheets_dir(&folder).join(format!("{fname}.xlsx"));
    if !path.exists() {
        return Err(format!("Datasheet not found: {fname}.xlsx — download CPT data first."));
    }

    // Config + input tables.
    let cfg = match read_settings_obj(&folder).get("cpt_calc") {
        Some(v) if v.is_object() => v.clone(),
        _ => json!({}),
    };
    let selected: Vec<String> = cfg
        .get("selected")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_else(|| {
            CATALOG.iter().filter(|c| c.default_selected).map(|c| c.name.to_string()).collect()
        });
    if selected.is_empty() {
        return Err("No columns selected — tick at least one column in the catalogue.".into());
    }
    let rounds: HashMap<String, i32> = cfg
        .get("round")
        .and_then(|v| v.as_object())
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_i64().map(|d| (k.clone(), d as i32)))
                .collect()
        })
        .unwrap_or_default();
    let nkt_robertson = cfg.get("nkt_method").and_then(|v| v.as_str()) == Some("Robertson (2012)");
    let gamma_water = cfg.get("gamma_water").and_then(|v| v.as_f64()).unwrap_or(10.0);

    let point_rows = read_simple_xlsx(&cpt_dir(&folder).join("cpt_point_data.xlsx"), POINT_HEADERS);
    let layer_rows = read_simple_xlsx(&cpt_dir(&folder).join("cpt_layer_data.xlsx"), LAYER_HEADERS);
    let mut area_ratio = HashMap::new();
    let mut water_level = HashMap::new();
    let mut gsb_level = HashMap::new();
    for r in &point_rows {
        let Some(pn) = r.get(POINT_HEADERS[0]).and_then(|v| v.as_str()).map(str::to_string) else { continue };
        if let Some(a) = r.get(POINT_HEADERS[3]).and_then(|v| v.as_f64()) { area_ratio.insert(pn.clone(), a); }
        if let Some(g) = r.get(POINT_HEADERS[4]).and_then(|v| v.as_f64()) { gsb_level.insert(pn.clone(), g); }
        if let Some(w) = r.get(POINT_HEADERS[5]).and_then(|v| v.as_f64()) { water_level.insert(pn.clone(), w); }
    }
    let mut gamma_soil = HashMap::new();
    let mut nkt_values = HashMap::new();
    for r in &layer_rows {
        let Some(l) = r.get(LAYER_HEADERS[0]).and_then(|v| v.as_str()).map(str::to_string) else { continue };
        if let Some(u) = r.get(LAYER_HEADERS[1]).and_then(|v| v.as_f64()) { gamma_soil.insert(l.clone(), u); }
        if let Some(nk) = r.get(LAYER_HEADERS[2]).and_then(|v| v.as_f64()) { nkt_values.insert(l.clone(), nk); }
    }

    let folder_c = folder.clone();
    let fname_c = fname.clone();
    tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let Some((mut columns, mut rows, mut formulas)) = read_existing_datasheet(&path) else {
            return Err("Failed to read the datasheet.".into());
        };

        // Required input columns (plan §E).
        let need = |name: &str| -> Result<usize, String> {
            col_idx(&columns, name).ok_or(format!("Required column '{name}' not found in {fname_c}.xlsx"))
        };
        let i_pn = need("PointNo")?;
        let i_qc = need("qc")?;
        let i_u2 = need("u2")?;
        let i_fs = need("fs")?;
        let i_depth = need("Depth")?;
        let i_level = need("Level")?;
        let i_layer = need("Primary Layer")?;
        let i_tid = need("TestId")?;
        let i_pid = need("PointId")?;

        let s = |r: &Vec<Value>, i: usize| -> String {
            match r.get(i) {
                Some(Value::String(v)) => v.trim().to_string(),
                Some(Value::Number(v)) => v.to_string(),
                _ => String::new(),
            }
        };
        let f = |r: &Vec<Value>, i: usize| -> f64 {
            match r.get(i) {
                Some(Value::Number(v)) => v.as_f64().unwrap_or(f64::NAN),
                Some(Value::String(v)) => v.trim().replace(',', ".").parse().unwrap_or(f64::NAN),
                _ => f64::NAN,
            }
        };

        // Reference drops rows with blank / "No Data" PointNo — we keep the
        // sheet rows but exclude them from the calc (their outputs stay blank).
        let valid: Vec<bool> = rows
            .iter()
            .map(|r| {
                let pn = s(r, i_pn);
                !pn.is_empty() && pn != "No Data"
            })
            .collect();
        let idx: Vec<usize> = (0..rows.len()).filter(|&i| valid[i]).collect();

        let inp = CptInputs {
            point_no: idx.iter().map(|&i| s(&rows[i], i_pn)).collect(),
            test_id: idx.iter().map(|&i| s(&rows[i], i_tid)).collect(),
            point_id: idx.iter().map(|&i| s(&rows[i], i_pid)).collect(),
            primary_layer: idx.iter().map(|&i| s(&rows[i], i_layer)).collect(),
            depth: idx.iter().map(|&i| f(&rows[i], i_depth)).collect(),
            level: idx.iter().map(|&i| f(&rows[i], i_level)).collect(),
            qc_mpa: idx.iter().map(|&i| f(&rows[i], i_qc)).collect(),
            u2: idx.iter().map(|&i| f(&rows[i], i_u2)).collect(),
            fs: idx.iter().map(|&i| f(&rows[i], i_fs)).collect(),
        };
        let params = CptParams {
            area_ratio, water_level, gsb_level, gamma_soil, nkt_values,
            nkt_robertson, gamma_water,
        };
        let results = cpt_calc(&inp, &params);

        // Upsert the SELECTED columns back into the sheet.
        let mut written = 0usize;
        for (name, col) in &results {
            if !selected.iter().any(|x| x == name) { continue; }
            let ci = match col_idx(&columns, name) {
                Some(i) => i,
                None => {
                    columns.push(name.to_string());
                    for r in rows.iter_mut() { r.push(Value::Null); }
                    columns.len() - 1
                }
            };
            // The calc overwrites these cells — drop stale formulas there.
            formulas.retain(|(_, c), _| *c != ci);
            let d = rounds.get(*name).copied().unwrap_or_else(|| {
                CATALOG.iter().find(|c| c.name == *name).map(|c| c.round).unwrap_or(3)
            });
            match col {
                Col::F(vals) => {
                    for (k, &ri) in idx.iter().enumerate() {
                        let v = vals[k];
                        rows[ri][ci] = if v.is_nan() || v.is_infinite() {
                            Value::Null
                        } else {
                            let rv = if d >= 0 { round_to(v, d) } else { v };
                            serde_json::Number::from_f64(rv).map(Value::Number).unwrap_or(Value::Null)
                        };
                    }
                }
                Col::S(vals) => {
                    for (k, &ri) in idx.iter().enumerate() {
                        let v = vals[k].trim();
                        rows[ri][ci] = if v.is_empty() { Value::Null } else { Value::String(vals[k].clone()) };
                    }
                }
            }
            written += 1;
        }

        let n_rows = rows.len();
        write_datasheet(&path, &columns, &rows, Some(&formulas))?;
        write_datasheet_cache(&folder_c, &fname_c, &columns, &rows, Some(&formulas));
        let has_strata = columns.iter().any(|c| c.eq_ignore_ascii_case("primary layer"));
        persist_datasheet_meta(&folder_c, &fname_c, n_rows, has_strata);
        Ok(json!({ "file": format!("{fname_c}.xlsx"), "rows": n_rows, "columns_written": written }))
    })
    .await
    .map_err(|e| format!("internal task error: {e}"))?
}

// ── Oracle fixture test (Q-E6) ────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../docs/cpt_reference/fixtures")
            .join(name)
    }

    fn load_csv(path: &PathBuf) -> (Vec<String>, Vec<Vec<String>>) {
        let text = std::fs::read_to_string(path).expect("fixture missing — run scripts/gen_cpt_fixture.py");
        let mut lines = text.lines();
        let headers: Vec<String> = lines.next().unwrap().split('\t').map(|s| s.to_string()).collect();
        let rows = lines
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.split('\t').map(|s| s.to_string()).collect())
            .collect();
        (headers, rows)
    }

    fn build_inputs(headers: &[String], rows: &[Vec<String>]) -> CptInputs {
        let col = |n: &str| headers.iter().position(|h| h == n).unwrap();
        let sf = |r: &Vec<String>, i: usize| r[i].parse::<f64>().unwrap_or(f64::NAN);
        CptInputs {
            point_no: rows.iter().map(|r| r[col("PointNo")].clone()).collect(),
            test_id: rows.iter().map(|r| r[col("TestId")].clone()).collect(),
            point_id: rows.iter().map(|r| r[col("PointId")].clone()).collect(),
            primary_layer: rows.iter().map(|r| r[col("Primary Layer")].clone()).collect(),
            depth: rows.iter().map(|r| sf(r, col("Depth"))).collect(),
            level: rows.iter().map(|r| sf(r, col("Level"))).collect(),
            qc_mpa: rows.iter().map(|r| sf(r, col("qc"))).collect(),
            u2: rows.iter().map(|r| sf(r, col("u2"))).collect(),
            fs: rows.iter().map(|r| sf(r, col("fs"))).collect(),
        }
    }

    fn params(robertson: bool) -> CptParams {
        // MUST mirror scripts/gen_cpt_fixture.py exactly.
        let mut area_ratio = HashMap::new();
        area_ratio.insert("CPT-1".to_string(), 0.8);
        area_ratio.insert("CPT-2".to_string(), 0.75);
        let mut water_level = HashMap::new();
        water_level.insert("CPT-1".to_string(), -1.0);
        water_level.insert("CPT-2".to_string(), 0.5);
        let mut gsb_level = HashMap::new();
        gsb_level.insert("CPT-2".to_string(), 0.2);
        let mut gamma_soil = HashMap::new();
        gamma_soil.insert("ler".to_string(), 19.0);
        let mut nkt_values = HashMap::new();
        nkt_values.insert("ler".to_string(), 12.0);
        CptParams {
            area_ratio, water_level, gsb_level, gamma_soil, nkt_values,
            nkt_robertson: robertson,
            gamma_water: 10.0,
        }
    }

    fn compare(expected_file: &str, robertson: bool) {
        let (in_h, in_rows) = load_csv(&fixture_path("cpt_input.csv"));
        let inputs = build_inputs(&in_h, &in_rows);
        let results = cpt_calc(&inputs, &params(robertson));
        let (ex_h, ex_rows) = load_csv(&fixture_path(expected_file));

        let mut checked = 0;
        for (name, col) in &results {
            let Some(ci) = ex_h.iter().position(|h| h == name) else { continue };
            match col {
                Col::F(vals) => {
                    for (ri, v) in vals.iter().enumerate() {
                        let cell = ex_rows[ri][ci].trim();
                        let exp = if cell.is_empty() { f64::NAN } else { cell.parse::<f64>().unwrap() };
                        let ok = if exp.is_nan() {
                            v.is_nan() || v.is_infinite()
                        } else {
                            let tol = 1e-6_f64.max(exp.abs() * 1e-6);
                            (v - exp).abs() <= tol
                        };
                        assert!(
                            ok,
                            "{expected_file}: column '{name}' row {ri}: rust={v} expected={cell}"
                        );
                    }
                }
                Col::S(vals) => {
                    for (ri, v) in vals.iter().enumerate() {
                        let cell = ex_rows[ri][ci].trim();
                        assert_eq!(
                            v.trim(), cell,
                            "{expected_file}: column '{name}' row {ri}"
                        );
                    }
                }
            }
            checked += 1;
        }
        assert!(checked > 50, "only {checked} columns compared — fixture incomplete?");
    }

    #[test]
    fn matches_python_oracle_mayne() {
        compare("expected_mayne.csv", false);
    }

    #[test]
    fn matches_python_oracle_robertson() {
        compare("expected_robertson.csv", true);
    }
}
