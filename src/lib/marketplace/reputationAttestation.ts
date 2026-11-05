/**
 * COPE node crystallized. Node ID: v15-31-00-reputation-attestation.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * Signed reputation attestation: what the marketplace's replayed public log
 * says about a party at one moment, signed so it can be kept and shown to
 * others. Trust boundaries stay visible — ledger facts (read from the XRPL
 * account on the party's profile, or null), marketplace history (finished
 * deals, disputes, ratings, mandate) and the verdict are separate fields, and
 * endpoint uptime is only what the caller reports (probe counts passed in,
 * not measured here). A missing fact is unknown, never fine.
 *
 * Addressed at a CAPPZ-rooted path, `parties/<partyId>/reputation/<date>`
 * (MarketplacePaths.reputationAddress), and signed with Ed25519 under its own
 * domain string, so it can never be mistaken for a counterparty-check report
 * or a signing approval made by the same key.
 *
 * Nothing is written to any external registry here. Outside reputation
 * registries may later be fed from these attestations by a bridge declared as
 * an MDM account under cappz/config/bridges/<id>, with the target named in its
 * metadata — never by a path segment naming the target.
 */
import { ed25519 } from '@noble/curves/ed25519';
import type { XrplNetwork } from '../xrpl/ledgerCheck';
import type { MarketState } from './replay';
import { canonicalJson, marketFacts, type AccountFacts, type MarketFacts, type Reason } from './counterpartyCheck';
import { reputationAddress } from './MarketplacePaths';

export const REPUTATION_DOMAIN = 'cappz-reputation-attestation/v1\n';
/** How long an attestation speaks for the log (it is a snapshot; ask again for a newer one). */
export const REPUTATION_TTL_MS = 24 * 60 * 60 * 1000;
export const REPUTATION_RULES = 'https://github.com/CAPPZ-ai/cappz-sdk/blob/main/src/lib/marketplace/reputationAttestation.ts';

export type ReputationStanding = 'good-standing' | 'limited-history' | 'no-history' | 'poorly-rated' | 'disputed' | 'unknown-party';

/** Health probes of the party's endpoint, as counted by whoever probed it. */
export interface UptimeReport { endpoint: string; probes: number; passed: number; from: string; to: string; probedBy: string }

export interface ReputationAttestation {
  kind: 'cappz-reputation-attestation';
  version: 1;
  network: XrplNetwork;
  partyId: string;
  address: string;
  issuedAt: string;
  validUntil: string;
  /** Read from the XRPL account on the party's profile (null when not read or there is none). */
  ledger: AccountFacts | null;
  /** Replayed from the marketplace's public log. */
  market: (MarketFacts & { ratings: number; keyDeclared: boolean; principalCredential: boolean }) | null;
  /** Reported by the prober, not measured by the attester. */
  uptime: (UptimeReport & { source: 'reported' }) | null;
  verdict: { standing: ReputationStanding; reasons: Reason[] };
  rules: string;
}

export interface SignedReputation { attestation: ReputationAttestation; signature: { alg: 'Ed25519'; publicKey: string; value: string } }

/** The rules: pure, over the facts in the attestation, so anyone can re-run them. */
export function reputationVerdict(market: ReputationAttestation['market'], ledger: AccountFacts | null, uptime: UptimeReport | null): ReputationAttestation['verdict'] {
  const r: Reason[] = [];
  if (!market) return { standing: 'unknown-party', reasons: [{ level: 'warn', code: 'unknown-party', text: 'No such party on this market.' }] };
  let standing: ReputationStanding;
  const total = market.finished + market.disputes;
  if (market.openDisputes > 0) { standing = 'disputed'; r.push({ level: 'warn', code: 'open-dispute', text: `${market.openDisputes} dispute(s) open now.` }); }
  else if (total > 0 && market.disputes / total > 0.2) { standing = 'disputed'; r.push({ level: 'warn', code: 'dispute-rate', text: `${market.disputes} dispute(s) against ${market.finished} finished deal(s).` }); }
  else if (market.finished === 0) { standing = 'no-history'; r.push({ level: 'info', code: 'no-history', text: 'No finished deals on this market yet.' }); }
  else if (market.averageRating !== null && market.averageRating < 3) { standing = 'poorly-rated'; r.push({ level: 'warn', code: 'low-rating', text: `Average rating ${market.averageRating} over ${market.ratings} review(s).` }); }
  else if (market.finished < 3) { standing = 'limited-history'; r.push({ level: 'info', code: 'limited-history', text: `${market.finished} finished deal(s).` }); }
  else { standing = 'good-standing'; r.push({ level: 'info', code: 'history', text: `${market.finished} finished deal(s), ${market.disputes} dispute(s)${market.averageRating !== null ? `, average rating ${market.averageRating}` : ''}.` }); }
  if (market.kind === 'agent') r.push(market.keyDeclared ? { level: 'info', code: 'key-declared', text: 'The agent declares a KeyZ signing key on its profile.' } : { level: 'info', code: 'key-undeclared', text: 'The agent declares no signing key; its requests cannot be tied to it.' });
  if (market.mandate && !market.mandate.active) r.push({ level: 'warn', code: 'mandate-expired', text: 'The agent’s mandate has expired.' });
  if (!ledger) r.push({ level: 'info', code: 'ledger-not-read', text: 'Ledger facts were not read for this attestation.' });
  else if (ledger.error) r.push({ level: 'info', code: 'ledger-unreadable', text: `The ledger could not be read: ${ledger.error}.` });
  else if (ledger.activated === false) r.push({ level: 'warn', code: 'not-activated', text: 'The profile’s XRPL account is not activated.' });
  if (!uptime) r.push({ level: 'info', code: 'uptime-not-reported', text: 'No endpoint health probes were reported.' });
  else if (uptime.probes > 0 && uptime.passed / uptime.probes < 0.9) r.push({ level: 'warn', code: 'uptime', text: `The endpoint passed ${uptime.passed} of ${uptime.probes} probes (${uptime.from} – ${uptime.to}, by ${uptime.probedBy}).` });
  return { standing, reasons: r };
}

export function buildReputationAttestation(state: MarketState, partyId: string, network: XrplNetwork, now: string, o: { ledger?: AccountFacts | null; uptime?: UptimeReport | null } = {}): ReputationAttestation {
  const p = state.parties.get(partyId);
  const facts = p ? marketFacts(state, null, partyId, now) : null;
  const market = facts && p ? { ...facts, ratings: state.reputation.get(partyId)?.ratings.length ?? 0, keyDeclared: !!p.keyDeclaration, principalCredential: !!p.principalCredential } : null;
  const uptime = o.uptime && Number.isInteger(o.uptime.probes) && Number.isInteger(o.uptime.passed) && o.uptime.passed >= 0 && o.uptime.passed <= o.uptime.probes ? { ...o.uptime, source: 'reported' as const } : null;
  const ledger = o.ledger ?? null;
  return {
    kind: 'cappz-reputation-attestation', version: 1, network, partyId, address: reputationAddress(partyId, now.slice(0, 10)),
    issuedAt: now, validUntil: new Date(Date.parse(now) + REPUTATION_TTL_MS).toISOString(),
    ledger, market, uptime, verdict: reputationVerdict(market, ledger, uptime), rules: REPUTATION_RULES,
  };
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

export function signReputation(attestation: ReputationAttestation, seedHex: string): SignedReputation {
  const seed = unhex(seedHex);
  const msg = new TextEncoder().encode(REPUTATION_DOMAIN + canonicalJson(attestation));
  return { attestation, signature: { alg: 'Ed25519', publicKey: hex(ed25519.getPublicKey(seed)), value: hex(ed25519.sign(msg, seed)) } };
}

export type ReputationCheckState = 'verified-published-key' | 'verified-unbound' | 'stale' | 'bad-signature' | 'malformed';

/** Verify a signed attestation; `expectedPublicKey` is the attester's key from the marketplace discovery document. */
export function verifyReputation(signed: SignedReputation, expectedPublicKey?: string, now: string = new Date().toISOString()): { state: ReputationCheckState; because: string } {
  const a = signed?.attestation; const s = signed?.signature;
  if (!a || !s || a.kind !== 'cappz-reputation-attestation' || a.version !== 1 || s.alg !== 'Ed25519') return { state: 'malformed', because: 'not a CAPPZ reputation attestation' };
  let ok = false;
  try { ok = ed25519.verify(unhex(s.value), new TextEncoder().encode(REPUTATION_DOMAIN + canonicalJson(a)), unhex(s.publicKey)); } catch { ok = false; }
  if (!ok) return { state: 'bad-signature', because: 'the signature does not verify over this attestation' };
  if (a.address !== reputationAddress(a.partyId, a.issuedAt.slice(0, 10))) return { state: 'malformed', because: 'the address does not match the party and date' };
  if (Date.parse(a.validUntil) <= Date.parse(now)) return { state: 'stale', because: `a snapshot of ${a.issuedAt}; ask for a newer one` };
  if (expectedPublicKey && expectedPublicKey.toLowerCase() === s.publicKey.toLowerCase()) return { state: 'verified-published-key', because: 'signed by the published attester key' };
  return { state: 'verified-unbound', because: expectedPublicKey ? 'signed, but not by the published attester key' : 'signed; no expected key was given to compare' };
}
