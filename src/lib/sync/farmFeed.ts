/**
 * COPE node crystallized.
 * Node ID: v15-10-00-farm-feed
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Scale-out processing farm on one segment.
 *
 * Partitioning — which node owns which flow: rendezvous (highest-random-
 * weight) hashing over the member table. Every node computes the same owner
 * from the same member list, with no coordinator; when a node leaves, only its
 * flows move, and when one joins it takes only the flows it now wins.
 *
 * Fan-out — reliable multicast, the way market-data feeds do it (NACK-based,
 * NORM/PGM-style): the sender numbers each datagram per feed and keeps a
 * window; receivers deliver strictly in sequence, ask for gaps with a NACK
 * (multicast, so one NACK suppresses the same NACK from other receivers),
 * and learn the tail from heartbeats. A sequence that left the sender's window
 * is answered with 'gone' and delivered as an explicit loss marker — never a
 * silent gap. Datagrams may be signed (Ed25519, the sender's declared key).
 *
 * Runtime-neutral state machines: the node (or a test) moves the datagrams.
 */

import { signCanonical, verifyCanonical, type SigningKey } from './helloSignature.ts';
import { canonicalJson } from '../identity/canonical.ts';

// ─── Partitioning ─────────────────────────────────────────────────

const M64 = 0xffffffffffffffffn;
/** 64-bit FNV-1a over UTF-8 plus the murmur3 finalizer: FNV alone spreads near-identical keys (flow-1|node-a) unevenly. Not a security boundary. */
function fnv1a64(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(s)) { h ^= BigInt(b); h = (h * 0x100000001b3n) & M64; }
  h ^= h >> 33n; h = (h * 0xff51afd7ed558ccdn) & M64; h ^= h >> 33n; h = (h * 0xc4ceb9fe1a85ec53n) & M64; h ^= h >> 33n;
  return h;
}

export interface FarmNode { id: string; weight?: number }

/** The node that owns a flow: highest score of hash(flow|node), scaled by weight. */
export function flowOwner(flowId: string, nodes: readonly FarmNode[]): string | null {
  let best: { id: string; score: number } | null = null;
  for (const n of nodes) {
    // Weighted rendezvous: score = -w / ln(u), u uniform in (0,1) from the hash.
    const u = (Number(fnv1a64(`${flowId}|${n.id}`) >> 11n) + 0.5) / 2 ** 53;
    const score = -(n.weight ?? 1) / Math.log(u);
    if (!best || score > best.score || (score === best.score && n.id < best.id)) best = { id: n.id, score };
  }
  return best?.id ?? null;
}

export function assignFlows(flowIds: readonly string[], nodes: readonly FarmNode[]): Map<string, string[]> {
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const f of flowIds) { const o = flowOwner(f, nodes); if (o) out.get(o)!.push(f); }
  return out;
}

// ─── Reliable multicast feed ──────────────────────────────────────

export type FeedDatagram =
  | { t: 'data'; feed: string; seq: number; payload: string; sig?: string; pk?: string }
  | { t: 'hb'; feed: string; high: number; low: number }
  | { t: 'nack'; feed: string; from: string; missing: number[] }
  | { t: 'gone'; feed: string; seqs: number[] };

export const FEED_MAX_NACK = 64;

const dataBody = (d: { feed: string; seq: number; payload: string }) => canonicalJson({ feed: d.feed, payload: d.payload, seq: d.seq, t: 'data' });

export function createFeedSender(o: { feed: string; window?: number; key?: SigningKey; repairIntervalMs?: number; now?: () => number }) {
  const window = o.window ?? 4096;
  const now = o.now ?? Date.now;
  const kept = new Map<number, FeedDatagram & { t: 'data' }>();
  const repairedAt = new Map<number, number>();
  let seq = 0;
  return {
    async publish(payload: string): Promise<FeedDatagram> {
      seq++;
      const d: FeedDatagram & { t: 'data' } = { t: 'data', feed: o.feed, seq, payload };
      if (o.key) { d.sig = await signCanonical(dataBody(d), o.key); d.pk = o.key.publicKeyHex; }
      kept.set(seq, d);
      if (kept.size > window) { const oldest = seq - window; kept.delete(oldest); repairedAt.delete(oldest); }
      return d;
    },
    heartbeat(): FeedDatagram { return { t: 'hb', feed: o.feed, high: seq, low: Math.max(1, seq - window + 1) }; },
    /** Answer a NACK: retransmit what is kept (each seq at most once per repair interval), report what is gone. */
    onNack(n: FeedDatagram & { t: 'nack' }): FeedDatagram[] {
      if (n.feed !== o.feed) return [];
      const out: FeedDatagram[] = []; const gone: number[] = [];
      for (const s of n.missing.slice(0, FEED_MAX_NACK)) {
        const d = kept.get(s);
        if (!d) { if (s >= 1 && s <= seq) gone.push(s); continue; }
        const last = repairedAt.get(s) ?? -Infinity;
        if (now() - last < (o.repairIntervalMs ?? 50)) continue; // another receiver's NACK already triggered this repair
        repairedAt.set(s, now()); out.push(d);
      }
      if (gone.length) out.push({ t: 'gone', feed: o.feed, seqs: gone });
      return out;
    },
    get high() { return seq; },
  };
}

export type Delivery = { seq: number; payload: string } | { seq: number; lost: true };

export function createFeedReceiver(o: { feed: string; id: string; senderKey?: string; maxBuffer?: number; nackDelayMs?: number; now?: () => number; random?: () => number }) {
  const now = o.now ?? Date.now; const random = o.random ?? Math.random;
  let next = 1; let high = 0;
  const buffer = new Map<number, string>();
  const lost = new Set<number>();
  const nackDue = new Map<number, number>(); // seq → when to NACK (jittered; suppressed by others' NACKs)
  const stats = { delivered: 0, lost: 0, nacksSent: 0, nacksSuppressed: 0, rejected: 0, duplicates: 0 };

  const schedule = (from: number, to: number) => {
    for (let s = from; s <= to; s++) if (!buffer.has(s) && !lost.has(s) && !nackDue.has(s)) nackDue.set(s, now() + (o.nackDelayMs ?? 20) * (0.5 + random()));
  };
  const drain = (): Delivery[] => {
    const out: Delivery[] = [];
    for (;;) {
      if (buffer.has(next)) { out.push({ seq: next, payload: buffer.get(next)! }); buffer.delete(next); stats.delivered++; next++; continue; }
      if (lost.has(next)) { out.push({ seq: next, lost: true }); lost.delete(next); stats.lost++; next++; continue; }
      return out;
    }
  };

  return {
    stats,
    /** Feed one datagram in; returns what can now be delivered, in order. */
    async receive(d: FeedDatagram): Promise<Delivery[]> {
      if (d.feed !== o.feed) return [];
      if (d.t === 'data') {
        if (o.senderKey && (d.pk !== o.senderKey || !d.sig || !(await verifyCanonical(dataBody(d), d.sig, d.pk)))) { stats.rejected++; return []; }
        if (d.seq < next || buffer.has(d.seq)) { stats.duplicates++; return []; }
        if (buffer.size >= (o.maxBuffer ?? 65_536)) return [];
        buffer.set(d.seq, d.payload); nackDue.delete(d.seq);
        if (d.seq > high) { schedule(high + 1, d.seq - 1); high = d.seq; }
        return drain();
      }
      if (d.t === 'hb') {
        if (d.low > next) { for (let s = next; s < d.low; s++) if (!buffer.has(s)) { lost.add(s); nackDue.delete(s); } } // fell out of the window before we asked
        if (d.high > high) high = d.high;
        schedule(next, high); // re-arm anything still missing (a repair can be lost too)
        return drain();
      }
      if (d.t === 'nack' && d.from !== o.id) {
        // Another receiver asked for the same seqs: postpone ours (the repair is coming), never drop it —
        // if that repair is lost for us too, we still ask.
        for (const s of d.missing) if (nackDue.has(s)) { nackDue.set(s, now() + (o.nackDelayMs ?? 20) * (2 + random())); stats.nacksSuppressed++; }
        return [];
      }
      if (d.t === 'gone') { for (const s of d.seqs) if (s >= next && !buffer.has(s)) { lost.add(s); nackDue.delete(s); } return drain(); }
      return [];
    },
    /** NACK whose delay elapsed (send it to the group). Re-arms for another round if the repair is lost too. */
    dueNack(): FeedDatagram | null {
      const t = now(); const missing: number[] = [];
      for (const [s, at] of nackDue) if (at <= t && missing.length < FEED_MAX_NACK) missing.push(s);
      if (!missing.length) return null;
      for (const s of missing) nackDue.set(s, t + (o.nackDelayMs ?? 20) * (2 + random())); // retry later if still missing
      stats.nacksSent++;
      return { t: 'nack', feed: o.feed, from: o.id, missing };
    },
    get next() { return next; },
  };
}
