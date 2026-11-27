// @vitest-environment node
// The edge node's sealed-store rules (packages/cappz-edge-node/agents/sealed.ts, 16.5.0): inputs, paid periods,
// renewals, grace and expiry, capacity, and which writes and purges a box accepts. The routes run end to end
// under Deno in agents/sealed_server_test.ts.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import { recordId, replayBox, sha256Hex, signPurge, signWrite } from '../lib/sealed/sealedStore';
import { GB, boxProblem, purgeProblem, replayBoxes, reservedBytes, sealedInputProblem, writeProblem, type SealedJob } from '../../packages/cappz-edge-node/agents/sealed';

const S = { days: 30, graceDays: 7, maxGb: 50, maxBoxGb: 50, maxObjectBytes: 256 * 1024 ** 2, maxWriters: 20 };
const DAY = 86_400_000;
const T0 = Date.parse('2026-12-01T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const ann = keyPairFromPhrase(generateRecoveryPhrase()), bob = keyPairFromPhrase(generateRecoveryPhrase());
const open = (jobId: string, gb: number, paidAt: number | null, openedAt = T0): SealedJob => ({ jobId, input: { gb, writers: [ann.address] }, openedAt: iso(openedAt), paidAt: paidAt === null ? null : iso(paidAt), cancelled: false });
const renew = (jobId: string, renews: string, paidAt: number | null, gb?: number): SealedJob => ({ jobId, input: { renews, ...(gb ? { gb } : {}) }, openedAt: iso(T0), paidAt: paidAt === null ? null : iso(paidAt), cancelled: false });
const A = 'job-aaaaaaaaaaaaaaaa', B = 'job-bbbbbbbbbbbbbbbb', C = 'job-cccccccccccccccc', D = 'job-dddddddddddddddd';

describe('sealed store: inputs', () => {
  it('opens with whole gigabytes and 1-20 distinct wallet writers; renews by box id', () => {
    expect(sealedInputProblem({ gb: 1, writers: [ann.address] }, S)).toBeNull();
    expect(sealedInputProblem({ gb: 1, writers: [ann.address.toUpperCase()] }, S)).toBeNull();
    expect(sealedInputProblem({ renews: A }, S)).toBeNull();
    expect(sealedInputProblem({ renews: A, gb: 5 }, S)).toBeNull();
    expect(sealedInputProblem({ gb: 0.5, writers: [ann.address] }, S)).toMatch(/whole number/);
    expect(sealedInputProblem({ gb: 51, writers: [ann.address] }, S)).toMatch(/from 1 to 50/);
    expect(sealedInputProblem({ gb: 1, writers: [] }, S)).toMatch(/1 to 20/);
    expect(sealedInputProblem({ gb: 1, writers: ['rAddress'] }, S)).toMatch(/66 hex/);
    expect(sealedInputProblem({ gb: 1, writers: [ann.address, ann.address] }, S)).toMatch(/twice/);
    expect(sealedInputProblem({ gb: 1, writers: [ann.address], extra: 1 }, S)).toMatch(/only gb, writers and label/);
    expect(sealedInputProblem({ renews: '../x' }, S)).toMatch(/box id/);
    expect(sealedInputProblem(null, S)).toMatch(/Send/);
  });
});

describe('sealed store: periods', () => {
  it('a box is active for its paid period, read-only through the grace, then expired', () => {
    const jobs = [open(A, 2, T0)];
    expect(replayBoxes(jobs, T0 + DAY, S).boxes.get(A)!.state).toBe('active');
    expect(replayBoxes(jobs, T0 + 31 * DAY, S).boxes.get(A)!.state).toBe('grace');
    expect(replayBoxes(jobs, T0 + 38 * DAY, S).boxes.get(A)!.state).toBe('expired');
    expect(replayBoxes([open(A, 2, null)], T0, S).boxes.get(A)!.state).toBe('unpaid');
  });

  it('a renewal starts when the current period ends (or at payment, if later) and may change the quota', () => {
    const early = replayBoxes([open(A, 2, T0), renew(B, A, T0 + 10 * DAY, 5)], T0 + 40 * DAY, S).boxes.get(A)!;
    expect(early.periods.map((p) => [p.jobId, (p.start - T0) / DAY, (p.end - T0) / DAY, p.gb])).toEqual([[A, 0, 30, 2], [B, 30, 60, 5]]);
    expect(early.state).toBe('active');
    expect(early.quotaBytes).toBe(5 * GB);
    const inGrace = replayBoxes([open(A, 2, T0), renew(B, A, T0 + 33 * DAY)], T0 + 40 * DAY, S).boxes.get(A)!;
    expect(inGrace.periods.map((p) => (p.start - T0) / DAY)).toEqual([0, 33]);
    expect(inGrace.quotaBytes).toBe(2 * GB);
  });

  it('a renewal paid after the grace never revives the box: it is an orphan (refund by hand)', () => {
    const r = replayBoxes([open(A, 2, T0), renew(B, A, T0 + 38 * DAY)], T0 + 40 * DAY, S);
    expect(r.orphans.map((o) => o.jobId)).toEqual([B]);
    expect(r.boxes.get(A)!.state).toBe('expired');
    expect(replayBoxes([renew(C, 'job-9999999999999999', T0)], T0, S).orphans.map((o) => o.jobId)).toEqual([C]);
  });
});

describe('sealed store: capacity', () => {
  it('counts paid active and grace boxes only: expired boxes and unpaid openings reserve nothing (16.5.1)', () => {
    const now = T0 + 31 * DAY;
    const jobs = [open(A, 10, T0), open(B, 20, T0 - 40 * DAY), open(C, 5, null, now - 60_000), open(D, 50, null, now - 1_000)];
    const { boxes } = replayBoxes(jobs, now, S);
    expect(reservedBytes(boxes)).toBe(10 * GB); // A in grace; B expired; C and D unpaid (D alone asked for all 50 GB)
    expect(boxProblem({ gb: 40, writers: [ann.address] }, boxes, S, () => 0)).toBeNull();
    expect(boxProblem({ gb: 41, writers: [ann.address] }, boxes, S, () => 0)).toMatch(/40\.0 GB left/);
    expect(boxProblem({ renews: A, gb: 50 }, boxes, S, () => 0)).toBeNull();
    expect(boxProblem({ renews: A, gb: 1 }, boxes, S, () => 3 * GB)).toMatch(/already holds/);
    expect(boxProblem({ renews: B }, boxes, S, () => 0)).toMatch(/past its grace/);
    expect(boxProblem({ renews: C }, boxes, S, () => 0)).toMatch(/not been paid/);
  });
});

describe('sealed store: writes and purges a box accepts', () => {
  const jobs = [{ ...open(A, 1, T0), input: { gb: 1, writers: [ann.address, bob.address] } }];
  const now = T0 + DAY;
  const box = replayBoxes(jobs, now, S).boxes.get(A)!;
  const bytes = new TextEncoder().encode('cw2.sealed');

  it('checks signature, writer, clock, size, hash, version chain, object size and quota', async () => {
    const empty = await replayBox(A, box.writers, []);
    const w = await signWrite(ann.privateKey, ann.address, { boxId: A, objectId: 'f', parent: null, bytes }, now);
    const ok = { length: bytes.length, sha256: sha256Hex(bytes) };
    expect(await writeProblem(w, ok, box, empty, now, S, 600_000)).toBeNull();
    expect((await writeProblem(w, ok, box, empty, now + 11 * 60_000, S, 600_000))?.code).toBe(422);
    expect((await writeProblem(w, { ...ok, length: 1 }, box, empty, now, S, 600_000))?.error).toMatch(/1 arrived/);
    expect((await writeProblem(w, { ...ok, sha256: '0'.repeat(64) }, box, empty, now, S, 600_000))?.error).toMatch(/SHA-256/);
    expect((await writeProblem(w, ok, box, empty, now, { maxObjectBytes: 4 }, 600_000))?.code).toBe(413);
    const after = await replayBox(A, box.writers, [w]);
    const fork = await signWrite(bob.privateKey, bob.address, { boxId: A, objectId: 'f', parent: null, bytes }, now);
    expect((await writeProblem(fork, ok, box, after, now, S, 600_000))?.code).toBe(409);
    const next = await signWrite(bob.privateKey, bob.address, { boxId: A, objectId: 'f', parent: recordId(w), bytes }, now);
    expect(await writeProblem(next, ok, box, after, now, S, 600_000)).toBeNull();
    expect((await writeProblem(next, ok, { ...box, quotaBytes: bytes.length }, after, now, S, 600_000))?.code).toBe(507);
    const outsider = keyPairFromPhrase(generateRecoveryPhrase());
    expect((await writeProblem(await signWrite(outsider.privateKey, outsider.address, { boxId: A, objectId: 'g', parent: null, bytes }, now), ok, box, empty, now, S, 600_000))?.code).toBe(403);
    expect((await writeProblem(w, ok, { ...box, state: 'grace' }, empty, now, S, 600_000))?.code).toBe(410);
    expect((await writeProblem(w, ok, { ...box, state: 'unpaid' }, empty, now, S, 600_000))?.code).toBe(402);
    expect((await writeProblem(w, ok, undefined, empty, now, S, 600_000))?.code).toBe(404);
  });

  it('a purge frees a live version by a writer, also during the grace', async () => {
    const w = await signWrite(ann.privateKey, ann.address, { boxId: A, objectId: 'f', parent: null, bytes }, now);
    const st = await replayBox(A, box.writers, [w]);
    const p = await signPurge(bob.privateKey, bob.address, { boxId: A, writeId: recordId(w) }, now);
    expect(await purgeProblem(p, box, st, now, 600_000)).toBeNull();
    expect(await purgeProblem(p, { ...box, state: 'grace' }, st, now, 600_000)).toBeNull();
    expect((await purgeProblem(p, { ...box, state: 'expired' }, st, now, 600_000))?.code).toBe(410);
    const done = await replayBox(A, box.writers, [w, p]);
    expect((await purgeProblem(await signPurge(ann.privateKey, ann.address, { boxId: A, writeId: recordId(w) }, now), box, done, now, 600_000))?.code).toBe(409);
    expect((await purgeProblem(await signPurge(ann.privateKey, ann.address, { boxId: A, writeId: 'f'.repeat(64) }, now), box, st, now, 600_000))?.code).toBe(404);
  });
});

describe('sealed store: launcher and settings', () => {
  const dir = resolve(__dirname, '../../packages/cappz-edge-node/agents');
  it('grants the agents read and write on the store drive, and the env examples name it with a cap', () => {
    const ps = readFileSync(join(dir, 'run-agents.ps1'), 'utf8');
    expect(ps).toContain('$sealed = $env:CAPPZ_SEALED_STORE_DIR');
    expect(ps).toMatch(/--allow-read=[^ ]*\$sealedGrant --allow-write=`"\$data`"\$sealedGrant/);
    for (const [f, cap] of [['agents.env.example', '1024'], ['agents-testnet.env.example', '1']]) {
      const env = readFileSync(join(dir, f), 'utf8');
      expect(env, f).toMatch(/^CAPPZ_SEALED_STORE_DIR=/m);
      expect(env, f).toContain(`CAPPZ_SEALED_MAX_GB=${cap}`);
    }
    const server = readFileSync(join(dir, 'server.ts'), 'utf8');
    expect(server).toContain("const SEALED_MAX_GB = Number(env('CAPPZ_SEALED_MAX_GB', '50'));");
    expect(server).toContain("storeDir: env('CAPPZ_SEALED_STORE_DIR', `${DATA}/sealed-store`)!");
    // A missing store drive (an unplugged USB disk) turns only the sealed store off.
    expect(server).toContain("if (url.pathname.startsWith('/agents/sealed-store/') && !sealed) return json(503,");
    expect(ps).toMatch(/try \{ New-Item -ItemType Directory -Force \$sealed -ErrorAction Stop/);
  });
});
