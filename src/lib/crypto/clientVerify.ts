/**
 * Client-Side Verification — Zero-server cryptographic verification.
 * 
 * Migrated from edge function `cappz-verify` for Phase 12e.
 * All hash computation and XRPL transaction lookup runs in-browser.
 * Hash receipt lookup reads the wallet only; ledger checks require public XRPL connectivity.
 */

import { findNotaryReceiptByHash } from './clientNotarize';
import { digestContent, type DigestSource } from './contentDigest';
import type { NativeKernels } from '../native/cappzNative';

// ─── Types ─────────────────────────────────────────────────────

export interface VerificationRequest {
  txId?: string;
  contentHash?: string;
  content?: string;
  /** The file to recompute from; read in slices, never base64-encoded. */
  file?: Blob;
  fileBytes?: Uint8Array;
  /** @deprecated pass `file` or `fileBytes`; base64 costs a third more bytes and two copies. */
  fileBase64?: string;
  salt?: string;
  expectedLeaf?: string;
  network?: 'mainnet' | 'testnet' | 'devnet';
  /** Hashing progress for large files. */
  onProgress?: (done: number, total: number) => void;
  /** Kernels for streamed hashing of large files (default: the SDK's active kernels). */
  kernels?: NativeKernels;
}

export interface VerificationResult {
  success: boolean;
  verified: boolean;
  method: 'txid' | 'hash' | 'recompute';
  leaf?: string;
  matchesExpected?: boolean;
  txId?: string;
  validated?: boolean;
  ledgerIndex?: number;
  timestamp?: string;
  onChainLeaf?: string;
  anchorAccount?: string;
  notarizationRecord?: {
    id: string;
    userWallet: string;
    fileName?: string;
    createdAt: string;
    status: string;
  };
  error?: string;
}

// ─── XRPL endpoints ───────────────────────────────────────────

const XRPL_HTTP_ENDPOINTS: Record<string, string> = {
  mainnet: 'https://xrplcluster.com',
  testnet: 'https://s.altnet.rippletest.net:51234',
  devnet: 'https://s.devnet.rippletest.net:51234',
};

// ─── Pure crypto helpers (browser Web Crypto API) ─────────────

/** The notarization leaf: SHA-256(UTF-8 salt text || content), uppercase hex. */
export async function computeSaltedHash(content: DigestSource, salt: string, o: { onProgress?: (done: number, total: number) => void; kernels?: NativeKernels } = {}): Promise<string> {
  const { leaf } = await digestContent(content, { ...o, leafPrefix: new TextEncoder().encode(salt), contentHash: false });
  return leaf!;
}

/** Bytes from the deprecated base64 field. */
export function bytesFromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function hexToString(hex: string): string {
  let str = '';
  for (let i = 0; i < hex.length; i += 2) {
    str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  }
  return str;
}

// ─── XRPL transaction fetch (client-side HTTP) ────────────────

async function fetchXRPLTransaction(txId: string, network: string): Promise<any> {
  const endpoint = XRPL_HTTP_ENDPOINTS[network] || XRPL_HTTP_ENDPOINTS.testnet;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'tx', params: [{ transaction: txId, binary: false }] }),
    });
    if (!response.ok) throw new Error(`XRPL API error: ${response.status}`);
    const data = await response.json();
    return data.result;
  } catch (error) {
    console.error('[client-verify] XRPL fetch error:', error);
    return null;
  }
}

function parseNotarizationFromTx(txData: any): { leaf?: string; salt?: string; fileName?: string } {
  const result: { leaf?: string; salt?: string; fileName?: string } = {};
  if (txData.InvoiceID) result.leaf = txData.InvoiceID;
  if (txData.Memos) {
    for (const memoWrapper of txData.Memos) {
      const memo = memoWrapper.Memo;
      if (memo?.MemoType) {
        try {
          const memoType = hexToString(memo.MemoType);
          if (memoType === 'cappz.notary.v1' && memo.MemoData) {
            const payload = JSON.parse(hexToString(memo.MemoData));
            result.leaf = payload.leaf || result.leaf;
            result.salt = payload.salt_b64u || payload.salt;
            result.fileName = payload.file_name;
          }
        } catch { /* skip malformed memo */ }
      }
    }
  }
  return result;
}

// ─── Public API ────────────────────────────────────────────────

export async function verifyClient(request: VerificationRequest): Promise<VerificationResult> {
  const network = request.network || 'testnet';
  const result: VerificationResult = { success: true, verified: false, method: 'hash' };

  // Method 1: Verify by XRPL transaction ID (fully client-side)
  if (request.txId) {
    result.method = 'txid';
    result.txId = request.txId;
    const txData = await fetchXRPLTransaction(request.txId, network);
    if (txData && !txData.error) {
      const parsed = parseNotarizationFromTx(txData);
      result.validated = txData.validated || false;
      result.ledgerIndex = txData.ledger_index;
      result.onChainLeaf = parsed.leaf;
      result.anchorAccount = txData.Account;
      if (txData.date) {
        const rippleEpoch = 946684800;
        result.timestamp = new Date((txData.date + rippleEpoch) * 1000).toISOString();
      }
      result.verified = result.validated === true && !!parsed.leaf;
      if (request.expectedLeaf && parsed.leaf) {
        result.matchesExpected = parsed.leaf.toUpperCase() === request.expectedLeaf.toUpperCase();
        result.verified = result.verified && result.matchesExpected;
      }
    } else {
      result.error = 'Transaction not found on XRPL';
    }
    return result;
  }

  // Method 2: Verify by content hash against the durable device wallet store.
  // The former hosted archive is absent and must never be treated as authority.
  if (request.contentHash) {
    result.method = 'hash';
    result.leaf = request.contentHash.toUpperCase();
    const local = await findNotaryReceiptByHash(result.leaf, network).catch(() => null);
    if (local) {
      result.verified = true;
      result.notarizationRecord = {
        id: String(local.id ?? ''),
        userWallet: String(local.user_wallet ?? ''),
        fileName: local.file_name as string | undefined,
        createdAt: String(local.created_at ?? ''),
        status: String(local.status ?? ''),
      };
      return result;
    }
    result.error = 'No wallet receipt found for this hash. Use the transaction ID for ledger verification.';
    return result;
  }

  // Method 3: Recompute hash from content (fully client-side)
  const source: DigestSource | null = request.file ?? request.fileBytes
    ?? (typeof request.fileBase64 === 'string' ? bytesFromBase64(request.fileBase64) : null)
    ?? (typeof request.content === 'string' ? new TextEncoder().encode(request.content) : null);
  if (source && request.salt) {
    result.method = 'recompute';
    const computedHash = await computeSaltedHash(source, request.salt, { onProgress: request.onProgress, kernels: request.kernels });
    result.leaf = computedHash;
    if (request.expectedLeaf) {
      result.matchesExpected = computedHash === request.expectedLeaf.toUpperCase();
      result.verified = result.matchesExpected;
    } else {
      result.verified = false; // Computing a hash alone is not comparison or ledger proof.
    }
    return result;
  }

  result.success = false;
  result.error = 'Provide txId, contentHash, or (file/fileBytes/content + salt)';
  return result;
}
