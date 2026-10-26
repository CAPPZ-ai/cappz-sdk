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
 */

import { x25519 } from '@noble/curves/ed25519';

export interface ChannelKeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

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

export function generateChannelKeyPair(): ChannelKeyPair {
  const secretKey = x25519.utils.randomPrivateKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** Derive the channel key from a wallet secret (in memory only, never stored). */
export async function channelKeyFromWalletSecret(walletSecret: Uint8Array): Promise<ChannelKeyPair> {
  const base = await crypto.subtle.importKey('raw', walletSecret as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('cappz-a2a-channel'), info: enc.encode('x25519') },
    base,
    256,
  );
  const secretKey = new Uint8Array(bits);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
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
}): Promise<SecureChannel> {
  const shared = x25519.getSharedSecret(opts.mine.secretKey, opts.peerPublicKey);
  const iAmLow = compareBytes(opts.mine.publicKey, opts.peerPublicKey) < 0;
  const [low, high] = iAmLow ? [opts.mine.publicKey, opts.peerPublicKey] : [opts.peerPublicKey, opts.mine.publicKey];
  const base = await crypto.subtle.importKey('raw', shared as BufferSource, 'HKDF', false, ['deriveKey']);
  const derive = (label: string) =>
    crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: enc.encode(opts.sessionId),
        info: enc.encode(`${label}:${toHex(low)}:${toHex(high)}`),
      },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  const lowToHigh = await derive('low->high');
  const highToLow = await derive('high->low');
  return iAmLow
    ? new SecureChannel(opts.sessionId, 0, lowToHigh, highToLow)
    : new SecureChannel(opts.sessionId, 1, highToLow, lowToHigh);
}

export { toB64 as bytesToB64, fromB64 as b64ToBytes };
