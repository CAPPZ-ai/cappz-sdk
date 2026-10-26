/**
 * COPE node crystallized. Node ID: v14-16-11-serialize-wallet
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Serialized wallet SET as the deployable unit — per app, never monolithic:
 * app PTW (HD tree + TX history + content partitions + runtime images +
 * ZUI snapshots) plus the embedded shared-core copy. Import replays TXs,
 * rehydrates, and verifies every fingerprint.
 *
 * Multi-writer merge: importing a wallet whose history diverges from local
 * runs the existing branch/merge path — per-artifact fingerprint comparison,
 * ConflictDetected on divergence, resolution via Conflict Remediation.
 *
 * Secrets rule: seeds/keys are never serialized — escrowed ciphertext only.
 */
import { sha256Hex } from './contentCompression';

export const SERIALIZED_WALLET_FORMAT = 'cappz-wallet-set/v1';

export interface SerializedWalletEntry {
  address: string;
  /** Raw content bytes (base64) when the address holds content. */
  contentB64?: string;
  /** Expected raw fingerprint from notarization, when known. */
  expectedHash?: string;
}

export interface SerializedWalletSet {
  format: typeof SERIALIZED_WALLET_FORMAT;
  appSlug: string;
  exportedAt: string;
  /** App PTW root and the embedded shared-core root. */
  roots: { app: string; core: string };
  entries: SerializedWalletEntry[];
  txs: unknown[];
  snapshots?: unknown[];
  governingPrinciple: string;
}

const PRINCIPLE = "m/44'/144'/100'/principles/cope/v1#wallet-content";

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toB64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b === undefined ? 0 : b >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | (c === undefined ? 0 : c >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

export function fromB64(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => (i + k < clean.length ? B64.indexOf(clean[i + k]) : 0));
    const triple = (n[0] << 18) | (n[1] << 12) | (n[2] << 6) | n[3];
    if (o < out.length) out[o++] = (triple >> 16) & 255;
    if (o < out.length) out[o++] = (triple >> 8) & 255;
    if (o < out.length) out[o++] = triple & 255;
  }
  return out;
}

/** Paths that must never be serialized (zero-storage-secrets rule). */
const SECRET_ADDRESS = /(?:^|\/)(?:_?keys?|seeds?|secrets?|_local\/escrow\/plain)(?:\/|$)/i;

export function planWalletSetExport(input: {
  appSlug: string;
  appRoot: string;
  coreRoot: string;
  entries: SerializedWalletEntry[];
  txs: unknown[];
  snapshots?: unknown[];
}): { set: SerializedWalletSet; excluded: { address: string; reason: string }[] } {
  const excluded: { address: string; reason: string }[] = [];
  const entries = input.entries.filter((e) => {
    if (SECRET_ADDRESS.test(e.address)) { excluded.push({ address: e.address, reason: 'secret-never-serialized' }); return false; }
    return true;
  });
  return {
    set: {
      format: SERIALIZED_WALLET_FORMAT,
      appSlug: input.appSlug,
      exportedAt: new Date().toISOString(),
      roots: { app: input.appRoot, core: input.coreRoot },
      entries: [...entries].sort((a, b) => a.address.localeCompare(b.address)),
      txs: input.txs,
      snapshots: input.snapshots,
      governingPrinciple: PRINCIPLE,
    },
    excluded,
  };
}

export interface ImportVerification {
  ok: boolean;
  verified: number;
  failed: { address: string; reason: string }[];
}

/** Verify every entry's fingerprint before any state is applied. */
export async function verifyWalletSet(set: SerializedWalletSet): Promise<ImportVerification> {
  const failed: { address: string; reason: string }[] = [];
  let verified = 0;
  if (set.format !== SERIALIZED_WALLET_FORMAT) return { ok: false, verified: 0, failed: [{ address: '(envelope)', reason: 'unknown-format' }] };
  for (const e of set.entries) {
    if (!e.contentB64) continue;
    if (!e.expectedHash) { failed.push({ address: e.address, reason: 'no-expected-hash' }); continue; }
    const hash = await sha256Hex(fromB64(e.contentB64));
    if (hash !== e.expectedHash) failed.push({ address: e.address, reason: 'hash-mismatch' });
    else verified++;
  }
  return { ok: failed.length === 0, verified, failed };
}

/**
 * Multi-writer merge plan: compare an imported wallet set against local heads
 * by fingerprint. Same hash → already have it; new address → import; different
 * hash on an address both sides amended → ConflictDetected for remediation.
 */
export interface WalletMergeItem {
  address: string;
  action: 'import' | 'skip' | 'conflict';
  incomingHash?: string;
  localHash?: string;
}

export function planWalletSetMerge(set: SerializedWalletSet, localHeads: Record<string, string>): WalletMergeItem[] {
  return set.entries
    .filter((e) => e.expectedHash)
    .map((e) => {
      const local = localHeads[e.address];
      if (local === undefined) return { address: e.address, action: 'import' as const, incomingHash: e.expectedHash };
      if (local === e.expectedHash) return { address: e.address, action: 'skip' as const, incomingHash: e.expectedHash, localHash: local };
      return { address: e.address, action: 'conflict' as const, incomingHash: e.expectedHash, localHash: local };
    })
    .sort((a, b) => a.address.localeCompare(b.address));
}
