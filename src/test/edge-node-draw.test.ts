// @vitest-environment node
// Fair draw (15.47.0): the edge node's draw agent (packages/cappz-edge-node/agents/draw.ts), the
// paid-agent kit's free completion after a prepaid stage, and verify.mjs agreeing with draw.ts.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  drawInputProblem, drawPicks, drawSeed, effectiveDrawAt, entriesFromText, entriesHash, findSeedLedger,
  type DrawLedgerReader, type LedgerHeader,
} from '../../packages/cappz-edge-node/agents/draw';
import { createPaidAgent, defineAgentOffer, isFreeCompletion, offerProblems, type LedgerReader } from '../lib/agentKit/paidAgent';
import { signEdgeTx } from '../lib/functions/edgeJobs';

const dir = resolve(__dirname, '../../packages/cappz-edge-node/agents');
const PAY_TO = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';

describe('fair draw: the rule', () => {
  it('fingerprints the list as given; a text list is one trimmed entry per line', async () => {
    expect(entriesFromText(' ann \r\nbob\n\n  \ncy\n')).toEqual(['ann', 'bob', 'cy']);
    const h = await entriesHash(['ann', 'bob', 'cy']);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await entriesHash(['bob', 'ann', 'cy'])).not.toBe(h); // order is part of the list
  });

  it('picks distinct, in-range indices, the same every time for the same ledger and list', async () => {
    const seed = await drawSeed('AB'.repeat(32), 'cd'.repeat(32), 1000, 25);
    const picks = await drawPicks(seed, 1000, 25);
    expect(picks).toHaveLength(25);
    expect(new Set(picks).size).toBe(25);
    expect(picks.every((i) => Number.isInteger(i) && i >= 0 && i < 1000)).toBe(true);
    expect(await drawPicks(seed, 1000, 25)).toEqual(picks);
    expect(await drawPicks(await drawSeed('AC'.repeat(32), 'cd'.repeat(32), 1000, 25), 1000, 25)).not.toEqual(picks);
    // The seed ignores case in the ledger hash, and every ticket can win when all are drawn.
    expect(await drawSeed('ab'.repeat(32), 'CD'.repeat(32), 1000, 25)).toBe(seed);
    expect((await drawPicks(seed, 7, 7)).sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    await expect(drawPicks(seed, 3, 4)).rejects.toThrow();
  });

  it('is unbiased enough to notice: over many seeds each of 5 entries wins about a fifth of the time', async () => {
    const wins = [0, 0, 0, 0, 0];
    for (let n = 0; n < 2000; n++) wins[(await drawPicks(await drawSeed(n.toString(16).padStart(64, '0'), 'ee'.repeat(32), 5, 1), 5, 1))[0]]++;
    for (const w of wins) expect(w).toBeGreaterThan(330); // expected 400; 330 is about 3.9 standard deviations below
  });

  it('finds the first validated ledger closed at or after the draw time', async () => {
    // Ledgers 100…400, one every 4 s from t0; two share a close time (close times are rounded on the ledger).
    const t0 = Date.parse('2026-12-01T20:00:00Z');
    const close = (i: number) => new Date(t0 + (i === 251 ? 250 : i) * 4000 - 400 * 1000).toISOString();
    const header = (i: number): LedgerHeader => ({ index: i, hash: i.toString(16).toUpperCase().padStart(64, '0'), closeTime: close(i) });
    let top = 400; let reads = 0;
    const reader: DrawLedgerReader = { validated: async () => header(top), byIndex: async (i) => { reads++; if (i < 100 || i > top) throw new Error('out of range'); return header(i); } };
    const drawAt = new Date(t0 + 250 * 4000 - 400 * 1000 - 1000).toISOString(); // a second before ledger 250 closes
    const found = await findSeedLedger(reader, drawAt, 120);
    expect(found?.seed.index).toBe(250);
    expect(found?.previous.index).toBe(249);
    expect(reads).toBeLessThan(15);
    // Exactly at a close time counts as "at or after"; with ledger 251 sharing 250's close time, 250 is still first.
    expect((await findSeedLedger(reader, close(250), 120))?.seed.index).toBe(250);
    top = 240; expect(await findSeedLedger(reader, drawAt, 120)).toBeNull(); // not reached yet
    top = 400; await expect(findSeedLedger(reader, close(110), 120)).rejects.toThrow(/not before the draw time/);
  });

  it('refuses bad requests in plain words and never draws sooner than the minimum lead', () => {
    const now = Date.parse('2026-12-01T00:00:00Z');
    const p = (x: unknown) => drawInputProblem(x, now, 30);
    expect(p({ entries: ['a', 'b'], winners: 1 })).toBeNull();
    expect(p({ entriesSha256: 'a'.repeat(64), count: 50_000, winners: 3, drawAt: '2026-12-02T20:00:00Z', label: 'x', public: true })).toBeNull();
    expect(p({ entries: ['a'], entriesSha256: 'a'.repeat(64), count: 1 })).toMatch(/either/);
    expect(p({ entries: [] })).toMatch(/1 to 10000/);
    expect(p({ entries: ['a', ''] })).toMatch(/1 to 200 characters/);
    expect(p({ entries: ['a'], winners: 2 })).toMatch(/from 1 to 1/);
    expect(p({ entriesSha256: 'zz', count: 2 })).toMatch(/SHA-256/);
    expect(p({ entriesSha256: 'a'.repeat(64) })).toMatch(/count/);
    expect(p({ entries: ['a'], drawAt: 'tomorrow' })).toMatch(/ISO/);
    expect(p({ entries: ['a'], drawAt: '2027-02-01T00:00:00Z' })).toMatch(/30 days/);
    expect(p(['a'])).toMatch(/object/);
    expect(effectiveDrawAt(undefined, now, 120_000)).toBe('2026-12-01T00:02:00.000Z');
    expect(effectiveDrawAt('2026-11-30T00:00:00Z', now, 120_000)).toBe('2026-12-01T00:02:00.000Z');
    expect(effectiveDrawAt('2026-12-05T20:00:00Z', now, 120_000)).toBe('2026-12-05T20:00:00.000Z');
  });
});

describe('paid-agent kit: a free completion after a prepaid stage (15.47.0)', () => {
  const stages = [
    { label: 'Pay', kind: 'upfront' as const, share: 1 },
    { label: 'Result', kind: 'completion' as const, share: 0 },
  ];

  it('is a valid offer only as the last stage after upfront stages that carry the whole price', () => {
    expect(offerProblems({ name: 'x', description: '', payTo: PAY_TO, network: 'testnet', currency: 'XRP', price: 0.1, stages })).toEqual([]);
    expect(isFreeCompletion(stages, 1)).toBe(true);
    expect(offerProblems({ name: 'x', description: '', payTo: PAY_TO, network: 'testnet', currency: 'XRP', price: 0.1, stages: [{ label: 'Work', kind: 'milestone', share: 1 }, { label: 'Result', kind: 'completion', share: 0 }] }).join(' ')).toMatch(/share above 0%/);
    expect(offerProblems({ name: 'x', description: '', payTo: PAY_TO, network: 'testnet', currency: 'XRP', price: 0.1, stages: [{ label: 'Result', kind: 'completion', share: 0 }] }).length).toBeGreaterThan(0);
  });

  it('releases the result once delivered, with nothing more to pay', async () => {
    let paid = false;
    const ledger: LedgerReader = {
      incoming: async () => [],
      tx: async (network, hash) => ({ hash, network, validated: paid, result: 'tesSUCCESS', ledgerIndex: 5, type: 'Payment', account: 'rBuyer', destination: PAY_TO, deliveredDrops: '100000', deliveredIssued: null, destinationTag: tag, fields: {}, memos: [], closeTime: null, checkedAt: new Date().toISOString() }),
    };
    let tag = 0;
    const agent = createPaidAgent({ offer: defineAgentOffer({ name: 'x', description: '', payTo: PAY_TO, network: 'testnet', currency: 'XRP', price: 0.1, stages }), ledger, work: async () => ({ done: true }) });
    const opened = await agent.openJob({});
    expect(opened.job.state).toBe('awaiting-payment');
    expect(opened.pay?.amount).toBe('0.1');
    tag = opened.pay!.destinationTag;
    paid = true;
    const check = await agent.claimPayment(opened.job.jobId, 'AB'.repeat(32));
    expect(check.state).toBe('paid');
    const after = await agent.work(opened.job.jobId);
    expect(after?.state).toBe('completed');
    expect(after?.stages[1]).toMatchObject({ amount: '0', state: 'released' });
    const r = await agent.result(opened.job.jobId, 1);
    expect(r.state).toBe('released');
    expect((await agent.job(opened.job.jobId))?.pay).toBeNull();
  });
});

describe('fair draw: verify.mjs agrees with draw.ts', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cappz-draw-'));
  const run = (doc: unknown, ...args: string[]) => {
    const file = join(tmp, `${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(doc));
    const r = spawnSync(process.execPath, [join(dir, 'docs', 'verify.mjs'), file, ...args], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const signedDraw = async (entries: string[], winners: number) => {
    const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const key = { privateKey: k.privateKey, publicKeyHex: Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey)), (b) => b.toString(16).padStart(2, '0')).join('') };
    const entriesSha256 = await entriesHash(entries);
    const base = { sourceAddress: 'rNode', targetAddress: 'rNode/draws/job-1', eventType: '' };
    const commitment = await signEdgeTx({ ...base, txId: 'DrawCommitted-1', timestamp: '2026-12-01T19:58:00.000Z', eventType: 'DrawCommitted', payload: { jobId: 'job-0000000000000001', rule: 'cappz-draw/v1', label: 'test', entriesSha256, count: entries.length, winners, drawAt: '2026-12-01T20:00:00.000Z', afterLedger: { index: 1000, hash: 'AA'.repeat(32), closeTime: '2026-12-01T19:57:58.000Z' }, seq: 0, previousCommitment: null, network: 'mainnet', governingPrinciple: 't' } }, key);
    const seedLedger = { index: 1040, hash: 'BC'.repeat(32), closeTime: '2026-12-01T20:00:01.000Z' };
    const seed = await drawSeed(seedLedger.hash, entriesSha256, entries.length, winners);
    const picks = await drawPicks(seed, entries.length, winners);
    const draw = await signEdgeTx({ ...base, txId: 'DrawPerformed-1', timestamp: '2026-12-01T20:00:10.000Z', eventType: 'DrawPerformed', payload: { jobId: 'job-0000000000000001', rule: 'cappz-draw/v1', commitment: commitment.txHash, label: 'test', entriesSha256, count: entries.length, winners, drawAt: '2026-12-01T20:00:00.000Z', seedLedger, previousLedger: { index: 1039, closeTime: '2026-12-01T19:59:58.000Z' }, seed, picks, picked: picks.map((i) => entries[i]), network: 'mainnet', governingPrinciple: 't' } }, key);
    return { draw, commitment, entries, key, picks };
  };

  it('recomputes the winners, and fails an edited pick, list or commitment', async () => {
    const entries = Array.from({ length: 40 }, (_, i) => `entry ${i}`);
    const { draw, commitment, picks } = await signedDraw(entries, 3);
    const ok = run({ draw, commitment, entries }, '--offline');
    expect(ok.out).toContain(`winners recomputed: ${picks.join(', ')}`);
    expect(ok.out).toContain('NOT checked against the XRP Ledger (--offline)');
    expect(ok.code).toBe(0);
    expect(run({ draw, commitment, entries: [...entries].reverse() }, '--offline').code).toBe(1);
    expect(run({ draw: { ...draw, payload: { ...draw.payload, picks: [0, 1, 2] } }, commitment, entries }, '--offline').code).toBe(1);
    expect(run({ draw, commitment: { ...commitment, payload: { ...commitment.payload, drawAt: '2026-12-02T00:00:00.000Z' } }, entries }, '--offline').code).toBe(1);
  });

  it('checks a private list given with --entries, and --hash-entries prints what to send', async () => {
    const entries = ['ann', 'bob', 'cy', 'dee', 'ed'];
    const { draw, commitment } = await signedDraw(entries, 2);
    const list = join(tmp, 'list.txt'); writeFileSync(list, ` ann\r\nbob\n\ncy\ndee\ned\n`);
    expect(run({ draw, commitment }, '--offline', '--entries', list).code).toBe(0);
    const h = spawnSync(process.execPath, [join(dir, 'docs', 'verify.mjs'), '--hash-entries', list], { encoding: 'utf8' });
    expect(JSON.parse(h.stdout)).toEqual({ entriesSha256: await entriesHash(entries), count: 5 });
  });
});
