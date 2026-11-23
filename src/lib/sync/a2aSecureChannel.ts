/**
 * COPE node crystallized.
 * Node ID: v12-21-00-a2a-secure-channel
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Transport-agnostic encrypted channel between two wallet copies — no TLS.
 * Both sides hold their own wallet keys: a channel key (X25519) is derived
 * in memory from the wallet secret, ECDH gives a shared secret, HKDF splits
 * it into one key per direction, and each frame is AES-GCM sealed with a
 * counter nonce (Noise-style). Whatever carries the frames — direct peer,
 * relay, store-and-forward — only ever sees ciphertext. A replayed or
 * reordered frame (counter not strictly increasing) is rejected.
 * Nothing here is persisted; keys live only for the session.
 *
 * v16-02-00 (post-quantum): a channel key may carry an ML-KEM-768 key (FIPS
 * 203). When the responder has one, the initiator encapsulates to it
 * (`channelKemOffer`) and sends the ciphertext with its hello; both sides then
 * feed the X25519 secret AND the ML-KEM secret into HKDF, with the KEM
 * ciphertext bound into the info. Recorded frames stay closed unless both are
 * broken, so a future quantum computer does not open traffic captured today.
 * Without a KEM the channel is X25519 exactly as before (`suite` says which).
 */

import { x25519 } from '@noble/curves/ed25519.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

export interface ChannelKeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  /** ML-KEM-768 key for hybrid channels (the public half travels beside the X25519 key). */
  kem?: { publicKey: Uint8Array; secretKey: Uint8Array };
}

export type ChannelSuite = 'x25519' | 'x25519+ml-kem-768';

export interface SealedFrame {
  sessionId: string;
  dir: 0 | 1;
  counter: number;
  iv: string;
  ct: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 1) s += String.fromCharCode(u[i]);
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const toHex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}

export function generateChannelKeyPair(opts: { postQuantum?: boolean } = {}): ChannelKeyPair {
  const secretKey = x25519.utils.randomSecretKey();
  const pair: ChannelKeyPair = { secretKey, publicKey: x25519.getPublicKey(secretKey) };
  if (opts.postQuantum !== false) pair.kem = ml_kem768.keygen(crypto.getRandomValues(new Uint8Array(64)));
  return pair;
}

/** Initiator: encapsulate to the responder's ML-KEM key; send `cipherText`, keep `sharedSecret` for openSecureChannel. */
export function channelKemOffer(peerKemPublicKey: Uint8Array): { cipherText: Uint8Array; sharedSecret: Uint8Array } {
  return ml_kem768.encapsulate(peerKemPublicKey);
}

/** Responder: recover the shared secret from the initiator's ciphertext. */
export function channelKemAccept(mine: ChannelKeyPair, cipherText: Uint8Array): Uint8Array {
  if (!mine.kem) throw new Error('this channel key has no ML-KEM-768 half');
  return ml_kem768.decapsulate(cipherText, mine.kem.secretKey);
}

/**
 * Derive the channel key from a wallet secret (in memory only, never stored). The ML-KEM-768 half comes only from
 * `pqSeed` (WalletKeyPair.pqSeed): a wallet's address is its public key, so anything derived from its private key
 * is open to a quantum computer. Without pqSeed the key is X25519 only.
 */
export async function channelKeyFromWalletSecret(walletSecret: Uint8Array, pqSeed?: Uint8Array): Promise<ChannelKeyPair> {
  const base = await crypto.subtle.importKey('raw', walletSecret as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('cappz-a2a-channel'), info: enc.encode('x25519') },
    base,
    256,
  );
  const secretKey = new Uint8Array(bits);
  if (!pqSeed) return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
  const pqBase = await crypto.subtle.importKey('raw', pqSeed as BufferSource, 'HKDF', false, ['deriveBits']);
  const kemSeed = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('cappz-a2a-channel'), info: enc.encode('ml-kem-768') },
    pqBase,
    512,
  ));
  const kem = ml_kem768.keygen(kemSeed);
  kemSeed.fill(0);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey), kem };
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

export class SecureChannel {
  private sendCounter = 0;
  private lastRecv = -1;
  constructor(
    readonly sessionId: string,
    private readonly myDir: 0 | 1,
    private readonly sendKey: CryptoKey,
    private readonly recvKey: CryptoKey,
    readonly suite: ChannelSuite = 'x25519',
  ) {}

  private nonce(dir: number, counter: number): Uint8Array {
    const iv = new Uint8Array(12);
    iv[0] = dir;
    new DataView(iv.buffer).setUint32(8, counter);
    new DataView(iv.buffer).setUint32(4, Math.floor(counter / 2 ** 32));
    return iv;
  }

  async seal(payload: unknown): Promise<SealedFrame> {
    const counter = this.sendCounter++;
    const iv = this.nonce(this.myDir, counter);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: enc.encode(this.sessionId) },
      this.sendKey,
      enc.encode(JSON.stringify(payload)),
    );
    return { sessionId: this.sessionId, dir: this.myDir, counter, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
  }

  async open<T = unknown>(frame: SealedFrame): Promise<T> {
    if (frame.sessionId !== this.sessionId) throw new Error('frame for another session');
    if (frame.dir === this.myDir) throw new Error('frame from own direction');
    if (frame.counter <= this.lastRecv) throw new Error('replayed or reordered frame');
    const iv = this.nonce(frame.dir, frame.counter);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: enc.encode(this.sessionId) },
      this.recvKey,
      fromB64(frame.ct) as BufferSource,
    );
    this.lastRecv = frame.counter;
    return JSON.parse(dec.decode(pt)) as T;
  }
}

export async function openSecureChannel(opts: {
  sessionId: string;
  mine: ChannelKeyPair;
  peerPublicKey: Uint8Array;
  /** Hybrid: the ML-KEM secret (channelKemOffer on the initiator, channelKemAccept on the responder) and the ciphertext both sides saw. */
  pq?: { sharedSecret: Uint8Array; cipherText: Uint8Array };
}): Promise<SecureChannel> {
  const classical = x25519.getSharedSecret(opts.mine.secretKey, opts.peerPublicKey);
  const shared = opts.pq ? new Uint8Array([...classical, ...opts.pq.sharedSecret]) : classical;
  const suite: ChannelSuite = opts.pq ? 'x25519+ml-kem-768' : 'x25519';
  const kemTag = opts.pq ? `:${suite}:${await sha256Hex(opts.pq.cipherText)}` : '';
  const iAmLow = compareBytes(opts.mine.publicKey, opts.peerPublicKey) < 0;
  const [low, high] = iAmLow ? [opts.mine.publicKey, opts.peerPublicKey] : [opts.peerPublicKey, opts.mine.publicKey];
  const base = await crypto.subtle.importKey('raw', shared as BufferSource, 'HKDF', false, ['deriveKey']);
  const derive = (label: string) =>
    crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: enc.encode(opts.sessionId),
        info: enc.encode(`${label}:${toHex(low)}:${toHex(high)}${kemTag}`),
      },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  const lowToHigh = await derive('low->high');
  const highToLow = await derive('high->low');
  return iAmLow
    ? new SecureChannel(opts.sessionId, 0, lowToHigh, highToLow, suite)
    : new SecureChannel(opts.sessionId, 1, highToLow, lowToHigh, suite);
}

export { toB64 as bytesToB64, fromB64 as b64ToBytes };
