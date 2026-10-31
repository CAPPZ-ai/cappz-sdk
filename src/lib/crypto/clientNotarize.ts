/**
 * Client-Side Notarization — Zero-server hash computation.
 * 
 * Migrated from edge function `cappz-notarize` for Phase 12e.
 * Salt generation and SHA-256 hashing run entirely in-browser.
 * v14-12-04: receipts persist to cappz-store (OPFS, awaited flush) on the
 * notarizer's device — no hosted table write.
 */

import { createOpfsBackend, opfsAvailable, type KvBackend } from '../sync/storageEngines/kvBackends';
import { bytesFromBase64 } from './clientVerify';
import { digestContent, type DigestSource } from './contentDigest';
import type { NativeKernels } from '../native/cappzNative';
import { resolveNetworkAddresses } from '../network/networkConfig';
import type { CappzNetwork } from '../network/networkConfig';

// ─── CAPPZ Token Config — resolved from shared network-config ──

const CAPPZ_NOTARIZATION_FEE = '2';

type Network = CappzNetwork;

// ─── Types ─────────────────────────────────────────────────────

export interface NotarizeRequest {
  contentHash?: string;
  content?: string;
  /** The file to notarize; read in slices, never base64-encoded. */
  file?: Blob;
  fileBytes?: Uint8Array;
  /** @deprecated pass `file` or `fileBytes`; base64 costs a third more bytes and two copies. */
  fileBase64?: string;
  /** Hashing progress for large files. */
  onProgress?: (done: number, total: number) => void;
  /** Kernels for streamed hashing of large files (default: the SDK's active kernels). */
  kernels?: NativeKernels;
  userWallet: string;
  cappzPaymentTxHash?: string;
  fileName?: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
  network?: Network;
}

export interface NotarizeReceipt {
  version: string;
  alg: string;
  leaf: string;
  salt: string;
  txid?: string;
  cappz_payment_tx?: string;
  anchor_account: string;
  treasury_account: string;
  timestamp_utc: string;
  file_name?: string;
  cappz_consumed: string;
}

export interface NotarizeResult {
  success: boolean;
  notarizationId: string;
  leaf: string;
  salt: string;
  treasuryAddress: string;
  timestamp: string;
  verificationUrl: string;
  receipt: NotarizeReceipt;
  /** SHA-256 of the content itself (lowercase hex), from the same pass as the leaf; absent for `contentHash` requests. */
  contentSha256?: string;
  /** @deprecated name kept for callers — true when the receipt is durably stored in cappz-store. */
  persistedToDb: boolean;
  persistedLocally: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────

function generateSalt(): string {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return btoa(String.fromCharCode(...salt))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function isValidXRPLAddress(address: string): boolean {
  return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address);
}

// ─── Public API ────────────────────────────────────────────────

export async function notarizeClient(request: NotarizeRequest): Promise<NotarizeResult> {
  if (!request.userWallet) throw new Error('userWallet is required');
  if (!isValidXRPLAddress(request.userWallet) && !request.userWallet.startsWith('rDemo')) {
    throw new Error('Invalid XRPL wallet address');
  }

  // A precomputed hash is the leaf itself; anything else is hashed with the salt.
  const preComputedHash = request.contentHash?.toUpperCase();
  const source: DigestSource | null = preComputedHash ? null
    : request.file ?? request.fileBytes
      ?? (request.fileBase64 ? bytesFromBase64(request.fileBase64) : null)
      ?? (request.content ? new TextEncoder().encode(request.content) : null);
  if (!preComputedHash && !source) throw new Error('One of contentHash, content, file, fileBytes or fileBase64 is required');

  const salt = generateSalt();
  let leaf: string;
  let contentSha256: string | undefined;
  if (preComputedHash) {
    leaf = preComputedHash;
  } else {
    // One pass: the salted leaf and the content's own SHA-256.
    const d = await digestContent(source!, { leafPrefix: new TextEncoder().encode(salt), onProgress: request.onProgress, kernels: request.kernels });
    leaf = d.leaf!;
    contentSha256 = d.sha256;
  }
  const network = request.network || 'testnet';
  const networkConfig = resolveNetworkAddresses(network);
  const timestamp = new Date().toISOString();
  const notarizationId = crypto.randomUUID();

  const verificationUrl = `https://cappz.ai/verify?chain=xrpl&alg=sha256&leaf=${leaf}&salt=${salt}`;

  const receipt: NotarizeReceipt = {
    version: 'cappz-notary-1.0',
    alg: 'sha256',
    leaf,
    salt,
    cappz_payment_tx: request.cappzPaymentTxHash,
    anchor_account: request.userWallet,
    treasury_account: networkConfig.treasury,
    timestamp_utc: timestamp,
    file_name: request.fileName,
    cappz_consumed: CAPPZ_NOTARIZATION_FEE,
  };

  const persistedLocally = await persistNotaryReceipt(notarizationId, {
    id: notarizationId, user_wallet: request.userWallet, content_hash: leaf, salt,
    file_name: request.fileName, content_type: request.contentType, metadata: request.metadata || {},
    cappz_payment_tx: request.cappzPaymentTxHash, network, receipt,
    status: request.cappzPaymentTxHash ? 'paid' : 'pending_payment', created_at: timestamp,
  });

  return {
    success: true,
    notarizationId,
    leaf,
    salt,
    treasuryAddress: networkConfig.treasury,
    timestamp,
    verificationUrl,
    receipt,
    ...(contentSha256 ? { contentSha256 } : {}),
    persistedToDb: persistedLocally,
    persistedLocally,
  };
}

// ─── cappz-store persistence ───────────────────────────────────

const NOTARY_STORE = 'notary-receipts';
let backend: KvBackend | null = null;
let rows: Map<string, unknown> | null = null;

export async function persistNotaryReceipt(id: string, row: Record<string, unknown>): Promise<boolean> {
  if (!opfsAvailable()) return false;
  try {
    backend ??= createOpfsBackend();
    rows ??= await backend.load(NOTARY_STORE);
    rows.set(id, row);
    backend.persist(NOTARY_STORE, rows);
    await backend.flush();
    return true;
  } catch {
    return false;
  }
}

/** Find one receipt by content hash (leaf) on this device. */
export async function findNotaryReceiptByHash(leaf: string, network?: string): Promise<Record<string, unknown> | null> {
  const all = await listNotaryReceipts();
  const upper = leaf.toUpperCase();
  return all.find((r) =>
    String(r.content_hash ?? '').toUpperCase() === upper &&
    (!network || r.network === network),
  ) ?? null;
}

/**
 * Read notary receipts stored on this device. Pass a wallet to scope to one
 * user's UAW receipts (Notarizer wallet tiers: PTW template, POW platform
 * working copy, one UAW per user holding their receipts).
 */
export async function listNotaryReceipts(userWallet?: string): Promise<Record<string, unknown>[]> {
  if (!opfsAvailable()) return [];
  backend ??= createOpfsBackend();
  rows ??= await backend.load(NOTARY_STORE);
  const all = [...rows.values()] as Record<string, unknown>[];
  return userWallet ? all.filter((r) => r.user_wallet === userWallet) : all;
}

/** Every receipt currently recoverable from this device's durable CAPPZ store. */
export async function inventoryNotaryReceipts(): Promise<Record<string, unknown>[]> {
  return listNotaryReceipts();
}
