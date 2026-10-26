/**
 * COPE node crystallized.
 * Node ID: v15-05-00-endpoint-directory
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * The Replicator's internal name service — a replicated "ip-config" for a
 * network of copies, in the spirit of NetBIOS name tables and the NetWare
 * bindery. When a copy is made, each of its devices writes one record at
 * its own HD address (copyDeviceAddress): which endpoints it accepts
 * connections on (LAN, public) and which carriers. The records replicate
 * with the network, so every copy resolves every other copy from its own
 * table; a change of address is an amendment, never an overwrite.
 *
 * Resolution order (resolvePeerPaths): same LAN, direct → the peer's public
 * endpoint, direct → a relay node, only when the peer accepts no inbound
 * connection the caller can reach. A relay is always someone's own node.
 *
 * A record is signed by the device's Ed25519 key, which the wallet binds
 * with a key declaration (helloKeyDeclaration.ts), or directly by the
 * wallet's secp256k1 key. Replay keeps the newest valid record per device
 * and says how far each one is trusted.
 */

import { signCanonical, verifyCanonical, type SigningKey } from './helloSignature.ts';
import { verifyHelloKeyDeclaration, type HelloKeyDeclaration } from './helloKeyDeclaration.ts';
import { signMessage, verifySignature } from '../auth/wallet/session.ts';
import type { CarrierRung } from './transports/httpsRelay.ts';

export type EndpointScope = 'lan' | 'public';

export interface DeviceEndpoint {
  scope: EndpointScope;
  /** Relay-protocol base URL this device serves (https://host:port/cpz1), or tcp://host:port. */
  url: string;
  carriers: Array<CarrierRung | 'tcp' | 'quic'>;
  /** LAN endpoints only: the network they are reachable on (e.g. a site id). */
  lanId?: string;
}

export interface EndpointRecord {
  v: 1;
  /** The network's wallet (Replicator network root's owner). */
  walletAddress: string;
  copyId: string;
  deviceId: string;
  /** copyDeviceAddress(...) — the internal address this record lives at. */
  address: string;
  /** Empty = outbound-only: this device dials out and is never dialed. */
  endpoints: DeviceEndpoint[];
  registeredAt: string;
  /** The record this one amends (same device), if any. */
  amends?: string;
  signer: { scheme: 'ed25519' | 'secp256k1'; publicKey: string };
  /** For ed25519 signers: the wallet's declaration that this key speaks for it. */
  keyDeclaration?: HelloKeyDeclaration;
  signature: string;
}

export type EndpointTrust = 'wallet-signed' | 'declared-device' | 'undeclared-device' | 'bad-signature';

export interface DirectoryEntry { record: EndpointRecord; recordId: string; trust: EndpointTrust }

export function canonicalEndpointRecord(r: Omit<EndpointRecord, 'signature' | 'keyDeclaration'>): string {
  return JSON.stringify({
    address: r.address, amends: r.amends ?? null, copyId: r.copyId, deviceId: r.deviceId,
    endpoints: r.endpoints.map((e) => ({ carriers: [...e.carriers].sort(), lanId: e.lanId ?? null, scope: e.scope, url: e.url })),
    registeredAt: r.registeredAt, signer: r.signer, v: 1, walletAddress: r.walletAddress,
  });
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Content address of a record (the id an amendment points at). */
export const endpointRecordId = (r: EndpointRecord) => sha256Hex(canonicalEndpointRecord(r) + r.signature);

type Unsigned = Omit<EndpointRecord, 'signature' | 'signer' | 'keyDeclaration' | 'v'>;

/** Sign with a device key (bind it with the wallet's key declaration). */
export async function signEndpointRecord(r: Unsigned, key: SigningKey, keyDeclaration?: HelloKeyDeclaration): Promise<EndpointRecord> {
  const body = { v: 1 as const, ...r, signer: { scheme: 'ed25519' as const, publicKey: key.publicKeyHex } };
  return { ...body, ...(keyDeclaration ? { keyDeclaration } : {}), signature: await signCanonical(canonicalEndpointRecord(body), key) };
}

/** Sign with the wallet's own secp256k1 key (its address is that public key). */
export async function signEndpointRecordWithWallet(r: Unsigned, walletPrivateKey: Uint8Array): Promise<EndpointRecord> {
  const body = { v: 1 as const, ...r, signer: { scheme: 'secp256k1' as const, publicKey: r.walletAddress } };
  return { ...body, signature: await signMessage(walletPrivateKey, canonicalEndpointRecord(body)) };
}

export async function verifyEndpointRecord(r: EndpointRecord, now = Date.now()): Promise<EndpointTrust> {
  const text = canonicalEndpointRecord(r);
  if (r.signer.scheme === 'secp256k1') {
    // Only the wallet itself may sign as the wallet.
    return r.signer.publicKey === r.walletAddress && (await verifySignature(text, r.signature, r.signer.publicKey)) ? 'wallet-signed' : 'bad-signature';
  }
  if (!(await verifyCanonical(text, r.signature, r.signer.publicKey))) return 'bad-signature';
  const d = r.keyDeclaration;
  const declared = d && d.walletAddress === r.walletAddress && d.devicePublicKey.toLowerCase() === r.signer.publicKey.toLowerCase()
    && (await verifyHelloKeyDeclaration(d, now)) === 'valid';
  return declared ? 'declared-device' : 'undeclared-device';
}

/**
 * The member table: newest valid record per (copy, device). Rules with event
 * context: a record must verify; an amendment must name the record it amends
 * and be signed by the same signer (a stranger cannot move someone's device).
 */
export async function replayEndpointDirectory(records: EndpointRecord[], opts: { now?: number; minTrust?: EndpointTrust[] } = {}): Promise<DirectoryEntry[]> {
  const accept = opts.minTrust ?? ['wallet-signed', 'declared-device', 'undeclared-device'];
  const latest = new Map<string, DirectoryEntry>();
  const sorted = [...records].sort((a, b) => a.registeredAt.localeCompare(b.registeredAt));
  for (const record of sorted) {
    const trust = await verifyEndpointRecord(record, opts.now);
    if (!accept.includes(trust)) continue;
    const key = `${record.walletAddress}|${record.copyId}|${record.deviceId}`;
    const prev = latest.get(key);
    if (prev) {
      if (record.amends !== prev.recordId) continue;
      if (record.signer.publicKey !== prev.record.signer.publicKey && trust !== 'wallet-signed') continue;
    }
    latest.set(key, { record, recordId: await endpointRecordId(record), trust });
  }
  return [...latest.values()];
}

export type PeerPath = { kind: 'direct-lan' | 'direct-public'; url: string; entry: DirectoryEntry } | { kind: 'relay'; url: string };

/**
 * Where to dial a peer copy, best first: its LAN endpoint when the caller is
 * on that LAN, its public endpoint, then the relays the caller knows.
 */
export function resolvePeerPaths(directory: DirectoryEntry[], peerCopyId: string, here: { lanIds?: string[]; relays?: string[] } = {}): PeerPath[] {
  const paths: PeerPath[] = [];
  const devices = directory.filter((e) => e.record.copyId === peerCopyId);
  for (const entry of devices) for (const ep of entry.record.endpoints) {
    if (ep.scope === 'lan' && ep.lanId && here.lanIds?.includes(ep.lanId)) paths.push({ kind: 'direct-lan', url: ep.url, entry });
  }
  for (const entry of devices) for (const ep of entry.record.endpoints) if (ep.scope === 'public') paths.push({ kind: 'direct-public', url: ep.url, entry });
  for (const url of here.relays ?? []) paths.push({ kind: 'relay', url });
  return paths;
}

export const PATH_LABEL: Record<PeerPath['kind'], string> = {
  'direct-lan': 'Direct, same network',
  'direct-public': 'Direct, to its public endpoint',
  relay: 'Through a relay node',
};
