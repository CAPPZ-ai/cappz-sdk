/**
 * COPE node crystallized. Node ID: v15-31-00-agent-request-auth.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * Signed agent requests. An agent signs each outgoing request (to the
 * signing-approval service, to a paid agent) with its declared KeyZ signing
 * key as an HTTP Message Signature (RFC 9421, alg ed25519) over the method,
 * path, authority, the body's Content-Digest (RFC 9530), the declaring wallet
 * and the party it acts as. The signer and the base are those of
 * identity/edgeVerify.ts, so any RFC 9421 library verifies the same bytes.
 * These are the same headers (Signature-Input / Signature / Content-Digest)
 * that card networks' agent payment protocols and Web Bot Auth build on;
 * their extra parameters (e.g. a `tag`, `expires`, a Signature-Agent key
 * directory) are not emitted here — the key directory is the party's
 * profile on the market's public log.
 *
 * The server checks the signature and then asks the market, not a registry:
 * is the key the one this party's profile declares, by a valid,
 * unrevoked, unexpired wallet declaration? The answer is a lifecycle state.
 * A valid signature by a key the party never declared says nothing about the
 * sender (`verified-unbound`, treated like `not-signed`), and adding a
 * signature never makes the outcome worse than sending none: only a mandate
 * bound to a key (MandateContent.boundKey) requires `verified-bound`.
 *
 * v16-03-00 post-quantum: an agent whose profile declares an ML-DSA-65 request key (pqKeyDeclaration, co-signed by
 * its pqAnchor) adds a second signature, sig2 (alg "ml-dsa-65", keyid = SHA-256 of the key), over the same
 * components. Verifiers then require it: a request from such a party without a valid sig2 is `pq-unsigned` (a
 * forged Ed25519 signature alone is not enough), and `postQuantum` reports hybrid / classical-only.
 */
import { contentDigestHeader, createVerifyGateway, parseSignatureInput, requestSigner, signatureBase, signatureBytes, SIGNED_COMPONENTS, type EdgeVerdict } from '../identity/edgeVerify';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import type { KeyDeclaration, KeyRevocation } from '../identity/keyDeclaration';
import { fromHex, toHex } from '../identity/canonical';
import { agentKeyState, agentPqKeyState, boundKeysOf } from './agentKeys';
import type { MarketState } from './replay';

export type RequestAuthState =
  | 'verified-bound'    // signature verifies; the key is the one the party's profile declares, in force
  | 'verified-unbound'  // signature verifies, but this party never declared the key (says nothing about the sender)
  | 'not-signed'
  | 'bad-signature'     // the signature, or the body against its signed digest, does not verify
  | 'revoked'           // the declaring wallet revoked the key
  | 'expired'           // the key's declaration expired
  | 'stale'             // signed outside the accepted clock window
  | 'replayed'          // the nonce was seen before (or none was sent)
  | 'malformed'
  | 'pq-unsigned'       // the party declares an ML-DSA-65 request key, and the request lacks its valid second signature
  | 'unavailable';      // the verifier could not evaluate (replay cache full): refused rather than guessed

export interface RequestAuth {
  state: RequestAuthState;
  /** The party the request was signed as (signed `cappz-party` component). */
  partyId: string | null;
  keyId?: string;
  walletAddress?: string;
  because: string;
  /** 'hybrid': Ed25519 and the declared ML-DSA-65 key both signed; 'classical-only': Ed25519 only (the party declares no ML-DSA key). */
  postQuantum?: 'hybrid' | 'classical-only';
}

/** The party a request acts as: covered by the signature, so it cannot be swapped. */
export const PARTY_HEADER = 'cappz-party';
export const AGENT_SIGNED_COMPONENTS = [...SIGNED_COMPONENTS, PARTY_HEADER] as const;

/** What an agent keeps to sign: its profile's declaration and the Ed25519 secret (32 bytes, hex) — on its own computer only. */
export interface AgentSigningKey {
  partyId: string; declaration: KeyDeclaration; secretKeyHex: string;
  /** v16-03-00: the ML-DSA-65 request key (its declaration and 32-byte seed, hex): adds sig2. */
  pq?: { declaration: KeyDeclaration; seedHex: string };
}

const PQ_ALG = 'ml-dsa-65';
const sha256Hex = async (hex: string) => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', fromHex(hex) as BufferSource)));
const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

/** A request to sign, as a hook receives it. */
export interface OutgoingRequest { method: string; url: string; body?: Uint8Array | string }
export type RequestSignHook = (req: OutgoingRequest) => Promise<Record<string, string>>;

const bytesOf = (b: Uint8Array | string | undefined) => (typeof b === 'string' ? new TextEncoder().encode(b) : b ?? new Uint8Array());

/** RFC 9421 headers for one request (lower-case names): content-digest, cappz-wallet, cappz-party, signature-input, signature. */
export async function signAgentRequest(req: OutgoingRequest, key: AgentSigningKey, now = Date.now()): Promise<Record<string, string>> {
  const signer = requestSigner({ publicKeyHex: key.declaration.publicKey.toLowerCase(), secretKey: fromHex(key.secretKeyHex) });
  const h = new Headers();
  h.set('content-digest', await contentDigestHeader(bytesOf(req.body)));
  h.set('cappz-wallet', key.declaration.walletAddress);
  h.set(PARTY_HEADER, key.partyId);
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(12)));
  const raw = `(${AGENT_SIGNED_COMPONENTS.map((c) => `"${c}"`).join(' ')});created=${Math.floor(now / 1000)};keyid="${signer.publicKeyHex}";alg="ed25519";nonce="${nonce}"`;
  const base = signatureBase({ components: AGENT_SIGNED_COMPONENTS, raw }, { method: req.method, url: new URL(req.url), headers: h })!;
  const sigHex = await signer.sign(base);
  let input = `sig1=${raw}`;
  let sig = `sig1=:${btoa(String.fromCharCode(...fromHex(sigHex)))}:`;
  if (key.pq) {
    const keyid = await sha256Hex(key.pq.declaration.publicKey.toLowerCase());
    const raw2 = `(${AGENT_SIGNED_COMPONENTS.map((c) => `"${c}"`).join(' ')});created=${Math.floor(now / 1000)};keyid="${keyid}";alg="${PQ_ALG}";nonce="${nonce}"`;
    const base2 = signatureBase({ components: AGENT_SIGNED_COMPONENTS, raw: raw2 }, { method: req.method, url: new URL(req.url), headers: h })!;
    const sk = ml_dsa65.keygen(fromHex(key.pq.seedHex)).secretKey;
    input += `, sig2=${raw2}`;
    sig += `, sig2=:${b64(ml_dsa65.sign(new TextEncoder().encode(base2), sk))}:`;
  }
  h.set('signature-input', input);
  h.set('signature', sig);
  return Object.fromEntries(h.entries());
}

/** A signRequest hook for approvalHook / the agent tool. */
export const agentRequestHook = (key: AgentSigningKey): RequestSignHook => (req) => signAgentRequest(req, key);

const fromVerdict = (v: EdgeVerdict): RequestAuthState | null => {
  switch (v.signature) {
    case 'unsigned': return 'not-signed';
    case 'bad-signature': return 'bad-signature';
    case 'stale': return 'stale';
    case 'replayed': return 'replayed';
    case 'replay-cache-full': return 'unavailable';
    case 'verified': return v.content === 'digest-mismatch' ? 'bad-signature' : null;
    default: return 'malformed';
  }
};

/**
 * Server side. One verifier per process holds the replay cache (nonces seen within ±maxAgeSec); the market state is
 * passed per call (replayed fresh by the caller). The party is read from the signed `cappz-party` component.
 */
export function createAgentRequestVerifier(o: { maxAgeSec?: number; now?: () => number; maxNonces?: number } = {}) {
  const now = o.now ?? Date.now;
  // Key trust is answered from the party's profile below, so the gateway needs no evidence of its own.
  const gateway = createVerifyGateway({ evidence: { evidenceFor: async () => ({ declarations: [] }) }, maxAgeSec: o.maxAgeSec, maxNonces: o.maxNonces, now });
  return {
    async verify(state: MarketState, req: Request, body: Uint8Array, revocations: readonly KeyRevocation[] = []): Promise<RequestAuth> {
      const partyId = req.headers.get(PARTY_HEADER);
      if (!req.headers.has('signature-input') && !req.headers.has('signature')) return { state: 'not-signed', partyId, because: 'no HTTP message signature' };
      const sigInput = req.headers.get('signature-input') ?? '';
      if (partyId !== null && !sigInput.includes(`"${PARTY_HEADER}"`)) return { state: 'malformed', partyId, because: `${PARTY_HEADER} is sent but not covered by the signature` };
      let v: EdgeVerdict;
      // The request as received: proxy hints (x-original-*) and a client-certificate header are the edge gateway's
      // inputs from a trusted proxy, never from the client here, so they are dropped before verifying.
      const headers = new Headers(req.headers);
      for (const h of ['x-original-uri', 'x-original-host', 'x-original-method', 'x-ssl-client-cert']) headers.delete(h);
      try { v = await gateway.verifyRequest(new Request(req.url, { method: req.method, headers }), body); } catch (e) { return { state: 'malformed', partyId, because: `verify fault: ${(e as Error).message}` }; }
      const early = fromVerdict(v);
      const ids = { ...(v.keyId ? { keyId: v.keyId.toLowerCase() } : {}), ...(v.walletAddress ? { walletAddress: v.walletAddress } : {}) };
      if (early) return { state: early, partyId, ...ids, because: v.content === 'digest-mismatch' ? 'the body does not match its signed Content-Digest' : v.because };
      if (!partyId) return { state: 'verified-unbound', partyId, ...ids, because: 'signed, but names no party (cappz-party)' };
      const k = await agentKeyState(state, partyId, v.keyId!, new Date(now()).toISOString(), revocations);
      if (k.walletAddress && v.walletAddress && k.walletAddress.toLowerCase() !== v.walletAddress.toLowerCase()) return { state: 'verified-unbound', partyId, ...ids, because: 'signed under a wallet other than the one that declared the profile key' };
      const s: RequestAuthState = k.state === 'declared' ? 'verified-bound' : k.state === 'revoked' ? 'revoked' : k.state === 'expired' ? 'expired' : k.state === 'pq-unsigned' ? 'pq-unsigned' : 'verified-unbound';
      if (s !== 'verified-bound') return { state: s, partyId, ...ids, because: `key ${k.state}: ${k.because}` };
      // Post-quantum: a party that declares an ML-DSA request key must sign with it too.
      const profile = state.parties.get(partyId)!;
      const pq = await agentPqKeyState(profile, new Date(now()).toISOString(), revocations);
      if (!pq) return { state: s, partyId, ...ids, postQuantum: 'classical-only', because: `signed by ${partyId}'s declared key (${k.because})` };
      if (pq.state !== 'declared') return { state: 'pq-unsigned', partyId, ...ids, because: `the profile's ML-DSA-65 key is ${pq.state} (${pq.because})` };
      const p1 = parseSignatureInput(headers.get('signature-input'), 'sig1');
      const p2 = parseSignatureInput(headers.get('signature-input'), 'sig2');
      const sig2 = signatureBytes(headers.get('signature'), 'sig2');
      if (!p2 || !sig2) return { state: 'pq-unsigned', partyId, ...ids, because: `${partyId} declares an ML-DSA-65 request key; the request carries no sig2` };
      const sameComponents = p2.components.join(' ') === AGENT_SIGNED_COMPONENTS.join(' ');
      if (p2.alg !== PQ_ALG || !sameComponents || p2.keyid !== (await sha256Hex(pq.publicKey)) || p2.created !== p1?.created || p2.nonce !== p1?.nonce) {
        return { state: 'bad-signature', partyId, ...ids, because: 'sig2 does not cover the same components, time and nonce with the declared ML-DSA-65 key' };
      }
      const base2 = signatureBase({ components: p2.components, raw: p2.raw }, { method: req.method, url: new URL(req.url), headers });
      let ok2 = false;
      try { ok2 = !!base2 && ml_dsa65.verify(sig2, new TextEncoder().encode(base2), fromHex(pq.publicKey)); } catch { ok2 = false; }
      if (!ok2) return { state: 'bad-signature', partyId, ...ids, because: 'sig2 (ML-DSA-65) does not verify' };
      return { state: s, partyId, ...ids, postQuantum: 'hybrid', because: `signed by ${partyId}'s declared Ed25519 and ML-DSA-65 keys (${k.because})` };
    },
  };
}

export type AgentRequestVerifier = ReturnType<typeof createAgentRequestVerifier>;

export const NOT_SIGNED: RequestAuth = { state: 'not-signed', partyId: null, because: 'no request signature was presented' };

/**
 * Does the request's auth let `partyId` act now? Only a mandate in force that binds a key requires a request signed by
 * that key (`verified-bound`); otherwise every state is reported and allowed — a signature never makes it worse.
 */
export function requestAuthDecision(state: MarketState, partyId: string, auth: RequestAuth, now: string): { decision: 'allow' | 'refuse'; boundKeys: string[]; reason: string } {
  const boundKeys = boundKeysOf(state, partyId, now);
  if (!boundKeys.length) return { decision: 'allow', boundKeys, reason: `request ${auth.state}; no mandate binds this party to a key` };
  if (auth.partyId !== partyId) return { decision: 'refuse', boundKeys, reason: `the mandate binds ${partyId} to a signing key, and the request is ${auth.partyId ? `signed as ${auth.partyId}` : auth.state}` };
  if (auth.state !== 'verified-bound') return { decision: 'refuse', boundKeys, reason: `the mandate binds ${partyId} to a signing key; the request is ${auth.state} (${auth.because})` };
  if (!auth.keyId || !boundKeys.includes(auth.keyId)) return { decision: 'refuse', boundKeys, reason: `signed by ${auth.keyId?.slice(0, 16)}…, but the mandate is bound to ${boundKeys.map((k) => `${k.slice(0, 16)}…`).join(' or ')}` };
  return { decision: 'allow', boundKeys, reason: 'signed by the key the mandate is bound to' };
}
