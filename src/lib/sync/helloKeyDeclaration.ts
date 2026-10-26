/**
 * COPE node crystallized.
 * Node ID: v15-04-00-hello-key-declaration
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * A wallet declares which device keys speak for it. The declaration binds
 * an Ed25519 device key (the one that signs transport hellos) to the wallet
 * and is signed with the wallet's own secp256k1 key — the sign-in address
 * IS that public key (lib/auth/wallet/session.ts) — so anyone can verify it
 * offline: no registry, no file, no lookup.
 *
 * A copy presents its declaration with the hello; a relay or peer that
 * verifies it treats the key as declared ('verified-bound'). The same
 * declaration is published on the wallet's TransportCapabilityDeclared
 * record (transportCapabilities.ts) for anyone replaying the wallet.
 * Declarations expire (default 90 days), which bounds a lost device key.
 */

import { signMessage, verifySignature } from '../auth/wallet/session.ts';

export interface HelloKeyDeclaration {
  v: 1;
  walletAddress: string;
  devicePublicKey: string;
  issuedAt: string;
  expiresAt: string;
  /** secp256k1 signature by the wallet key over canonicalDeclaration(). */
  signature: string;
}

export type DeclarationCheck = 'valid' | 'bad-signature' | 'expired' | 'not-yet-valid' | 'malformed';

export const DECLARATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function canonicalDeclaration(d: Omit<HelloKeyDeclaration, 'signature'>): string {
  return JSON.stringify({ devicePublicKey: d.devicePublicKey.toLowerCase(), expiresAt: d.expiresAt, issuedAt: d.issuedAt, v: 1, walletAddress: d.walletAddress });
}

/** Sign with the wallet key (memory only). walletAddress is the compressed secp256k1 public key hex. */
export async function declareHelloKey(walletPrivateKey: Uint8Array, walletAddress: string, devicePublicKey: string, ttlMs = DECLARATION_TTL_MS, now = Date.now()): Promise<HelloKeyDeclaration> {
  const body = { v: 1 as const, walletAddress, devicePublicKey: devicePublicKey.toLowerCase(), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString() };
  return { ...body, signature: await signMessage(walletPrivateKey, canonicalDeclaration(body)) };
}

export async function verifyHelloKeyDeclaration(d: HelloKeyDeclaration | undefined | null, now = Date.now()): Promise<DeclarationCheck> {
  if (!d || d.v !== 1 || !d.walletAddress || !d.devicePublicKey || !d.signature) return 'malformed';
  const issued = Date.parse(d.issuedAt); const expires = Date.parse(d.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return 'malformed';
  if (!(await verifySignature(canonicalDeclaration(d), d.signature, d.walletAddress))) return 'bad-signature';
  if (issued - 5 * 60_000 > now) return 'not-yet-valid';
  if (expires <= now) return 'expired';
  return 'valid';
}

/** The device keys a wallet declared, from the declarations a copy presented (only valid ones count). */
export async function declaredKeysFromDeclarations(walletAddress: string, declarations: Array<HelloKeyDeclaration | undefined>, now = Date.now()): Promise<string[]> {
  const out: string[] = [];
  for (const d of declarations) {
    if (d?.walletAddress === walletAddress && (await verifyHelloKeyDeclaration(d, now)) === 'valid') out.push(d.devicePublicKey.toLowerCase());
  }
  return out;
}
