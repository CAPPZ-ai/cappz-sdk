/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-identity
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Who may speak on a resilience mesh, verified with no server reachable.
 *
 * A mesh is anchored by a charter: a statement signed by its founding
 * authority wallet naming the authority wallets and the mesh policy. Its id
 * is the hash of the signed charter, so a node provisioned with the charter
 * (QR, file, before the outage) can recognise the mesh and nothing else can
 * claim it. An authority grants a member wallet a role (MeshMembershipGranted)
 * with an expiry and withdraws it early with a revocation
 * (MeshMembershipRevoked) that every node replays — the same shape as KeyZ key
 * declarations and revocations (identity/keyDeclaration.ts), which still decide
 * which device key speaks for a member wallet.
 *
 * Capability is not binary: the role bounds the precedence a member may send
 * at and whether it may broadcast. A wallet with no grant is a guest, which
 * the charter may allow at ROUTINE precedence only, under a small quota — so a
 * civilian with the app but no provisioning can still reach someone.
 */

import { signMessage, verifySignature } from '../auth/wallet/session.ts';
import { canonicalJson, sha256HexOf } from '../identity/canonical.ts';

/** NATO-style message precedence, highest first. */
export const PRECEDENCE = ['flash', 'immediate', 'priority', 'routine'] as const;
export type Precedence = (typeof PRECEDENCE)[number];
export const precedenceRank = (p: Precedence) => PRECEDENCE.length - PRECEDENCE.indexOf(p); // flash 4 … routine 1

export type MeshRole = 'coordinator' | 'responder' | 'member' | 'guest';

export interface RoleAllowance {
  /** Highest precedence this role may originate. */
  maxPrecedence: Precedence;
  /** May originate channel (one-to-many) bundles. */
  broadcast: boolean;
  /** Bundles per minute a source wallet of this role may originate (enforced at every hop). */
  perMinute: number;
  /** Share of a node's store one source of this role may occupy. */
  storeShare: number;
}

export interface MeshPolicy {
  /** Longest a bundle may live. */
  maxTtlMs: number;
  /** Largest bundle body, bytes (before base64). */
  maxBodyBytes: number;
  /** Hops before a bundle stops being forwarded. */
  maxHops: number;
  /** Guests (wallets with no grant) are dropped, or carried at ROUTINE under the guest allowance. */
  guests: 'drop' | 'routine';
  roles: Record<MeshRole, RoleAllowance>;
}

export const DEFAULT_MESH_POLICY: MeshPolicy = {
  maxTtlMs: 72 * 3600_000,
  maxBodyBytes: 16 * 1024,
  maxHops: 32,
  guests: 'routine',
  roles: {
    coordinator: { maxPrecedence: 'flash', broadcast: true, perMinute: 120, storeShare: 0.25 },
    responder: { maxPrecedence: 'immediate', broadcast: true, perMinute: 60, storeShare: 0.15 },
    member: { maxPrecedence: 'priority', broadcast: true, perMinute: 20, storeShare: 0.08 },
    guest: { maxPrecedence: 'routine', broadcast: false, perMinute: 3, storeShare: 0.01 },
  },
};

export interface MeshCharter {
  v: 1;
  kind: 'cpz-mesh-charter';
  name: string;
  /** Wallet addresses that may grant and revoke membership. The first one signs the charter. */
  authorities: string[];
  policy: MeshPolicy;
  issuedAt: string;
  signature: string;
}

export interface MeshMembership {
  v: 1;
  kind: 'cpz-mesh-membership';
  meshId: string;
  authority: string;
  member: string;
  role: Exclude<MeshRole, 'guest'>;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}

export interface MeshMembershipRevocation {
  v: 1;
  kind: 'cpz-mesh-membership-revocation';
  meshId: string;
  authority: string;
  grantHash: string;
  member: string;
  revokedAt: string;
  reason: string;
  signature: string;
}

export type CharterCheck = 'valid' | 'bad-signature' | 'malformed';
export type MembershipState =
  | 'granted'        // valid, unrevoked grant by a charter authority
  | 'guest'          // no grant presented (the charter decides what a guest may do)
  | 'revoked'
  | 'expired'
  | 'not-yet-valid'
  | 'not-authority'  // signed by a wallet the charter does not name
  | 'wrong-mesh'
  | 'wrong-member'   // a valid grant, for another wallet
  | 'bad-signature'
  | 'malformed';

const CLOCK_SKEW_MS = 10 * 60_000;
const body = <T extends { signature: string }>(x: T): Omit<T, 'signature'> => { const { signature: _s, ...rest } = x; return rest; };

// Signed statements never change: cache the secp256k1 check by exact text + signature + signer.
const sigCache = new Map<string, boolean>();
async function walletSigned(text: string, signature: string, wallet: string): Promise<boolean> {
  const k = `${wallet}|${signature}|${text}`;
  const hit = sigCache.get(k);
  if (hit !== undefined) return hit;
  const ok = await verifySignature(text, signature, wallet);
  if (sigCache.size >= 20_000) sigCache.delete(sigCache.keys().next().value!);
  sigCache.set(k, ok);
  return ok;
}

export async function createCharter(authorityPrivateKey: Uint8Array, c: { name: string; authorities: string[]; policy?: MeshPolicy }, now = Date.now()): Promise<MeshCharter> {
  if (!c.authorities.length) throw new Error('a charter names at least one authority');
  const d: Omit<MeshCharter, 'signature'> = { v: 1, kind: 'cpz-mesh-charter', name: c.name, authorities: c.authorities, policy: c.policy ?? DEFAULT_MESH_POLICY, issuedAt: new Date(now).toISOString() };
  return { ...d, signature: await signMessage(authorityPrivateKey, canonicalJson(d)) };
}

export async function verifyCharter(c: MeshCharter | null | undefined): Promise<CharterCheck> {
  if (!c || c.v !== 1 || c.kind !== 'cpz-mesh-charter' || !c.authorities?.length || !c.policy || !c.signature) return 'malformed';
  return (await walletSigned(canonicalJson(body(c)), c.signature, c.authorities[0])) ? 'valid' : 'bad-signature';
}

/** The mesh id: hash of the signed charter. Nodes compare ids, never names. */
export function meshIdOf(c: MeshCharter): Promise<string> {
  return sha256HexOf(canonicalJson(c));
}

export async function grantMembership(authorityPrivateKey: Uint8Array, g: { meshId: string; authority: string; member: string; role: MeshMembership['role']; ttlMs?: number }, now = Date.now()): Promise<MeshMembership> {
  const d: Omit<MeshMembership, 'signature'> = {
    v: 1, kind: 'cpz-mesh-membership', meshId: g.meshId, authority: g.authority, member: g.member, role: g.role,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + (g.ttlMs ?? 180 * 24 * 3600_000)).toISOString(),
  };
  return { ...d, signature: await signMessage(authorityPrivateKey, canonicalJson(d)) };
}

export function membershipHash(g: MeshMembership): Promise<string> {
  return sha256HexOf(canonicalJson(g));
}

export async function revokeMembership(authorityPrivateKey: Uint8Array, g: MeshMembership, authority: string, reason: string, now = Date.now()): Promise<MeshMembershipRevocation> {
  const d: Omit<MeshMembershipRevocation, 'signature'> = {
    v: 1, kind: 'cpz-mesh-membership-revocation', meshId: g.meshId, authority, grantHash: await membershipHash(g), member: g.member,
    revokedAt: new Date(now).toISOString(), reason,
  };
  return { ...d, signature: await signMessage(authorityPrivateKey, canonicalJson(d)) };
}

/** Any charter authority may revoke any grant (a captured coordinator can be cut off by another). */
export async function verifyMembershipRevocation(r: MeshMembershipRevocation | null | undefined, charter: MeshCharter, meshId: string): Promise<'valid' | 'not-authority' | 'wrong-mesh' | 'bad-signature' | 'malformed'> {
  if (!r || r.v !== 1 || r.kind !== 'cpz-mesh-membership-revocation' || !r.grantHash || !r.member || !r.signature) return 'malformed';
  if (r.meshId !== meshId) return 'wrong-mesh';
  if (!charter.authorities.includes(r.authority)) return 'not-authority';
  return (await walletSigned(canonicalJson(body(r)), r.signature, r.authority)) ? 'valid' : 'bad-signature';
}

export interface MembershipEvaluation { state: MembershipState; role: MeshRole; grantHash?: string; because: string }

/** What may this wallet do on this mesh? Revocations are the ones the node has replayed (already verified). */
export async function evaluateMembership(
  wallet: string,
  grant: MeshMembership | null | undefined,
  ctx: { charter: MeshCharter; meshId: string; revokedGrants: ReadonlySet<string>; now?: number },
): Promise<MembershipEvaluation> {
  const now = ctx.now ?? Date.now();
  if (!grant) return { state: 'guest', role: 'guest', because: 'no membership grant presented' };
  const no = (state: MembershipState, because: string): MembershipEvaluation => ({ state, role: 'guest', because });
  if (grant.v !== 1 || grant.kind !== 'cpz-mesh-membership' || !grant.member || !grant.signature || !grant.role) return no('malformed', 'grant is not a membership');
  if (!['coordinator', 'responder', 'member'].includes(grant.role)) return no('malformed', `unknown role ${grant.role}`);
  if (grant.meshId !== ctx.meshId) return no('wrong-mesh', 'grant is for another mesh');
  if (grant.member !== wallet) return no('wrong-member', 'grant names another wallet');
  if (!ctx.charter.authorities.includes(grant.authority)) return no('not-authority', 'grantor is not a charter authority');
  if (!(await walletSigned(canonicalJson(body(grant)), grant.signature, grant.authority))) return no('bad-signature', 'grant signature does not verify');
  const hash = await membershipHash(grant);
  if (ctx.revokedGrants.has(hash)) return { state: 'revoked', role: 'guest', grantHash: hash, because: 'an authority revoked this grant' };
  const issued = Date.parse(grant.issuedAt); const expires = Date.parse(grant.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return no('malformed', 'grant window unreadable');
  if (issued - CLOCK_SKEW_MS > now) return { state: 'not-yet-valid', role: 'guest', grantHash: hash, because: `grant starts ${grant.issuedAt}` };
  if (expires <= now) return { state: 'expired', role: 'guest', grantHash: hash, because: `grant expired ${grant.expiresAt}` };
  return { state: 'granted', role: grant.role, grantHash: hash, because: `${grant.role} until ${grant.expiresAt}` };
}

/**
 * The tag a bundle carries instead of its recipient's wallet address: relays
 * route on it, the recipient recognises it. Salted with the mesh id so tags
 * do not link across meshes. It hides the address from a casual reader, not
 * from someone who already has a candidate list (they can hash it).
 */
export function recipientTag(meshId: string, wallet: string): Promise<string> {
  return sha256HexOf(`cpz-mesh-to|${meshId}|${wallet}`).then((h) => h.slice(0, 32));
}
