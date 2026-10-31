/**
 * COPE node crystallized.
 * Node ID: v15-16-00-notary-batch
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Batch notarization: many salted leaves, one ledger anchor. The anchor holds
 * the root of an RFC 9162 (Certificate Transparency v2) Merkle tree over the
 * leaves; each file's receipt carries its index and inclusion path, so it
 * verifies on its own against the one transaction.
 *
 *   leaf node  = SHA-256(0x00 || leaf)          (leaf = the 32-byte salted hash)
 *   inner node = SHA-256(0x01 || left || right)
 *
 * The 0x00 / 0x01 prefixes keep an inner node from being passed off as a
 * notarized file. A tree splits at the largest power of two below its size,
 * so an unpaired node is never duplicated (duplication lets two different
 * batches share a root). Verification follows RFC 9162 §2.1.3.2 exactly.
 */
import { sha256 } from '@noble/hashes/sha2.js';

export const NOTARY_BATCH_VERSION = 'cappz-notary-batch-1.0' as const;
export const NOTARY_BATCH_MEMO_TYPE = 'cappz.notary.batch.v1' as const;
/** Upper bound on leaves per anchor; keeps proofs at 20 hashes or fewer. */
export const NOTARY_BATCH_MAX = 1 << 20;

export interface NotaryInclusionProof {
  /** Position of the leaf in the batch, from 0. */
  index: number;
  /** Number of leaves in the batch. */
  count: number;
  /** Sibling hashes from the leaf up, uppercase hex. */
  path: string[];
}

export interface NotaryBatch {
  root: string;
  count: number;
  /** One proof per input leaf, same order. */
  proofs: NotaryInclusionProof[];
}

const HEX64 = /^[0-9a-fA-F]{64}$/;
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
function fromHex64(h: string, what: string): Uint8Array {
  if (!HEX64.test(h)) throw new Error(`notary batch: ${what} must be 64 hex characters`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function leafNode(leaf: Uint8Array): Uint8Array {
  const b = new Uint8Array(33); b[0] = 0x00; b.set(leaf, 1);
  return sha256(b);
}
function innerNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  const b = new Uint8Array(65); b[0] = 0x01; b.set(left, 1); b.set(right, 33);
  return sha256(b);
}
/** Largest power of two strictly below n (n >= 2). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** Merkle tree hash of leaf nodes [lo, hi), memoised by range. */
function mth(nodes: Uint8Array[], lo: number, hi: number, memo: Map<string, Uint8Array>): Uint8Array {
  if (hi - lo === 1) return nodes[lo];
  const key = `${lo}:${hi}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const k = split(hi - lo);
  const h = innerNode(mth(nodes, lo, lo + k, memo), mth(nodes, lo + k, hi, memo));
  memo.set(key, h);
  return h;
}

/** PATH(m, D[lo:hi]) of RFC 9162, deepest sibling first. */
function path(nodes: Uint8Array[], m: number, lo: number, hi: number, memo: Map<string, Uint8Array>): Uint8Array[] {
  if (hi - lo === 1) return [];
  const k = split(hi - lo);
  return m < k
    ? [...path(nodes, m, lo, lo + k, memo), mth(nodes, lo + k, hi, memo)]
    : [...path(nodes, m - k, lo + k, hi, memo), mth(nodes, lo, lo + k, memo)];
}

/** Root and per-leaf inclusion proofs for salted leaves (64 hex each). */
export function buildNotaryBatch(leaves: readonly string[]): NotaryBatch {
  if (!leaves.length) throw new Error('notary batch: no leaves');
  if (leaves.length > NOTARY_BATCH_MAX) throw new Error(`notary batch: at most ${NOTARY_BATCH_MAX} leaves`);
  const nodes = leaves.map((l, i) => leafNode(fromHex64(l, `leaf ${i}`)));
  const memo = new Map<string, Uint8Array>();
  const root = toHex(mth(nodes, 0, nodes.length, memo));
  const proofs = nodes.map((_, i) => ({ index: i, count: nodes.length, path: path(nodes, i, 0, nodes.length, memo).map(toHex) }));
  return { root, count: nodes.length, proofs };
}

/** The root this leaf and proof lead to, or null when the proof is malformed. RFC 9162 §2.1.3.2. */
export function rootFromInclusion(leaf: string, proof: NotaryInclusionProof): string | null {
  const { index, count } = proof;
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 0 || count < 1 || count > NOTARY_BATCH_MAX || index >= count) return null;
  if (!Array.isArray(proof.path) || proof.path.length > 64 || !proof.path.every((p) => typeof p === 'string' && HEX64.test(p))) return null;
  if (!HEX64.test(leaf)) return null;
  let fn = index;
  let sn = count - 1;
  let r = leafNode(fromHex64(leaf, 'leaf'));
  for (const p of proof.path) {
    if (sn === 0) return null;
    const sib = fromHex64(p, 'path entry');
    if ((fn & 1) === 1 || fn === sn) {
      r = innerNode(sib, r);
      if ((fn & 1) === 0) while ((fn & 1) === 0 && fn !== 0) { fn >>>= 1; sn >>>= 1; }
    } else {
      r = innerNode(r, sib);
    }
    fn >>>= 1; sn >>>= 1;
  }
  return sn === 0 ? toHex(r) : null;
}

/** What a batch anchor commits to: the root and the number of leaves. */
export interface NotaryBatchAnchor { root: string; count: number }

/**
 * Does `leaf` belong to the anchored batch? The leaf count must match the
 * anchor's: within one subtree an RFC 9162 path does not commit to the tree
 * size, so the size is bound by the anchor (as a CT signed tree head does).
 */
export function verifyNotaryInclusion(leaf: string, proof: NotaryInclusionProof, anchor: NotaryBatchAnchor): boolean {
  if (!HEX64.test(anchor.root) || proof.count !== anchor.count) return false;
  const got = rootFromInclusion(leaf, proof);
  return got !== null && got === anchor.root.toUpperCase();
}

/** The memo payload a batch anchor carries (alongside InvoiceID = root). */
export function notaryBatchMemoPayload(b: { root: string; count: number; cappzPaymentTx?: string }): Record<string, unknown> {
  return { version: NOTARY_BATCH_VERSION, alg: 'sha256', tree: 'rfc9162', root: b.root.toUpperCase(), count: b.count, ...(b.cappzPaymentTx ? { cappz_payment_tx: b.cappzPaymentTx } : {}) };
}
