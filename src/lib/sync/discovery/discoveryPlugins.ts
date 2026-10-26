/**
 * COPE node crystallized.
 * Node ID: v12-23-03-discovery-plugins
 * Provenance: m/44'/144'/100'/principles/cope/v1
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Discovery plug-ins. Discovery only ever answers "who holds heads for
 * wallet X and how do I reach them" — beacons carry a signed announcement,
 * never state. Browsers cannot send UDP, so the browser-side beacon is a
 * spec + verification layer; the standalone edge node (packages/
 * cappz-edge-node) implements the actual UDP socket with this same record.
 */

import { sha256Hex } from '../a2aSecureChannel';
import type { DiscoveryMethod, EdgeTransportKind } from '../transportContract';

/** Signed LAN announcement. ~200 bytes — fits one UDP datagram. */
export interface UdpBeacon {
  version: 1;
  powAddress: string;
  heads: string[];
  transports: EdgeTransportKind[];
  /** e.g. "tcp://192.168.1.20:41441" — where the transfer session opens. */
  endpoints: string[];
  sentAt: string;
  signature: string;
  publicKey: string;
}

export const UDP_BEACON_PORT = 41440;
export const UDP_BEACON_GROUP = '239.44.144.100'; // CAPPZ multicast group

export async function buildBeaconPayload(b: Omit<UdpBeacon, 'signature'>): Promise<string> {
  return sha256Hex(JSON.stringify({
    endpoints: [...b.endpoints].sort(),
    heads: [...b.heads].sort(),
    powAddress: b.powAddress,
    publicKey: b.publicKey,
    sentAt: b.sentAt,
    transports: [...b.transports].sort(),
    version: b.version,
  }));
}

/** Rate limit: ignore beacons from the same POW more often than this. */
export const BEACON_MIN_INTERVAL_MS = 5_000;

export class BeaconRateLimiter {
  private lastSeen = new Map<string, number>();
  admit(powAddress: string, now = Date.now()): boolean {
    if (!this.lastSeen.has(powAddress)) { this.lastSeen.set(powAddress, now); return true; }
    const last = this.lastSeen.get(powAddress)!;
    if (now - last < BEACON_MIN_INTERVAL_MS) return false;
    this.lastSeen.set(powAddress, now);
    return true;
  }
}

/** Short-lived pairing code for QR / sound (gibberlink-style) exchange. */
export interface PairingCode {
  code: string; // 6 groups of 4 base32 chars — speakable, typeable
  powAddress: string;
  publicKey: string;
  expiresAt: string;
}

export function mintPairingCode(powAddress: string, publicKey: string, ttlMs = 5 * 60_000): PairingCode {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  const rand = crypto.getRandomValues(new Uint8Array(24));
  const code = [...rand].map((b) => alphabet[b % alphabet.length]).join('').replace(/(.{4})/g, '$1-').slice(0, -1);
  return { code, powAddress, publicKey, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
}

export function pairingCodeValid(p: PairingCode, now = Date.now()): boolean {
  return Date.parse(p.expiresAt) > now;
}

/** What a discovery plug-in produces: a reachable peer hint. */
export interface PeerHint {
  powAddress: string;
  via: DiscoveryMethod;
  endpoint: string;
  publicKey?: string;
  heardAt: string;
}
