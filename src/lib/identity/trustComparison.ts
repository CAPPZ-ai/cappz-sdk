/**
 * COPE node crystallized.
 * Node ID: v15-11-00-trust-comparison
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * KeyZ (CAPPZ key declarations) versus X.509 client certificates, measured with the
 * same primitives on the same machine, and honest about where X.509 still
 * wins. Three kinds of number, always labelled:
 *   measured    — run here (CPU time of a check, verdicts on a virtual clock)
 *   assumption  — a network or price input the reader replaces with theirs
 *   policy      — a property of the mechanism (e.g. a CRL is trusted until its nextUpdate)
 *
 * The X.509 baseline is a conventional chain — root CA → intermediate →
 * client certificate (ECDSA P-256) — checked with WebCrypto signatures, a
 * validity window, issuer names and a signed revocation list (a CRL stand-in
 * with thisUpdate / nextUpdate). Production validators (OpenSSL, the OS
 * stores) do more checks and run natively; compare ratios, then measure your
 * own route with the shadow harness (shadowCompare.ts).
 *
 * The strongest difference is not speed but the revocation window: a CRL or
 * a cached OCSP answer is trusted until it expires, so a revoked certificate
 * keeps working for hours or days; a CAPPZ revocation is a signed record the
 * verifier replays as soon as it arrives.
 */

import { generateRecoveryPhrase, keyPairFromPhrase } from '../auth/wallet/session.ts';
import { generateSigningKey } from '../sync/helloSignature.ts';
import { declareKey, revokeKeyDeclaration, type KeyDeclaration, type KeyRevocation } from './keyDeclaration.ts';
import { createVerifyGateway, requestSigner, signRequest } from './edgeVerify.ts';
import { issueCertificate, parseCertificate, verifySignedBy, type ParsedCertificate } from './x509.ts';
import { buf, canonicalJson, toHex, utf8 } from './canonical.ts';

export type Source = 'measured' | 'assumption' | 'policy';

export interface ComparisonAssumptions {
  /** How long a verifier keeps a CRL before fetching the next one (its nextUpdate). Common: 24 h. */
  crlValidityHours: number;
  /** How long a cached / stapled OCSP answer is trusted. Common: hours to 7 days. */
  ocspCacheHours: number;
  /** Network round trip of a live OCSP lookup, when not cached. */
  ocspLookupMs: number;
  /** Time for a wallet's revocation record to reach the verifier (replication through the member table / relay). */
  revocationPropagationSeconds: number;
  /** The same ARM instance for every path, per hour. */
  instanceUsdPerHour: number;
  vcpus: number;
  /** CA-issued client certificate cost per client per year (public CA; 0 for a private CA you run). */
  clientCertUsdPerYear: number;
  /** Running a private CA (HSM, staff time, audits) per year, spread over all clients. */
  privateCaUsdPerYear: number;
  clients: number;
  requestsPerClientPerYear: number;
}

export const DEFAULT_COMPARISON_ASSUMPTIONS: ComparisonAssumptions = {
  crlValidityHours: 24,
  ocspCacheHours: 96,
  ocspLookupMs: 60,
  revocationPropagationSeconds: 5,
  instanceUsdPerHour: 0.034,
  vcpus: 2,
  clientCertUsdPerYear: 0,
  privateCaUsdPerYear: 12_000,
  clients: 500,
  requestsPerClientPerYear: 200_000,
};

/** Labels for the assumptions (shown next to every input). */
export const ASSUMPTION_LABELS: Record<keyof ComparisonAssumptions, string> = {
  crlValidityHours: 'CRL validity (hours)',
  ocspCacheHours: 'OCSP answer cached (hours)',
  ocspLookupMs: 'Live OCSP lookup (ms)',
  revocationPropagationSeconds: 'KeyZ revocation reaches the verifier (s)',
  instanceUsdPerHour: 'ARM instance, same for both ($/hour)',
  vcpus: 'vCPUs on that instance',
  clientCertUsdPerYear: 'Client certificate per client per year ($)',
  privateCaUsdPerYear: 'Running a private CA per year ($)',
  clients: 'Clients',
  requestsPerClientPerYear: 'Requests per client per year',
};

export interface Percentiles { p50: number; p95: number; n: number }
const pct = (xs: number[]): Percentiles => { const s = [...xs].sort((a, b) => a - b); const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0; return { p50: at(0.5), p95: at(0.95), n: s.length }; };

/**
 * Time per check from batches, not single calls: browsers coarsen performance.now() to 0.1 ms without
 * cross-origin isolation, which read a 30 µs check as 0. Ten batches → ten per-check means for percentiles.
 */
async function batches(n: number, fn: () => Promise<unknown>): Promise<number[]> {
  const per = Math.max(5, Math.floor(n / 10)); const out: number[] = [];
  for (let b = 0; b < 10; b++) { const t = performance.now(); for (let i = 0; i < per; i++) await fn(); out.push((performance.now() - t) / per); }
  return out;
}

// ─── X.509 baseline ───────────────────────────────────────────────

interface Pki {
  root: { cert: ParsedCertificate; spki: Uint8Array };
  intermediate: { cert: ParsedCertificate; spki: Uint8Array; keyPair: CryptoKeyPair };
  leafDer: Uint8Array;
  leafSerial: string;
}

async function p256(): Promise<CryptoKeyPair> { return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>; }

export async function buildPki(now = Date.now()): Promise<Pki> {
  const rootKey = await p256(); const interKey = await p256(); const leafKey = await p256();
  const year = 365 * 86400_000;
  const root = await issueCertificate({ keyPair: rootKey, algorithm: 'p256', commonName: 'Example Root CA', ca: true, notBefore: new Date(now - 86400_000), notAfter: new Date(now + 10 * year) });
  const inter = await issueCertificate({ keyPair: interKey, algorithm: 'p256', commonName: 'Example Issuing CA', ca: true, notBefore: new Date(now - 86400_000), notAfter: new Date(now + 5 * year), issuer: { keyPair: rootKey, algorithm: 'p256', commonName: 'Example Root CA' } });
  const leaf = await issueCertificate({ keyPair: leafKey, algorithm: 'p256', commonName: 'erp-client.example.com', notBefore: new Date(now - 86400_000), notAfter: new Date(now + year), issuer: { keyPair: interKey, algorithm: 'p256', commonName: 'Example Issuing CA' } });
  const rootP = await parseCertificate(root.der); const interP = await parseCertificate(inter.der);
  return { root: { cert: rootP, spki: rootP.spki }, intermediate: { cert: interP, spki: interP.spki, keyPair: interKey }, leafDer: leaf.der, leafSerial: (await parseCertificate(leaf.der)).serialHex };
}

/** A signed revocation list (CRL stand-in): revoked serials, thisUpdate, nextUpdate. */
export interface Crl { revoked: string[]; thisUpdate: number; nextUpdate: number; signature: string }

export async function signCrl(pki: Pki, revoked: string[], thisUpdate: number, validityHours: number): Promise<Crl> {
  const body = { revoked: [...revoked].sort(), thisUpdate, nextUpdate: thisUpdate + validityHours * 3600_000 };
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pki.intermediate.keyPair.privateKey, buf(utf8(canonicalJson(body)))));
  return { ...body, signature: toHex(sig) };
}

export type X509Verdict = 'valid' | 'expired' | 'bad-chain' | 'revoked' | 'stale-crl';

/** Walk leaf → intermediate → root, check validity windows, then the CRL the verifier holds. */
export async function verifyX509(pki: Pki, leafDer: Uint8Array, crl: Crl, now: number, chainCache?: Map<string, boolean>): Promise<X509Verdict> {
  const leaf = await parseCertificate(leafDer);
  if (leaf.notBefore.getTime() > now || leaf.notAfter.getTime() <= now) return 'expired';
  let chainOk = chainCache?.get(leaf.sha256);
  if (chainOk === undefined) {
    chainOk = leaf.issuerCommonName === pki.intermediate.cert.commonName
      && (await verifySignedBy(leaf, pki.intermediate.spki, 'p256'))
      && pki.intermediate.cert.issuerCommonName === pki.root.cert.commonName
      && (await verifySignedBy(pki.intermediate.cert, pki.root.spki, 'p256'))
      && pki.intermediate.cert.notAfter.getTime() > now && pki.root.cert.notAfter.getTime() > now;
    chainCache?.set(leaf.sha256, chainOk);
  }
  if (!chainOk) return 'bad-chain';
  if (crl.nextUpdate <= now) return 'stale-crl'; // a strict verifier refuses; many fail open here
  return crl.revoked.includes(leaf.serialHex) ? 'revoked' : 'valid';
}

// ─── Comparison ───────────────────────────────────────────────────

export interface ExposureRow { label: string; mechanism: 'x509' | 'cappz'; seconds: number; source: Source; note: string }
export interface LatencyRow { label: string; mechanism: 'x509' | 'cappz'; cpuMs: number; networkMs: number; cpuSource: Source; networkSource: Source }
export interface CostRow { label: string; mechanism: 'x509' | 'cappz'; computeUsdPerMillion: number; credentialsUsdPerMillion: number; totalUsdPerMillion: number; lines: Array<{ label: string; usd: number; source: Source }> }
export interface TimelinePoint { at: string; afterSeconds: number; x509: X509Verdict; cappz: string }
/**
 * Why X.509 stays where it does. 'policy': a law, standard or root program names the
 * certificate — KeyZ could do the job technically, and the rule can be revised.
 * 'adoption': the keys work, the surrounding tools and processes expect certificates.
 * 'technology': it cannot fit today. `path` is how the limit could be lifted.
 */
export interface TradeoffConstraint { kind: 'policy' | 'adoption' | 'technology'; why: string; path: string }
export interface Tradeoff { aspect: string; x509: string; cappz: string; edge: 'x509' | 'cappz' | 'both'; constraint?: TradeoffConstraint }

export interface ComparisonReport {
  measured: { x509Cold: Percentiles; x509Warm: Percentiles; cappzCold: Percentiles; cappzWarm: Percentiles; unit: 'ms' };
  timeline: TimelinePoint[];
  exposure: (a: ComparisonAssumptions) => ExposureRow[];
  latency: (a: ComparisonAssumptions) => LatencyRow[];
  cost: (a: ComparisonAssumptions) => CostRow[];
  tradeoffs: Tradeoff[];
}

export const TRADEOFFS: Tradeoff[] = [
  { aspect: 'Revocation takes effect', x509: 'When the verifier next fetches a CRL or its cached OCSP answer expires: hours to days; many verifiers fail open when the responder is down', cappz: 'When the signed revocation record reaches the verifier (replication: seconds); checked offline, nothing to fail open on', edge: 'cappz' },
  { aspect: 'What is proven per request', x509: 'mTLS proves who opened the connection; the request body is not signed', cappz: 'Each request is signed over method, path, host and a body digest (RFC 9421 + RFC 9530); replay is refused by nonce', edge: 'cappz' },
  { aspect: 'Answer a verifier gets', x509: 'Valid, or a reason code (expired, revoked, untrusted issuer)', cappz: 'Signature state, key trust (declared, delegated, operator-listed, undeclared, revoked, expired), content digest, ledger anchor — separately', edge: 'cappz' },
  { aspect: 'Who vouches', x509: 'One CA hierarchy; a CA compromise affects every certificate it issued', cappz: 'The wallet itself, plus any number of attestations; a compromise is one wallet (guardian recovery rotates it)', edge: 'cappz' },
  { aspect: 'Running cost', x509: 'Issuance and renewal per client, or a private CA (HSM, audits, staff)', cappz: 'No issuance: the wallet signs its own declarations; verification runs on your own node', edge: 'cappz' },
  { aspect: 'Rotation and old signatures', x509: 'After expiry, old signatures need a timestamp authority to stay verifiable', cappz: 'A new declaration supersedes the old one; earlier signatures stay verifiable against the key valid then', edge: 'cappz' },
  { aspect: 'Public websites (browser HTTPS)', x509: 'Required: browsers trust only public CA roots', cappz: 'Not a replacement today: keep a public-CA certificate on nginx/Caddy', edge: 'x509',
    constraint: { kind: 'policy', why: 'Browser root programs and the CA/Browser Forum Baseline Requirements decide which certificates browsers accept, and the visitor’s browser enforces it. Technically a browser can already trust a key by its hash (WebTransport certificate hashes, which KeyZ Gate offers).', path: 'Keep the public certificate for public pages; use KeyZ behind it and for WebTransport; propose key-declaration trust to the IETF, W3C and browser root programs, with the revocation measurements as evidence.' } },
  { aspect: 'Regulated credentials', x509: 'Required where law names it (eIDAS qualified certificates and seals, PSD2 QWAC/QSealC, PIV/CAC)', cappz: 'Keep them for compliance; KeyZ can carry the certificate hash in the declaration and add per-request signing beside it', edge: 'x509',
    constraint: { kind: 'policy', why: 'The rule names the instrument (eIDAS qualified certificates and seals, the PSD2 RTS for QWAC/QSealC, FIPS 201 for PIV/CAC). The limit is that the rule requires a certificate, not that a key declaration cannot do the job.', path: 'Comply today, and bring evidence (shadow reports, revocation windows) to the reviews: ETSI ESI standards, EBA reviews of the PSD2 RTS, NIST FIPS 201 revisions. EU digital identity wallets already accept SD-JWT VC, the format the identity vault uses.' } },
  { aspect: 'Hardware and tooling', x509: 'Every HSM, smart card, OS and language ships it', cappz: 'Needs the SDK or any RFC 9421 library (Python, PHP, Go, Java exist); keys can live in WebAuthn authenticators', edge: 'x509',
    constraint: { kind: 'adoption', why: 'HSMs and smart cards sign with P-256 and Ed25519 keys that KeyZ can declare; their enrolment, management tools and audits are built around certificates. Partly technology: many do not support the secp256k1 wallet key itself.', path: 'Keep the wallet key in a WebAuthn authenticator or software vault and delegate P-256/Ed25519 keys held in the HSM or card; add KeyZ support to the tools as vendors adopt RFC 9421.' } },
  { aspect: 'Works with existing mTLS clients', x509: 'Yes', cappz: 'Yes: a wallet-projected certificate is an ordinary X.509 client certificate, trusted as far as the wallet declared its key', edge: 'both' },
];

/** How long a revoked credential keeps being accepted, per mechanism (assumption-driven; no run needed). */
export function exposureRows(a: ComparisonAssumptions): ExposureRow[] {
  return [
    { label: 'X.509 with a CRL', mechanism: 'x509', seconds: a.crlValidityHours * 3600, source: 'assumption', note: 'until the verifier fetches the next CRL' },
    { label: 'X.509 with cached / stapled OCSP', mechanism: 'x509', seconds: a.ocspCacheHours * 3600, source: 'assumption', note: 'until the cached OCSP answer expires' },
    { label: 'X.509 with live OCSP per request', mechanism: 'x509', seconds: 60, source: 'assumption', note: 'responder update lag; adds a network lookup to every request' },
    { label: 'KeyZ revocation record', mechanism: 'cappz', seconds: a.revocationPropagationSeconds, source: 'assumption', note: 'until the signed record replicates to the verifier' },
  ];
}

export async function runTrustComparison(o: { iterations?: number; now?: number } = {}): Promise<ComparisonReport> {
  const n = o.iterations ?? 200;
  const now = o.now ?? Date.now();

  // X.509: a chain and a CRL fetched an hour ago.
  const pki = await buildPki(now);
  const crlThen = await signCrl(pki, [], now - 3600_000, 24);
  const chainCache = new Map<string, boolean>();
  const x509Cold = await batches(n, () => verifyX509(pki, pki.leafDer, crlThen, now));
  const x509Warm = await batches(n, () => verifyX509(pki, pki.leafDer, crlThen, now, chainCache));

  // CAPPZ: a wallet-declared device key signing each request, checked by KeyZ Gate.
  const wallet = keyPairFromPhrase(generateRecoveryPhrase());
  const device = await generateSigningKey();
  const declarations: KeyDeclaration[] = [await declareKey(wallet.privateKey, wallet.address, { publicKey: device.publicKeyHex, algorithm: 'ed25519', purpose: 'signing' }, undefined, now - 3600_000)];
  const revocations: KeyRevocation[] = [];
  let clock = now;
  const gw = createVerifyGateway({ evidence: { evidenceFor: async () => ({ declarations, revocations }) }, requireBound: true, now: () => clock, maxAgeSec: 10 * 86400 });
  const body = utf8('{"amount":"250.00"}');
  const signed = async (at: number) => {
    const h = await signRequest({ method: 'POST', url: 'https://api.example.com/v1/payments', body, walletAddress: wallet.address }, requestSigner(device), at);
    return new Request('https://api.example.com/v1/payments', { method: 'POST', headers: h, body });
  };
  const reqs = await Promise.all(Array.from({ length: 2 * 10 * Math.max(5, Math.floor(n / 10)) }, () => signed(now)));
  let next = 0;
  const cappzCold = await batches(n, () => gw.verifyRequest(reqs[next++], body));
  const cappzWarm = await batches(n, () => gw.verifyRequest(reqs[next++], body));
  const measured = { x509Cold: pct(x509Cold), x509Warm: pct(x509Warm), cappzCold: pct(cappzCold), cappzWarm: pct(cappzWarm), unit: 'ms' as const };

  // Revocation at T0 on a virtual clock: the verdicts each verifier actually gives afterwards.
  // X.509 keeps the CRL it fetched before T0 until its nextUpdate (the next fetch would list the serial).
  // CAPPZ receives the revocation record 5 s after T0 (the default propagation assumption).
  const T0 = now;
  // The verifier's next CRL is the one it fetches when the old one expires; it lists the serial.
  const crlAfter = await signCrl(pki, [pki.leafSerial], crlThen.nextUpdate, 24);
  const revocation = await revokeKeyDeclaration(wallet.privateKey, declarations[0], 'device lost', T0);
  const checkpoints: Array<[string, number]> = [['just before', -1], ['+1 minute', 60], ['+1 hour', 3600], ['+12 hours', 12 * 3600], ['+1 day', 86400 + 60]];
  const timeline: TimelinePoint[] = [];
  for (const [at, after] of checkpoints) {
    const t = T0 + after * 1000;
    const crlHeld = t >= crlThen.nextUpdate ? crlAfter : crlThen;
    const x = await verifyX509(pki, pki.leafDer, crlHeld, t);
    clock = t;
    revocations.length = 0;
    if (after >= 5) revocations.push(revocation);
    const v = await gw.verifyRequest(await signed(t), body);
    timeline.push({ at, afterSeconds: after, x509: x, cappz: `${v.status} ${v.trust}` });
  }

  const exposure = exposureRows;
  const ms = (p: Percentiles) => p.p50;
  const latency = (a: ComparisonAssumptions): LatencyRow[] => [
    { label: 'X.509 chain, CRL cached', mechanism: 'x509', cpuMs: ms(measured.x509Warm), networkMs: 0, cpuSource: 'measured', networkSource: 'policy' },
    { label: 'X.509 chain, live OCSP', mechanism: 'x509', cpuMs: ms(measured.x509Warm), networkMs: a.ocspLookupMs, cpuSource: 'measured', networkSource: 'assumption' },
    { label: 'KeyZ signed request', mechanism: 'cappz', cpuMs: ms(measured.cappzWarm), networkMs: 0, cpuSource: 'measured', networkSource: 'policy' },
  ];
  const cost = (a: ComparisonAssumptions): CostRow[] => {
    const perMillionCompute = (cpuMs: number) => ((cpuMs * 1e6) / 1000 / 3600 / Math.max(1, a.vcpus)) * a.instanceUsdPerHour;
    const yearRequests = Math.max(1, a.clients * a.requestsPerClientPerYear);
    const credsX509 = ((a.clientCertUsdPerYear * a.clients + a.privateCaUsdPerYear) / yearRequests) * 1e6;
    const row = (label: string, mechanism: 'x509' | 'cappz', cpuMs: number, creds: number): CostRow => {
      const compute = perMillionCompute(cpuMs);
      const lines = [{ label: `CPU ${cpuMs.toFixed(3)} ms × 1M on the instance`, usd: compute, source: 'measured' as Source }, { label: 'Credentials (certificates / CA)', usd: creds, source: 'assumption' as Source }];
      return { label, mechanism, computeUsdPerMillion: compute, credentialsUsdPerMillion: creds, totalUsdPerMillion: lines.reduce((x, l) => x + l.usd, 0), lines };
    };
    return [
      row('X.509 chain, CRL cached', 'x509', ms(measured.x509Warm), credsX509),
      // Live OCSP adds latency (see latency), not CPU: an async server waits without burning the core.
      row('X.509 chain, live OCSP', 'x509', ms(measured.x509Warm), credsX509),
      row('KeyZ signed request', 'cappz', ms(measured.cappzWarm), 0),
    ];
  };
  return { measured, timeline, exposure, latency, cost, tradeoffs: TRADEOFFS };
}
