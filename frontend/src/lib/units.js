// Unit conversion registry for the import wizard (issue #288).
//
// The DESTINATION unit of each datasheet column comes from the column
// dictionary (GIRTool_Column_Reference.xlsx → colDict[col].unit) so it stays
// in sync with the reference sheet automatically.  This file adds the geology
// / geotechnics CONVERSION knowledge on top: for each dimension, the common
// units seen in European and American projects and their factor to a base
// unit.  Converting a value: value_in_base = value × toBase[unit]; to go from
// a source unit S into a destination unit D of the same dimension,
//   factor = toBase[S] / toBase[D]   (dest_value = source_value × factor).
//
// Factors are exact/standard reference values (NIST SP 811, ISO 80000):
//   1 ft = 0.3048 m · 1 in = 0.0254 m
//   1 psi = 6.894757 kPa · 1 ksf = 47.880259 kPa · 1 tsf = 95.760518 kPa
//   1 kgf/cm² = 98.0665 kPa · 1 bar = 100 kPa · 1 atm = 101.325 kPa
//   1 pcf (force) = 0.15708746 kN/m³ · 1 pcf (mass) = 0.016018463 Mg/m³
//   1 rad = 57.29578° · 1 gon = 0.9° · 1 ft/s = 0.3048 m/s

// dimension → { units: { <unit label>: <factor to base> } }.  The first key in
// each dimension is the base (factor 1).  Labels are what the user sees.
export const UNIT_DIMENSIONS = {
  length: {
    units: { m: 1, cm: 0.01, mm: 0.001, 'µm': 1e-6, ft: 0.3048, in: 0.0254 },
  },
  pressure: {
    units: {
      kPa: 1, MPa: 1000, Pa: 0.001, bar: 100, atm: 101.325,
      psi: 6.894757, ksf: 47.880259, tsf: 95.760518, 'kgf/cm²': 98.0665,
    },
  },
  ratio: {
    // Geotech data sometimes stores percentages as a 0–1 fraction.
    units: { '%': 1, fraction: 100, '‰': 0.1 },
  },
  unitWeight: {
    units: { 'kN/m³': 1, 'MN/m³': 1000, 'N/m³': 0.001, pcf: 0.15708746 },
  },
  density: {
    units: {
      'Mg/m³': 1, 'g/cm³': 1, 't/m³': 1, 'kg/m³': 0.001, pcf: 0.016018463,
    },
  },
  angle: {
    units: { '°': 1, rad: 57.29578, gon: 0.9 },
  },
  velocity: {
    units: {
      'm/s': 1, 'cm/s': 0.01, 'mm/s': 0.001, 'km/s': 1000,
      'km/h': 0.2777778, 'ft/s': 0.3048, mph: 0.44704,
    },
  },
  time: {
    units: { min: 1, s: 0.0166667, h: 60 },
  },
  stressRate: {
    units: {
      'MPa/min': 1, 'kPa/min': 0.001, 'MPa/s': 60, 'kPa/s': 0.06,
      'psi/min': 0.006894757, 'psi/s': 0.4136854,
    },
  },
}

// Reference-sheet unit string → { dim, canon }.  `canon` is the dimension's
// unit that the destination column is stored in (the "no conversion" choice).
// Keys match the exact strings used in GIRTool_Column_Reference.xlsx.
export const EXCEL_UNIT_MAP = {
  'm':            { dim: 'length',     canon: 'm' },
  'm (mSL)':      { dim: 'length',     canon: 'm' },     // elevation — length conversion
  'mm':           { dim: 'length',     canon: 'mm' },
  '%':            { dim: 'ratio',      canon: '%' },
  'kPa':          { dim: 'pressure',   canon: 'kPa' },
  'MPa':          { dim: 'pressure',   canon: 'MPa' },
  'kN/m3':        { dim: 'unitWeight', canon: 'kN/m³' },
  'Mg/m3':        { dim: 'density',    canon: 'Mg/m³' },
  'degrees':      { dim: 'angle',      canon: '°' },
  'm/s':          { dim: 'velocity',   canon: 'm/s' },
  'min':          { dim: 'time',       canon: 'min' },
  'MPa/min':      { dim: 'stressRate', canon: 'MPa/min' },
  // Deliberately NOT mapped (no conversion offered): '-' (dimensionless),
  // 'blows/300 mm' (a count), and any text / blank unit.
}

function normUnit(u) {
  return (u == null ? '' : String(u)).trim()
}

// null when the unit isn't a convertible numeric quantity (text, '-', count,
// blank, or an unmapped unit); otherwise the dimension + the source-unit
// options to offer (every unit in the dimension except the destination's own).
export function unitOptions(excelUnit) {
  const m = EXCEL_UNIT_MAP[normUnit(excelUnit)]
  if (!m) return null
  const dim = UNIT_DIMENSIONS[m.dim]
  if (!dim) return null
  const units = Object.keys(dim.units).filter(u => u !== m.canon)
  return { dim: m.dim, canon: m.canon, units }
}

export function isConvertible(excelUnit) {
  return unitOptions(excelUnit) != null
}

// Multiplier that turns a value expressed in `srcUnit` into the destination
// column's unit (`excelDestUnit`).  Returns 1 when either side is unknown or
// they're the same — i.e. a safe no-op.
export function factorBetween(srcUnit, excelDestUnit) {
  const m = EXCEL_UNIT_MAP[normUnit(excelDestUnit)]
  if (!m) return 1
  const dim = UNIT_DIMENSIONS[m.dim]
  const sb = dim?.units[srcUnit]
  const db = dim?.units[m.canon]
  if (sb == null || db == null) return 1
  return sb / db
}
