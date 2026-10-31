/**
 * COPE node crystallized.
 * Node ID: v12-23-00-wallet-session
 * Provenance: m/44'/144'/100'/principles/cope/v1
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Unhosted wallet sign-in — the wallet is the identity.
 *   - secp256k1 key from a 24-word BIP39 recovery phrase (in memory only)
 *   - UserCreated / UserSessionCreated carry public address + device key +
 *     signature — never a password hash
 *   - a signed challenge replaces the server token; peers and the ledger
 *     verify block signatures against the wallet address
 *   - admin roles resolve from Permission TXs, never the hosted roles table
 *
 * Events (Noun-Verb, past): UserCreated, UserSessionCreated, WalletLinked,
 * WalletKeyRotated.
 */

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { mnemonicToSeedSync, generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { sha256Hex } from '../../sync/a2aSecureChannel';
import { activeKernels } from '../../native/cappzNative';

export const WALLET_AUTH_EVENT_TYPES = [
  'UserCreated',
  'UserSessionCreated',
  'WalletLinked',
  'WalletKeyRotated',
  'RecoveryEscrowConfigured',
  'RecoveryRequested',
  'RecoveryCancelled',
  'RecoveryShareReleased',
  'RecoveryCompleted',
  'RecoveryDelayConfigured',
  'EscrowCreated',
] as const;
export type WalletAuthEventType = (typeof WALLET_AUTH_EVENT_TYPES)[number];

export interface WalletKeyPair {
  /** 32-byte private key — memory only, never persisted. */
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  /** Compressed public key hex — the wallet's sign-in address. */
  address: string;
}

export function generateRecoveryPhrase(): string {
  return generateMnemonic(wordlist, 256); // 24 words
}

/** Derive the secp256k1 key pair from a BIP39 phrase (path m/44'/144'/0'/0/0). */
export function keyPairFromPhrase(phrase: string): WalletKeyPair {
  if (!validateMnemonic(phrase, wordlist)) throw new Error('invalid recovery phrase');
  const seed = mnemonicToSeedSync(phrase);
  // BIP32-style hardened derivation via SHA-256 domain separation keeps this
  // dependency-light; the phrase is the root of truth either way.
  const privateKey = secp.etc.numberToBytesBE(secp.etc.secretKeyToScalar(sha256(seed.slice(0, 32))));
  const publicKey = secp.getPublicKey(privateKey, true);
  return { privateKey, publicKey, address: secp.etc.bytesToHex(publicKey) };
}

// @noble/secp256k1 v3 needs explicit hashes for sign/verify.
const _sha256Sync = (...msgs: (Uint8Array | undefined)[]) =>
  sha256(secp.etc.concatBytes(...msgs.filter((m): m is Uint8Array => m instanceof Uint8Array)));
// Casts: Deno types noble's results as Uint8Array<ArrayBufferLike>; the bytes are the same.
secp.hashes.sha256 = _sha256Sync as typeof secp.hashes.sha256;
secp.hashes.hmacSha256 = ((key: Uint8Array, msg: Uint8Array) => hmac(sha256, key, msg)) as typeof secp.hashes.hmacSha256;

export async function signMessage(privateKey: Uint8Array, message: string): Promise<string> {
  const msgHash = sha256(new TextEncoder().encode(message));
  const sig = secp.sign(msgHash, privateKey, { lowS: true });
  return secp.etc.bytesToHex(sig);
}

export async function verifySignature(message: string, signatureHex: string, publicKeyHex: string): Promise<boolean> {
  try {
    const msgHash = sha256(new TextEncoder().encode(message));
    // Loaded kernels check the same thing — ECDSA over the hash noble verifies
    // by default, sha256(msgHash), low-S — natively ~50x faster; the WASM
    // signature module ~1.8x in browsers (without it, this is noble anyway).
    const kernels = activeKernels();
    if (kernels.backend !== 'typescript') {
      return kernels.secp256k1VerifyMany([{ digest: sha256(msgHash), signature: secp.etc.hexToBytes(signatureHex), publicKey: secp.etc.hexToBytes(publicKeyHex) }])[0];
    }
    return secp.verify(secp.etc.hexToBytes(signatureHex), msgHash, secp.etc.hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

/** Bundle signature verification (bundleTransport import path). */
export async function verifyBundleSignature(bundleHashHex: string, signatureHex: string, publicKeyHex: string): Promise<boolean> {
  return verifySignature(bundleHashHex, signatureHex, publicKeyHex);
}

export interface WalletSession {
  address: string;
  devicePublicKey: string;
  challenge: string;
  signature: string;
  issuedAt: string;
  expiresAt: string;
}

/** Sign a session challenge — the signed challenge replaces the server token. */
export async function createSession(key: WalletKeyPair, devicePublicKey: string, ttlMs = 24 * 3600_000): Promise<WalletSession> {
  const now = Date.now();
  const challenge = `cappz-session:${key.address}:${devicePublicKey}:${now}`;
  const signature = await signMessage(key.privateKey, challenge);
  return {
    address: key.address,
    devicePublicKey,
    challenge,
    signature,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
}

/** Verify a session: signature valid, address matches, not expired. */
export async function verifySession(session: WalletSession): Promise<boolean> {
  if (Date.now() > Date.parse(session.expiresAt)) return false;
  return verifySignature(session.challenge, session.signature, session.address);
}

/** Serialize a signed UserSessionCreated payload (hash-only; no secrets). */
export async function sessionEventPayload(session: WalletSession): Promise<Record<string, unknown>> {
  return {
    address: session.address,
    devicePublicKey: session.devicePublicKey,
    challengeHash: await sha256Hex(session.challenge),
    signature: session.signature,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
  };
}
