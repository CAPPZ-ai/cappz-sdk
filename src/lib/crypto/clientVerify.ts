/**
 * Client-Side Verification — Zero-server cryptographic verification.
 * 
 * Migrated from edge function `cappz-verify` for Phase 12e.
 * All hash computation and XRPL transaction lookup runs in-browser.
 * Hash receipt lookup reads the wallet only; ledger checks require public XRPL connectivity.
 */

import { findNotaryReceiptByHash } from './clientNotarize';

// ─── Types ─────────────────────────────────────────────────────

export interface VerificationRequest {
  txId?: string;
  contentHash?: string;
  content?: string;
  fileBase64?: string;
  salt?: string;
  expectedLeaf?: string;
  network?: 'mainnet' | 'testnet' | 'devnet';
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

export async function computeSaltedHash(content: Uint8Array, salt: string): Promise<string> {
  const saltBytes = new TextEncoder().encode(salt);
  const combined = new Uint8Array(saltBytes.length + content.length);
  combined.set(saltBytes);
  combined.set(content, saltBytes.length);
  const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
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
  if ((typeof request.content === 'string' || typeof request.fileBase64 === 'string') && request.salt) {
    result.method = 'recompute';
    let contentBytes: Uint8Array;
    if (request.fileBase64) {
      const binaryString = atob(request.fileBase64);
      contentBytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        contentBytes[i] = binaryString.charCodeAt(i);
      }
    } else {
      contentBytes = new TextEncoder().encode(request.content ?? '');
    }
    const computedHash = await computeSaltedHash(contentBytes, request.salt);
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
  result.error = 'Provide txId, contentHash, or (content/fileBase64 + salt)';
  return result;
}
