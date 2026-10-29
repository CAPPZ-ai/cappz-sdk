/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-store
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * The carry buffer of a mesh node: bundles held for others, bounded in bytes.
 * This is Transporter state (payloads in transit), not wallet state; what a
 * node delivers to its own app is handed to the Replicator or the app and
 * leaves this store.
 *
 * When full, a bundle displaces only bundles of lower rank (precedence; control
 * bundles above FLASH), soonest-expiring first. Each source wallet may occupy
 * at most its role's share, so one member — honest or captured — cannot fill
 * the mesh's memory with its own traffic.
 */

import { precedenceRank } from './meshIdentity.ts';
import { bundleWireBytes, type MeshBundle } from './meshBundle.ts';

export interface StoredBundle {
  id: string;
  bundle: MeshBundle;
  bytes: number;
  rank: number;
  receivedAt: number;
}

/** Hex chars of a bundle id carried in inv / getdata frames (96 bits). */
export const PREFIX = 24;

export type StoreResult = 'stored' | 'held' | 'no-room' | 'source-quota';

/** Revocations, receipts and contacts are small and are what lets the mesh heal: ranked above FLASH. */
export function bundleRank(b: MeshBundle): number {
  return b.h.kind === 'msg' ? precedenceRank(b.h.prec) : precedenceRank('flash') + 1;
}

export class BundleStore {
  private readonly entries = new Map<string, StoredBundle>();
  private readonly perSource = new Map<string, number>();
  private readonly prefixes = new Map<string, string>(); // id prefix (as carried in inv / getdata) → id
  bytes = 0;
  peakBytes = 0;
  evicted = 0;

  constructor(readonly capacityBytes: number) {}

  get size(): number { return this.entries.size; }
  has(id: string): boolean { return this.entries.has(id); }
  get(id: string): StoredBundle | undefined { return this.entries.get(id); }
  values(): IterableIterator<StoredBundle> { return this.entries.values(); }
  ids(): IterableIterator<string> { return this.entries.keys(); }
  hasPrefix(prefix: string): boolean { return this.prefixes.has(prefix); }
  idOfPrefix(prefix: string): string | undefined { return this.prefixes.get(prefix); }

  put(id: string, bundle: MeshBundle, sourceShare: number, now: number): StoreResult {
    if (this.entries.has(id)) return 'held';
    const bytes = bundleWireBytes(bundle);
    const rank = bundleRank(bundle);
    const src = bundle.h.src;
    const displaceable = (e: StoredBundle) => e.rank < rank || (e.rank === rank && e.bundle.h.expires < bundle.h.expires);
    // Over its share, a source makes room among its own bundles only; control bundles are exempt.
    const quota = this.capacityBytes * sourceShare;
    const held = this.perSource.get(src) ?? 0;
    if (held + bytes > quota && rank <= precedenceRank('flash')) {
      if (!this.makeRoom([...this.entries.values()].filter((e) => e.bundle.h.src === src && displaceable(e)), quota - held, bytes)) return 'source-quota';
    }
    if (this.bytes + bytes > this.capacityBytes) {
      if (!this.makeRoom([...this.entries.values()].filter(displaceable), this.capacityBytes - this.bytes, bytes)) return 'no-room';
    }
    this.entries.set(id, { id, bundle, bytes, rank, receivedAt: now });
    this.prefixes.set(id.slice(0, PREFIX), id);
    this.bytes += bytes;
    this.perSource.set(src, (this.perSource.get(src) ?? 0) + bytes);
    if (this.bytes > this.peakBytes) this.peakBytes = this.bytes;
    return 'stored';
  }

  /** Evict the lowest-ranked, soonest-expiring candidates until `need` bytes fit in `free`; evict nothing if they cannot. */
  private makeRoom(candidates: StoredBundle[], free: number, need: number): boolean {
    candidates.sort((a, b) => a.rank - b.rank || a.bundle.h.expires - b.bundle.h.expires);
    const out: StoredBundle[] = [];
    for (const v of candidates) { if (free >= need) break; out.push(v); free += v.bytes; }
    if (free < need) return false;
    for (const v of out) { this.delete(v.id); this.evicted++; }
    return true;
  }

  delete(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    this.entries.delete(id);
    this.prefixes.delete(id.slice(0, PREFIX));
    this.bytes -= e.bytes;
    const left = (this.perSource.get(e.bundle.h.src) ?? 0) - e.bytes;
    if (left > 0) this.perSource.set(e.bundle.h.src, left); else this.perSource.delete(e.bundle.h.src);
    return true;
  }

  purgeExpired(now: number): number {
    let n = 0;
    for (const e of [...this.entries.values()]) if (e.bundle.h.expires <= now) { this.delete(e.id); n++; }
    return n;
  }
}
