/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-gate
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * KeyZ Gate for the mesh: what the edge verify gateway (identity/edgeVerify.ts)
 * does for an HTTP request, done for a bundle at every hop, offline. Nothing
 * is stored or forwarded unless it passes, so a captured or hostile device
 * cannot use the mesh's own carriers against it.
 *
 * Cheap checks run first (shape, size, mesh, time, dedupe) so a flood of junk
 * costs a hash, not a signature check; signature failures are remembered by
 * (id, signature) so the same forgery is never verified twice. Then: device
 * key signature, body hash, KeyZ trust in the key (declared by the source
 * wallet, not revoked), membership (granted by a charter authority, not
 * revoked), the role's precedence and broadcast allowance, and the source's
 * rate. The verdict is a lifecycle state; missing is not the same as bad.
 */

import { evaluateKey, verifyKeyRevocation, type KeyRevocation, type KeyTrust } from '../identity/keyDeclaration.ts';
import { canonicalJson, sha256HexOf, fromBase64Url } from '../identity/canonical.ts';
import { bundleId, bundleSignatureValid, bodyMatches, readJsonBody, type MeshBundle } from './meshBundle.ts';
import {
  evaluateMembership, verifyMembershipRevocation, precedenceRank, PRECEDENCE,
  type MeshCharter, type MeshMembershipRevocation, type MembershipEvaluation, type MeshRole,
} from './meshIdentity.ts';

export type GateVerdict =
  | 'admitted'            // a member, inside its role
  | 'admitted-guest'      // no grant; the charter carries guests at ROUTINE under a quota
  | 'duplicate'           // already held or delivered (same id)
  | 'malformed'
  | 'too-large'
  | 'wrong-mesh'
  | 'expired'
  | 'future-dated'
  | 'hop-limit'
  | 'bad-signature'
  | 'body-mismatch'       // header verifies, body was altered on the way
  | 'key-revoked'         // the source wallet revoked the device key's declaration
  | 'key-untrusted'       // the key is not declared for the source wallet (or expired, wrong purpose)
  | 'membership-revoked'
  | 'not-member'          // bad / foreign grant, or guests are dropped by the charter
  | 'precedence-denied'   // above what the role may originate
  | 'broadcast-denied'
  | 'bad-control'         // a revocation bundle whose payload does not verify
  | 'rate-limited';

export const ACCEPTED: ReadonlySet<GateVerdict> = new Set(['admitted', 'admitted-guest']);

export interface GateResult {
  verdict: GateVerdict;
  id?: string;
  role?: MeshRole;
  keyTrust?: KeyTrust;
  membership?: MembershipEvaluation;
  because: string;
}

export interface MeshGateOptions {
  charter: MeshCharter;
  meshId: string;
  now?: () => number;
  /** Future skew tolerated on `created` (device clocks drift with no network time). */
  clockSkewMs?: number;
  /** Largest bundle body string accepted (sealed / base64 bodies are larger than maxBodyBytes). */
  maxBodyChars?: number;
  seenCapacity?: number;
}

/** Device keys a member may sign bundles with: its declared transport hello key, or a signing key. */
const DEVICE_PURPOSES = ['hello', 'signing'] as const;

export class MeshGate {
  readonly charter: MeshCharter;
  readonly meshId: string;
  readonly keyRevocations: KeyRevocation[] = [];
  readonly revokedGrants = new Set<string>();
  private readonly knownControl = new Set<string>();
  private readonly seen = new Map<string, number>(); // id → expires
  private readonly forged = new Map<string, number>(); // id|sig → until
  private readonly buckets = new Map<string, number>(); // src|minute → originated
  private readonly now: () => number;
  private readonly skew: number;
  private readonly maxBodyChars: number;
  private readonly seenCapacity: number;
  readonly counts: Partial<Record<GateVerdict, number>> = {};

  constructor(o: MeshGateOptions) {
    this.charter = o.charter; this.meshId = o.meshId;
    this.now = o.now ?? Date.now;
    this.skew = o.clockSkewMs ?? 10 * 60_000;
    this.maxBodyChars = o.maxBodyChars ?? Math.ceil(o.charter.policy.maxBodyBytes * 1.4) + 512;
    this.seenCapacity = o.seenCapacity ?? 50_000;
  }

  /** Ids are remembered by their first 96 bits, the same prefix inv frames carry. */
  hasSeen(id: string): boolean { return this.seen.has(id.slice(0, 24)); }

  /** Remember an id until its bundle expires (admitted, delivered, or originated here). */
  markSeen(id: string, expires: number): void {
    if (this.seen.size >= this.seenCapacity) {
      const t = this.now();
      for (const [k, e] of this.seen) if (e <= t) this.seen.delete(k);
      if (this.seen.size >= this.seenCapacity) this.seen.delete(this.seen.keys().next().value!);
    }
    this.seen.set(id.slice(0, 24), expires);
  }

  private done(r: GateResult): GateResult {
    this.counts[r.verdict] = (this.counts[r.verdict] ?? 0) + 1;
    return r;
  }

  /** Learn a KeyZ revocation (from provisioning or a gossiped bundle). Returns false when invalid or known. */
  async learnKeyRevocation(r: KeyRevocation): Promise<boolean> {
    const h = await sha256HexOf(canonicalJson(r));
    if (this.knownControl.has(h) || (await verifyKeyRevocation(r)) !== 'valid') return false;
    this.knownControl.add(h); this.keyRevocations.push(r);
    return true;
  }

  async learnMembershipRevocation(r: MeshMembershipRevocation): Promise<boolean> {
    const h = await sha256HexOf(canonicalJson(r));
    if (this.knownControl.has(h) || (await verifyMembershipRevocation(r, this.charter, this.meshId)) !== 'valid') return false;
    this.knownControl.add(h); this.revokedGrants.add(r.grantHash);
    return true;
  }

  /**
   * Origination rate, counted per minute of the bundle's own `created` time — not arrival time, so a
   * backlog that arrives at once after a partition heals is not throttled. Backdating to reach older
   * minutes is bounded by the charter's maximum lifetime and by the per-source store quota.
   */
  private take(src: string, created: number, perMinute: number): boolean {
    const k = `${src}|${Math.floor(created / 60_000)}`;
    const n = this.buckets.get(k) ?? 0;
    if (n >= perMinute) return false;
    if (this.buckets.size > 100_000) {
      const oldest = Math.floor((this.now() - this.charter.policy.maxTtlMs) / 60_000);
      for (const key of this.buckets.keys()) if (Number(key.slice(key.lastIndexOf('|') + 1)) < oldest) this.buckets.delete(key);
    }
    this.buckets.set(k, n + 1);
    return true;
  }

  /** Verify a bundle arriving from a neighbour (or originated locally). Does not mark it seen. */
  async check(b: MeshBundle): Promise<GateResult> {
    const p = this.charter.policy;
    const h = b?.h;
    if (!h || h.v !== 1 || typeof b.sig !== 'string' || typeof b.body !== 'string' || !b.cred?.decl || !h.to || !PRECEDENCE.includes(h.prec)
      || !Number.isFinite(h.created) || !Number.isFinite(h.expires) || !Number.isInteger(b.hops) || !Number.isInteger(b.copies) || b.copies < 1) {
      return this.done({ verdict: 'malformed', because: 'not a mesh bundle' });
    }
    if (b.body.length > this.maxBodyChars || h.bodyBytes > p.maxBodyBytes) return this.done({ verdict: 'too-large', because: `body over ${p.maxBodyBytes} bytes` });
    if (h.meshId !== this.meshId) return this.done({ verdict: 'wrong-mesh', because: 'bundle is for another mesh' });
    const t = this.now();
    if (h.expires <= t) return this.done({ verdict: 'expired', because: 'past its expiry' });
    if (h.created - this.skew > t) return this.done({ verdict: 'future-dated', because: 'created in the future' });
    if (h.expires - h.created > p.maxTtlMs) return this.done({ verdict: 'malformed', because: 'lifetime above the charter maximum' });
    if (b.hops > p.maxHops) return this.done({ verdict: 'hop-limit', because: `more than ${p.maxHops} hops` });
    const id = await bundleId(h);
    if (this.seen.has(id.slice(0, 24))) return this.done({ verdict: 'duplicate', id, because: 'already held or delivered' });
    const forgedKey = `${id}|${b.sig}`;
    if ((this.forged.get(forgedKey) ?? 0) > t) return this.done({ verdict: 'bad-signature', id, because: 'known forgery' });

    if (!(await bundleSignatureValid(b))) {
      if (this.forged.size > 10_000) this.forged.clear();
      this.forged.set(forgedKey, h.expires);
      return this.done({ verdict: 'bad-signature', id, because: 'device-key signature does not verify' });
    }
    if (!(await bodyMatches(b))) return this.done({ verdict: 'body-mismatch', id, because: 'body does not match its signed hash' });

    let keyTrust: KeyTrust = { state: 'undeclared', because: 'no declaration names this key' };
    for (const purpose of DEVICE_PURPOSES) {
      keyTrust = await evaluateKey(h.src, h.key, purpose, { declarations: [b.cred.decl], revocations: this.keyRevocations }, t);
      if (keyTrust.state === 'declared' || keyTrust.state === 'revoked') break;
    }
    if (keyTrust.state === 'revoked') return this.done({ verdict: 'key-revoked', id, keyTrust, because: keyTrust.because });
    if (keyTrust.state !== 'declared') return this.done({ verdict: 'key-untrusted', id, keyTrust, because: keyTrust.because });

    const membership = await evaluateMembership(h.src, b.cred.grant, { charter: this.charter, meshId: this.meshId, revokedGrants: this.revokedGrants, now: t });
    if (membership.state === 'revoked') return this.done({ verdict: 'membership-revoked', id, keyTrust, membership, because: membership.because });
    if (membership.state !== 'granted' && (membership.state !== 'guest' || p.guests === 'drop')) {
      return this.done({ verdict: 'not-member', id, keyTrust, membership, because: membership.state === 'guest' ? 'the charter drops guests' : membership.because });
    }
    const role = membership.role;
    const allow = p.roles[role];
    const base = { id, role, keyTrust, membership };

    // Revocations are self-authenticating and are the antidote to a captured device: carried at any precedence, from anyone verified.
    if (h.kind === 'key-revocation' || h.kind === 'mesh-revocation') {
      if (h.enc !== 'clear') return this.done({ ...base, verdict: 'bad-control', because: 'revocations travel in the clear' });
      let ok = false;
      try {
        const payload = readJsonBody<KeyRevocation & MeshMembershipRevocation>(fromBase64Url(b.body));
        ok = h.kind === 'key-revocation'
          ? (await verifyKeyRevocation(payload)) === 'valid'
          : (await verifyMembershipRevocation(payload, this.charter, this.meshId)) === 'valid';
      } catch { ok = false; }
      if (!ok) return this.done({ ...base, verdict: 'bad-control', because: 'revocation payload does not verify' });
      return this.done({ ...base, verdict: role === 'guest' ? 'admitted-guest' : 'admitted', because: `${h.kind} carried at any precedence` });
    }

    if (precedenceRank(h.prec) > precedenceRank(allow.maxPrecedence)) return this.done({ ...base, verdict: 'precedence-denied', because: `${role} may originate up to ${allow.maxPrecedence}` });
    if (h.to.t === 'channel' && !allow.broadcast && h.kind !== 'contact') return this.done({ ...base, verdict: 'broadcast-denied', because: `${role} may not broadcast` });
    if (!this.take(h.src, h.created, allow.perMinute)) return this.done({ ...base, verdict: 'rate-limited', because: `${role} limit ${allow.perMinute}/min` });
    return this.done({ ...base, verdict: role === 'guest' ? 'admitted-guest' : 'admitted', because: membership.because });
  }
}
