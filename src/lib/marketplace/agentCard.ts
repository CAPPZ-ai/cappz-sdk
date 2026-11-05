/**
 * COPE node crystallized. Node ID: v15-31-00-agent-card.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * A2A agent card. Standards before reinvention: a paid agent describes
 * itself in the Agent2Agent (A2A) AgentCard shape served at
 * `/.well-known/agent-card.json` — name, description, url, version,
 * capabilities (with extensions), skills, default modes, and `signatures`.
 * The card is built from what already exists: the paid agent's public
 * `card()` (price, network, stages) and, for the marketplace, the agent API
 * manifest (each operation a skill). Payment and request signing are
 * declared as card extensions under CAPPZ's own URIs, since neither is an
 * OpenAPI security scheme.
 *
 * Signature: A2A's AgentCardSignature, a JWS (RFC 7515) with detached
 * payload in the general JSON form { protected, signature, header? } over
 * the canonical JSON of the card without `signatures`; alg EdDSA (Ed25519).
 * canonicalJson sorts keys by UTF-16 code units and prints with
 * JSON.stringify, which equals RFC 8785 (JCS) for the strings, integers and
 * booleans a card holds (non-integer numbers are not used here).
 *
 * Trust is a state, never a boolean: `declared` when a wallet's KeyZ
 * declaration (purpose signing) names the signing key, `published-key` when
 * it is the key the verifier expected from a discovery document,
 * `verified-unbound` when the signature holds but nothing vouches for the
 * key, and `revoked` / `expired` / `bad-signature` / `not-signed` /
 * `malformed` otherwise.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { evaluateKey, type KeyDeclaration, type KeyRevocation } from '../identity/keyDeclaration';
import { canonicalJson, fromBase64Url, fromHex, toBase64Url, toHex, utf8 } from '../identity/canonical';
import { AGENT_SIGNED_COMPONENTS } from './agentRequestAuth';

export const A2A_PROTOCOL_VERSION = '0.3.0';
export const PAID_AGENT_EXTENSION = 'https://cappz.ai/ext/paid-agent/v1';
export const REQUEST_SIGNATURE_EXTENSION = 'https://cappz.ai/ext/http-message-signatures/v1';

export interface AgentExtension { uri: string; description?: string; required?: boolean; params?: Record<string, unknown> }
export interface AgentSkill { id: string; name: string; description: string; tags: string[]; examples?: string[]; inputModes?: string[]; outputModes?: string[] }
export interface AgentCardSignature { protected: string; signature: string; header?: Record<string, unknown> }
export interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  preferredTransport: string;
  version: string;
  provider?: { organization: string; url: string };
  documentationUrl?: string;
  capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean; extensions: AgentExtension[] };
  securitySchemes?: Record<string, Record<string, unknown>>;
  security?: Array<Record<string, string[]>>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  supportsAuthenticatedExtendedCard: boolean;
  signatures?: AgentCardSignature[];
}

/** The public part of a paid agent (paidAgent.createPaidAgent(...).card()). */
export interface PaidAgentCard { name: string; description: string; network: string; payTo: string; currency: string; issuer: string | null; price: string; stages: Array<{ label: string; kind: string; share: number; amount: string; deliverable?: string }> }
/** The parts of agentApi.agentApiManifest() a card uses. */
export interface ApiManifestLike { name: string; version: string; network: string; operations: Array<{ verb: string; summary: string; writes: boolean }> }

export interface CardInput {
  /** Where the agent is served (the paid-agent base URL, e.g. https://check.example/testnet). */
  url: string;
  version: string;
  paid?: PaidAgentCard;
  manifest?: ApiManifestLike;
  name?: string;
  description?: string;
  provider?: { organization: string; url: string };
  documentationUrl?: string;
  /** Skills the host serves besides the paid job (e.g. a free approval endpoint). */
  extraSkills?: AgentSkill[];
  /** Request signing (agentRequestAuth.ts): accepted (optional) or required by the host. Absent = not declared. */
  requestSigning?: 'optional' | 'required';
  /** Declared trust of the card's own signing key, stated in the card so a reader sees it before verifying. */
  signingKeyTrust?: string;
  securitySchemes?: AgentCard['securitySchemes'];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function buildAgentCard(i: CardInput): AgentCard {
  if (!i.paid && !i.manifest) throw new Error('An agent card needs a paid agent card() or an agent API manifest.');
  const extensions: AgentExtension[] = [];
  const skills: AgentSkill[] = [];
  if (i.paid) {
    const p = i.paid;
    extensions.push({ uri: PAID_AGENT_EXTENSION, required: true, description: `Paid per job in ${p.currency} on XRPL ${p.network}, stage by stage: open a job, pay the stage shown (destination tag per job and stage), collect each result and check its SHA-256.`,
      params: { network: p.network, payTo: p.payTo, currency: p.currency, issuer: p.issuer, price: p.price, stages: p.stages.map((s) => ({ label: s.label, kind: s.kind, amount: s.amount })), protocol: 'POST /jobs {"input"} → pay → POST /jobs/<id>/payments {"txHash"} → GET /jobs/<id>/stages/<n>/result' } });
    skills.push({ id: slug(p.name) || 'paid-job', name: p.name, description: `${p.description} Price: ${p.price} ${p.currency} per job (${p.stages.map((s) => `${s.label} ${s.amount}`).join(', ')}).`, tags: ['paid', p.currency.toLowerCase(), `xrpl-${p.network}`], inputModes: ['application/json'], outputModes: ['application/json'] });
  }
  if (i.manifest) for (const op of i.manifest.operations) skills.push({ id: op.verb, name: op.verb, description: op.summary, tags: [i.manifest.name, op.writes ? 'governed-write' : 'read'], inputModes: ['application/json'], outputModes: ['application/json'] });
  skills.push(...(i.extraSkills ?? []));
  if (i.requestSigning) extensions.push({ uri: REQUEST_SIGNATURE_EXTENSION, required: i.requestSigning === 'required', description: 'HTTP Message Signatures (RFC 9421, alg ed25519) with Content-Digest (RFC 9530), keyed by the party’s KeyZ-declared signing key on its marketplace profile. Unsigned requests are reported, not refused, unless the agent’s mandate binds a key.',
    params: { alg: 'ed25519', components: [...AGENT_SIGNED_COMPONENTS], keyDirectory: 'the party profile (keyDeclaration) on the market’s public log', states: ['verified-bound', 'verified-unbound', 'not-signed', 'bad-signature', 'revoked', 'expired', 'stale', 'replayed', 'malformed'] } });
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: i.name ?? i.paid?.name ?? i.manifest!.name,
    description: i.description ?? i.paid?.description ?? `Marketplace agent API (${i.manifest!.network}).`,
    url: i.url, preferredTransport: 'HTTP+JSON', version: i.version,
    ...(i.provider ? { provider: i.provider } : {}), ...(i.documentationUrl ? { documentationUrl: i.documentationUrl } : {}),
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true, extensions: i.signingKeyTrust ? [...extensions, { uri: 'https://cappz.ai/ext/card-signing-key/v1', required: false, description: i.signingKeyTrust }] : extensions },
    ...(i.securitySchemes ? { securitySchemes: i.securitySchemes } : {}),
    defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'], skills, supportsAuthenticatedExtendedCard: false,
  };
}

const b64json = (v: unknown) => toBase64Url(utf8(JSON.stringify(v)));
const signingInput = (protectedB64: string, card: AgentCard) => { const { signatures: _s, ...rest } = card; return utf8(`${protectedB64}.${toBase64Url(utf8(canonicalJson(rest)))}`); };

/** Sign a card with a 32-byte Ed25519 seed (hex); the KeyZ declaration of that key, when there is one, rides in the unprotected header. */
export function signAgentCard(card: AgentCard, seedHex: string, keyDeclaration?: KeyDeclaration): AgentCard {
  const seed = fromHex(seedHex);
  const kid = toHex(ed25519.getPublicKey(seed));
  const prot = b64json({ alg: 'EdDSA', typ: 'JOSE', kid });
  const sig = toBase64Url(ed25519.sign(signingInput(prot, card), seed));
  const { signatures: _s, ...rest } = card;
  return { ...rest, signatures: [{ protected: prot, signature: sig, ...(keyDeclaration ? { header: { keyDeclaration } } : {}) }] };
}

export type CardTrustState = 'declared' | 'published-key' | 'verified-unbound' | 'revoked' | 'expired' | 'wrong-purpose' | 'bad-signature' | 'not-signed' | 'malformed';
export interface CardVerification { state: CardTrustState; kid?: string; because: string }

const RANK: Record<CardTrustState, number> = { declared: 9, 'published-key': 8, 'verified-unbound': 6, revoked: 5, expired: 5, 'wrong-purpose': 4, 'bad-signature': 2, 'not-signed': 1, malformed: 0 };

/**
 * Verify a card's signatures. `expectedPublicKey` is the key a discovery document publishes for the host;
 * `declarations` / `revocations` are KeyZ evidence the verifier holds (a declaration in the card's header counts too).
 */
export async function verifyAgentCard(card: AgentCard, o: { expectedPublicKey?: string; declarations?: readonly KeyDeclaration[]; revocations?: readonly KeyRevocation[]; now?: number } = {}): Promise<CardVerification> {
  if (!card || typeof card !== 'object') return { state: 'malformed', because: 'not an agent card' };
  if (!Array.isArray(card.signatures) || !card.signatures.length) return { state: 'not-signed', because: 'the card carries no signatures' };
  let best: CardVerification = { state: 'malformed', because: 'no readable signature' };
  for (const s of card.signatures.slice(0, 8)) {
    let v: CardVerification;
    let header: { alg?: string; kid?: string };
    try { header = JSON.parse(new TextDecoder().decode(fromBase64Url(String(s.protected)))); } catch { header = {}; }
    if (header.alg !== 'EdDSA' || !/^[0-9a-f]{64}$/i.test(String(header.kid ?? ''))) v = { state: 'malformed', because: 'protected header must carry alg EdDSA and a 32-byte Ed25519 kid (hex)' };
    else {
      const kid = header.kid!.toLowerCase();
      let ok = false;
      try { ok = ed25519.verify(fromBase64Url(String(s.signature)), signingInput(String(s.protected), card), fromHex(kid)); } catch { ok = false; }
      if (!ok) v = { state: 'bad-signature', kid, because: 'the signature does not verify over the canonical card' };
      else {
        const inHeader = (s.header as { keyDeclaration?: KeyDeclaration } | undefined)?.keyDeclaration;
        const decls = [...(o.declarations ?? []), ...(inHeader && typeof inHeader === 'object' ? [inHeader] : [])].filter((d) => d?.v === 2 && typeof d.publicKey === 'string' && d.publicKey.toLowerCase() === kid);
        let keyz: CardVerification | null = null;
        for (const d of decls) {
          const t = await evaluateKey(d.walletAddress, kid, 'signing', { declarations: [d], revocations: o.revocations ?? [] }, o.now ?? Date.now());
          const st: CardTrustState | null = t.state === 'declared' ? 'declared' : t.state === 'revoked' ? 'revoked' : t.state === 'expired' ? 'expired' : t.state === 'wrong-purpose' ? 'wrong-purpose' : null;
          if (st && (!keyz || RANK[st] > RANK[keyz.state])) keyz = { state: st, kid, because: `KeyZ: ${t.because} (wallet ${d.walletAddress.slice(0, 12)}…)` };
        }
        // A revoked or expired declaration is a fact about the key: a published-key match does not override it.
        if (keyz && keyz.state !== 'wrong-purpose') v = keyz;
        else if (o.expectedPublicKey && o.expectedPublicKey.toLowerCase() === kid) v = { state: 'published-key', kid, because: 'signed by the key the discovery document publishes for this host (not KeyZ-declared)' };
        else v = keyz ?? { state: 'verified-unbound', kid, because: 'the signature verifies, but no declaration or published key vouches for the key' };
      }
    }
    if (RANK[v.state] > RANK[best.state]) best = v;
  }
  return best;
}
