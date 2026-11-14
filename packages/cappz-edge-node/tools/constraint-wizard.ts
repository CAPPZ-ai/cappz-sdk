/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-wizard
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Constraint Guard, step by step (deno run -A tools/constraint-wizard.ts <step> [flags]):
 *
 *   keygen                                   operator key (signs envelopes, endorsements, commands, mode changes)
 *   init --envelope-id <id>                  config with this operator trusted; add fronts and maps, then doctor
 *   draft-graph --vertices f --edges f --mapping f   draft points/constraints from a device graph (GraphSON or plain JSON)
 *   declare --file envelope-draft.json       sign the next version (prints every loosening it contains)
 *   endorse --hash <envelopeHash>            a second operator's endorsement (loosenings need minRelaxSigners)
 *   revoke --reason "..."                    revoke the active version (also needs endorsements + cooling)
 *   status                                   active version, pending loosening, history, point modes
 *   command --point p --value v [--unit u] [--ttl-min 5] [--reason r] [--arm http://guard:41452]
 *                                            a signed command (header for HTTP fronts; --arm for Modbus/BACnet/DNP3/104/MQTT)
 *   enforce --point p|* --report <url|hash> --reason r      enforce on the shadow report (fetched from the guard URL)
 *   shadow --point p|* --reason r            back to shadow at once (rollback)
 *   doctor                                   config, maps and envelope agree; loosening is possible; upstreams parse
 *
 * Flags: --dir <dir> (default ./cappz-constraints), --data <dir> (default <dir>/data),
 * CAPPZ_CONSTRAINTS_OPERATOR_KEY="pkcs8base64:pubhex" instead of <dir>/operator.key.
 */

import { importSigningKey, type SigningKey } from '../../../src/lib/sync/helloSignature.ts';
import { declareEnvelope, endorseEnvelope, lintEnvelope, looserThan, replayEnvelopes, revokeEnvelope, type EnvelopeBody, type EnvelopeRecord, type SignedEnvelope } from '../../../src/lib/constraints/envelope.ts';
import { signCommand, type PointValue } from '../../../src/lib/constraints/authority.ts';
import { replayPointModes, signPointMode, type PointModeRecord } from '../../../src/lib/constraints/guard.ts';
import { draftEnvelopeFromGraph, type GraphDraftMapping } from '../../../src/lib/constraints/adapters/graph.ts';
import { hostPort, readJsonl, type ConstraintsConfig } from '../constraintGuard.ts';
import { NUMBER_TEXT, trimChar } from '../../../src/lib/constraints/adapters/common.ts';

const USAGE = `constraint-wizard <step> [flags]      guide: docs/CONSTRAINT_GUARD.md

  Run with no step (or "next") to see what is in place and the one thing to do next.

Set up (once)
  keygen                                   make your operator key (each operator runs this once)
  init --envelope-id <id>                  write cappz-constraints/constraints.json trusting your key

Write the envelope
  draft-graph --vertices f --edges f --mapping f [--asset a]   draft an envelope from a device graph
  declare [--file envelope-draft.json]     sign the next envelope version (lists any loosening)
  endorse --hash <envelopeHash>            a second operator approves a loosening
  revoke --reason "…"                      revoke the active version (needs endorsements + cooling)

Check
  doctor                                   check config, maps and envelope agree
  status                                   active version, pending changes, history, point modes
  next                                     what is done, and the next step

Run the guard
  command --point p --value v [--unit u] [--ttl-min 5] [--reason r] [--arm http://guard:41452]
                                           sign a command (prints the HTTP header, or arms it at the guard)
  enforce --point p|* --report <guard url|report hash> --reason "…"   enforce on the shadow report
  shadow --point p|* --reason "…"          back to shadow at once (rollback)

  --dir <dir>   working directory (default ./cappz-constraints)     --data <dir>   (default <dir>/data)
  CAPPZ_CONSTRAINTS_OPERATOR_KEY="pkcs8base64:pubhex" signs instead of <dir>/operator.key`;

const args = Deno.args; const step = args[0]?.startsWith('--') && args[0] !== '--help' ? undefined : args[0];
const flag = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const dir = flag('dir', './cappz-constraints')!; const data = flag('data', `${dir}/data`)!;
const P = { key: `${dir}/operator.key`, config: `${dir}/constraints.json`, envelopes: `${data}/constraint-envelopes.jsonl`, modes: `${data}/constraint-modes.jsonl` };
const say = (s = '') => console.log(s);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const exists = (p: string) => Deno.stat(p).then(() => true, () => false);
const append = async (path: string, v: unknown) => { await Deno.mkdir(data, { recursive: true }); await Deno.writeTextFile(path, JSON.stringify(v) + '\n', { append: true }); };

async function operatorKey(): Promise<SigningKey> {
  const raw = Deno.env.get('CAPPZ_CONSTRAINTS_OPERATOR_KEY')?.trim() || await Deno.readTextFile(P.key).catch(() => ''); // empty means unset
  const [pkcs8, pub] = raw.trim().split(':');
  if (!pkcs8 || !pub) throw new Error('no operator key — run: constraint-wizard keygen (or set CAPPZ_CONSTRAINTS_OPERATOR_KEY)');
  return importSigningKey(pkcs8, pub);
}
async function readConfig(): Promise<ConstraintsConfig> { try { return JSON.parse(await Deno.readTextFile(P.config)); } catch { throw new Error(`no config at ${P.config} — run: constraint-wizard init`); } }

async function lineState(cfg: ConstraintsConfig) {
  const records = await readJsonl<EnvelopeRecord>(P.envelopes);
  const r = await replayEnvelopes(records, { trustedKeys: cfg.trustedOperators, minRelaxSigners: cfg.minRelaxSigners });
  const line = r.lines[cfg.envelopeId];
  const versions = records.filter((x): x is SignedEnvelope => x.kind === 'cappz.constraints.envelope' && x.envelopeId === cfg.envelopeId);
  const pendingHash = line?.pending?.envelopeHash;
  const head = (pendingHash ? versions.find((v) => v.envelopeHash === pendingHash) : undefined) ?? line?.active ?? null;
  return { line, head, refused: r.refused };
}

/** What is in place, in rollout order, and the one next step (the first thing missing). */
export async function progress(): Promise<{ checks: Array<{ done: boolean; what: string }>; next: string }> {
  const T = 'deno run -A packages/cappz-edge-node/tools/constraint-wizard.ts';
  const checks: Array<{ done: boolean; what: string; todo: string; later?: boolean }> = [];
  const add = (done: boolean, what: string, todo: string, later = false) => { checks.push({ done, what, todo, later }); return done; };
  const hasKey = !!Deno.env.get('CAPPZ_CONSTRAINTS_OPERATOR_KEY')?.trim() || await exists(P.key);
  add(hasKey, 'your operator key', `${T} keygen`);
  const cfg = await Deno.readTextFile(P.config).then((t) => JSON.parse(t) as ConstraintsConfig, () => null);
  if (add(!!cfg, `config ${P.config}`, `${T} init --envelope-id <site/device>`) && cfg) {
    const need = cfg.minRelaxSigners ?? 2;
    add((cfg.trustedOperators?.length ?? 0) >= need, `${need} trusted operators (loosening needs ${need})`, `ask a second operator to run keygen, then add their public key to trustedOperators in ${P.config}`, true);
    const { line } = await lineState(cfg).catch(() => ({ line: undefined }));
    const draft = await exists(flag('file', `${dir}/envelope-draft.json`)!);
    add(!!line?.active || draft, 'an envelope draft', `copy packages/cappz-sdk/examples/constraints/envelope-draft.json to ${dir}/envelope-draft.json and fill in your device's limits (or: cappz-market constraints-draft --file manual.txt)`);
    add(!!line?.active, 'an active envelope', `${T} declare`);
    const fronts = (['http', 'modbus', 'dnp3', 'iec104', 'mqtt', 'bacnet', 'gremlin'] as const).filter((f) => cfg[f]);
    add(fronts.length > 0, `a front for the controller's protocol${fronts.length ? ` (${fronts.join(', ')})` : ''}`, `add a front for the controller's protocol to ${P.config} (copy one from packages/cappz-sdk/examples/constraints/constraints.json), then ${T} doctor`);
    const ran = await exists(`${data}/constraint-verdicts.jsonl`);
    add(ran, 'the guard running in shadow (verdicts recorded)', `CAPPZ_CONSTRAINTS_CONFIG=${P.config} CAPPZ_NODE_DATA=${data} deno run -A --unstable-net packages/cappz-edge-node/main.ts   (then point the HMI or integration at the guard's port)`);
    const { modes } = await replayPointModes(await readJsonl<PointModeRecord>(P.modes), cfg.trustedOperators, cfg.envelopeId);
    const enforced = Object.values(modes).filter((m) => m.mode === 'enforce').length;
    add(enforced > 0, `points enforced${enforced ? ` (${enforced})` : ''}`, `read the report (curl http://<guard>:41452/cappz/constraints/report, or cappz-market constraints-review --guard http://<guard>:41452), move senders to signed commands, then ${T} enforce --point <id> --report http://<guard>:41452 --reason "…"`);
  }
  const first = checks.find((c) => !c.done && !c.later) ?? checks.find((c) => !c.done);
  return { checks: checks.map(({ done, what, later }) => ({ done, what: !done && later ? `${what} — needed before any loosening, not before declaring` : what })), next: first ? first.todo : 'all steps in place — keep reconciliation scheduled (skills/monitoring-constraints) and enforce the remaining points as their reports say ready' };
}

async function showProgress() {
  const p = await progress();
  say(`Where you are (${dir}):`);
  for (const c of p.checks) say(`  ${c.done ? '✓' : '·'} ${c.what}`);
  say(`\nNext: ${p.next}`);
}

const steps: Record<string, () => Promise<boolean | void>> = {
  async next() { await showProgress(); },
  async keygen() {
    await Deno.mkdir(dir, { recursive: true });
    if (await exists(P.key)) { say(`operator key already at ${P.key} (public: ${(await operatorKey()).publicKeyHex})`); return; }
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const pkcs8 = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))));
    const pub = hex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
    await Deno.writeTextFile(P.key, `${pkcs8}:${pub}\n`, { mode: 0o600, createNew: true });
    say(`operator key written to ${P.key} (mode 600). Public key: ${pub}`);
    say('Each operator keeps their own key. The guard host needs only the public keys (trustedOperators).');
  },
  async init() {
    const id = flag('envelope-id'); if (!id) throw new Error('init needs --envelope-id (one envelope line per asset)');
    if (await exists(P.config)) { say(`config already at ${P.config}`); return; }
    const pub = await operatorKey().then((k) => k.publicKeyHex).catch(() => null);
    const cfg: ConstraintsConfig = { envelopeId: id, trustedOperators: pub ? [pub] : [], minRelaxSigners: 2, host: '127.0.0.1', allowPrivileged: [], allowUnmapped: false, gate: { minWrites: 20, minDays: 7, minCleanWrites: 10 } };
    await Deno.mkdir(dir, { recursive: true }); await Deno.writeTextFile(P.config, JSON.stringify(cfg, null, 2) + '\n');
    say(`config written to ${P.config}. Add a second operator's public key (loosening needs ${cfg.minRelaxSigners} signers), then the fronts you need (http, modbus, dnp3, iec104, mqtt, bacnet, gremlin) with their maps, and run doctor.`);
  },
  async 'draft-graph'() {
    const read = async (n: string) => { const f = flag(n); if (!f) throw new Error(`draft-graph needs --${n}`); return JSON.parse(await Deno.readTextFile(f)); };
    const d = draftEnvelopeFromGraph({ vertices: await read('vertices'), edges: await read('edges') }, await read('mapping') as GraphDraftMapping);
    const out = flag('out', `${dir}/envelope-draft.json`)!;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(out, JSON.stringify({ asset: flag('asset', '<asset address>'), points: d.points, constraints: d.constraints }, null, 2) + '\n');
    say(`draft: ${d.points.length} point(s), ${d.constraints.length} constraint(s) → ${out}`);
    if (d.needs.length) { say('Still needed (nothing was invented):'); for (const n of d.needs) say(`  - ${n}`); }
    say('Add an authority constraint (who may command which setpoints) before declaring.');
  },
  async declare() {
    const cfg = await readConfig(); const key = await operatorKey();
    const file = flag('file', `${dir}/envelope-draft.json`)!;
    const draft = JSON.parse(await Deno.readTextFile(file)) as Partial<EnvelopeBody>;
    const problems = lintEnvelope({ points: draft.points ?? [], constraints: draft.constraints ?? [], modePoint: draft.modePoint });
    if (problems.length) { say('Not declared:'); for (const p of problems) say(`  - ${p}`); return false; }
    const { head } = await lineState(cfg);
    const env = await declareEnvelope({ envelopeId: cfg.envelopeId, asset: draft.asset ?? cfg.envelopeId, version: (head?.version ?? 0) + 1, supersedes: head?.envelopeHash ?? null, points: draft.points!, constraints: draft.constraints!, modePoint: draft.modePoint, advisory: draft.advisory, coolingMs: draft.coolingMs }, key);
    await append(P.envelopes, env);
    const base = (await lineState(cfg)).line?.active;
    const loosens = head ? looserThan(base && base.envelopeHash !== env.envelopeHash ? base : head, env) : [];
    say(`declared ${cfg.envelopeId} version ${env.version} (${env.envelopeHash})`);
    if (loosens.length) { say(`It LOOSENS ${loosens.length} thing(s); it needs ${cfg.minRelaxSigners ?? 2} operators (endorse --hash ${env.envelopeHash}) and then waits ${Math.round(env.coolingMs / 3600_000)} h:`); for (const l of loosens) say(`  - ${l}`); }
    else say('Tighter or equal: active now.');
  },
  async endorse() {
    const cfg = await readConfig(); const hash = flag('hash'); if (!hash) throw new Error('endorse needs --hash');
    const records = await readJsonl<EnvelopeRecord>(P.envelopes);
    const target = records.find((r): r is SignedEnvelope => r.kind === 'cappz.constraints.envelope' && r.envelopeHash === hash);
    if (!target) throw new Error(`no envelope ${hash} in ${P.envelopes}`);
    const { line } = await lineState(cfg);
    if (line?.active) { const l = looserThan(line.active, target); if (l.length) { say('You are endorsing these loosenings:'); for (const x of l) say(`  - ${x}`); } }
    await append(P.envelopes, await endorseEnvelope(target, await operatorKey()));
    say(`endorsed ${hash}`);
  },
  async revoke() {
    const cfg = await readConfig(); const reason = flag('reason'); if (!reason) throw new Error('revoke needs --reason');
    const { line } = await lineState(cfg); if (!line?.active) throw new Error('no active version to revoke');
    await append(P.envelopes, await revokeEnvelope(line.active, reason, await operatorKey()));
    say(`revocation of version ${line.active.version} recorded; it takes effect after ${cfg.minRelaxSigners ?? 2} operators and the cooling period`);
  },
  async status() {
    const cfg = await readConfig(); const { line, refused } = await lineState(cfg);
    say(`envelope ${cfg.envelopeId}: ${line?.active ? `version ${line.active.version} active (${line.active.envelopeHash.slice(0, 16)}…)` : 'none active'}`);
    if (line?.pending) say(`pending ${line.pending.state}: ${line.pending.loosens.join('; ')} — endorsed by ${line.pending.endorsedBy.length}/${line.pending.needs}${line.pending.activeFrom ? `, active from ${line.pending.activeFrom}` : ''}`);
    for (const h of line?.history ?? []) say(`  ${h.at}  v${h.version ?? '?'}  ${h.state}: ${h.because}`);
    for (const r of refused) say(`  refused: ${r.record}: ${r.because}`);
    const { modes, refused: mr } = await replayPointModes(await readJsonl<PointModeRecord>(P.modes), cfg.trustedOperators, cfg.envelopeId);
    for (const [p, r] of Object.entries(modes)) say(`  mode ${p}: ${r.mode} since ${r.at} (${r.reason}${r.reportHash ? `, report ${r.reportHash.slice(0, 12)}…` : ''})`);
    if (mr) say(`  ${mr} mode record(s) ignored`);
    say(`\nNext: ${(await progress()).next}`);
  },
  async command() {
    const cfg = await readConfig(); const point = flag('point'); const raw = flag('value');
    if (!point || raw === undefined) throw new Error('command needs --point and --value');
    const value: PointValue = NUMBER_TEXT.test(raw) ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : raw;
    const cmd = await signCommand({ envelopeId: cfg.envelopeId, point, value, unit: flag('unit'), reason: flag('reason'), ttlMs: Number(flag('ttl-min', '5')) * 60_000 }, await operatorKey());
    const header = btoa(JSON.stringify(cmd)).replace(/\+/g, '-').replace(/\//g, '_'); const header64 = trimChar(header, '=');
    const arm = flag('arm');
    if (arm) {
      const res = await fetch(new URL('/cappz/constraints/arm', arm), { method: 'POST', body: JSON.stringify(cmd), headers: { 'content-type': 'application/json' } });
      const body = await res.json(); say(`arm: ${res.status} ${body.state} — ${body.because}`); return res.ok;
    }
    say(JSON.stringify(cmd, null, 2)); say(`\nHTTP header:\nCappz-Command: ${header64}`);
  },
  async enforce() { return setMode('enforce'); },
  async shadow() { return setMode('shadow'); },
  async doctor() {
    const cfg = await readConfig(); let ok = true; const bad = (s: string) => { ok = false; say(`  ✗ ${s}`); }; const good = (s: string) => say(`  ✓ ${s}`);
    say(`doctor ${P.config}`);
    if (!cfg.trustedOperators?.length) bad('no trusted operators'); else good(`${cfg.trustedOperators.length} trusted operator(s)`);
    if ((cfg.trustedOperators?.length ?? 0) < (cfg.minRelaxSigners ?? 2)) bad(`loosening needs ${cfg.minRelaxSigners ?? 2} operators but only ${cfg.trustedOperators?.length ?? 0} are trusted: no envelope could ever be loosened`);
    const fronts = (['http', 'modbus', 'dnp3', 'iec104', 'mqtt', 'bacnet', 'gremlin'] as const).filter((f) => cfg[f]);
    if (!fronts.length) bad('no fronts configured'); else good(`fronts: ${fronts.join(', ')}`);
    for (const f of ['modbus', 'dnp3', 'iec104', 'mqtt', 'bacnet'] as const) if (cfg[f]) { try { hostPort(cfg[f]!.upstream); } catch (e) { bad(`${f}: ${(e as Error).message}`); } }
    const ports = fronts.map((f) => cfg[f]!.port); if (new Set(ports).size !== ports.length) bad(`two fronts share a port: ${ports.join(', ')}`);
    const { line } = await lineState(cfg); const env = line?.active;
    if (!env) { bad('no active envelope (declare one)'); return ok; }
    good(`envelope v${env.version} active`);
    const mapped = new Set<string>([
      ...(cfg.modbus?.map ?? []).map((m) => m.point), ...(cfg.dnp3?.map ?? []).map((m) => m.point), ...(cfg.iec104?.map ?? []).map((m) => m.point),
      ...(cfg.bacnet?.map ?? []).map((m) => m.point), ...(cfg.gremlin?.map ?? []).map((m) => m.point), ...Object.values(cfg.mqtt?.topics ?? {}).map((t) => t.point), ...Object.values(cfg.mqtt?.sparkplug?.map ?? {}),
      ...(cfg.http?.routes ?? []).flatMap((r) => (typeof r.point === 'string' ? [r.point] : Object.values(r.point.map))),
    ]);
    const declared = new Set(env.points.map((p) => p.id));
    for (const p of mapped) if (!declared.has(p)) bad(`a map names ${p}, which the envelope does not declare (writes to it will be refused as unmapped)`);
    for (const p of env.points.filter((x) => x.kind === 'setpoint' || x.kind === 'command')) if (!mapped.has(p.id)) say(`  ! setpoint ${p.id} is not reachable through any front (fine if it has no remote write path)`);
    const authed = new Set(env.constraints.flatMap((c) => (c.kind === 'authority' ? c.points : [])));
    for (const p of env.points.filter((x) => x.kind === 'setpoint' || x.kind === 'command')) if (!authed.has(p.id) && !authed.has('*')) bad(`setpoint ${p.id} has no authority constraint: any unsigned write inside its limits would pass`);
    if (env.advisory) bad('the active envelope is advisory: the guard will refuse every write it covers');
    say(ok ? 'doctor: ok' : 'doctor: problems found'); return ok;
  },
};

async function setMode(mode: 'shadow' | 'enforce') {
  const cfg = await readConfig(); const point = flag('point'); const reason = flag('reason');
  if (!point || !reason) throw new Error(`${mode} needs --point (or '*') and --reason`);
  let reportHash: string | null = null;
  if (mode === 'enforce') {
    const rep = flag('report'); if (!rep) throw new Error('enforce needs --report <guard url | report hash>');
    if (/^[0-9a-f]{64}$/.test(rep)) reportHash = rep;
    else {
      const r = await (await fetch(new URL('/cappz/constraints/report', rep))).json();
      const pts = point === '*' ? Object.entries(r.points) : [[point, r.points[point]]];
      for (const [p, s] of pts as Array<[string, { enforce: { ready: boolean; because: string[] } } | undefined]>) {
        if (!s) throw new Error(`the report has no point ${p}`);
        if (!s.enforce.ready) { say(`${p} is not ready to enforce:`); for (const b of s.enforce.because) say(`  - ${b}`); if (!args.includes('--anyway')) return false; }
      }
      reportHash = r.reportHash;
    }
  }
  const rec = await signPointMode({ envelopeId: cfg.envelopeId, point, mode, reason, reportHash }, await operatorKey());
  await append(P.modes, rec);
  say(`${point}: ${mode} recorded${reportHash ? ` on report ${reportHash.slice(0, 16)}…` : ''} (the guard picks it up within seconds)`);
}

if (import.meta.main) {
  if (step === undefined) { say(USAGE); say(''); await showProgress().catch(() => {}); Deno.exit(0); }
  const fn = steps[step];
  if (!fn) {
    if (step !== 'help' && step !== '--help') console.error(`constraint-wizard: no step "${step}"\n`);
    say(USAGE);
    Deno.exit(step === 'help' || step === '--help' || step === undefined ? 0 : 2);
  }
  try { const r = await fn(); Deno.exit(r === false ? 1 : 0); } catch (e) { console.error(`constraint-wizard ${step}: ${(e as Error).message}`); Deno.exit(1); }
}
