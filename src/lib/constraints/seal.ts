/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-seal
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Seal observations at the collector. An attacker who changes a controller
 * often also controls what it records ("they are hacking the system that is
 * doing the registration of the temperature"). The collector — an edge node
 * or small board beside the equipment, with its own key — signs each batch of
 * samples as it reads them and chains it to the previous batch. Reconciling
 * against sealed batches makes an edited, removed or reordered batch fail
 * verification, so the report says `sealed-broken` instead of trusting it.
 *
 * What a seal proves: these samples were recorded by that collector key, in
 * that order, unchanged since. It does not prove the sensor was accurate —
 * that is what `agreement` with an independent sensor is for.
 */

import { canonicalJson, sha256HexOf } from '../identity/canonical.ts';
import { signCanonical, verifyCanonical, type SigningKey } from '../sync/helloSignature.ts';
import type { IntegrityState, Observation } from './reconcile.ts';

export interface SealedObservationBatch {
  v: 1; kind: 'cappz.constraints.observation-batch';
  collector: string;
  previous: string | null;
  seq: number;
  from: string; to: string;
  items: Observation[];
  signerKey: string; batchHash: string; signature: string;
}

export async function sealObservationBatch(items: readonly Observation[], o: { collector: string; previous: SealedObservationBatch | null; key: SigningKey }): Promise<SealedObservationBatch> {
  const sorted = [...items].sort((a, b) => a.at - b.at);
  const unsigned = {
    v: 1 as const, kind: 'cappz.constraints.observation-batch' as const, collector: o.collector,
    previous: o.previous?.batchHash ?? null, seq: (o.previous?.seq ?? -1) + 1,
    from: new Date(sorted[0]?.at ?? 0).toISOString(), to: new Date(sorted[sorted.length - 1]?.at ?? 0).toISOString(),
    items: sorted, signerKey: o.key.publicKeyHex,
  };
  const batchHash = await sha256HexOf(canonicalJson(unsigned));
  return { ...unsigned, batchHash, signature: await signCanonical(batchHash, o.key) };
}

/** Verify a collector's chain (any order; sorted by seq). Returns the samples and the integrity state for the report. */
export async function openSealedObservations(batches: readonly SealedObservationBatch[], trustedKeys: readonly string[]): Promise<{ integrity: IntegrityState; observations: Observation[] }> {
  const trusted = new Set(trustedKeys.map((k) => k.toLowerCase()));
  const byCollector = new Map<string, SealedObservationBatch[]>();
  for (const b of batches) (byCollector.get(b.collector) ?? byCollector.set(b.collector, []).get(b.collector)!).push(b);
  const observations: Observation[] = [];
  for (const [collector, list] of byCollector) {
    const chain = [...list].sort((a, b) => a.seq - b.seq);
    let prev: SealedObservationBatch | null = null;
    for (const b of chain) {
      const where = `${collector} batch ${b.seq}`;
      if (!trusted.has(String(b.signerKey).toLowerCase())) return { integrity: { state: 'sealed-broken', because: `${where}: signer is not a trusted collector key` }, observations };
      const { batchHash, signature, ...unsigned } = b;
      if ((await sha256HexOf(canonicalJson(unsigned))) !== batchHash) return { integrity: { state: 'sealed-broken', because: `${where}: samples changed after sealing` }, observations };
      if (!(await verifyCanonical(batchHash, signature, b.signerKey).catch(() => false))) return { integrity: { state: 'sealed-broken', because: `${where}: bad signature` }, observations };
      if (prev && (b.seq !== prev.seq + 1 || b.previous !== prev.batchHash)) return { integrity: { state: 'sealed-broken', because: `${where}: chain broken after batch ${prev.seq} (a batch is missing, inserted or reordered)` }, observations };
      prev = b;
      observations.push(...b.items);
    }
  }
  return { integrity: { state: 'sealed-verified', because: `${batches.length} batch(es) from ${byCollector.size} collector(s) verified` }, observations };
}
