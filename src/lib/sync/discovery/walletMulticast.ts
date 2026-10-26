/**
 * COPE node crystallized.
 * Node ID: v15-09-00-wallet-multicast
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * UDP kick-off for configured side channels. Each wallet has its own
 * multicast group, derived from its address the way its HD positions are —
 * reproducible, no allocation: IPv6 ff15::<112 bits of sha256> (transient,
 * site-local scope) and IPv4 239.192.0.0/14 (organization-local, RFC 2365).
 * 18 IPv4 bits collide at scale, so a group is only a hint: every datagram
 * names the full wallet and is signed, and receivers filter.
 *
 * A copy that wants to sync sends one signed ReplicaConnectRequested-shaped
 * datagram (≤ 1200 bytes) to the target wallet's group, naming the carriers
 * it can open (transport type ids, transportTypes.ts). A node holding that
 * wallet answers unicast with an offer listing where it accepts each carrier.
 * The offer is never larger than the request (no amplification) and carries
 * no secret: the side channel authenticates with its own signed hello.
 * The copy may open more than one offered carrier at once; frames are
 * checksummed and endpoints dedupe by id/hash, so the same frames on two
 * paths is safe ("multi-channel").
 *
 * v15-10-00: an endpoint on the sender's own address is offered as a port
 * only (`{ carrier, port }`) — the asker dials the address the offer came
 * from — so several carriers fit. An ask that wants several paths pads itself
 * (signed `pad`, as QUIC pads its Initial to 1200 bytes) so the answer may be
 * as large: amplification stays at most 1:1.
 *
 * The 239.44.144.100 LAN beacon (discoveryPlugins.ts) is unchanged.
 * Multicast never leaves the LAN; across networks the member table and the
 * TX bid/ask relay still apply.
 */

import { canonicalJson, sha256, toHex } from '../../identity/canonical.ts';
import { signCanonical, verifyCanonical, type SignatureCheck, type SigningKey } from '../helloSignature.ts';
import type { HelloKeyDeclaration } from '../helloKeyDeclaration.ts';
import { resolveTransportType } from '../transportTypes.ts';
export const UDP_DATAGRAM_MAX = 1200;
/** UDP port of wallet groups (the LAN beacon keeps 41440). */
export const WALLET_GROUP_PORT = 41448;
export const CONNECT_MAX_AGE_MS = 60_000;

export interface WalletGroup { walletAddress: string; ipv6: string; ipv4: string; port: number }

export async function walletMulticastGroup(walletAddress: string): Promise<WalletGroup> {
  const h = await sha256(new TextEncoder().encode(`cappz-multicast-v1|${walletAddress}`));
  const groups: string[] = [];
  for (let i = 0; i < 14; i += 2) groups.push(((h[i] << 8) | h[i + 1]).toString(16));
  const ipv6 = `ff15:${groups.join(':')}`;
  const v4 = ((h[14] << 16) | (h[15] << 8) | h[16]) & 0x3ffff; // 18 bits
  const ipv4 = `239.${192 + (v4 >> 16)}.${(v4 >> 8) & 0xff}.${v4 & 0xff}`;
  return { walletAddress, ipv6, ipv4, port: WALLET_GROUP_PORT };
}

export interface UdpConnectRequest {
  v: 1;
  kind: 'cpz1-connect';
  /** Wallet the requester is a copy of. */
  walletAddress: string;
  /** Wallet whose holders should answer (usually the same wallet: another copy). */
  targetWallet: string;
  copyId: string;
  /** Transport type ids the requester can open (old names accepted, resolved on receipt). */
  carriers: string[];
  nonce: string;
  sentAt: string;
  publicKey: string;
  keyDeclaration?: HelloKeyDeclaration;
  /** v15-10-00: padding (signed) so the answer may carry several carriers. */
  pad?: string;
  signature: string;
}

/** Where to dial one carrier: a full URL, or only a port on the address the offer came from. */
export interface OfferedEndpoint { carrier: string; url?: string; port?: number }

/** The URL to dial for an offered endpoint (port-only endpoints use the address the offer came from). */
export function endpointUrl(e: OfferedEndpoint, fromHost: string): string | null {
  const host = fromHost.includes(':') ? `[${fromHost}]` : fromHost;
  if (e.port) return `${e.carrier}://${host}:${e.port}`;
  if (!e.url) return null;
  return e.url.replace(/^(\w[\w+.-]*:\/\/)(0\.0\.0\.0|\[::\])/, `$1${host}`);
}

/** Offer form of a bind URL: tcp://0.0.0.0:41441 → { carrier, port } (smaller, and right for every interface). */
export function compactEndpoint(e: OfferedEndpoint): OfferedEndpoint {
  const m = e.url ? /^\w[\w+.-]*:\/\/(?:0\.0\.0\.0|\[::\]):(\d+)\/?$/.exec(e.url) : null;
  return m ? { carrier: e.carrier, port: Number(m[1]) } : e;
}

export interface UdpConnectOffer {
  v: 1;
  kind: 'cpz1-offer';
  walletAddress: string;
  inReplyTo: string;
  endpoints: OfferedEndpoint[];
  sentAt: string;
  publicKey: string;
  signature: string;
}

const unsigned = <T extends { signature: string }>(m: T) => { const { signature: _s, ...rest } = m; return rest; };

/** padTo: pad the signed request to this many bytes so a larger (multi-carrier) answer is allowed. */
export async function buildConnectRequest(r: Omit<UdpConnectRequest, 'v' | 'kind' | 'nonce' | 'sentAt' | 'publicKey' | 'signature' | 'pad'>, key: SigningKey, now = Date.now(), padTo = 0): Promise<{ request: UdpConnectRequest; bytes: Uint8Array }> {
  const base = { v: 1 as const, kind: 'cpz1-connect' as const, ...r, nonce: toHex(crypto.getRandomValues(new Uint8Array(12))), sentAt: new Date(now).toISOString(), publicKey: key.publicKeyHex };
  const sign = async (pad?: string) => { const body = pad ? { ...base, pad } : base; return { ...body, signature: await signCanonical(canonicalJson(body), key) } as UdpConnectRequest; };
  let request = await sign();
  let bytes = new TextEncoder().encode(JSON.stringify(request));
  const target = Math.min(padTo, UDP_DATAGRAM_MAX);
  if (target > bytes.length) {
    // ,"pad":"" adds 9 bytes; the signature length does not change.
    request = await sign('0'.repeat(Math.max(1, target - bytes.length - 9)));
    bytes = new TextEncoder().encode(JSON.stringify(request));
  }
  if (bytes.length > UDP_DATAGRAM_MAX) throw new Error(`connect request is ${bytes.length} bytes; a datagram carries at most ${UDP_DATAGRAM_MAX}`);
  return { request, bytes };
}

export type ConnectCheck = SignatureCheck | 'too-large' | 'malformed' | 'not-for-us' | 'replayed';

/** Bounded nonce memory: a datagram replayed inside the freshness window is dropped. */
export class NonceWindow {
  private seen = new Map<string, number>();
  constructor(private maxAgeMs = CONNECT_MAX_AGE_MS, private cap = 10_000) {}
  admit(id: string, now = Date.now()): boolean {
    for (const [k, t] of this.seen) { if (now - t > this.maxAgeMs * 2) this.seen.delete(k); else break; }
    if (this.seen.has(id)) return false;
    this.seen.set(id, now);
    if (this.seen.size > this.cap) this.seen.delete(this.seen.keys().next().value!);
    return true;
  }
}

export async function readConnectRequest(bytes: Uint8Array, o: { wallets: readonly string[]; nonces: NonceWindow; declaredKeys?: (wallet: string) => readonly string[] | null | Promise<readonly string[] | null>; now?: number }): Promise<{ check: ConnectCheck; request?: UdpConnectRequest }> {
  if (bytes.length > UDP_DATAGRAM_MAX) return { check: 'too-large' };
  let r: UdpConnectRequest;
  try { r = JSON.parse(new TextDecoder().decode(bytes)); } catch { return { check: 'malformed' }; }
  if (r?.v !== 1 || r.kind !== 'cpz1-connect' || !r.walletAddress || !r.targetWallet || !Array.isArray(r.carriers) || !r.nonce) return { check: 'malformed' };
  if (!o.wallets.includes(r.targetWallet)) return { check: 'not-for-us', request: r };
  if (!r.signature || !r.publicKey) return { check: 'unsigned', request: r };
  if (!(await verifyCanonical(canonicalJson(unsigned(r)), r.signature, r.publicKey))) return { check: 'bad-signature', request: r };
  const now = o.now ?? Date.now();
  const age = now - Date.parse(r.sentAt);
  if (!Number.isFinite(age) || Math.abs(age) > CONNECT_MAX_AGE_MS) return { check: 'stale', request: r };
  if (!o.nonces.admit(`${r.publicKey}|${r.nonce}`, now)) return { check: 'replayed', request: r };
  const declared = await o.declaredKeys?.(r.walletAddress);
  if (!declared) return { check: 'verified-unbound', request: r };
  return { check: declared.some((k) => k.toLowerCase() === r.publicKey.toLowerCase()) ? 'verified-bound' : 'wrong-key', request: r };
}

/**
 * Answer with the carriers both sides have, in the responder's order of
 * preference, trimmed so the answer is never larger than the request.
 */
export async function buildConnectOffer(request: UdpConnectRequest, requestBytes: number, responder: { walletAddress: string; endpoints: OfferedEndpoint[] }, key: SigningKey, now = Date.now()): Promise<{ offer: UdpConnectOffer; bytes: Uint8Array } | null> {
  const wanted = new Set(request.carriers.map((c) => resolveTransportType(c)?.id).filter(Boolean));
  let endpoints = responder.endpoints.filter((e) => wanted.has(resolveTransportType(e.carrier)?.id)).map(compactEndpoint);
  while (endpoints.length) {
    const body = { v: 1 as const, kind: 'cpz1-offer' as const, walletAddress: responder.walletAddress, inReplyTo: request.nonce, endpoints, sentAt: new Date(now).toISOString(), publicKey: key.publicKeyHex };
    const offer: UdpConnectOffer = { ...body, signature: await signCanonical(canonicalJson(body), key) };
    const bytes = new TextEncoder().encode(JSON.stringify(offer));
    if (bytes.length <= requestBytes) return { offer, bytes };
    endpoints = endpoints.slice(0, -1);
  }
  return null; // nothing in common, or nothing fits: stay silent
}

export async function readConnectOffer(bytes: Uint8Array, request: UdpConnectRequest, now = Date.now()): Promise<{ check: ConnectCheck; offer?: UdpConnectOffer }> {
  let o: UdpConnectOffer;
  try { o = JSON.parse(new TextDecoder().decode(bytes)); } catch { return { check: 'malformed' }; }
  if (o?.v !== 1 || o.kind !== 'cpz1-offer' || o.inReplyTo !== request.nonce || o.walletAddress !== request.targetWallet) return { check: 'not-for-us' };
  if (!(await verifyCanonical(canonicalJson(unsigned(o)), o.signature, o.publicKey))) return { check: 'bad-signature' };
  if (Math.abs(now - Date.parse(o.sentAt)) > CONNECT_MAX_AGE_MS) return { check: 'stale' };
  // The side channel's own signed hello binds the key; here the offer is only a hint where to dial.
  return { check: 'verified-unbound', offer: o };
}

/** Which offered carriers to open, fastest first; `paths` > 1 opens several at once. */
export function planSideChannels(offer: UdpConnectOffer, mine: readonly string[], paths = 1): OfferedEndpoint[] {
  const order = mine.map((c) => resolveTransportType(c)?.id).filter(Boolean);
  const picked: OfferedEndpoint[] = [];
  for (const id of order) {
    const e = offer.endpoints.find((x) => resolveTransportType(x.carrier)?.id === id);
    if (e && !picked.includes(e)) picked.push(e);
    if (picked.length >= paths) break;
  }
  return picked;
}
