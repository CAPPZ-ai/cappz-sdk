/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-units
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Units for constraint envelopes, by their UCUM codes (the Unified Code for
 * Units of Measure). A value is only compared with a limit after both are in
 * the same unit: a freezer limit in Cel and a reading in [degF] compare
 * correctly, a pressure limit in kPa and a reading in Cel do not compare at
 * all — the answer is `null` (not evaluated), never a guess.
 *
 * Only linear units are listed (value_in_base = value * scale + offset). A
 * unit code that is not listed is unknown: checks that need it report
 * not-evaluated with the code, so a typo shows instead of passing.
 */

export interface UnitDef { code: string; dimension: string; scale: number; offset?: number; label: string }

const U = (code: string, dimension: string, scale: number, label: string, offset = 0): UnitDef => ({ code, dimension, scale, offset, label });

/** UCUM code → definition. Base units per dimension have scale 1. */
export const UNITS: Readonly<Record<string, UnitDef>> = Object.freeze(Object.fromEntries([
  U('1', 'dimensionless', 1, 'count / ratio'),
  U('%', 'dimensionless', 0.01, 'percent'),
  U('{bool}', 'boolean', 1, 'on/off'),
  U('{state}', 'state', 1, 'enumerated state'),
  // temperature (base K)
  U('K', 'temperature', 1, 'kelvin'),
  U('Cel', 'temperature', 1, 'degree Celsius', 273.15),
  U('[degF]', 'temperature', 5 / 9, 'degree Fahrenheit', 273.15 - 32 * 5 / 9),
  // pressure (base Pa)
  U('Pa', 'pressure', 1, 'pascal'), U('hPa', 'pressure', 100, 'hectopascal'), U('kPa', 'pressure', 1000, 'kilopascal'),
  U('MPa', 'pressure', 1e6, 'megapascal'), U('bar', 'pressure', 1e5, 'bar'), U('mbar', 'pressure', 100, 'millibar'),
  U('[psi]', 'pressure', 6894.757293168, 'pound per square inch'), U('[in_i\'Hg]', 'pressure', 3386.389, 'inch of mercury'),
  // length (base m)
  U('m', 'length', 1, 'metre'), U('km', 'length', 1000, 'kilometre'), U('cm', 'length', 0.01, 'centimetre'), U('mm', 'length', 0.001, 'millimetre'),
  U('[ft_i]', 'length', 0.3048, 'foot'), U('[nmi_i]', 'length', 1852, 'nautical mile'), U('[mi_i]', 'length', 1609.344, 'mile'),
  // speed (base m/s)
  U('m/s', 'speed', 1, 'metre per second'), U('km/h', 'speed', 1000 / 3600, 'kilometre per hour'),
  U('[kn_i]', 'speed', 1852 / 3600, 'knot'), U('[mi_i]/h', 'speed', 1609.344 / 3600, 'mile per hour'), U('[ft_i]/min', 'speed', 0.3048 / 60, 'foot per minute'),
  // angle (base rad)
  U('rad', 'angle', 1, 'radian'), U('deg', 'angle', Math.PI / 180, 'degree'),
  // time (base s)
  U('s', 'time', 1, 'second'), U('ms', 'time', 0.001, 'millisecond'), U('min', 'time', 60, 'minute'), U('h', 'time', 3600, 'hour'),
  // electrical / power / frequency
  U('V', 'voltage', 1, 'volt'), U('kV', 'voltage', 1000, 'kilovolt'), U('mV', 'voltage', 0.001, 'millivolt'),
  U('A', 'current', 1, 'ampere'), U('mA', 'current', 0.001, 'milliampere'), U('kA', 'current', 1000, 'kiloampere'),
  U('W', 'power', 1, 'watt'), U('kW', 'power', 1000, 'kilowatt'), U('MW', 'power', 1e6, 'megawatt'),
  U('Hz', 'frequency', 1, 'hertz'), U('/min', 'frequency', 1 / 60, 'per minute (rpm)'),
  // flow, concentration, mass
  U('L/min', 'flow', 1 / 60000, 'litre per minute'), U('m3/h', 'flow', 1 / 3600, 'cubic metre per hour'), U('L/s', 'flow', 0.001, 'litre per second'),
  U('mg/L', 'concentration', 1, 'milligram per litre'), U('g/L', 'concentration', 1000, 'gram per litre'),
  U('[ppm]', 'ratio-ppm', 1, 'part per million'), U('[pH]', 'ph', 1, 'pH'),
  U('kg', 'mass', 1, 'kilogram'), U('g', 'mass', 0.001, 'gram'), U('t', 'mass', 1000, 'tonne'), U('[lb_av]', 'mass', 0.45359237, 'pound'),
].map((u) => [u.code, u])));

export const unitDef = (code: string | undefined): UnitDef | undefined => (code === undefined ? undefined : UNITS[code]);

/** Convert a value; null when either unit is unknown or the dimensions differ. */
export function convert(value: number, from: string, to: string): number | null {
  if (from === to) return Number.isFinite(value) ? value : null;
  const a = UNITS[from]; const b = UNITS[to];
  if (!a || !b || a.dimension !== b.dimension || !Number.isFinite(value)) return null;
  const base = value * a.scale + (a.offset ?? 0);
  return (base - (b.offset ?? 0)) / b.scale;
}

/** Convert a difference (a tolerance, a step, a rate): offsets do not apply. */
export function convertDelta(delta: number, from: string, to: string): number | null {
  if (from === to) return Number.isFinite(delta) ? delta : null;
  const a = UNITS[from]; const b = UNITS[to];
  if (!a || !b || a.dimension !== b.dimension || !Number.isFinite(delta)) return null;
  return (delta * a.scale) / b.scale;
}
