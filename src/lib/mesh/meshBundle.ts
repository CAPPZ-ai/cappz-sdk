/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-bundle
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * The unit a resilience mesh stores, carries and forwards: a bundle in the
 * delay-tolerant sense (RFC 9171 shape, CAPPZ trust). There is no end-to-end
 * path to wait for; a bundle moves one contact at a time, on whatever link two
 * devices share, and may sit in a phone's store for hours.
 *
 * The header is signed by the sender's device key (Ed25519). The device key is
 * bound to the sender's wallet by the KeyZ declaration the bundle carries, and
 * the wallet's role by the membership grant it carries, so every hop verifies
 * the bundle offline with only the mesh charter provisioned. The body is
 * covered by its hash: sealed to the recipient's declared encryption key
 * (direct), under a channel key (members), or clear (public alerts).
 *
 * `hops` and `copies` change at every hop and are not signed. A relay can
 * misstate them; expiry and per-hop dedupe bound what that buys.
 */

import { canonicalJson, sha256HexOf, toBase64Url, fromBase64Url, utf8 } from '../identity/canonical.ts';
import { signCanonical, verifyCanonical, type SigningKey } from '../sync/helloSignature.ts';
import type { KeyDeclaration } from '../identity/keyDeclaration.ts';
import type { HelloKeyDeclaration } from '../sync/helloKeyDeclaration.ts';
import { sealBytesTo, openBytesWith, encryptBytes, decryptBytes, type CompactSealedBox } from '../crypto/sealedBox.ts';
import { recipientTag, type MeshMembership, type Precedence } from './meshIdentity.ts';

export type BundleKind =
  | 'msg'              // application payload
  | 'ack'              // delivery receipt from the recipient: purges carried copies (an anti-packet)
  | 'key-revocation'   // a KeyZ KeyRevocation, gossiped so revoked device keys stop being carried
  | 'mesh-revocation'  // a MeshMembershipRevocation
  | 'contact';         // a member's encryption key declaration, so others can seal to it

export type BundleDestination =
  | { t: 'wallet'; tag: string }
  | { t: 'channel'; ch: string };

export type BodyEncoding = 'clear' | 'sealed' | 'channel';

export interface MeshBundleHeader {
  v: 1;
  meshId: string;
  kind: BundleKind;
  src: string;          // sender wallet address
  key: string;          // sender device key (Ed25519 hex)
  seq: number;          // per device key, increasing
  to: BundleDestination;
  prec: Precedence;
  created: number;      // ms since epoch
  expires: number;
  enc: BodyEncoding;
  bodyHash: string;     // sha256 hex of the body string as carried
  bodyBytes: number;
}

export interface MeshCredentials {
  decl: KeyDeclaration | HelloKeyDeclaration;
  grant?: MeshMembership;
}

export interface MeshBundle {
  h: MeshBundleHeader;
  sig: string;
  body: string;
  cred: MeshCredentials;
  hops: number;
  copies: number;
}

/** Bundle id: hash of the signed header. Same id ⇒ same bundle, whatever the hop fields say. */
export function bundleId(h: MeshBundleHeader): Promise<string> {
  return sha256HexOf(canonicalJson(h));
}

export interface SenderIdentity {
  walletAddress: string;
  deviceKey: SigningKey;
  credentials: MeshCredentials;
}

export interface NewBundle {
  meshId: string;
  kind?: BundleKind;
  to: { wallet: string; encryptionKey?: string } | { channel: string; channelKey?: string };
  prec: Precedence;
  body: Uint8Array;
  ttlMs: number;
  copies?: number;
  /** Direct bundles are sealed unless the caller says the body is public. */
  clear?: boolean;
}

export async function createBundle(sender: SenderIdentity, seq: number, b: NewBundle, now = Date.now()): Promise<{ id: string; bundle: MeshBundle }> {
  let body: string; let enc: BodyEncoding; let to: BundleDestination;
  if ('wallet' in b.to) {
    to = { t: 'wallet', tag: await recipientTag(b.meshId, b.to.wallet) };
    if (b.clear) { body = toBase64Url(b.body); enc = 'clear'; }
    else {
      if (!b.to.encryptionKey) throw new Error('no declared encryption key for the recipient: pass clear: true for a public body');
      body = canonicalJson(await sealBytesTo(b.to.encryptionKey, b.body)); enc = 'sealed';
    }
  } else {
    to = { t: 'channel', ch: b.to.channel };
    if (b.to.channelKey) { body = canonicalJson(await encryptBytes(b.to.channelKey, b.body)); enc = 'channel'; }
    else { body = toBase64Url(b.body); enc = 'clear'; }
  }
  const h: MeshBundleHeader = {
    v: 1, meshId: b.meshId, kind: b.kind ?? 'msg', src: sender.walletAddress, key: sender.deviceKey.publicKeyHex.toLowerCase(), seq, to, prec: b.prec,
    created: now, expires: now + b.ttlMs, enc, bodyHash: await sha256HexOf(body), bodyBytes: b.body.byteLength,
  };
  const sig = await signCanonical(canonicalJson(h), sender.deviceKey);
  return { id: await bundleId(h), bundle: { h, sig, body, cred: sender.credentials, hops: 0, copies: b.copies ?? 1 } };
}

/** Device-key signature over the header, and the body against its hash. Trust in the key is the gate's job. */
export async function bundleSignatureValid(b: MeshBundle): Promise<boolean> {
  return verifyCanonical(canonicalJson(b.h), b.sig, b.h.key);
}

export async function bodyMatches(b: MeshBundle): Promise<boolean> {
  return (await sha256HexOf(b.body)) === b.h.bodyHash;
}

export interface OpenKeys { encryptionPrivateKey?: JsonWebKey; channelKeys?: Record<string, string> }

/** Recover the body bytes. Throws when the node lacks the key. */
export async function openBody(b: MeshBundle, keys: OpenKeys): Promise<Uint8Array> {
  if (b.h.enc === 'clear') return fromBase64Url(b.body);
  if (b.h.enc === 'sealed') {
    if (!keys.encryptionPrivateKey) throw new Error('no encryption key to open a sealed body');
    return openBytesWith(keys.encryptionPrivateKey, JSON.parse(b.body) as CompactSealedBox);
  }
  const ch = b.h.to.t === 'channel' ? b.h.to.ch : '';
  const k = keys.channelKeys?.[ch];
  if (!k) throw new Error(`no key for channel ${ch}`);
  return decryptBytes(k, JSON.parse(b.body));
}

export const jsonBody = (v: unknown) => utf8(canonicalJson(v));
export const readJsonBody = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder().decode(bytes)) as T;

/** Wire size of a bundle as JSON (what a link carries, before CPZ1 framing or fragmentation). */
export function bundleWireBytes(b: MeshBundle): number {
  return utf8(JSON.stringify(b)).byteLength;
}
