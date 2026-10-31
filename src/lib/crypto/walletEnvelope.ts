/**
 * COPE node crystallized.
 * Node ID: v15-17-00-wallet-envelope
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Data keys wrapped by a wallet. Each record gets a fresh random 256-bit data
 * key; the data key encrypts the record (AES-256-GCM) and is itself wrapped
 * (AES-256-GCM) under a key-encryption key derived from the wallet's private
 * key with HKDF-SHA-256. The wrapped key travels with the record, so nothing
 * else is stored, and the recovery phrase recovers every record on any device.
 *
 *   'cw1.' + base64( kekIv[12] || wrappedDataKey[48] || dataIv[12] || ciphertext+tag )
 *
 * `context` (purpose, wallet, scope) is the HKDF info and the associated data
 * of both encryptions: a record cannot be opened as another purpose's record
 * or under another wallet. Wrapping per record also leaves room to grant a
 * record to another wallet later by wrapping its data key again.
 *
 * Unlike keys derived from an address or a content hash, nothing here can be
 * computed from public values: opening needs the wallet's private key.
 *
 * 15.18.0 (v15-18-00-shared-envelope): sealForRecipients / openSharedEnvelope
 * ('cw2.') wrap one data key for the owner and for each recipient's declared
 * P-256 encryption key; walletEncryptionKey derives that key from the wallet.
 */
import { p256 } from '@noble/curves/p256';
import { openBytesWith, p256JwkFromHex, sealBytesTo, type CompactSealedBox } from './sealedBox';

export const WALLET_ENVELOPE_PREFIX = 'cw1.';
const LABEL = 'cappz.wallet-envelope.v1';
const te = new TextEncoder();
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function keyEncryptionKey(walletPrivateKey: Uint8Array, context: string): Promise<CryptoKey> {
  if (walletPrivateKey.length < 32) throw new Error('wallet envelope: wallet private key must be at least 32 bytes');
  const ikm = await crypto.subtle.importKey('raw', buf(walletPrivateKey), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: buf(te.encode(LABEL)), info: buf(te.encode(context)) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export const isWalletEnvelope = (stored: string) => stored.startsWith(WALLET_ENVELOPE_PREFIX);

/** Encrypt `plain` so that only `walletPrivateKey` (with the same `context`) opens it. */
export async function sealForWallet(plain: Uint8Array, walletPrivateKey: Uint8Array, context: string): Promise<string> {
  const aad = buf(te.encode(context));
  const dataKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  try {
    const kekIv = crypto.getRandomValues(new Uint8Array(12));
    const dataIv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(kekIv), additionalData: aad }, await keyEncryptionKey(walletPrivateKey, context), buf(dataKeyBytes)));
    const dataKey = await crypto.subtle.importKey('raw', buf(dataKeyBytes), 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(dataIv), additionalData: aad }, dataKey, buf(plain)));
    const out = new Uint8Array(12 + wrapped.length + 12 + ct.length);
    out.set(kekIv); out.set(wrapped, 12); out.set(dataIv, 12 + wrapped.length); out.set(ct, 24 + wrapped.length);
    return WALLET_ENVELOPE_PREFIX + toBase64(out);
  } finally {
    dataKeyBytes.fill(0);
  }
}

/** Open a record sealed by sealForWallet. Null for the wrong wallet, the wrong context or changed bytes. */
export async function openForWallet(stored: string, walletPrivateKey: Uint8Array, context: string): Promise<Uint8Array | null> {
  if (!isWalletEnvelope(stored)) return null;
  let dataKeyBytes: Uint8Array | null = null;
  try {
    const raw = fromBase64(stored.slice(WALLET_ENVELOPE_PREFIX.length));
    if (raw.length < 12 + 48 + 12 + 16) return null;
    const aad = buf(te.encode(context));
    dataKeyBytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(raw.subarray(0, 12)), additionalData: aad }, await keyEncryptionKey(walletPrivateKey, context), buf(raw.subarray(12, 60))));
    const dataKey = await crypto.subtle.importKey('raw', buf(dataKeyBytes), 'AES-GCM', false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(raw.subarray(60, 72)), additionalData: aad }, dataKey, buf(raw.subarray(72))));
  } catch {
    return null;
  } finally {
    dataKeyBytes?.fill(0);
  }
}

// ─── Shared records: one data key, wrapped for the owner and each recipient ───

export const SHARED_ENVELOPE_PREFIX = 'cw2.';

/** A recipient: an id (its wallet address) and its KeyZ-declared P-256 encryption key (SEC1 uncompressed hex). */
export interface EnvelopeRecipient { id: string; publicKey: string }

interface SharedEnvelope {
  v: 2;
  iv: string;
  ct: string;
  wraps: Array<{ to: 'owner'; kind: 'wallet'; sealed: string } | { to: string; kind: 'p256'; box: CompactSealedBox }>;
}

const b64u = (b: Uint8Array) => toBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => fromBase64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

/**
 * Encrypt `plain` once and give each party its own wrap of the data key:
 * the owner's wallet (as sealForWallet) and every recipient's declared P-256
 * encryption key (ECDH sealed box). `context` is the associated data of the
 * record, so a wrap cannot be moved onto another record's ciphertext.
 * Verify each recipient's key declaration (purpose 'encryption') first.
 */
export async function sealForRecipients(plain: Uint8Array, context: string, o: { ownerPrivateKey?: Uint8Array; recipients: readonly EnvelopeRecipient[] }): Promise<string> {
  if (!o.ownerPrivateKey && !o.recipients.length) throw new Error('shared envelope: nobody to seal for');
  const dataKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const dataKey = await crypto.subtle.importKey('raw', buf(dataKeyBytes), 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(te.encode(context)) }, dataKey, buf(plain)));
    const wraps: SharedEnvelope['wraps'] = [];
    if (o.ownerPrivateKey) wraps.push({ to: 'owner', kind: 'wallet', sealed: await sealForWallet(dataKeyBytes, o.ownerPrivateKey, `${context}|data-key`) });
    for (const r of o.recipients) wraps.push({ to: r.id, kind: 'p256', box: await sealBytesTo(r.publicKey.toLowerCase(), dataKeyBytes) });
    const env: SharedEnvelope = { v: 2, iv: b64u(iv), ct: b64u(ct), wraps };
    return SHARED_ENVELOPE_PREFIX + b64u(te.encode(JSON.stringify(env)));
  } finally {
    dataKeyBytes.fill(0);
  }
}

function parseShared(stored: string): SharedEnvelope | null {
  if (!stored.startsWith(SHARED_ENVELOPE_PREFIX)) return null;
  try {
    const env = JSON.parse(new TextDecoder().decode(unb64u(stored.slice(SHARED_ENVELOPE_PREFIX.length)))) as SharedEnvelope;
    return env.v === 2 && Array.isArray(env.wraps) ? env : null;
  } catch {
    return null;
  }
}

/** Who can open a shared record ('owner' and recipient ids). */
export function envelopeRecipients(stored: string): string[] {
  return parseShared(stored)?.wraps.map((w) => w.to) ?? [];
}

/**
 * Open a shared record as its owner (wallet private key) or as a recipient
 * (its id and its encryption private key, from walletEncryptionKey). Null
 * when this party has no wrap, the key is wrong, or the record was changed.
 */
export async function openSharedEnvelope(stored: string, context: string, as: { ownerPrivateKey: Uint8Array } | { recipientId: string; encryptionPrivateKey: JsonWebKey }): Promise<Uint8Array | null> {
  const env = parseShared(stored);
  if (!env) return null;
  let dataKeyBytes: Uint8Array | null = null;
  try {
    if ('ownerPrivateKey' in as) {
      const w = env.wraps.find((x) => x.to === 'owner' && x.kind === 'wallet') as { sealed: string } | undefined;
      dataKeyBytes = w ? await openForWallet(w.sealed, as.ownerPrivateKey, `${context}|data-key`) : null;
    } else {
      const w = env.wraps.find((x) => x.to === as.recipientId && x.kind === 'p256') as { box: CompactSealedBox } | undefined;
      dataKeyBytes = w ? await openBytesWith(as.encryptionPrivateKey, w.box) : null;
    }
    if (!dataKeyBytes || dataKeyBytes.length !== 32) return null;
    const dataKey = await crypto.subtle.importKey('raw', buf(dataKeyBytes), 'AES-GCM', false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(unb64u(env.iv)), additionalData: buf(te.encode(context)) }, dataKey, buf(unb64u(env.ct))));
  } catch {
    return null;
  } finally {
    dataKeyBytes?.fill(0);
  }
}

/**
 * A wallet's P-256 encryption key, derived from its private key (HKDF, then
 * reduced into the curve's scalar range), so the recovery phrase recovers it
 * on any device. Publish `publicKey` with a KeyZ declaration (purpose
 * 'encryption', algorithm 'p256') so others can seal records to it.
 */
export async function walletEncryptionKey(walletPrivateKey: Uint8Array): Promise<{ publicKey: string; privateKey: JsonWebKey }> {
  const ikm = await crypto.subtle.importKey('raw', buf(walletPrivateKey), 'HKDF', false, ['deriveBits']);
  const okm = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(te.encode(LABEL)), info: buf(te.encode('cappz.wallet-encryption-key.p256.v1')) }, ikm, 384));
  // 48 bytes reduced mod n leaves a negligible bias (FIPS 186-5 A.2.1 style).
  const n = p256.CURVE.n;
  let d = 0n;
  for (const b of okm) d = (d << 8n) | BigInt(b);
  d = (d % (n - 1n)) + 1n;
  okm.fill(0);
  const dBytes = new Uint8Array(32);
  for (let i = 31, x = d; i >= 0; i--, x >>= 8n) dBytes[i] = Number(x & 0xffn);
  const point = p256.getPublicKey(dBytes, false);
  const jwk = { ...p256JwkFromHex(Array.from(point, (b) => b.toString(16).padStart(2, '0')).join('')), d: b64u(dBytes) };
  dBytes.fill(0);
  return { publicKey: Array.from(point, (b) => b.toString(16).padStart(2, '0')).join(''), privateKey: jwk };
}
