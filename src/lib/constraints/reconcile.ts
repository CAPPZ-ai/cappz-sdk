/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-reconcile
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Constraint reconciliation: read-only detection that works on any system,
 * from data it already produces. The rule generalises SAML reconciliation
 * ("every session needs a matching issuance"):
 *
 *   every change needs a matching authorised command, and every value must
 *   stay inside the owner's signed envelope.
 *
 * Inputs: the envelope, observations (sensor and historian samples), the
 * setpoints read back from controllers (config), and the commands the control
 * system logged (signed or not). Nothing needs to be inline: reading a
 * controller's setpoint back and finding it changed with no signed command is
 * enough to catch a panel tampered with from outside.
 *
 * States (each finding names the constraint and the evidence):
 *   matched               a setpoint change an authorised command accounts for
 *   orphan-change         a setpoint changed and no authorised command accounts for it
 *   unauthorized-command  a logged command fails authorisation (unsigned, revoked key, outside window, out of range …)
 *   out-of-envelope       a value broke a range, rate or dwell constraint (one finding per excursion)
 *   disagreement          redundant sources disagree; the outlier is named when a majority agrees
 *   no-response           a setpoint change had no effect, or the effect went the wrong way
 *   stale                 a point fell silent longer than it may (silence is never "fine")
 *   unmapped              data for a point the envelope does not declare
 *   outside-coverage      a constrained point with no usable data in the period
 *   not-evaluated         a check that could not run (unit mismatch, unknown mode)
 * Gaps are never clean. The report is hashed so an incident record can cite it.
 */

import { canonicalJson, sha256HexOf } from '../identity/canonical.ts';
import type { KeyEvidence } from '../identity/keyDeclaration.ts';
import { authorize, inPointUnit, type Authorization, type PointValue, type SignedCommand } from './authority.ts';
import type { AgreementConstraint, Constraint, DwellConstraint, EnvelopeBody, RangeConstraint, RateConstraint, ResponseConstraint, SignedEnvelope } from './envelope.ts';
import { convert, convertDelta } from './units.ts';

export type Quality = 'good' | 'uncertain' | 'bad';
export interface Observation { at: number; point: string; value: PointValue; unit?: string; quality?: Quality; source: string }
export interface CommandRecord { at: number; point: string; value: PointValue; unit?: string; command?: SignedCommand | null; source: string }

export type FindingState = 'orphan-change' | 'unauthorized-command' | 'out-of-envelope' | 'disagreement' | 'no-response' | 'stale' | 'unmapped' | 'outside-coverage' | 'not-evaluated';
export type CountState = 'matched' | FindingState;

export interface Finding {
  state: FindingState;
  point: string;
  at: string;
  until?: string;
  constraintId?: string;
  value?: PointValue;
  /** For disagreement: the source(s) outside the consensus. */
  outliers?: string[];
  authorization?: Authorization['state'];
  source?: string;
  because: string;
}

export interface IntegrityState { state: 'sealed-verified' | 'sealed-broken' | 'unsealed'; because: string }

export interface ConstraintReport {
  envelope: { envelopeId: string; version: number; envelopeHash?: string; advisory: boolean };
  period: { from?: string; to?: string };
  integrity: IntegrityState;
  counts: Record<CountState, number>;
  byPoint: Record<string, Partial<Record<CountState, number>>>;
  findings: Finding[];
  verdict: 'clean' | 'findings' | 'gaps-only';
  summary: string;
  inputHashes: { observations: string; config: string; commands: string };
  reportHash: string;
}

export interface ReconcileConstraintsOptions {
  /** How long before a setpoint change its command may have been issued (default 10 min). */
  commandWindowMs?: number;
  /** Clock difference tolerated the other way (default 2 min). */
  skewMs?: number;
  /** Reporting period; also bounds stale checks at both ends. */
  period?: { from?: number; to?: number };
  keyEvidence?: KeyEvidence;
  integrity?: IntegrityState;
  /** Most finding rows kept (counts are always complete). Default 2000. */
  maxRows?: number;
}

const zero = (): Record<CountState, number> => ({ matched: 0, 'orphan-change': 0, 'unauthorized-command': 0, 'out-of-envelope': 0, disagreement: 0, 'no-response': 0, stale: 0, unmapped: 0, 'outside-coverage': 0, 'not-evaluated': 0 });
const iso = (t: number) => new Date(t).toISOString();
const applies = (c: Constraint, mode: string | null | undefined) => !c.modes || (mode != null && c.modes.includes(mode));

interface Sample { at: number; value: PointValue; source: string; quality: Quality }

export async function reconcileConstraints(env: EnvelopeBody | SignedEnvelope, input: { observations?: readonly Observation[]; config?: readonly Observation[]; commands?: readonly CommandRecord[] }, o: ReconcileConstraintsOptions = {}): Promise<ConstraintReport> {
  const cmdWindow = o.commandWindowMs ?? 10 * 60_000; const skew = o.skewMs ?? 2 * 60_000; const maxRows = o.maxRows ?? 2000;
  const counts = zero(); const byPoint: ConstraintReport['byPoint'] = {}; const findings: Finding[] = [];
  const add = (f: Finding) => { counts[f.state]++; const b = (byPoint[f.point] ??= {}); b[f.state] = (b[f.state] ?? 0) + 1; if (findings.length < maxRows) findings.push(f); };
  const matched = (point: string) => { counts.matched++; const b = (byPoint[point] ??= {}); b.matched = (b.matched ?? 0) + 1; };
  const pointOf = new Map(env.points.map((p) => [p.id, p]));

  // ── Normalise: units into each point's unit; unknown points are unmapped. ──
  const series = new Map<string, Sample[]>(); // measurement + state + setpoint values (observed)
  const unmapped = new Map<string, { first: number; n: number; source: string }>();
  const notConvertible = new Map<string, { first: number; unit: string }>();
  const push = (x: Observation) => {
    if (!Number.isFinite(x.at)) return;
    const p = pointOf.get(x.point);
    if (!p) { const u = unmapped.get(x.point); if (u) u.n++; else unmapped.set(x.point, { first: x.at, n: 1, source: x.source }); return; }
    let value = x.value;
    if (typeof value === 'number' && x.unit && x.unit !== p.unit) {
      const c = convert(value, x.unit, p.unit);
      if (c === null) { if (!notConvertible.has(x.point)) notConvertible.set(x.point, { first: x.at, unit: x.unit }); return; }
      value = c;
    }
    (series.get(x.point) ?? series.set(x.point, []).get(x.point)!).push({ at: x.at, value, source: x.source, quality: x.quality ?? 'good' });
  };
  for (const x of input.observations ?? []) push(x);
  for (const x of input.config ?? []) push({ ...x, source: x.source || 'config' });
  for (const s of series.values()) s.sort((a, b) => a.at - b.at);
  const goodCache = new Map<string, Sample[]>();
  const good = (id: string): Sample[] => goodCache.get(id) ?? goodCache.set(id, (series.get(id) ?? []).filter((s) => s.quality !== 'bad')).get(id)!;

  const allTimes = [...series.values()].flat().map((s) => s.at).concat((input.commands ?? []).map((c) => c.at)).filter(Number.isFinite);
  const from = o.period?.from ?? (allTimes.length ? Math.min(...allTimes) : undefined);
  const to = o.period?.to ?? (allTimes.length ? Math.max(...allTimes) : undefined);

  for (const [point, u] of unmapped) add({ state: 'unmapped', point, at: iso(u.first), source: u.source, because: `${u.n} sample(s) for a point the envelope does not declare: map it or declare it` });
  for (const [point, u] of notConvertible) add({ state: 'not-evaluated', point, at: iso(u.first), because: `samples in ${u.unit} do not convert to the point's unit ${pointOf.get(point)!.unit}` });

  // ── Mode over time. ──
  const modeSeries = env.modePoint ? good(env.modePoint) : [];
  const modeAt = (t: number): string | null | undefined => {
    if (!env.modePoint) return undefined;
    let m: string | null = null;
    for (const s of modeSeries) { if (s.at > t) break; m = String(s.value); }
    return m;
  };

  // ── Commands: authorise each, in time order. ──
  const usedNonces = new Set<string>();
  const lastAuthorized = new Map<string, { at: number; value: PointValue }>();
  const lastObservedAt = (point: string, t: number): { at: number; value: number } | undefined => {
    let v: { at: number; value: number } | undefined;
    for (const s of good(point)) { if (s.at > t) break; if (typeof s.value === 'number') v = { at: s.at, value: s.value }; }
    return v;
  };
  const authorized: Array<CommandRecord & { used: boolean }> = []; const refusedCmds: Array<CommandRecord & { auth: Authorization }> = [];
  for (const c of [...(input.commands ?? [])].filter((c) => Number.isFinite(c.at)).sort((a, b) => a.at - b.at)) {
    if (!pointOf.has(c.point)) { add({ state: 'unmapped', point: c.point, at: iso(c.at), source: c.source, because: 'a command for a point the envelope does not declare' }); continue; }
    // The current value is the later of the last observation and the last authorised command (what the guard tracks too), so prevention and detection agree on step limits.
    const obsAt = lastObservedAt(c.point, c.at - 1); const cmdAt = lastAuthorized.get(c.point);
    const current = cmdAt && (!obsAt || cmdAt.at >= obsAt.at) ? (typeof cmdAt.value === 'number' ? cmdAt.value : undefined) : obsAt?.value;
    const auth = await authorize(env, { at: c.at, write: { point: c.point, value: c.value, unit: c.unit }, command: c.command ?? null, current, mode: modeAt(c.at), usedNonces, keyEvidence: o.keyEvidence, skewMs: skew });
    if (auth.state === 'authorized') { authorized.push({ ...c, used: false }); const pv = inPointUnit(env, c.point, c.value, c.unit); if (pv !== null) lastAuthorized.set(c.point, { at: c.at, value: pv }); }
    else { refusedCmds.push({ ...c, auth }); add({ state: 'unauthorized-command', point: c.point, at: iso(c.at), value: c.value, authorization: auth.state, constraintId: auth.constraintId, source: c.source, because: auth.because }); }
  }

  // ── Setpoint changes need a matching authorised command. ──
  const changes = new Map<string, Array<{ at: number; from: PointValue; to: PointValue; source: string }>>();
  for (const p of env.points.filter((p) => p.kind === 'setpoint' || p.kind === 'command')) {
    const s = good(p.id); const list: Array<{ at: number; from: PointValue; to: PointValue; source: string }> = [];
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1].value; const b = s[i].value;
      const differs = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a)) : a !== b;
      if (differs) list.push({ at: s[i].at, from: a, to: b, source: s[i].source });
    }
    changes.set(p.id, list);
    for (const ch of list) {
      const sameValue = (v: PointValue, unit?: string) => {
        const pv = typeof v === 'number' && unit && unit !== p.unit ? convert(v, unit, p.unit) : v;
        return typeof pv === 'number' && typeof ch.to === 'number' ? Math.abs(pv - ch.to) <= 1e-6 * Math.max(1, Math.abs(pv)) : pv === ch.to;
      };
      const inWin = (c: CommandRecord) => c.point === p.id && c.at >= ch.at - cmdWindow && c.at <= ch.at + skew && sameValue(c.value, c.unit);
      const hit = authorized.filter((c) => !c.used && inWin(c)).sort((a, b) => Math.abs(a.at - ch.at) - Math.abs(b.at - ch.at))[0];
      if (hit) { hit.used = true; matched(p.id); continue; }
      const bad = refusedCmds.find(inWin);
      add({ state: 'orphan-change', point: p.id, at: iso(ch.at), value: ch.to, source: ch.source,
        because: bad ? `${String(ch.from)} → ${String(ch.to)} ${p.unit}: only a command that failed authorisation (${bad.auth.state}) accounts for it` : `${String(ch.from)} → ${String(ch.to)} ${p.unit} with no authorised command in the ${Math.round(cmdWindow / 60_000)} min before it — changed outside the governed path` });
    }
  }

  // ── Range, rate, dwell, agreement, response. ──
  const toC = (v: PointValue, point: string, unit: string): number | null => (typeof v === 'number' ? convert(v, pointOf.get(point)!.unit, unit) : null);
  for (const c of env.constraints) {
    if (c.kind === 'range' || c.kind === 'dwell') {
      const r = c as RangeConstraint | DwellConstraint;
      for (const point of r.points) {
        let start: number | null = null; let peak: number | null = null; let lastAt = 0; let unknownMode = false;
        const flush = (endAt: number | null, ongoing: boolean) => {
          if (start === null) return;
          const dur = (endAt ?? lastAt) - start;
          if (r.kind === 'range' || dur > (r as DwellConstraint).maxMs) add({ state: 'out-of-envelope', point, at: iso(start), until: endAt === null ? undefined : iso(endAt), constraintId: r.id, value: peak ?? undefined,
            because: r.kind === 'range' ? `outside ${r.min ?? '−∞'}…${r.max ?? '∞'} ${r.unit}${ongoing ? ' (still outside at the end of the data)' : ''}, worst ${peak} ${r.unit}` : `outside ${r.min ?? '−∞'}…${r.max ?? '∞'} ${r.unit} for ${Math.round(dur / 60_000)} min (allowed ${Math.round((r as DwellConstraint).maxMs / 60_000)} min)${ongoing ? ', still outside' : ''}, worst ${peak} ${r.unit}` });
          start = null; peak = null;
        };
        for (const s of good(point)) {
          const m = modeAt(s.at);
          if (r.modes && m === null) { unknownMode = true; continue; }
          if (!applies(r, m)) { flush(s.at, false); continue; }
          const v = toC(s.value, point, r.unit); if (v === null) continue;
          const out = (r.min !== undefined && v < r.min) || (r.max !== undefined && v > r.max);
          if (out) { if (start === null) start = s.at; const dist = (x: number) => Math.max((r.min ?? x) - x, x - (r.max ?? x)); if (peak === null || dist(v) > dist(peak)) peak = v; }
          else flush(s.at, false);
          lastAt = s.at;
        }
        flush(null, true);
        if (unknownMode) add({ state: 'not-evaluated', point, at: iso(from ?? 0), constraintId: r.id, because: `${r.id} applies only in modes ${r.modes!.join(', ')} and the mode point had no value for part of the period` });
      }
    } else if (c.kind === 'rate') {
      const r = c as RateConstraint;
      for (const point of r.points) {
        const s = good(point).filter((x) => typeof x.value === 'number'); const isSet = pointOf.get(point)!.kind !== 'measurement';
        let run: { at: number; worst: number } | null = null;
        const end = (t?: number) => { if (run) add({ state: 'out-of-envelope', point, at: iso(run.at), until: t === undefined ? undefined : iso(t), constraintId: r.id, value: run.worst, because: isSet && r.maxStep !== undefined ? `a setpoint step of ${run.worst} ${r.unit} exceeds ${r.maxStep} ${r.unit}` : `changed at ${run.worst.toPrecision(4)} ${r.unit} per ${Math.round(r.perMs! / 1000)} s (allowed ${r.maxDelta})` }); run = null; };
        for (let i = 1; i < s.length; i++) {
          const m = modeAt(s[i].at); if (!applies(r, m)) { end(s[i].at); continue; }
          const d = convertDelta(Math.abs((s[i].value as number) - (s[i - 1].value as number)), pointOf.get(point)!.unit, r.unit); if (d === null) continue;
          let bad = false; let metric = d;
          if (isSet && r.maxStep !== undefined) bad = d > r.maxStep + 1e-9;
          else if (r.maxDelta !== undefined && r.perMs) { const dt = s[i].at - s[i - 1].at; if (dt > 0) { metric = (d / dt) * r.perMs; bad = metric > r.maxDelta + 1e-9; } }
          if (bad) { if (!run) run = { at: s[i].at, worst: metric }; else run.worst = Math.max(run.worst, metric); } else end(s[i].at);
        }
        end();
      }
    } else if (c.kind === 'agreement') {
      const a = c as AgreementConstraint; const maxSkew = a.maxSkewMs ?? 5_000; const persist = a.persistMs ?? 0;
      const srcs = a.points.map((p) => ({ p, s: good(p).filter((x) => typeof x.value === 'number') }));
      const times = [...new Set(srcs.flatMap((x) => x.s.map((y) => y.at)))].sort((x, y) => x - y);
      const idx = srcs.map(() => 0);
      let ep: { at: number; last: number; outliers: string; spread: number } | null = null;
      const close = (t?: number) => {
        if (ep && ep.last - ep.at >= persist) add({ state: 'disagreement', point: a.points.join('|'), at: iso(ep.at), until: t === undefined ? undefined : iso(t), constraintId: a.id, outliers: ep.outliers ? ep.outliers.split(',') : undefined,
          because: ep.outliers ? `${ep.outliers} disagreed with the other source(s) by up to ${ep.spread.toPrecision(4)} ${a.unit} (tolerance ${a.tolerance})` : `no majority within ${a.tolerance} ${a.unit} (spread up to ${ep.spread.toPrecision(4)} ${a.unit}): which source is right cannot be told from these alone` });
        ep = null;
      };
      for (const t of times) {
        if (!applies(a, modeAt(t))) { close(t); continue; }
        const vals: Array<{ p: string; v: number }> = [];
        srcs.forEach((x, i) => { while (idx[i] + 1 < x.s.length && x.s[idx[i] + 1].at <= t) idx[i]++; const smp = x.s[idx[i]]; if (smp && smp.at <= t && t - smp.at <= maxSkew) { const v = toC(smp.value, x.p, a.unit); if (v !== null) vals.push({ p: x.p, v }); } });
        if (vals.length < 2) continue;
        const sorted = vals.map((x) => x.v).sort((x, y) => x - y); const med = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
        const spread = sorted[sorted.length - 1] - sorted[0];
        if (spread <= a.tolerance + 1e-9) { close(t); continue; }
        // A consensus: the largest group within tolerance of each other, if it is a strict majority.
        let best: string[] = [];
        for (const x of vals) { const grp = vals.filter((y) => Math.abs(y.v - x.v) <= a.tolerance + 1e-9).map((y) => y.p); if (grp.length > best.length) best = grp; }
        const outliers = best.length * 2 > vals.length ? vals.filter((x) => !best.includes(x.p)).map((x) => x.p).sort().join(',') : '';
        void med;
        if (ep && ep.outliers === outliers) { ep.last = t; ep.spread = Math.max(ep.spread, spread); }
        else { close(t); ep = { at: t, last: t, outliers, spread }; }
      }
      close();
    } else if (c.kind === 'response') {
      const r = c as ResponseConstraint; const [cmdPoint, obsPoint] = r.points; const need = r.minChange ?? r.deadband;
      const triggers = (changes.get(cmdPoint) ?? []).map((x) => ({ at: x.at, to: x.to }));
      if (!triggers.length) for (const ac of authorized.filter((x) => x.point === cmdPoint)) triggers.push({ at: ac.at, to: ac.value });
      const obs = good(obsPoint).filter((x) => typeof x.value === 'number');
      for (const tr of triggers) {
        if (!applies(r, modeAt(tr.at))) continue;
        if (to !== undefined && tr.at + r.withinMs > to) { add({ state: 'not-evaluated', point: obsPoint, at: iso(tr.at), constraintId: r.id, because: `the data ends before the ${Math.round(r.withinMs / 60_000)} min response window does` }); continue; }
        const S = toC(tr.to, cmdPoint, r.unit); const base = [...obs].reverse().find((x) => x.at <= tr.at);
        const O0 = base ? toC(base.value, obsPoint, r.unit) : null;
        if (S === null || O0 === null) { add({ state: 'not-evaluated', point: obsPoint, at: iso(tr.at), constraintId: r.id, because: base ? 'units do not convert' : 'no observation before the change to compare with' }); continue; }
        if (Math.abs(S - O0) <= r.deadband) continue;
        const dir = Math.sign(S - O0);
        const win = obs.filter((x) => x.at > tr.at && x.at <= tr.at + r.withinMs).map((x) => dir * (toC(x.value, obsPoint, r.unit)! - O0));
        if (!win.length) { add({ state: 'stale', point: obsPoint, at: iso(tr.at), constraintId: r.id, because: `no ${obsPoint} sample in the ${Math.round(r.withinMs / 60_000)} min after the change, so its effect cannot be checked` }); continue; }
        const bestP = Math.max(...win); const worst = Math.min(...win);
        if (bestP >= need) continue;
        add({ state: 'no-response', point: obsPoint, at: iso(tr.at), constraintId: r.id, value: tr.to,
          because: worst <= -need ? `${cmdPoint} → ${String(tr.to)}, but ${obsPoint} moved the other way by ${(-worst).toPrecision(3)} ${r.unit} — the reading or the actuator is not what it claims` : `${cmdPoint} → ${String(tr.to)}, but ${obsPoint} moved only ${bestP.toPrecision(3)} ${r.unit} toward it in ${Math.round(r.withinMs / 60_000)} min (needs ${need})` });
      }
    }
  }

  // ── Silence and coverage. ──
  const constrained = new Set(env.constraints.flatMap((c) => (c.kind === 'authority' || c.kind === 'schedule' ? [] : c.points)));
  for (const p of env.points) {
    const s = good(p.id);
    if (!s.length) { if (constrained.has(p.id) || p.maxGapMs) add({ state: 'outside-coverage', point: p.id, at: iso(from ?? 0), because: series.get(p.id)?.length ? 'every sample in the period was marked bad quality' : 'no data for this point in the period' }); continue; }
    if (!p.maxGapMs) continue;
    const edges = [o.period?.from, ...s.map((x) => x.at), o.period?.to].filter((x): x is number => x !== undefined);
    for (let i = 1; i < edges.length; i++) if (edges[i] - edges[i - 1] > p.maxGapMs) add({ state: 'stale', point: p.id, at: iso(edges[i - 1]), until: iso(edges[i]), because: `silent for ${Math.round((edges[i] - edges[i - 1]) / 60_000)} min (allowed ${Math.round(p.maxGapMs / 60_000)} min)` });
  }

  findings.sort((a, b) => a.at.localeCompare(b.at) || a.point.localeCompare(b.point) || a.state.localeCompare(b.state));
  const integrity: IntegrityState = o.integrity ?? { state: 'unsealed', because: 'observations were not sealed at the collector: a tampered historian would not show' };
  const bad = counts['orphan-change'] + counts['unauthorized-command'] + counts['out-of-envelope'] + counts.disagreement + counts['no-response'] + (integrity.state === 'sealed-broken' ? 1 : 0);
  const gaps = counts.stale + counts.unmapped + counts['outside-coverage'] + counts['not-evaluated'];
  const verdict: ConstraintReport['verdict'] = bad ? 'findings' : gaps ? 'gaps-only' : 'clean';
  const summary = bad
    ? `${bad} finding(s): ${counts['orphan-change']} change(s) without an authorised command, ${counts['unauthorized-command']} unauthorised command(s), ${counts['out-of-envelope']} envelope breach(es), ${counts.disagreement} source disagreement(s), ${counts['no-response']} missing response(s)${integrity.state === 'sealed-broken' ? `, and the sealed record is broken (${integrity.because})` : ''}`
    : gaps ? `no breach found, but ${gaps} gap(s) (${counts.stale} stale, ${counts['outside-coverage']} without data, ${counts.unmapped} unmapped, ${counts['not-evaluated']} not evaluated): close them before calling it clean`
      : counts.matched ? `all ${counts.matched} setpoint change(s) matched authorised commands; every value stayed in the envelope` : 'no setpoint changed; every value stayed in the envelope';
  const body = {
    envelope: { envelopeId: env.envelopeId, version: env.version, envelopeHash: (env as SignedEnvelope).envelopeHash, advisory: !!env.advisory },
    period: { from: from === undefined ? undefined : iso(from), to: to === undefined ? undefined : iso(to) },
    integrity, counts, byPoint, findings, verdict, summary,
    inputHashes: { observations: await sha256HexOf(canonicalJson(input.observations ?? [])), config: await sha256HexOf(canonicalJson(input.config ?? [])), commands: await sha256HexOf(canonicalJson(input.commands ?? [])) },
  };
  return { ...body, reportHash: await sha256HexOf(canonicalJson(body)) };
}
