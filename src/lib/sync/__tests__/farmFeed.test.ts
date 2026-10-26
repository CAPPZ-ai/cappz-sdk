/** v15-10-00 — farm partitioning and reliable multicast over a simulated lossy segment. */
import { describe, expect, it } from 'vitest';
import { assignFlows, flowOwner, createFeedSender, createFeedReceiver, type FeedDatagram, type Delivery } from '../farmFeed';
import { generateSigningKey } from '../helloSignature';

// Deterministic PRNG so the lossy network is reproducible.
const rng = (seed: number) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

describe('farm partitioning (rendezvous hashing)', () => {
  const nodes = ['node-a', 'node-b', 'node-c', 'node-d'].map((id) => ({ id }));
  const flows = Array.from({ length: 2000 }, (_, i) => `flow-${i}`);
  it('every node computes the same owner; load spreads; weights shift share', () => {
    const a = assignFlows(flows, nodes);
    for (const [, fs] of a) expect(fs.length).toBeGreaterThan(400); // ~500 each
    expect(flowOwner('flow-7', nodes)).toBe(flowOwner('flow-7', [...nodes].reverse()));
    const heavy = assignFlows(flows, [{ id: 'node-a', weight: 3 }, ...nodes.slice(1)]);
    expect(heavy.get('node-a')!.length).toBeGreaterThan(900);
  });
  it('a node leaving moves only its own flows', () => {
    const before = assignFlows(flows, nodes);
    const after = assignFlows(flows, nodes.filter((n) => n.id !== 'node-c'));
    for (const id of ['node-a', 'node-b', 'node-d']) for (const f of before.get(id)!) expect(after.get(id)).toContain(f);
  });
});

describe('reliable multicast feed', () => {
  it('three receivers on a segment losing 20% get all 500 messages, in order, with suppressed NACKs', async () => {
    let t = 0; const now = () => t;
    const sender = createFeedSender({ feed: 'trades', now });
    const rx = ['r1', 'r2', 'r3'].map((id, i) => createFeedReceiver({ feed: 'trades', id, now, random: rng(i + 7) }));
    const got: Delivery[][] = rx.map(() => []);
    const lose = rng(42);
    // One multicast send: each receiver independently loses ~20%; NACKs and repairs ride the same group.
    const multicast = async (d: FeedDatagram) => {
      for (let i = 0; i < rx.length; i++) if (lose() > 0.2) got[i].push(...(await rx[i].receive(d)));
      if (d.t === 'nack') for (const r of sender.onNack(d)) await multicast(r);
    };
    for (let i = 1; i <= 500; i++) {
      await multicast(await sender.publish(`trade ${i}`));
      t += 1;
      for (const r of rx) { const n = r.dueNack(); if (n) await multicast(n); }
    }
    // Tail: heartbeats until everyone is complete (bounded).
    for (let round = 0; round < 200 && rx.some((r) => r.next <= 500); round++) {
      t += 25;
      await multicast(sender.heartbeat());
      for (const r of rx) { const n = r.dueNack(); if (n) await multicast(n); }
    }
    for (let i = 0; i < rx.length; i++) {
      expect(got[i].map((d) => d.seq)).toEqual(Array.from({ length: 500 }, (_, k) => k + 1));
      expect(got[i].every((d) => 'payload' in d)).toBe(true);
    }
    const s = rx.map((r) => r.stats);
    expect(s.reduce((n, x) => n + x.nacksSuppressed, 0)).toBeGreaterThan(0);
  });

  it('a gap older than the sender window is delivered as an explicit loss, never silently skipped', async () => {
    const sender = createFeedSender({ feed: 'f', window: 3 });
    const r = createFeedReceiver({ feed: 'f', id: 'r' });
    const d1 = await sender.publish('a'); const d2 = await sender.publish('b');
    for (const x of ['c', 'd', 'e', 'f']) await sender.publish(x);
    const out: Delivery[] = [];
    out.push(...(await r.receive(d1)));
    // d2 never arrived; the window (3) now holds 4-6, so 2 and 3 are out of it: the heartbeat's low edge marks them lost.
    void d2;
    out.push(...(await r.receive(sender.heartbeat())));
    const nack = r.dueNack() ?? { t: 'nack' as const, feed: 'f', from: 'r', missing: [2, 3, 4, 5, 6] };
    for (const rep of sender.onNack({ ...nack, missing: [3, 4, 5, 6] } as FeedDatagram & { t: 'nack' })) out.push(...(await r.receive(rep)));
    expect(out.map((d) => ('lost' in d ? `${d.seq}:lost` : `${d.seq}:${d.payload}`))).toEqual(['1:a', '2:lost', '3:lost', '4:d', '5:e', '6:f']);
    // Asking for a seq that left the window is answered 'gone', not silence.
    expect(sender.onNack({ t: 'nack', feed: 'f', from: 'r', missing: [2] })).toEqual([{ t: 'gone', feed: 'f', seqs: [2] }]);
  });

  it('signed feeds drop datagrams not signed by the declared sender key', async () => {
    const key = await generateSigningKey(); const other = await generateSigningKey();
    const good = createFeedSender({ feed: 'f', key }); const bad = createFeedSender({ feed: 'f', key: other });
    const r = createFeedReceiver({ feed: 'f', id: 'r', senderKey: key.publicKeyHex });
    expect(await r.receive(await bad.publish('forged'))).toEqual([]);
    expect(r.stats.rejected).toBe(1);
    expect(await r.receive(await good.publish('real'))).toEqual([{ seq: 1, payload: 'real' }]);
  });
});
