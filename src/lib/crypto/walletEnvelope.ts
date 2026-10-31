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
 */
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
