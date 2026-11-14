/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-vehicle
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Navigation and air-data integrity for moving vehicles — aircraft, ships,
 * trains, road vehicles — as constraint observations, so the same envelope,
 * reconciliation and triage apply. "Making the crew believe they are on
 * course" is GNSS spoofing; it is caught by comparing independent sources, not
 * by trusting any one of them:
 *
 *   - separation between each pair of position sources (GNSS, inertial, radio
 *     navigation such as DME/DME or VOR, terrain-referenced, AIS for ships);
 *   - each source's offset from the closest other source — with three or more
 *     sources the spoofed one is the one far from all the others;
 *   - the speed a source's own consecutive fixes imply (a GNSS "jump");
 *   - the offset of GNSS time from the vehicle's own monotonic clock (spoofing
 *     moves the clock as well as the position).
 * Redundant air data (three airspeeds, two altitudes) is a plain `agreement`
 * constraint — the unreliable-airspeed pattern of AF447 (iced pitot probes)
 * shows as a disagreement with or without a majority.
 *
 * Scope, honestly: these envelopes are always `advisory`. The guard refuses to
 * authorise inline writes with them, and nothing here belongs in a flight- or
 * vehicle-control loop. Realistic uses are post-flight/voyage analysis
 * (flight-data monitoring), an advisory display on an electronic flight bag or
 * bridge system, and ground monitoring. Anything installed on an aircraft is
 * certified separately (e.g. DO-178C, DO-326A) by whoever installs it. Every
 * threshold comes from the operator; none is defaulted here.
 */

import type { Constraint, ConstraintPoint } from './envelope.ts';
import type { Observation, Quality } from './reconcile.ts';

export interface PositionFix { at: number; source: string; lat: number; lon: number; quality?: Quality }
export interface TimeFix { at: number; source: string; /** The source's time (ms since epoch). */ time: number; /** The vehicle's monotonic clock mapped to epoch at a trusted moment (ms). */ local: number }

const R = 6_371_008.8; // mean Earth radius, m
const rad = (d: number) => (d * Math.PI) / 180;
/** Great-circle distance in metres (haversine). */
export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = rad(b.lat - a.lat); const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const validFix = (f: PositionFix) => Number.isFinite(f.at) && Number.isFinite(f.lat) && Number.isFinite(f.lon) && Math.abs(f.lat) <= 90 && Math.abs(f.lon) <= 180;

export const navPoints = (vehicle: string, sources: readonly string[]) => ({
  separation: (a: string, b: string) => `${vehicle}/nav/separation/${[a, b].sort().join('~')}`,
  offset: (s: string) => `${vehicle}/nav/offset/${s}`,
  impliedSpeed: (s: string) => `${vehicle}/nav/implied-speed/${s}`,
  clockOffset: (s: string) => `${vehicle}/time/offset/${s}`,
  sources,
});

/**
 * Position fixes → observations. At each fix time, every source's latest fix
 * no older than `maxAgeMs` is compared. Bad-quality fixes are skipped.
 */
export function navigationObservations(vehicle: string, fixes: readonly PositionFix[], o: { maxAgeMs: number }): Observation[] {
  const good = fixes.filter((f) => validFix(f) && f.quality !== 'bad').sort((a, b) => a.at - b.at);
  const sources = [...new Set(good.map((f) => f.source))].sort();
  const P = navPoints(vehicle, sources); const out: Observation[] = [];
  const last = new Map<string, PositionFix>();
  for (const f of good) {
    const prev = last.get(f.source);
    if (prev && f.at > prev.at) out.push({ at: f.at, point: P.impliedSpeed(f.source), value: distanceM(prev, f) / ((f.at - prev.at) / 1000), unit: 'm/s', source: `nav:${f.source}` });
    last.set(f.source, f);
    const fresh = [...last.values()].filter((x) => f.at - x.at <= o.maxAgeMs);
    if (fresh.length < 2) continue;
    const dist = new Map<string, number[]>();
    for (let i = 0; i < fresh.length; i++) for (let j = i + 1; j < fresh.length; j++) {
      const d = distanceM(fresh[i], fresh[j]);
      out.push({ at: f.at, point: P.separation(fresh[i].source, fresh[j].source), value: d, unit: 'm', source: 'nav' });
      (dist.get(fresh[i].source) ?? dist.set(fresh[i].source, []).get(fresh[i].source)!).push(d);
      (dist.get(fresh[j].source) ?? dist.set(fresh[j].source, []).get(fresh[j].source)!).push(d);
    }
    if (fresh.length >= 3) for (const [s, ds] of dist) out.push({ at: f.at, point: P.offset(s), value: Math.min(...ds), unit: 'm', source: 'nav' });
  }
  return out;
}

/** Time fixes → clock-offset observations (seconds; positive = the source is ahead). */
export function clockObservations(vehicle: string, fixes: readonly TimeFix[]): Observation[] {
  const P = navPoints(vehicle, []);
  return fixes.filter((f) => Number.isFinite(f.at) && Number.isFinite(f.time) && Number.isFinite(f.local)).map((f) => ({ at: f.at, point: P.clockOffset(f.source), value: (f.time - f.local) / 1000, unit: 's', source: `time:${f.source}` }));
}

export interface VehicleEnvelopeSpec {
  vehicle: string;
  positionSources?: string[];
  /** Largest separation between any two position sources (m), and how long it may persist (ms, default 0). */
  maxSeparationM?: number; separationPersistMs?: number;
  /** With three or more sources: largest distance from a source to its closest other source (m). */
  maxOffsetM?: number;
  /** Fastest speed a source's own fixes may imply (m/s). */
  maxImpliedSpeedMs?: number;
  timeSources?: string[];
  /** Largest clock offset (s). */
  maxClockOffsetS?: number;
  /** Redundant measurements that must agree, e.g. three airspeeds in [kn_i]. */
  agreements?: Array<{ id: string; points: string[]; unit: string; tolerance: number; persistMs?: number; maxSkewMs?: number }>;
}

/** Points and constraints for a vehicle's advisory envelope (declare it with advisory: true). */
export function vehicleEnvelope(s: VehicleEnvelopeSpec): { points: ConstraintPoint[]; constraints: Constraint[]; advisory: true } {
  const ps = [...new Set(s.positionSources ?? [])].sort(); const P = navPoints(s.vehicle, ps);
  const points: ConstraintPoint[] = []; const constraints: Constraint[] = [];
  const add = (id: string, unit: string) => { if (!points.some((p) => p.id === id)) points.push({ id, kind: 'measurement', unit }); };
  if (s.maxSeparationM !== undefined) {
    const ids: string[] = [];
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) { const id = P.separation(ps[i], ps[j]); add(id, 'm'); ids.push(id); }
    if (ids.length) {
      if (s.separationPersistMs) constraints.push({ id: 'nav-separation', kind: 'dwell', points: ids, unit: 'm', max: s.maxSeparationM, maxMs: s.separationPersistMs });
      else constraints.push({ id: 'nav-separation', kind: 'range', points: ids, unit: 'm', max: s.maxSeparationM });
    }
  }
  if (s.maxOffsetM !== undefined && ps.length >= 3) { const ids = ps.map((x) => P.offset(x)); ids.forEach((id) => add(id, 'm')); constraints.push({ id: 'nav-offset', kind: 'range', points: ids, unit: 'm', max: s.maxOffsetM }); }
  if (s.maxImpliedSpeedMs !== undefined && ps.length) { const ids = ps.map((x) => P.impliedSpeed(x)); ids.forEach((id) => add(id, 'm/s')); constraints.push({ id: 'nav-implied-speed', kind: 'range', points: ids, unit: 'm/s', max: s.maxImpliedSpeedMs }); }
  if (s.maxClockOffsetS !== undefined && s.timeSources?.length) { const ids = s.timeSources.map((x) => P.clockOffset(x)); ids.forEach((id) => add(id, 's')); constraints.push({ id: 'time-offset', kind: 'range', points: ids, unit: 's', min: -s.maxClockOffsetS, max: s.maxClockOffsetS }); }
  for (const a of s.agreements ?? []) { for (const p of a.points) add(p, a.unit); constraints.push({ id: a.id, kind: 'agreement', points: a.points, unit: a.unit, tolerance: a.tolerance, ...(a.persistMs ? { persistMs: a.persistMs } : {}), ...(a.maxSkewMs ? { maxSkewMs: a.maxSkewMs } : {}) }); }
  return { points, constraints, advisory: true };
}
