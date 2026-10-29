/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-evals
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * The resilience mesh's benchmark and eval suite: named scenarios, each with
 * thresholds declared before it runs. Security thresholds are absolute (no
 * forged bundle admitted, no honest bundle purged by a forged receipt, no
 * revoked-key bundle admitted once the node knows); delivery thresholds are
 * floors for the scenario's conditions. The report keeps measured values next
 * to thresholds so a change shows what it moved, not only whether it passed.
 *
 * Scale 'quick' runs in CI; 'full' is the benchmark (more nodes, longer runs).
 * Everything runs in simulation (meshSim.ts) — see its header for what that
 * does and does not model.
 */

import { runSimulation, type SimConfig, type SimResult } from './meshSim.ts';

export type EvalScale = 'quick' | 'full';

export interface Check { metric: string; value: number | null; op: '>=' | '<=' | '=='; threshold: number; pass: boolean }

export interface MeshEval {
  id: string;
  title: string;
  /** What the scenario stands for in the field. */
  models: string;
  config(scale: EvalScale): SimConfig;
  thresholds(r: SimResult): Check[];
  /** Router modes compared on the same seed (benchmark rows; the first is the one judged). */
  compare?: SimConfig['router'][];
}

export interface MeshEvalOutcome { id: string; title: string; models: string; pass: boolean; checks: Check[]; result: SimResult; comparison?: SimResult[] }
export interface MeshEvalReport { scale: EvalScale; startedAt: string; wallMs: number; passed: number; failed: number; outcomes: MeshEvalOutcome[] }

const c = (metric: string, value: number | null, op: Check['op'], threshold: number): Check => ({
  metric, value, op, threshold,
  pass: value !== null && (op === '>=' ? value >= threshold : op === '<=' ? value <= threshold : value === threshold),
});

const base = (scale: EvalScale, o: Partial<SimConfig> & Pick<SimConfig, 'name'>): SimConfig => ({
  seed: 7,
  nodes: scale === 'quick' ? 24 : 60,
  areaM: scale === 'quick' ? 600 : 1200,
  rangeM: 100,
  durationS: scale === 'quick' ? 1800 : 3 * 3600,
  tickS: scale === 'quick' ? 10 : 15,
  mobility: { kind: 'random-waypoint', speed: [0.5, 1.5], pauseS: 120 },
  bandwidthBps: 250_000,
  router: 'spray-prophet',
  coordinators: 2,
  responders: 3,
  guests: 2,
  messages: scale === 'quick' ? 30 : 150,
  messageBytes: 200,
  precedenceMix: { flash: 1, immediate: 2, priority: 3, routine: 4 },
  alerts: scale === 'quick' ? 3 : 8,
  ...o,
});

const highPrecedence = (r: SimResult): number | null => {
  const f = r.messages.byPrecedence.flash, i = r.messages.byPrecedence.immediate;
  const sent = (f?.sent ?? 0) + (i?.sent ?? 0);
  return sent ? ((f?.delivered ?? 0) + (i?.delivered ?? 0)) / sent : null;
};

const security = (r: SimResult): Check[] => [
  c('forged bundles admitted', r.security.forgedAdmitted, '==', 0),
  c('replays admitted by a node that had seen them', r.security.replayAdmittedAfterSeen, '==', 0),
  c('honest bundles purged by forged receipts', r.security.illegitimatePurges, '==', 0),
  c('revoked-key bundles admitted after the node learned the revocation', r.security.revokedAdmittedAfterLearned, '==', 0),
];

export const MESH_EVALS: readonly MeshEval[] = [
  {
    id: 'dense-connected',
    title: 'Dense neighbourhood, everyone in multi-hop reach',
    models: 'A block or camp where phones on a shared hotspot / Wi-Fi Direct group form one connected mesh',
    config: (s) => base(s, { name: 'dense-connected', mobility: { kind: 'static', connected: true }, areaM: s === 'quick' ? 250 : 400, rangeM: 90, durationS: s === 'quick' ? 600 : 1800 }),
    thresholds: (r) => [c('delivery ratio', r.messages.ratio, '>=', 0.98), c('alert coverage', r.alerts.meanCoverage, '>=', 0.98), c('p95 latency (s)', r.messages.latencyP95S, '<=', 60), ...security(r)],
  },
  {
    id: 'sparse-dtn',
    title: 'Sparse, moving people: no end-to-end path, ever',
    models: 'A city with the cell network down: people walking, rarely more than two within range',
    config: (s) => base(s, { name: 'sparse-dtn', areaM: s === 'quick' ? 900 : 2000 }),
    thresholds: (r) => [c('delivery ratio', r.messages.ratio, '>=', 0.6), c('alert coverage', r.alerts.meanCoverage, '>=', 0.7), ...security(r)],
    compare: ['spray-prophet', 'epidemic', 'direct'],
  },
  {
    id: 'shelters-couriers',
    title: 'Shelters joined only by couriers',
    models: 'Isolated shelters / bunkers with local meshes; runners, cyclists or vehicles carry bundles between them',
    config: (s) => base(s, { name: 'shelters-couriers', mobility: { kind: 'shelters', shelters: s === 'quick' ? 3 : 5, couriers: s === 'quick' ? 3 : 6, speed: [1.5, 5], pauseS: 300 }, areaM: s === 'quick' ? 1500 : 4000 }),
    thresholds: (r) => [c('delivery ratio', r.messages.ratio, '>=', 0.6), c('alert coverage', r.alerts.meanCoverage, '>=', 0.75), ...security(r)],
  },
  {
    id: 'hostile-injection',
    title: 'Forgers, impersonators and outsiders on the mesh',
    models: 'Hostile devices in range: altered bundles, a fake evacuation order in a coordinator\'s name, unprovisioned devices sending FLASH',
    config: (s) => base(s, { name: 'hostile-injection', adversaries: { forgers: 2, impersonators: 2, outsiders: 2, replayers: 1 } }),
    thresholds: (r) => [c('attack bundles injected', r.security.attackBundlesInjected, '>=', 1), c('delivery ratio', r.messages.ratio, '>=', 0.55), ...security(r)],
  },
  {
    id: 'flood',
    title: 'Members flooding the mesh',
    models: 'A captured or misbehaving member device spamming valid traffic to exhaust storage and airtime',
    config: (s) => base(s, { name: 'flood', storeBytes: 2 * 1024 * 1024, adversaries: { flooders: 2 }, messages: s === 'quick' ? 60 : 200, precedenceMix: { flash: 3, immediate: 3, priority: 2, routine: 2 } }),
    thresholds: (r) => [
      c('delivery ratio', r.messages.ratio, '>=', 0.55),
      c('max share of any honest store held by flooders', r.security.flooderStoreShareMax, '<=', 0.17),
      c('FLASH + IMMEDIATE delivery ratio', highPrecedence(r), '>=', 0.6),
      c('flood bundles refused by the rate limit', r.security.verdicts['rate-limited'] ?? 0, '>=', 1),
      ...security(r),
    ],
  },
  {
    id: 'captured-device',
    title: 'A member device is captured, then revoked',
    models: 'A phone taken at a checkpoint; its owner reports it and a coordinator puts the KeyZ revocation on the mesh',
    config: (s) => base(s, { name: 'captured-device', adversaries: { captured: { atS: s === 'quick' ? 300 : 1800, revokeAfterS: s === 'quick' ? 120 : 600 } } }),
    thresholds: (r) => [c('share of honest nodes that learned the revocation', r.security.revocationReach, '>=', 0.85), ...security(r)],
  },
  {
    id: 'blackholes',
    title: 'Members that accept custody and drop everything',
    models: 'Compromised relays (20%) silently discarding what they are handed',
    config: (s) => base(s, { name: 'blackholes', adversaries: { blackholes: Math.round((s === 'quick' ? 24 : 60) * 0.2) } }),
    thresholds: (r) => [c('delivery ratio', r.messages.ratio, '>=', 0.4), ...security(r)],
    compare: ['spray-prophet', 'epidemic'],
  },
  {
    id: 'receipt-forgery',
    title: 'Forged delivery receipts',
    models: 'Members trying to make carriers drop messages by claiming they were delivered',
    config: (s) => base(s, { name: 'receipt-forgery', adversaries: { ackForgers: 3 } }),
    thresholds: (r) => [c('attack bundles injected', r.security.attackBundlesInjected, '>=', 1), c('delivery ratio', r.messages.ratio, '>=', 0.55), ...security(r)],
  },
  {
    id: 'jammed-ble',
    title: 'Bluetooth-only links under jamming',
    models: 'Wi-Fi jammed or off; BLE links (MTU 180, ~20 kB/s) failing 20% of ticks',
    config: (s) => base(s, { name: 'jammed-ble', mtu: 180, bandwidthBps: 20_000, rangeM: 40, areaM: s === 'quick' ? 300 : 600, linkFailPerTick: 0.2 }),
    thresholds: (r) => [c('delivery ratio', r.messages.ratio, '>=', 0.5), ...security(r)],
  },
];

export async function runMeshEvals(o: { scale?: EvalScale; only?: string[]; onProgress?: (o: MeshEvalOutcome) => void } = {}): Promise<MeshEvalReport> {
  const scale = o.scale ?? 'quick';
  const started = Date.now();
  const outcomes: MeshEvalOutcome[] = [];
  for (const e of MESH_EVALS) {
    if (o.only?.length && !o.only.includes(e.id)) continue;
    const cfg = e.config(scale);
    const result = await runSimulation(cfg);
    const checks = e.thresholds(result);
    let comparison: SimResult[] | undefined;
    if (e.compare && scale === 'full') {
      comparison = [result];
      for (const router of e.compare.slice(1)) comparison.push(await runSimulation({ ...cfg, router, name: `${cfg.name}/${router}` }));
    }
    const out: MeshEvalOutcome = { id: e.id, title: e.title, models: e.models, pass: checks.every((x) => x.pass), checks, result, comparison };
    outcomes.push(out);
    o.onProgress?.(out);
  }
  const passed = outcomes.filter((x) => x.pass).length;
  return { scale, startedAt: new Date(started).toISOString(), wallMs: Date.now() - started, passed, failed: outcomes.length - passed, outcomes };
}

const f = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(d));

export function formatEvalReport(r: MeshEvalReport): string {
  const lines = [`# CAPPZ mesh evals (${r.scale})`, '', `${r.passed} passed, ${r.failed} failed, ${(r.wallMs / 1000).toFixed(1)} s. Simulated radios; real crypto, gate, store and routing.`, ''];
  lines.push('| eval | result | delivery | p50 / p95 latency (s) | alert coverage | tx per delivered | peak store (KB) | gate checks |', '|---|---|---|---|---|---|---|---|');
  for (const o of r.outcomes) {
    const m = o.result;
    lines.push(`| ${o.id} | ${o.pass ? 'PASS' : 'FAIL'} | ${f(m.messages.ratio)} (${m.messages.delivered}/${m.messages.sent}) | ${f(m.messages.latencyP50S, 0)} / ${f(m.messages.latencyP95S, 0)} | ${f(m.alerts.meanCoverage)} | ${f(m.overhead.perDelivered, 1)} | ${f(m.overhead.peakStoreBytes / 1024, 0)} | ${m.cpu.gateChecks} |`);
  }
  for (const o of r.outcomes) {
    lines.push('', `## ${o.id}: ${o.title}`, '', `Models: ${o.models}.`, '');
    for (const ch of o.checks) lines.push(`- ${ch.pass ? '✓' : '✗'} ${ch.metric}: ${f(ch.value)} (needs ${ch.op} ${ch.threshold})`);
    const s = o.result.security;
    const v = Object.entries(s.verdicts).sort((a, b) => b[1]! - a[1]!).map(([k, n]) => `${k} ${n}`).join(', ');
    lines.push(`- gate verdicts at honest nodes: ${v || '—'}`);
    if (s.attackBundlesInjected) lines.push(`- attack bundles injected: ${s.attackBundlesInjected}; links closed for abuse: ${s.linksClosedForAbuse}`);
    if (s.revocationReach !== null) lines.push(`- revocation reached ${f(s.revocationReach)} of honest nodes, p90 ${f(s.revocationP90S, 0)} s; captured-key bundles admitted before a node knew: ${s.revokedAdmittedBeforeLearned}`);
    if (o.comparison) {
      lines.push('', '| router | delivery | p95 latency (s) | tx per delivered | bytes out (MB) |', '|---|---|---|---|---|');
      for (const x of o.comparison) lines.push(`| ${x.config.router} | ${f(x.messages.ratio)} | ${f(x.messages.latencyP95S, 0)} | ${f(x.overhead.perDelivered, 1)} | ${f(x.overhead.bytesOut / 1e6)} |`);
    }
  }
  return lines.join('\n') + '\n';
}
