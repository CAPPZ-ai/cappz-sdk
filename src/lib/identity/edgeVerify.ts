/**
 * COPE node crystallized.
 * Node ID: v15-09-00-edge-verify
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Verify at the edge, not the origin. One Fetch-API handler (Request →
 * Response) that sits next to nginx/Caddy in the DMZ, on the edge node, in a
 * browser demo or a test — "verified" means the same at every hop. A check is
 * a hash plus a signature: no database, no network, no shared state, so it
 * scales by adding (ARM) nodes.
 *
 * Three ways in, safest last to adopt:
 *   1. Legacy mTLS: nginx terminates TLS with `ssl_verify_client
 *      optional_no_ca` and passes the client certificate
 *      (`proxy_set_header X-SSL-Client-Cert $ssl_client_escaped_cert`). The
 *      certificate is a projection (x509.ts): its key is trusted exactly as
 *      far as the wallet declared it for 'tls'.
 *   2. HTTP Message Signatures (RFC 9421 subset, alg ed25519) with
 *      Content-Digest (RFC 9530): any language's library can sign requests
 *      with a wallet-declared device key; `Cappz-Wallet` names the wallet and
 *      `Cappz-Key-Declaration` may carry the wallet's signed declaration.
 *   3. Native CPZ1 sessions (signed hello) — the relay, unchanged.
 *
 * Modes: nginx `auth_request` (no body: the origin checks the body against
 * the signed Content-Digest with checkContentDigest), proxy (the gateway
 * reads the body, checks the digest, forwards with Cappz-Verified-* headers
 * and strips any the client sent), and content verdicts for detached
 * signatures over a content hash (datasets, model weights, notarized files).
 *
 * The answer is the platform's layered trust, never one boolean: the
 * signature state, the key's trust (declared, delegated, operator-listed,
 * undeclared, revoked, expired…), the content digest, and the ledger anchor
 * (unchecked unless an anchor checker is configured). Verdicts on a content
 * hash are cached by hash; key trust is re-read every time, so a revocation
 * takes effect on the next request.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { hasWebCryptoEd25519, signCanonical, verifyCanonical, type SigningKey } from '../sync/helloSignature.ts';
import { evaluateKey, type KeyDeclaration, type KeyEvidence, type KeyTrustState } from './keyDeclaration.ts';
import type { HelloKeyDeclaration } from '../sync/helloKeyDeclaration.ts';
import { buf, fromBase64Url, fromHex, sha256, toHex, utf8 } from './canonical.ts';
import { parseCertificate, verifySelfSignature, certificateBindings } from './x509.ts';
import { parseDidKey } from './didKey.ts';
import { readLegacyVerdict, type createShadowComparison, type CostAssumptions } from './shadowCompare.ts';

export type SignatureState = 'verified' | 'mtls' | 'unsigned' | 'bad-signature' | 'stale' | 'replayed' | 'malformed' | 'replay-cache-full' | 'too-large';
export type ContentState = 'digest-match' | 'digest-mismatch' | 'signed-digest' | 'not-checked';
export type AnchorState = 'anchored' | 'not-anchored' | 'unchecked';
/** evidence-unavailable: the evidence files could not be read and no good copy is held — fail closed (503). */
export type GatewayTrust = KeyTrustState | 'operator-listed' | 'evidence-unavailable';

export interface EdgeVerdict {
  allowed: boolean;
  status: number;
  signature: SignatureState;
  trust: GatewayTrust;
  content: ContentState;
  anchor: AnchorState;
  walletAddress?: string;
  keyId?: string;
  contentSha256?: string;
  because: string;
}

export interface EvidenceSource {
  /** Declarations, revocations and delegations known for a wallet (replicated, never fetched per request). */
  evidenceFor(walletAddress: string): Promise<KeyEvidence>;
  /** Legacy operator key lists (declared-hello-keys.json): honoured, but reported as 'operator-listed'. */
  operatorKeysFor?(walletAddress: string): Promise<readonly string[] | null>;
}

export interface GatewayOptions {
  evidence: EvidenceSource;
  /** Refuse keys the wallet did not declare or delegate (operator lists still count as bound). */
  requireBound?: boolean;
  maxAgeSec?: number;
  /** Proxy mode: verified requests are forwarded here (URL prefix or a function). */
  upstream?: string | ((req: Request) => Promise<Response>);
  /** Header nginx puts the escaped client certificate in. */
  clientCertHeader?: string;
  anchorCheck?: (contentSha256: string) => Promise<AnchorState>;
  /**
   * v15-11-00 shadow mode: the upstream (a legacy verifier, e.g. a PHP route) stays authoritative — every
   * request is forwarded and its response returned unchanged — and the gateway records its own verdict next
   * to the route's X-Legacy-Verdict for shadowCompare.ts. GET /cappz/verify/shadow answers the report.
   */
  shadow?: { compare: ReturnType<typeof createShadowComparison>; legacyHeader?: string; cost: CostAssumptions };
  /** v15-11-00 hardening: largest request body read (default 10 MB) — beyond it 413, never buffered. */
  maxBodyBytes?: number;
  /** Most nonces held for replay detection (default 1,000,000); when full, new signers are refused (503), never let through. */
  maxNonces?: number;
  /** Refuse multipart bodies before they reach the upstream (e.g. a PHP app whose multipart / upload-progress parsing is exposed). */
  denyMultipart?: boolean;
  /** Content verdict cache size (by content hash + key + signature). */
  cacheSize?: number;
  now?: () => number;
}

/** RFC 9110 §7.6.1 hop-by-hop headers, plus those fetch sets itself: never forwarded by a proxy. */
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'host', 'content-length', 'expect'];

const VERIFIED_HEADERS = ['cappz-verified-signature', 'cappz-verified-trust', 'cappz-verified-content', 'cappz-verified-anchor', 'cappz-verified-wallet', 'cappz-verified-key'];

// ─── RFC 9421 subset ──────────────────────────────────────────────

export const SIGNED_COMPONENTS = ['@method', '@path', '@authority', 'content-digest', 'cappz-wallet'] as const;

/** RFC 9530 Content-Digest value for a body. */
export async function contentDigestHeader(body: Uint8Array): Promise<string> {
  let s = ''; for (const b of await sha256(body)) s += String.fromCharCode(b);
  return `sha-256=:${btoa(s)}:`;
}

function digestHex(header: string | null): string | null {
  const m = header ? /sha-256=:([A-Za-z0-9+/=]+):/.exec(header) : null;
  if (!m) return null;
  try { return toHex(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))); } catch { return null; }
}

/** Origin-side check for auth_request mode: does the body match the Content-Digest the gateway saw signed? */
export async function checkContentDigest(body: Uint8Array, header: string | null): Promise<boolean> {
  const want = digestHex(header);
  return Boolean(want) && toHex(await sha256(body)) === want;
}

interface SigParams { components: string[]; created: number; keyid: string; alg: string; nonce?: string; raw: string }

function parseSignatureInput(v: string | null): SigParams | null {
  const m = v ? /^sig1=\(([^)]*)\)(.*)$/.exec(v.trim()) : null;
  if (!m) return null;
  const components = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  const params = Object.fromEntries([...m[2].matchAll(/;(\w+)=("([^"]*)"|\d+)/g)].map((x) => [x[1], x[3] ?? x[2]]));
  const created = Number(params.created);
  if (!params.keyid || !Number.isFinite(created)) return null;
  return { components, created, keyid: String(params.keyid), alg: String(params.alg ?? ''), nonce: params.nonce ? String(params.nonce) : undefined, raw: v!.trim().slice(5) };
}

function componentValue(name: string, req: { method: string; url: URL; headers: Headers }): string | null {
  switch (name) {
    case '@method': return req.method.toUpperCase();
    case '@path': return req.url.pathname;
    case '@authority': return req.url.host.toLowerCase();
    default: return req.headers.get(name);
  }
}

export function signatureBase(p: { components: readonly string[]; raw: string }, req: { method: string; url: URL; headers: Headers }): string | null {
  const lines: string[] = [];
  for (const c of p.components) { const v = componentValue(c, req); if (v === null) return null; lines.push(`"${c}": ${v}`); }
  lines.push(`"@signature-params": ${p.raw}`);
  return lines.join('\n');
}

/** Client side: sign a request with an Ed25519 device key (any RFC 9421 library produces the same headers). */
export async function signRequest(req: { method: string; url: string; body?: Uint8Array; walletAddress: string; declaration?: HelloKeyDeclaration | KeyDeclaration }, key: { publicKeyHex: string; sign(base: string): Promise<string> }, now = Date.now()): Promise<Headers> {
  const h = new Headers();
  h.set('content-digest', await contentDigestHeader(req.body ?? new Uint8Array()));
  h.set('cappz-wallet', req.walletAddress);
  if (req.declaration) h.set('cappz-key-declaration', btoa(JSON.stringify(req.declaration)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(12)));
  const raw = `(${SIGNED_COMPONENTS.map((c) => `"${c}"`).join(' ')});created=${Math.floor(now / 1000)};keyid="${key.publicKeyHex}";alg="ed25519";nonce="${nonce}"`;
  const base = signatureBase({ components: SIGNED_COMPONENTS, raw }, { method: req.method, url: new URL(req.url), headers: h })!;
  h.set('signature-input', `sig1=${raw}`);
  h.set('signature', `sig1=:${hexToB64(await key.sign(base))}:`);
  return h;
}

const hexToB64 = (hex: string) => btoa(String.fromCharCode(...(hex.match(/../g) ?? []).map((x) => parseInt(x, 16))));
const b64ToHex = (b64: string) => toHex(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

// ─── Gateway ──────────────────────────────────────────────────────

class Lru<V> {
  private m = new Map<string, V>();
  constructor(private size: number) {}
  get(k: string) { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }
  set(k: string, v: V) { this.m.delete(k); this.m.set(k, v); if (this.m.size > this.size) this.m.delete(this.m.keys().next().value!); }
}

export interface VerifyGateway {
  handle(req: Request): Promise<Response>;
  /** Verify one request without answering it (tests, embedding). */
  verifyRequest(req: Request, body?: Uint8Array): Promise<EdgeVerdict>;
  /** Detached signature over a content hash. */
  verifyContent(input: { contentSha256: string; walletAddress: string; publicKey: string; signature: string; declaration?: HelloKeyDeclaration | KeyDeclaration }): Promise<EdgeVerdict>;
}

export function createVerifyGateway(o: GatewayOptions): VerifyGateway {
  const now = o.now ?? Date.now;
  const maxAge = o.maxAgeSec ?? 300;
  const nonces = new Map<string, number>();
  const sigCache = new Lru<boolean>(o.cacheSize ?? 10_000);
  const certHeader = (o.clientCertHeader ?? 'x-ssl-client-cert').toLowerCase();

  const maxNonces = o.maxNonces ?? 1_000_000;
  let sweptAt = 0;
  /** 'seen' | 'new' | 'full'. Expiry times are not monotonic (created is client-chosen within ±maxAge), so sweep fully, not up to the first live entry. */
  function seenNonce(keyid: string, nonce: string, created: number): 'seen' | 'new' | 'full' {
    const t = now();
    if (nonces.size >= maxNonces || t - sweptAt > 10_000) { sweptAt = t; for (const [k, exp] of nonces) if (exp < t) nonces.delete(k); }
    const id = `${keyid}|${nonce}`;
    if (nonces.has(id)) return 'seen';
    // Full of live nonces: refuse (a flood of fresh signers), never forget one early (that would reopen replay).
    if (nonces.size >= maxNonces) return 'full';
    nonces.set(id, (created + maxAge) * 1000 + 1000);
    return 'new';
  }

  async function keyTrust(walletAddress: string, publicKey: string, purpose: 'hello' | 'tls' | 'signing', presented?: HelloKeyDeclaration | KeyDeclaration): Promise<{ trust: GatewayTrust; because: string }> {
    let ev: KeyEvidence;
    // Unreadable evidence (a half-written revocation file) must never read as "no revocations": fail closed.
    try { ev = await o.evidence.evidenceFor(walletAddress); } catch (err) { return { trust: 'evidence-unavailable', because: `key evidence unavailable: ${err instanceof Error ? err.message : err}` }; }
    // Stored evidence is operator-supplied JSON: entries of the wrong shape are skipped, never dereferenced.
    // Never cached by array identity: in-memory sources mutate their arrays (a pushed revocation must count at once).
    ev = { ...ev, declarations: ev.declarations.filter(isDeclarationShape), revocations: (ev.revocations ?? []).filter((r) => !!r && typeof r.publicKey === 'string' && typeof r.walletAddress === 'string' && typeof r.declarationHash === 'string'), delegations: (ev.delegations ?? []).filter((d) => !!d && typeof d.publicKey === 'string' && typeof d.parentPublicKey === 'string') };
    const declarations = presented ? [...ev.declarations, presented] : ev.declarations;
    // A request-signing key may be declared for hello (device key) or signing.
    const purposes: Array<'hello' | 'tls' | 'signing'> = purpose === 'tls' ? ['tls'] : ['signing', 'hello'];
    let best: { trust: GatewayTrust; because: string } | null = null;
    for (const p of purposes) {
      const t = await evaluateKey(walletAddress, publicKey, p, { ...ev, declarations }, now());
      if (t.state === 'declared' || t.state === 'delegated') return { trust: t.state, because: t.because };
      if (!best || best.trust === 'undeclared' || best.trust === 'wrong-purpose') best = { trust: t.state, because: t.because };
    }
    if (best!.trust === 'undeclared') {
      let listed: readonly string[] | null | undefined;
      try { listed = await o.evidence.operatorKeysFor?.(walletAddress); } catch { listed = null; }
      if (listed?.some((k) => k.toLowerCase() === publicKey.toLowerCase())) {
        const revoked = (ev.revocations ?? []).some((r) => r.walletAddress === walletAddress && r.publicKey.toLowerCase() === publicKey.toLowerCase());
        return revoked ? { trust: 'revoked', because: 'operator-listed key the wallet revoked' } : { trust: 'operator-listed', because: 'listed by the node operator (declared-hello-keys.json), not by a wallet declaration' };
      }
    }
    return best!;
  }

  function decide(signature: SignatureState, trust: GatewayTrust, content: ContentState, because: string, extra: Partial<EdgeVerdict>): EdgeVerdict {
    let status = 200;
    if (signature === 'replay-cache-full' || trust === 'evidence-unavailable') status = 503;
    else if (signature === 'too-large') status = 413;
    else if (signature !== 'verified' && signature !== 'mtls') status = 401;
    else if (content === 'digest-mismatch') status = 422;
    else if (!(trust === 'declared' || trust === 'delegated' || trust === 'operator-listed' || (trust === 'undeclared' && !o.requireBound))) status = 403;
    return { allowed: status === 200, status, signature, trust, content, anchor: 'unchecked', because, ...extra };
  }

  async function withAnchor(v: EdgeVerdict): Promise<EdgeVerdict> {
    if (!v.allowed || !v.contentSha256 || !o.anchorCheck) return v;
    try { return { ...v, anchor: await o.anchorCheck(v.contentSha256) }; } catch { return v; }
  }

  /** A client-supplied declaration: size-capped and shape-checked before anything reads it; anything else is ignored. */
  function presentedDeclaration(h: Headers): HelloKeyDeclaration | KeyDeclaration | undefined {
    const raw = h.get('cappz-key-declaration');
    if (!raw || raw.length > 4096) return undefined;
    let d: unknown;
    try { d = JSON.parse(new TextDecoder().decode(fromBase64Url(raw))); } catch { return undefined; }
    return isDeclarationShape(d) ? d : undefined;
  }

  async function verifyMtls(pemEscaped: string): Promise<EdgeVerdict> {
    let pem: string;
    try { pem = decodeURIComponent(pemEscaped); } catch { return decide('malformed', 'undeclared', 'not-checked', 'client certificate header unreadable', {}); }
    let cert;
    try { cert = await parseCertificate(pem); } catch { return decide('malformed', 'undeclared', 'not-checked', 'client certificate unreadable', {}); }
    const t = now();
    if (cert.notBefore.getTime() - 300_000 > t || cert.notAfter.getTime() <= t) return decide('stale', 'expired', 'not-checked', 'client certificate outside its validity window', {});
    if (!(await verifySelfSignature(cert))) return decide('bad-signature', 'undeclared', 'not-checked', 'client certificate is not self-signed by its own key (CA-issued certificates are not wallet projections)', {});
    const did = certificateBindings(cert).walletDid;
    const wallet = did ? parseDidKey(did) : null;
    if (!wallet || wallet.algorithm !== 'secp256k1') return decide('mtls', 'undeclared', 'not-checked', 'certificate names no wallet (did:key SAN)', { keyId: cert.publicKeyHex });
    const k = await keyTrust(wallet.publicKeyHex, cert.publicKeyHex, 'tls');
    return decide('mtls', k.trust, 'not-checked', `mTLS: ${k.because}`, { walletAddress: wallet.publicKeyHex, keyId: cert.publicKeyHex });
  }

  async function verifyRequest(req: Request, body?: Uint8Array): Promise<EdgeVerdict> {
    const pem = req.headers.get(certHeader);
    if (pem) return pem.length > 16_384 ? decide('malformed', 'undeclared', 'not-checked', 'client certificate header too large', {}) : verifyMtls(pem);
    const original = req.headers.get('x-original-uri');
    // auth_request: nginx passes the original URI and host (proxy_set_header X-Original-Host $host).
    const url = original ? new URL(original, `https://${req.headers.get('x-original-host') ?? new URL(req.url).host}`) : new URL(req.url);
    const method = req.headers.get('x-original-method') ?? req.method;
    const p = parseSignatureInput(req.headers.get('signature-input'));
    const sigHeader = /sig1=:([A-Za-z0-9+/=]+):/.exec(req.headers.get('signature') ?? '');
    if (!p || !sigHeader) return decide('unsigned', 'undeclared', 'not-checked', 'no HTTP message signature (RFC 9421 sig1) and no client certificate', {});
    const wallet = req.headers.get('cappz-wallet');
    // The wallet is a compressed secp256k1 key: checked before it is used as a lookup key or echoed in a header.
    if (wallet && !WALLET_RE.test(wallet)) return decide('malformed', 'undeclared', 'not-checked', 'cappz-wallet must be a compressed secp256k1 public key (66 hex)', {});
    if (!/^[0-9a-f]{64}$/i.test(p.keyid)) return decide('malformed', 'undeclared', 'not-checked', 'keyid must be a 32-byte Ed25519 key in hex', {});
    if (p.alg !== 'ed25519' || !wallet || SIGNED_COMPONENTS.some((c) => !p.components.includes(c))) return decide('malformed', 'undeclared', 'not-checked', `signature must be alg ed25519 and cover ${SIGNED_COMPONENTS.join(', ')}`, {});
    const base = signatureBase(p, { method, url, headers: req.headers });
    if (!base) return decide('malformed', 'undeclared', 'not-checked', 'a signed component is missing from the request', {});
    let ok = false;
    try { ok = await verifyCanonicalRaw(base, b64ToHex(sigHeader[1]), p.keyid); } catch { ok = false; }
    if (!ok) return decide('bad-signature', 'undeclared', 'not-checked', 'signature does not verify against keyid', { walletAddress: wallet, keyId: p.keyid });
    if (Math.abs(now() / 1000 - p.created) > maxAge) return decide('stale', 'undeclared', 'not-checked', `signature created outside ±${maxAge}s`, { walletAddress: wallet, keyId: p.keyid });
    const seen = p.nonce && p.nonce.length <= 128 ? seenNonce(p.keyid, p.nonce, p.created) : 'seen';
    if (seen === 'full') return decide('replay-cache-full', 'undeclared', 'not-checked', 'replay cache full of live nonces: refused rather than forgetting one', { walletAddress: wallet, keyId: p.keyid });
    if (seen === 'seen') return decide('replayed', 'undeclared', 'not-checked', p.nonce ? 'nonce already used (or longer than 128)' : 'signature carries no nonce', { walletAddress: wallet, keyId: p.keyid });
    const signedDigest = digestHex(req.headers.get('content-digest'));
    let content: ContentState = 'signed-digest';
    if (body) content = signedDigest && toHex(await sha256(body)) === signedDigest ? 'digest-match' : 'digest-mismatch';
    const k = await keyTrust(wallet, p.keyid, 'signing', presentedDeclaration(req.headers));
    return withAnchor(decide('verified', k.trust, content, k.because, { walletAddress: wallet, keyId: p.keyid, contentSha256: signedDigest ?? undefined }));
  }

  async function verifyContent(i: { contentSha256: string; walletAddress: string; publicKey: string; signature: string; declaration?: HelloKeyDeclaration | KeyDeclaration }): Promise<EdgeVerdict> {
    if (!i || typeof i !== 'object' || !/^[0-9a-f]{64}$/.test(String(i.contentSha256)) || !WALLET_RE.test(String(i.walletAddress)) || !/^[0-9a-f]{64}$/i.test(String(i.publicKey)) || !/^[0-9a-f]{128}$/i.test(String(i.signature))) return decide('malformed', 'undeclared', 'not-checked', 'contentSha256 (64 hex), walletAddress (66 hex), publicKey (64 hex) and signature (128 hex) required', {});
    if (i.declaration !== undefined && !isDeclarationShape(i.declaration)) i = { ...i, declaration: undefined };
    const ck = `${i.contentSha256}|${i.publicKey}|${i.signature}`;
    let ok = sigCache.get(ck);
    if (ok === undefined) { ok = await verifyCanonical(`cappz-content-v1|${i.contentSha256}`, i.signature, i.publicKey); sigCache.set(ck, ok); }
    if (!ok) return decide('bad-signature', 'undeclared', 'not-checked', 'content signature does not verify', { walletAddress: i.walletAddress, keyId: i.publicKey, contentSha256: i.contentSha256 });
    const k = await keyTrust(i.walletAddress, i.publicKey, 'signing', i.declaration);
    return withAnchor(decide('verified', k.trust, 'signed-digest', k.because, { walletAddress: i.walletAddress, keyId: i.publicKey, contentSha256: i.contentSha256 }));
  }

  const headersOf = (v: EdgeVerdict) => ({
    'cappz-verified-signature': v.signature, 'cappz-verified-trust': v.trust, 'cappz-verified-content': v.content, 'cappz-verified-anchor': v.anchor,
    ...(v.walletAddress ? { 'cappz-verified-wallet': v.walletAddress } : {}), ...(v.keyId ? { 'cappz-verified-key': v.keyId } : {}),
  });

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/cappz/verify/content') && req.method === 'POST') {
      let input;
      try { const b = await readBounded(req, 64 * 1024); if (!b) return Response.json({ error: 'body too large' }, { status: 413 }); input = JSON.parse(new TextDecoder().decode(b)); } catch { return Response.json({ error: 'JSON body required' }, { status: 400 }); }
      const v = await verifyContent(input);
      return Response.json(v, { status: v.status, headers: headersOf(v) });
    }
    // auth_request mode: answer only (nginx forwards the original request itself).
    if (url.pathname.endsWith('/cappz/verify') || req.headers.has('x-original-uri')) {
      const v = await verifyRequest(req);
      return new Response(null, { status: v.allowed ? 204 : v.status, headers: headersOf(v) });
    }
    if (o.shadow && url.pathname.endsWith('/cappz/verify/shadow') && req.method === 'GET') return Response.json(await o.shadow.compare.report(o.shadow.cost), { headers: { 'cache-control': 'no-store' } });
    if (!o.upstream) return Response.json({ error: 'no upstream configured; use /cappz/verify (auth_request) or /cappz/verify/content' }, { status: 404 });
    if (o.denyMultipart && /^multipart\//i.test(req.headers.get('content-type') ?? '')) return Response.json({ error: 'multipart bodies are not accepted on this route' }, { status: 415 });
    // Bounded read: an oversized or endless body is refused, never buffered whole (the out-of-memory trigger).
    const body = await readBounded(req, o.maxBodyBytes ?? 10 * 1024 * 1024);
    if (!body) { const v = decide('too-large', 'undeclared', 'not-checked', `request body over ${o.maxBodyBytes ?? 10 * 1024 * 1024} bytes`, {}); return Response.json(v, { status: v.status, headers: headersOf(v) }); }
    const started = performance.now();
    let v: EdgeVerdict;
    try { v = await verifyRequest(req, body); }
    catch (err) {
      // Never let a verify fault pass a request; in shadow mode it is recorded and the legacy path still answers.
      v = decide('malformed', 'undeclared', 'not-checked', `verify fault: ${err instanceof Error ? err.message : err}`, {});
    }
    const cappzMs = performance.now() - started;
    if (o.shadow) {
      // Legacy stays authoritative: forward everything, return its response, record both verdicts.
      const fwd = new Headers(req.headers);
      for (const h of [...VERIFIED_HEADERS, ...HOP_BY_HOP, ...(req.headers.get('connection') ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)]) fwd.delete(h);
      fwd.set('x-original-host', url.host); // the authority the client signed; fetch replaces Host
      const init: RequestInit = { method: req.method, headers: fwd, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body as BodyInit };
      const res = typeof o.upstream === 'function' ? await o.upstream(new Request(req.url, init)) : await fetch(new Request(o.upstream.replace(/\/$/, '') + url.pathname + url.search, init));
      const legacy = readLegacyVerdict(res, o.shadow.legacyHeader);
      o.shadow.compare.record({ cappz: v, cappzMs, legacy: legacy.verdict, legacyMs: legacy.ms, path: url.pathname });
      return passThrough(res);
    }
    if (!v.allowed) return Response.json(v, { status: v.status, headers: headersOf(v) });
    const fwd = new Headers(req.headers);
    for (const h of [...VERIFIED_HEADERS, ...HOP_BY_HOP, ...(req.headers.get('connection') ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)]) fwd.delete(h);
    for (const [k, val] of Object.entries(headersOf(v))) fwd.set(k, val);
    fwd.set('x-original-host', url.host);
    const init: RequestInit = { method: req.method, headers: fwd, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body as BodyInit };
    if (typeof o.upstream === 'function') return passThrough(await o.upstream(new Request(req.url, init)));
    return passThrough(await fetch(new Request(o.upstream.replace(/\/$/, '') + url.pathname + url.search, init)));
  }

  return { handle, verifyRequest, verifyContent };
}

const WALLET_RE = /^0[23][0-9a-f]{64}$/i;


/** Structural check of an untrusted declaration before any field is read (signatures are checked later). */
export function isDeclarationShape(d: unknown): d is HelloKeyDeclaration | KeyDeclaration {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  const x = d as Record<string, unknown>;
  const str = (k: string, re: RegExp) => typeof x[k] === 'string' && re.test(x[k] as string);
  const common = str('walletAddress', WALLET_RE) && str('signature', /^[0-9a-f]{120,160}$/i) && str('issuedAt', /^\d{4}-/) && str('expiresAt', /^\d{4}-/);
  if (x.v === 1) return common && str('devicePublicKey', /^[0-9a-f]{64}$/i);
  if (x.v === 2) return common && str('publicKey', /^[0-9a-f]{64,130}$/i) && ['hello', 'tls', 'signing', 'encryption'].includes(x.purpose as string) && ['ed25519', 'p256', 'secp256k1', 'x25519'].includes(x.algorithm as string);
  return false;
}

/** Read a request body up to max bytes; null when it is larger (checked as it streams, not after). */
export async function readBounded(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader(); const parts: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * Return an upstream response. A small one is buffered and sent in one write: streaming it through made
 * the server write headers and body separately, and the client's delayed ACK held the second write
 * ~40 ms (measured on Deno 2.5: 50 ms vs 0.5 ms per forwarded request). Bodies up to 1 MB are buffered
 * with or without a Content-Length (php-fpm behind nginx answers chunked); larger ones stream.
 */
async function passThrough(res: Response): Promise<Response> {
  if (!res.body) return res;
  const headers = new Headers(res.headers);
  headers.delete('content-encoding'); headers.delete('transfer-encoding'); headers.delete('content-length');
  // Read up to 1 MB whether or not the upstream sent a length (php-fpm behind nginx answers chunked).
  const reader = res.body.getReader(); const parts: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      const out = new Uint8Array(n); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
      return new Response(out, { status: res.status, statusText: res.statusText, headers });
    }
    parts.push(value); n += value.length;
    if (n > 1_048_576) break;
  }
  // Large: stream what was read, then the rest.
  const stream = new ReadableStream<Uint8Array>({
    start(c) { for (const p of parts) c.enqueue(p); },
    async pull(c) { const { done, value } = await reader.read(); if (done) c.close(); else c.enqueue(value); },
    cancel(r) { return reader.cancel(r); },
  });
  return new Response(stream, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Ed25519 over the raw signature base (RFC 9421 signs the base itself, not its hash). Native WebCrypto where
 * the runtime has it — 16× faster than the pure-JS fallback measured on Deno 2.5 (0.05 vs 0.83 ms) — with
 * imported keys cached by keyid; the fallback stays for browsers without WebCrypto Ed25519.
 */
const importedKeys = new Map<string, Promise<CryptoKey | null>>();
async function verifyCanonicalRaw(base: string, sigHex: string, publicKeyHex: string): Promise<boolean> {
  const sig = fromHex(sigHex); const pub = fromHex(publicKeyHex);
  if (pub.length !== 32 || sig.length !== 64) return false;
  if (await hasWebCryptoEd25519()) {
    let k = importedKeys.get(publicKeyHex);
    if (!k) {
      k = crypto.subtle.importKey('raw', buf(pub), { name: 'Ed25519' }, false, ['verify']).catch(() => null);
      if (importedKeys.size >= 10_000) importedKeys.delete(importedKeys.keys().next().value!);
      importedKeys.set(publicKeyHex, k);
    }
    const key = await k;
    if (key) return crypto.subtle.verify({ name: 'Ed25519' }, key, buf(sig), buf(utf8(base)));
  }
  return ed25519.verify(sig, utf8(base), pub);
}

/** A signRequest signer for a device key (WebCrypto Ed25519 where present, else the pure-JS fallback). */
export function requestSigner(key: SigningKey): { publicKeyHex: string; sign(base: string): Promise<string> } {
  return {
    publicKeyHex: key.publicKeyHex,
    async sign(base) {
      if (key.privateKey) return toHex(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, buf(utf8(base)))));
      if (key.secretKey) return toHex(ed25519.sign(utf8(base), key.secretKey));
      throw new Error('signing key has no private part');
    },
  };
}

/** Content signature a publisher attaches to a dataset, model chunk or notarized file. */
export function signContentHash(contentSha256: string, key: SigningKey): Promise<string> {
  return signCanonical(`cappz-content-v1|${contentSha256}`, key);
}
