/** The Constraint Guard's guide, skills and example files stay true to the code. */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { declareEnvelope, lintEnvelope, type EnvelopeBody, type SignedEnvelope } from '../lib/constraints/envelope';
import { AUTHORIZATION_STATES } from '../lib/constraints/authority';
import { GUARD_REFUSAL_REASONS } from '../lib/constraints/guard';
import { observationsFromCsv, type HistorianMapping } from '../lib/constraints/adapters/records';
import { reconcileConstraints } from '../lib/constraints/reconcile';
import { generateSigningKey } from '../lib/sync/helloSignature';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const EX = 'packages/cappz-sdk/examples/constraints';
const json = <T,>(f: string) => JSON.parse(read(`${EX}/${f}`)) as T;
const GUIDE = 'docs/CONSTRAINT_GUARD.md';
const SKILLS = ['skills/securing-control-systems/SKILL.md', 'skills/monitoring-constraints/SKILL.md'];
const TUTORIAL = 'docs/tutorials/constraint-guard.html';

describe('15.40.0 Constraint Guard docs and examples', () => {
  const draft = json<EnvelopeBody & { asset: string }>('envelope-draft.json');
  let env: SignedEnvelope;
  beforeAll(async () => {
    const key = await generateSigningKey();
    const filled = JSON.parse(JSON.stringify(draft).replace('REPLACE-with-the-technician-public-key-hex', key.publicKeyHex));
    env = await declareEnvelope({ envelopeId: 'site-17/oven-3', version: 1, supersedes: null, declaredAt: '2026-11-01T00:00:00Z', ...filled }, key);
  });

  it('the example envelope refuses its placeholder key and lints clean once it is replaced', () => {
    expect(lintEnvelope(draft).join()).toMatch(/not a 64-hex Ed25519 public key.*replace the placeholder/);
    expect(lintEnvelope(env)).toEqual([]);
  });

  it('the example config maps only declared points, every setpoint has an authority, upstreams are host:port', () => {
    const cfg = json<Record<string, any>>('constraints.json');
    const declared = new Set(draft.points.map((p) => p.id));
    const mapped = [...cfg.modbus.map.map((m: { point: string }) => m.point), ...Object.values(cfg.mqtt.topics).map((t: any) => t.point), ...cfg.http.routes.flatMap((r: any) => (typeof r.point === 'string' ? [r.point] : Object.values(r.point.map)))];
    for (const p of mapped) expect(declared.has(p), p).toBe(true);
    for (const f of ['modbus', 'mqtt']) expect(cfg[f].upstream).toMatch(/^[^:\s]+:\d{1,5}$/);
    const authed = new Set(draft.constraints.flatMap((c) => (c.kind === 'authority' ? c.points : [])));
    for (const p of draft.points.filter((x) => x.kind === 'setpoint')) expect(authed.has(p.id), p.id).toBe(true);
    expect(cfg.envelopeId).toBe('site-17/oven-3');
  });

  it('the quick start gives the results the guide shows: clean, then an orphan change and two breaches', async () => {
    const obs = observationsFromCsv(read(`${EX}/historian.csv`), json<HistorianMapping>('historian-map.json'));
    expect(obs.unmapped).toEqual([]); expect(obs.skipped).toBe(0);
    const rb = json<HistorianMapping>('readback-map.json');
    const clean = await reconcileConstraints(env, { observations: obs.observations, config: observationsFromCsv(read(`${EX}/setpoints.csv`), rb).observations });
    expect(clean.verdict).toBe('clean');
    expect(read(GUIDE)).toContain(`CLEAN: ${clean.summary}`);
    const bad = await reconcileConstraints(env, { observations: obs.observations, config: observationsFromCsv(read(`${EX}/setpoints-tampered.csv`), rb).observations });
    expect(bad.verdict).toBe('findings');
    expect(bad.counts).toMatchObject({ 'orphan-change': 1, 'out-of-envelope': 2 });
    for (const f of bad.findings.filter((x) => x.state !== 'not-evaluated')) expect(read(GUIDE)).toContain(f.because);
  });

  it('the refusal table explains every reason the guard can give', () => {
    const table = read(GUIDE).split('## Refusal reasons and what to do')[1].split('\n## ')[0];
    for (const r of [...AUTHORIZATION_STATES.filter((s) => s !== 'authorized'), ...GUARD_REFUSAL_REASONS]) expect(table, r).toContain(`\`${r}\``);
  });

  it('every tool flag and wizard step the guide and skills mention exists in the tools', () => {
    const wizard = read('packages/cappz-edge-node/tools/constraint-wizard.ts');
    const recon = read('packages/cappz-edge-node/tools/constraint-reconcile.ts');
    const steps = new Set([...wizard.matchAll(/^ {2}(?:async )?'?([a-z-]+)'?\(\) \{/gm)].map((m) => m[1]));
    for (const s of ['keygen', 'init', 'draft-graph', 'declare', 'endorse', 'revoke', 'status', 'command', 'enforce', 'shadow', 'doctor', 'next']) expect(steps.has(s), s).toBe(true);
    const market = read('packages/cappz-market/commands.ts');
    const marketHas = (cmd: string, flag: string) => { const i = market.indexOf(`name: '${cmd}'`); if (i < 0) return false; const end = market.indexOf("\n  {\n    name: '", i + 1); return market.slice(i, end < 0 ? undefined : end).includes(`name: '${flag}'`); };
    for (const doc of [GUIDE, ...SKILLS, TUTORIAL]) {
      for (const line of read(doc).split('\n')) {
        // each command segment runs from a tool name to the next one
        const parts = line.split(/(?=constraint-wizard|constraint-reconcile|cappz-market )/);
        for (const seg of parts) {
          const tool = seg.startsWith('constraint-wizard') ? 'wizard' : seg.startsWith('constraint-reconcile') ? 'recon' : seg.startsWith('cappz-market ') ? 'market' : null;
          if (!tool) continue;
          const src = tool === 'wizard' ? wizard : recon;
          const mcmd = tool === 'market' ? /^cappz-market ([a-z-]+)/.exec(seg)?.[1] ?? '' : '';
          for (const m of seg.matchAll(/--([a-z][a-z-]+)/g)) {
            if (['allow-read', 'allow-write', 'unstable-net', 'help'].includes(m[1])) continue;
            const ok = tool === 'market' ? marketHas(mcmd, m[1]) : src.includes(`flag('${m[1]}'`) || src.includes(`read('${m[1]}')`) || src.includes(`'--${m[1]}'`);
            expect(ok, `${doc}: ${tool === 'market' ? `cappz-market ${mcmd}` : tool} --${m[1]}`).toBe(true);
          }
          const step = tool === 'wizard' ? /^constraint-wizard(?:\.ts)? ([a-z-]+)/.exec(seg)?.[1] : undefined;
          if (step && step !== 'help') expect(steps.has(step), `${doc}: step ${step}`).toBe(true);
          if (tool === 'market' && mcmd.startsWith('constraints-')) expect(market.includes(`name: '${mcmd}'`), `${doc}: cappz-market ${mcmd}`).toBe(true);
        }
      }
    }
  });

  it('every relative link, and every link into this repo on GitHub, resolves to a file here', () => {
    const local = (u: string) => /^https:\/\/(?:github\.com\/CAPPZ-ai\/cappz-sdk\/(?:blob|tree)\/main|raw\.githubusercontent\.com\/CAPPZ-ai\/cappz-sdk\/main)\/([^)#\s"'`]+)/.exec(u)?.[1];
    for (const doc of [GUIDE, ...SKILLS, TUTORIAL, 'skills/README.md', 'README.md', 'llms.txt', 'skills/index.json']) {
      const text = read(doc);
      for (const m of text.matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)(?:#[^)]*)?\)/g)) expect(existsSync(resolve(ROOT, dirname(doc), m[1])), `${doc} → ${m[1]}`).toBe(true);
      for (const m of text.matchAll(/https:\/\/(?:github\.com|raw\.githubusercontent\.com)\/CAPPZ-ai\/cappz-sdk\/[^)\s"'`<]+/g)) {
        const p = local(m[0]); if (p) expect(existsSync(resolve(ROOT, p.replace(/[.,]$/, ''))), `${doc} → ${m[0]}`).toBe(true);
      }
    }
  });

  it('the tutorial shows the guide\'s outputs and the guard\'s own refusal reasons, so it cannot drift from the code', () => {
    const tut = read(TUTORIAL); const guide = read(GUIDE); const authority = read('src/lib/constraints/authority.ts');
    for (const reason of ['this point needs a signed command and the write carried none', 'this command was already used for a write', 'signed by a granted key']) {
      expect(tut).toContain(reason); expect(authority).toContain(reason);
    }
    for (const line of ['orphan-change', '200 → 400 Cel with no authorised command in the 10 min before it', 'a setpoint step of 200 Cel exceeds 20 Cel', '1 change(s) without an authorised command, 0 unauthorised command(s), 2 envelope breach(es)']) {
      expect(tut).toContain(line); expect(guide).toContain(line);
    }
    // the envelope card shows the example envelope's own numbers
    for (const n of ['160–250 °C', 'at most 20 °C', '150–260 °C', 'within 6 °C', '04:00–20:00']) expect(tut).toContain(n);
    expect(draft.constraints.find((c) => c.id === 'setpoint-range')).toMatchObject({ min: 160, max: 250 });
    expect(draft.constraints.find((c) => c.id === 'setpoint-step')).toMatchObject({ maxStep: 20 });
    expect(draft.constraints.find((c) => c.id === 'probes-agree')).toMatchObject({ tolerance: 6 });
    // every scene has a link of its own, and the guide links the tutorial and its diagram
    for (const id of ['attack', 'envelope', 'detect', 'shadow', 'signed', 'enforce', 'refused']) expect(tut).toContain(`id: '${id}'`);
    expect(guide).toContain('](tutorials/constraint-guard.html)'); expect(guide).toContain('](images/constraint-guard.svg)');
  });
});
