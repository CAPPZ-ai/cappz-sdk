/**
 * COPE node crystallized.
 * Node ID: v15-04-00-edge-body-pull
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Headers-first, pull bodies — over any verified edge session (TCP, QUIC,
 * the WS bridge, tests). Bodies are content-addressed: a body's id IS the
 * sha256 of its bytes, so a receiver checks every body itself and trusts no
 * peer.
 *
 *   inv      {heads}   "I hold these ids"           → peer asks for what it lacks
 *   getdata  {ids}     "send me these"              → peer answers with frames
 *   frame    {id,data} one body (base64)            → verified, stored, acked
 *   ack      {id}
 *
 * A body that was not asked for, or whose hash does not match its id, is
 * rejected and counted. Runtime-neutral: the store is injected (memory in
 * tests and browsers, files on the edge node).
 */

import { decodeJsonFrame } from './frameCodec.ts';
import type { EdgePeerSession } from './edgeSession.ts';

export interface BodyStore {
  /** Ids (sha256 hex) this store holds, newest first is fine. */
  list(): Promise<string[]>;
  has(id: string): Promise<boolean>;
  get(id: string): Promise<Uint8Array | null>;
  put(id: string, bytes: Uint8Array): Promise<void>;
}

export interface BodyPullStats { announced: number; requested: number; received: number; served: number; rejected: Array<{ id: string; reason: string }> }

/** Bodies above this are refused (CPZ1 frames carry ≤ 8 MB; base64 adds a third). */
export const MAX_BODY_BYTES = 6 * 1024 * 1024;
/** Ids per getdata and per inv. */
export const MAX_IDS_PER_FRAME = 256;

const ID = /^[0-9a-f]{64}$/;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  const d = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}
const toB64 = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function memoryBodyStore(initial: Uint8Array[] = []): BodyStore & { ready: Promise<void> } {
  const m = new Map<string, Uint8Array>();
  const ready = Promise.all(initial.map(async (b) => { m.set(await sha256Hex(b), b); })).then(() => {});
  return {
    ready,
    list: async () => { await ready; return [...m.keys()]; },
    has: async (id) => { await ready; return m.has(id); },
    get: async (id) => { await ready; return m.get(id) ?? null; },
    put: async (id, bytes) => { await ready; m.set(id, bytes); },
  };
}

export interface BodyExchangeOptions {
  /** Called for each verified body stored (id, size). */
  onBody?: (id: string, bytes: number) => void;
  /** Called for each rejected body. */
  onReject?: (id: string, reason: string) => void;
  /** Called with the ids a peer announces (inventory gossip). */
  onHeads?: (heads: string[]) => void;
}

/**
 * Run the body exchange on an open session until the peer says bye or the
 * connection ends. Announces our ids first; answers the peer's getdata;
 * asks for and verifies what we lack. Returns what moved.
 */
export async function runBodyExchange(session: EdgePeerSession, store: BodyStore, opts: BodyExchangeOptions = {}): Promise<BodyPullStats> {
  const stats: BodyPullStats = { announced: 0, requested: 0, received: 0, served: 0, rejected: [] };
  const asked = new Set<string>();
  const reject = (id: string, reason: string) => { stats.rejected.push({ id, reason }); opts.onReject?.(id, reason); };
  const mine = (await store.list()).filter((id) => ID.test(id)).slice(0, MAX_IDS_PER_FRAME);
  stats.announced = mine.length;
  await session.send('inv', { heads: mine });
  for await (const frame of session.frames()) {
    if (frame.command === 'inv') {
      const heads = decodeJsonFrame<{ heads?: unknown[] }>(frame).heads ?? [];
      opts.onHeads?.(heads.filter((h): h is string => typeof h === 'string'));
      const missing: string[] = [];
      for (const h of heads.slice(0, MAX_IDS_PER_FRAME)) {
        if (typeof h === 'string' && ID.test(h) && !asked.has(h) && !(await store.has(h))) missing.push(h);
      }
      for (const id of missing) asked.add(id);
      stats.requested += missing.length;
      if (missing.length) await session.send('getdata', { ids: missing });
      else await session.send('ack', { id: 'inv' }); // nothing to pull: let the peer know
    } else if (frame.command === 'getdata') {
      const ids = decodeJsonFrame<{ ids?: unknown[] }>(frame).ids ?? [];
      for (const id of ids.slice(0, MAX_IDS_PER_FRAME)) {
        if (typeof id !== 'string' || !ID.test(id)) continue;
        const bytes = await store.get(id);
        if (!bytes || bytes.length > MAX_BODY_BYTES) continue;
        await session.send('frame', { id, data: toB64(bytes) });
        stats.served++;
      }
    } else if (frame.command === 'frame') {
      const { id, data } = decodeJsonFrame<{ id?: string; data?: string }>(frame);
      if (typeof id !== 'string' || !asked.has(id)) { reject(String(id), 'not requested'); continue; }
      let bytes: Uint8Array;
      try { bytes = fromB64(String(data ?? '')); } catch { reject(id, 'not base64'); continue; }
      if (bytes.length > MAX_BODY_BYTES) { reject(id, 'too large'); continue; }
      if ((await sha256Hex(bytes)) !== id) { reject(id, 'hash mismatch'); continue; }
      asked.delete(id);
      await store.put(id, bytes);
      stats.received++;
      opts.onBody?.(id, bytes.length);
      await session.send('ack', { id });
    } else if (frame.command === 'ping') {
      await session.send('pong', { at: new Date().toISOString() });
    } else if (frame.command === 'bye') {
      break;
    }
  }
  return stats;
}
