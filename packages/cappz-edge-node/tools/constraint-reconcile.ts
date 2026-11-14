/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-reconcile-tool
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Constraint reconciliation from files (src/lib/constraints/reconcile.ts):
 *
 *   deno run --allow-read --allow-write tools/constraint-reconcile.ts \
 *     --config ./cappz-constraints/constraints.json --data ./cappz-constraints/data \
 *     [--sealed data/constraint-observations.jsonl --collectors <hex,hex>] \
 *     [--observations historian.csv --mapping mapping.json] [--config-readback readback.csv --readback-mapping m.json] \
 *     [--commands data/constraint-verdicts.jsonl] [--from ISO --to ISO] [--out report.json]
 *
 * The envelope is the line's active version replayed from <data>/constraint-envelopes.jsonl
 * (or --envelope <signed envelope file>). Observations come from sealed batches (verified;
 * a broken chain is a finding), and/or historian exports by field mapping
 * (records.ts HistorianMapping; .json files may be arrays of rows). Commands come from the
 * guard's verdict log: every forwarded write with the signed command it carried, re-verified here.
 * Exit code: 0 clean, 1 findings, 2 gaps only.
 */

import { replayEnvelopes, verifyEnvelope, type EnvelopeRecord, type SignedEnvelope } from '../../../src/lib/constraints/envelope.ts';
import { reconcileConstraints, type CommandRecord, type IntegrityState, type Observation } from '../../../src/lib/constraints/reconcile.ts';
import { openSealedObservations, type SealedObservationBatch } from '../../../src/lib/constraints/seal.ts';
import { observationsFromCsv, observationsFromRecords, type HistorianMapping } from '../../../src/lib/constraints/adapters/records.ts';
import type { GuardVerdict } from '../../../src/lib/constraints/guard.ts';
import { readJsonl, type ConstraintsConfig } from '../constraintGuard.ts';

const args = Deno.args;
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

async function historian(file: string, mappingFile: string | undefined): Promise<Observation[]> {
  if (!mappingFile) throw new Error(`${file}: a --mapping file is needed`);
  const m = JSON.parse(await Deno.readTextFile(mappingFile)) as HistorianMapping;
  const text = await Deno.readTextFile(file);
  const r = file.endsWith('.json') ? observationsFromRecords(JSON.parse(text), m, file) : observationsFromCsv(text, m, file);
  if (r.unmapped.length) console.warn(`${file}: ${r.unmapped.length} unmapped tag(s): ${r.unmapped.slice(0, 10).join(', ')}`);
  if (r.skipped) console.warn(`${file}: ${r.skipped} row(s) skipped (no time or value)`);
  return r.observations;
}

export async function main(): Promise<number> {
  const cfgPath = flag('config'); const data = flag('data') ?? './cappz-constraints/data';
  let env: SignedEnvelope | null = null;
  const envFile = flag('envelope');
  if (envFile) { env = JSON.parse(await Deno.readTextFile(envFile)); const v = await verifyEnvelope(env!); if (v !== 'valid') throw new Error(`${envFile}: envelope ${v}`); }
  else {
    if (!cfgPath) throw new Error('--config (or --envelope) is required');
    const cfg = JSON.parse(await Deno.readTextFile(cfgPath)) as ConstraintsConfig;
    const { lines } = await replayEnvelopes(await readJsonl<EnvelopeRecord>(`${data}/constraint-envelopes.jsonl`), { trustedKeys: cfg.trustedOperators, minRelaxSigners: cfg.minRelaxSigners });
    env = lines[cfg.envelopeId]?.active ?? null;
    if (!env) throw new Error(`no active envelope for ${cfg.envelopeId}`);
  }
  const observations: Observation[] = []; let integrity: IntegrityState | undefined;
  const sealed = flag('sealed');
  if (sealed) {
    const collectors = (flag('collectors') ?? Deno.env.get('CAPPZ_NODE_PUB') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!collectors.length) throw new Error('--collectors <public key hex,…> is needed to verify sealed batches');
    const r = await openSealedObservations(await readJsonl<SealedObservationBatch>(sealed), collectors);
    integrity = r.integrity; observations.push(...r.observations);
  }
  const obsFile = flag('observations'); if (obsFile) observations.push(...await historian(obsFile, flag('mapping')));
  const readback = flag('config-readback'); const config = readback ? await historian(readback, flag('readback-mapping')) : [];
  const commands: CommandRecord[] = [];
  const verdicts = flag('commands');
  if (verdicts) for (const v of await readJsonl<GuardVerdict>(verdicts)) {
    if (!v.forward || v.kind !== 'write') continue;
    for (const w of v.writes) commands.push({ at: Date.parse(v.at), point: w.point, value: w.value, command: w.command ?? null, source: v.source });
  }
  const from = flag('from'); const to = flag('to');
  const report = await reconcileConstraints(env!, { observations, config, commands }, { integrity, period: { from: from ? Date.parse(from) : undefined, to: to ? Date.parse(to) : undefined } });
  const out = flag('out');
  if (out) await Deno.writeTextFile(out, JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.verdict.toUpperCase()}: ${report.summary}`);
  console.log(`integrity: ${report.integrity.state} — ${report.integrity.because}`);
  for (const f of report.findings.slice(0, 50)) console.log(`  ${f.at}  ${f.state.padEnd(20)} ${f.point}${f.constraintId ? ` [${f.constraintId}]` : ''}: ${f.because}`);
  if (report.findings.length > 50) console.log(`  … ${report.findings.length - 50} more in the report`);
  console.log(`report ${report.reportHash}`);
  return report.verdict === 'clean' ? 0 : report.verdict === 'findings' ? 1 : 2;
}

const USAGE = `constraint-reconcile --config <constraints.json> --data <dir> [sources] [--from ISO --to ISO] [--out report.json]
  sources (any combination):
    --observations <csv|json> --mapping <map.json>              historian export
    --config-readback <csv|json> --readback-mapping <map.json>  setpoints read back from the controller
    --sealed <constraint-observations.jsonl> --collectors <hex,…> the guard's sealed observations
    --commands <constraint-verdicts.jsonl>                      the guard's verdict log (re-verified)
  --envelope <file> uses a signed envelope file instead of --config/--data.
  Exit: 0 clean, 1 findings, 2 gaps only, 3 the check failed.   Guide: docs/CONSTRAINT_GUARD.md`;

if (import.meta.main && (args.length === 0 || args.includes('--help') || args[0] === 'help')) { console.log(USAGE); Deno.exit(0); }
if (import.meta.main) { try { Deno.exit(await main()); } catch (e) { console.error(`constraint-reconcile: ${(e as Error).message}`); Deno.exit(3); } }
