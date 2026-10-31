/**
 * COPE node crystallized.
 * Node ID: v15-03-00-hello-signature
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Ed25519 signatures for the transport hello and the UDP LAN beacon, over
 * WebCrypto so the same code runs in browsers, Deno (edge node), Bun and
 * Node. Same key format as the edge node's signed TX log: raw public key
 * as hex, private key as a CryptoKey (PKCS8 when loaded from env).
 *
 * The signature covers sha256(canonical JSON), so field order never matters.
 * A check returns a lifecycle state, not a boolean: a valid signature from a
 * key nobody vouched for ('verified-unbound') is not the same as one from a
 * key the wallet declared ('verified-bound').
 *
 * v15-04-01: browsers without WebCrypto Ed25519 (iOS Safari before 17,
 * Chrome before 137) threw "The operation is not supported" on the first
 * key. Generation, signing and verification now fall back to a pure-JS
 * Ed25519 (@noble/curves); Ed25519 is deterministic, so both paths produce
 * and accept the same signatures.
 */

import { canonicalHelloJson, type TransportHello } from './transportContract.ts';
import { buildBeaconPayload, type UdpBeacon } from './discovery/discoveryPlugins.ts';
import { ed25519 } from '@noble/curves/ed25519';
import { activeKernels } from '../native/cappzNative';

export type SignatureCheck =
  | 'verified-bound'   // valid, and the key is one the wallet declared
  | 'verified-unbound' // valid, but no declared key list was available to bind it
  | 'unsigned'         // no signature or public key
  | 'bad-signature'    // signature does not verify against the public key
  | 'wrong-key'        // valid, but the key is not among the wallet's declared keys
  | 'stale';           // valid, but sentAt is outside the freshness window

export const HELLO_MAX_AGE_MS = 10 * 60_000;

/** A WebCrypto key where the runtime has Ed25519, else the raw 32-byte secret (memory only). */
export interface SigningKey { publicKeyHex: string; privateKey?: CryptoKey; secretKey?: Uint8Array }

let webCryptoEd25519: Promise<boolean> | null = null;
/** Does this runtime's WebCrypto do Ed25519? Probed once. */
export function hasWebCryptoEd25519(): Promise<boolean> {
  return (webCryptoEd25519 ??= (async () => {
    try { await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']); return true; } catch { return false; }
  })());
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => {
  if (!/^(?:[0-9a-f]{2})+$/i.test(h)) throw new Error('not hex');
  return Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));
};
const buf = (b: Uint8Array) => { const c = new Uint8Array(b.byteLength); c.set(b); return c.buffer; };

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** New device key (tests, demos, a copy without a declared key yet). */
export async function generateSigningKey(): Promise<SigningKey> {
  if (await hasWebCryptoEd25519()) {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    return { privateKey: pair.privateKey, publicKeyHex: hex(raw) };
  }
  const secretKey = ed25519.utils.randomPrivateKey();
  return { secretKey, publicKeyHex: hex(ed25519.getPublicKey(secretKey)) };
}

/** PKCS8 base64 (CAPPZ_NODE_KEY) + raw hex public key (CAPPZ_NODE_PUB). */
export async function importSigningKey(pkcs8Base64: string, publicKeyHex: string): Promise<SigningKey & { privateKey: CryptoKey }> {
  const der = Uint8Array.from(atob(pkcs8Base64), (c) => c.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey('pkcs8', buf(der), { name: 'Ed25519' }, false, ['sign']);
  return { privateKey, publicKeyHex };
}

async function signBytes(key: SigningKey, bytes: Uint8Array): Promise<string> {
  if (key.privateKey) return hex(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, buf(bytes))));
  if (key.secretKey) return hex(ed25519.sign(bytes, key.secretKey));
  throw new Error('signing key has no private part');
}

async function verifyBytes(publicKeyHex: string, signatureHex: string, bytes: Uint8Array): Promise<boolean> {
  try {
    const pub = unhex(publicKeyHex); const sig = unhex(signatureHex);
    // Native kernels (ed25519-dalek, strict) where loaded; never accept more than WebCrypto would.
    const kernels = activeKernels();
    if (kernels.backend === 'native') return kernels.ed25519VerifyMany([{ message: bytes, signature: sig, publicKey: pub }])[0];
    if (!(await hasWebCryptoEd25519())) return ed25519.verify(sig, bytes, pub);
    const key = await crypto.subtle.importKey('raw', buf(pub), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, buf(sig), buf(bytes));
  } catch {
    return false;
  }
}

/** Test hook: pretend WebCrypto has (or lacks) Ed25519. */
export function __setWebCryptoEd25519ForTests(available: boolean | null) { webCryptoEd25519 = available === null ? null : Promise.resolve(available); }

/** Sign sha256(text) with a device key (any canonical record, e.g. an endpoint record). */
export async function signCanonical(text: string, key: SigningKey): Promise<string> {
  return signBytes(key, await digest(text));
}

/** Verify a signCanonical signature. */
export async function verifyCanonical(text: string, signatureHex: string, publicKeyHex: string): Promise<boolean> {
  return verifyBytes(publicKeyHex, signatureHex, await digest(text));
}

/** Sign a hello: fills publicKey, then signs sha256(canonicalHelloJson). */
export async function signHello(hello: Omit<TransportHello, 'signature' | 'publicKey'>, key: SigningKey): Promise<TransportHello> {
  const unsigned = { ...hello, publicKey: key.publicKeyHex };
  return { ...unsigned, signature: await signBytes(key, await digest(canonicalHelloJson(unsigned))) };
}

export interface VerifyOptions {
  /** Keys the wallet declared (UserSessionCreated device keys, node POW key). null/undefined = unknown. */
  declaredKeys?: readonly string[] | null;
  maxAgeMs?: number;
  now?: number;
}

export async function verifyHello(hello: TransportHello | undefined, opts: VerifyOptions = {}): Promise<SignatureCheck> {
  if (!hello?.signature || !hello.publicKey) return 'unsigned';
  const { signature, ...unsigned } = hello;
  if (!(await verifyBytes(hello.publicKey, signature, await digest(canonicalHelloJson(unsigned))))) return 'bad-signature';
  const age = (opts.now ?? Date.now()) - Date.parse(hello.sentAt);
  if (!Number.isFinite(age) || Math.abs(age) > (opts.maxAgeMs ?? HELLO_MAX_AGE_MS)) return 'stale';
  return bindCheck(hello.publicKey, opts.declaredKeys);
}

/** Sign a UDP beacon over buildBeaconPayload (sha256 of its canonical JSON). */
export async function signBeacon(beacon: Omit<UdpBeacon, 'signature' | 'publicKey'>, key: SigningKey): Promise<UdpBeacon> {
  const unsigned = { ...beacon, publicKey: key.publicKeyHex };
  return { ...unsigned, signature: await signBytes(key, unhex(await buildBeaconPayload(unsigned))) };
}

export async function verifyBeacon(beacon: UdpBeacon, opts: VerifyOptions = {}): Promise<SignatureCheck> {
  if (!beacon?.signature || !beacon.publicKey) return 'unsigned';
  const { signature, ...unsigned } = beacon;
  if (!(await verifyBytes(beacon.publicKey, signature, unhex(await buildBeaconPayload(unsigned))))) return 'bad-signature';
  const age = (opts.now ?? Date.now()) - Date.parse(beacon.sentAt);
  if (!Number.isFinite(age) || Math.abs(age) > (opts.maxAgeMs ?? HELLO_MAX_AGE_MS)) return 'stale';
  return bindCheck(beacon.publicKey, opts.declaredKeys);
}

function bindCheck(publicKey: string, declared: readonly string[] | null | undefined): SignatureCheck {
  if (!declared) return 'verified-unbound';
  return declared.some((k) => k.toLowerCase() === publicKey.toLowerCase()) ? 'verified-bound' : 'wrong-key';
}

/** States a node may carry under a policy. */
export function acceptsSignature(check: SignatureCheck, requireBound: boolean): boolean {
  return check === 'verified-bound' || (!requireBound && check === 'verified-unbound');
}
