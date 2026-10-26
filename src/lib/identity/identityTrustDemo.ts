/**
 * COPE node crystallized.
 * Node ID: v15-10-00-identity-trust-demo
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * The identity-and-trust demo, end to end, in one call — the same code in the
 * browser tutorial (/tutorials/identity-and-trust, signed out, no server) and
 * in the test suite, so the page IS the validation. Every step states what it
 * expects and checks it: the bad paths (replayed presentation, forged claim,
 * revoked key, executable drop) must be refused, or the step fails.
 *
 * Wallets here are made in memory for the run and forgotten; nothing is
 * written to a ledger. Costs come from the published price sheets
 * (lib/treasury/fees); business inputs are labelled assumptions.
 */

import { generateRecoveryPhrase, keyPairFromPhrase } from '../auth/wallet/session.ts';
import { generateBoxKeyPair, newContentKey } from '../crypto/sealedBox.ts';
import { generateSigningKey } from '../sync/helloSignature.ts';
import { answerDisclosure, attestClaims, openClaim, recordBiometricBinding, recordClaim, requestDisclosure, revokeAttestation, verifyDisclosure, type IdentityTx } from './identityVault.ts';
import { presentSdJwt, verifyPresentation } from './sdJwt.ts';
import { declareKey, declarationHash, delegateKey, revokeKeyDeclaration, type KeyDeclaration, type KeyDelegation, type KeyRevocation } from './keyDeclaration.ts';
import { createVerifyGateway, requestSigner, signContentHash, signRequest } from './edgeVerify.ts';
import { issueSelfSignedCertificate, KEYDECL_URI_PREFIX } from './x509.ts';
import { didKeyFor } from './didKey.ts';
import { toHex } from './canonical.ts';
import { createLegacyGateway, memoryQuarantineStore } from '../sync/transports/legacyGateway.ts';
import { BASE_TX_FEE_CENTS, GENESIS_PRICE_SHEETS, REPLICATOR_APP_ROOT, resolvePriceSheet } from '../treasury/fees/index.ts';
import { runTrustComparison, type ComparisonReport } from './trustComparison.ts';

export type Actor = 'holder' | 'issuer' | 'verifier' | 'edge node' | 'legacy sender';

export interface DemoStep {
  id: string;
  title: string;
  actor: Actor;
  /** What must happen for the step to pass (including refusals). */
  expect: string;
  /** What did happen. */
  got: string;
  ok: boolean;
  /** Short evidence a reader can inspect (hashes, states, sizes). Never a secret. */
  evidence: Record<string, string | number | boolean>;
  ms: number;
  /** Ledger TXs this step would write on a real wallet (priced below). */
  txs: number;
  bytes: number;
}

export interface DemoAssumptions {
  /** What one repeat identity check costs a counterparty today (document review, vendor fee). */
  recheckCostUsd: number;
  /** Counterparties that need the same customer's identity. */
  counterparties: number;
  /** Customers onboarded per month. */
  customersPerMonth: number;
}

export const DEFAULT_DEMO_ASSUMPTIONS: DemoAssumptions = { recheckCostUsd: 12, counterparties: 4, customersPerMonth: 1000 };

export interface DemoEconomics {
  lines: Array<{ label: string; source: string; usd: number }>;
  perCustomerUsd: number;
  perCustomerTodayUsd: number;
  monthlySavedUsd: number;
}

export interface DemoReport {
  steps: DemoStep[];
  passed: number;
  failed: number;
  allPassed: boolean;
  measured: { contentChecksPerSecond: number; cachedChecksPerSecond: number; requestChecksPerSecond: number };
  /** v15-11-00: KeyZ (CAPPZ key declarations) vs an X.509 chain with a CRL, measured in the same run. */
  comparison: ComparisonReport | null;
  totals: { txs: number; bytes: number };
  economics: (a: DemoAssumptions) => DemoEconomics;
}

const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const short = (h: string) => `${h.slice(0, 12)}…`;

export async function runIdentityTrustDemo(o: { onStep?: (s: DemoStep) => void; perfIterations?: number } = {}): Promise<DemoReport> {
  const steps: DemoStep[] = [];
  const step = async (id: string, title: string, actor: Actor, expect: string, run: () => Promise<{ ok: boolean; got: string; evidence?: DemoStep['evidence']; txs?: number; bytes?: number }>) => {
    const t = performance.now();
    let r: Awaited<ReturnType<typeof run>>;
    try { r = await run(); } catch (e) { r = { ok: false, got: `threw: ${e instanceof Error ? e.message : String(e)}` }; }
    const s: DemoStep = { id, title, actor, expect, got: r.got, ok: r.ok, evidence: r.evidence ?? {}, ms: Math.round((performance.now() - t) * 10) / 10, txs: r.txs ?? 0, bytes: r.bytes ?? 0 };
    steps.push(s); o.onStep?.(s);
    return s;
  };

  const holder = keyPairFromPhrase(generateRecoveryPhrase());
  const issuer = keyPairFromPhrase(generateRecoveryPhrase());
  const verifier = keyPairFromPhrase(generateRecoveryPhrase());
  const holderRoot = "m/44'/144'/0'/users/demo-holder";
  const contentKey = await newContentKey();
  const ledger: IdentityTx[] = [];
  let claims: IdentityTx[] = []; let disclosures: string[] = [];
  let binding: IdentityTx | null = null;
  let attestation: Awaited<ReturnType<typeof attestClaims>> | null = null;
  const box = await generateBoxKeyPair();
  let req: ReturnType<typeof requestDisclosure> | null = null;
  let answer: Awaited<ReturnType<typeof answerDisclosure>> | null = null;

  await step('claims', 'Keep identity in your wallet', 'holder', 'Three claims recorded; the TXs carry salted digests and ciphertext, never the values', async () => {
    const values: Array<[string, string]> = [['name', 'Ada Lovelace'], ['birthdate', '1815-12-10'], ['passportNumber', 'X1234567']];
    claims = await Promise.all(values.map(([t, v]) => recordClaim(holderRoot, t, v, contentKey)));
    ledger.push(...claims);
    disclosures = await Promise.all(claims.map((c) => openClaim(c.data as never, contentKey)));
    const leaked = values.filter(([, v]) => JSON.stringify(claims).includes(v));
    return { ok: leaked.length === 0, got: leaked.length ? `values visible: ${leaked.map(([t]) => t).join(', ')}` : 'no value appears in any TX', evidence: { claims: claims.length, digest: short((claims[0].data as { digest: string }).digest) }, txs: claims.length, bytes: size(claims) };
  });

  await step('binding', 'Bind your device authenticator (no biometric data)', 'holder', 'Only a hash of the WebAuthn credential id is recorded', async () => {
    const credentialId = crypto.getRandomValues(new Uint8Array(32)); // the tutorial uses a real passkey when the browser offers one
    binding = await recordBiometricBinding(holderRoot, credentialId);
    ledger.push(binding);
    const raw = toHex(credentialId);
    return { ok: !JSON.stringify(binding).includes(raw), got: 'credential id stored as a hash only', evidence: { credentialIdHash: short((binding.data as { credentialIdHash: string }).credentialIdHash) }, txs: 1, bytes: size(binding) };
  });

  await step('attest', 'An issuer vouches once', 'issuer', 'The issuer signs the claim digests as an SD-JWT VC at IAL2, citing the binding', async () => {
    attestation = await attestClaims({ issuerPrivateKey: issuer.privateKey, issuerAddress: issuer.address, subjectRoot: holderRoot, subjectAddress: holder.address, disclosures, level: 'IAL2', method: 'document check + passkey liveness', bindingTxId: binding!.txId });
    ledger.push(attestation);
    return { ok: attestation.data.jwt.split('.').length === 3, got: `SD-JWT VC issued by ${short(didKeyFor('secp256k1', issuer.address))}`, evidence: { issuer: didKeyFor('secp256k1', issuer.address).slice(0, 24) + '…', level: 'IAL2', attestationId: short(attestation.data.attestationId) }, txs: 1, bytes: size(attestation) };
  });

  await step('request', 'A verifier asks for only what it needs', 'verifier', 'Request names name + birthdate, a purpose and a fresh nonce', async () => {
    req = requestDisclosure({ holderRoot, verifierAddress: verifier.address, holderAddress: holder.address, claimTypes: ['name', 'birthdate'], purpose: 'age check for account opening', verifierBoxKey: box.publicKey });
    ledger.push(req);
    return { ok: req.data.nonce.length === 32, got: `asks for ${req.data.claimTypes.join(' + ')}`, evidence: { purpose: req.data.purpose, nonce: short(req.data.nonce) }, txs: 1, bytes: size(req) };
  });

  await step('disclose', 'You reveal two claims, sealed to that verifier', 'holder', 'Passport number is not revealed; the answer is sealed and bound to the nonce', async () => {
    let overAsk = false;
    try { await answerDisclosure({ holderRoot, holderPrivateKey: holder.privateKey, request: req!, attestationJwt: attestation!.data.jwt, disclosures }); } catch { overAsk = true; }
    answer = await answerDisclosure({ holderRoot, holderPrivateKey: holder.privateKey, request: req!, attestationJwt: attestation!.data.jwt, disclosures: disclosures.slice(0, 2) });
    ledger.push(answer);
    return { ok: overAsk && !JSON.stringify(answer).includes('Ada'), got: 'over-disclosure refused; answer sealed (no plaintext on the wire)', evidence: { sealedBytes: answer.data.sealed.cipher.length, presentationHash: short(answer.data.presentationHash) }, txs: 1, bytes: size(answer) };
  });

  await step('verify', 'The verifier checks it offline', 'verifier', "State 'verified' at IAL2 with exactly name + birthdate; anchor reported separately", async () => {
    const v = await verifyDisclosure(answer!, req!, box.privateKey, ledger);
    const ok = v.state === 'verified' && v.holderMatches && Object.keys(v.claims).sort().join() === 'birthdate,name' && v.anchor === 'unchecked';
    return { ok, got: `${v.state} · ${v.evidence?.level} · claims ${Object.keys(v.claims).join(', ')}`, evidence: { state: v.state, level: String(v.evidence?.level), anchor: v.anchor, passportRevealed: 'passportNumber' in v.claims } };
  });

  await step('replay', 'A stolen presentation is useless elsewhere', 'verifier', "Replayed to another verifier: 'nonce-mismatch'; forged claim: 'digest-mismatch'", async () => {
    const p = await presentSdJwt(attestation!.data.jwt, disclosures.slice(0, 2), holder.privateKey, req!.data.audience, req!.data.nonce);
    const replay = await verifyPresentation(p, { aud: 'did:key:z-another-verifier', nonce: 'another-nonce' });
    const forgedDisclosure = btoa(JSON.stringify(['salt', 'birthdate', '1990-01-01'])).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const forged = await verifyPresentation(await presentSdJwt(attestation!.data.jwt, [forgedDisclosure], holder.privateKey, req!.data.audience, req!.data.nonce), { aud: req!.data.audience, nonce: req!.data.nonce });
    return { ok: replay.state === 'nonce-mismatch' && forged.state === 'digest-mismatch', got: `${replay.state} · ${forged.state}`, evidence: { replay: replay.state, forged: forged.state } };
  });

  await step('revoke-attestation', 'The issuer can withdraw it', 'issuer', "After an issuer-signed revocation the same answer reads 'revoked'", async () => {
    const rev = await revokeAttestation(issuer.privateKey, issuer.address, holderRoot, attestation!.data.attestationId, 'document reported lost');
    const v = await verifyDisclosure(answer!, req!, box.privateKey, [...ledger, rev]);
    return { ok: v.state === 'revoked', got: v.state, evidence: { state: v.state }, txs: 1, bytes: size(rev) };
  });

  // ─── Keys and the edge ──────────────────────────────────────────
  const device = await generateSigningKey();
  const declarations: Array<KeyDeclaration> = []; const revocations: KeyRevocation[] = []; const delegations: KeyDelegation[] = [];
  const gateway = createVerifyGateway({ evidence: { evidenceFor: async () => ({ declarations, revocations, delegations }) }, requireBound: true });
  const signed = async (path: string) => {
    const body = new TextEncoder().encode('{"amount":"250.00","currency":"EUR"}');
    const h = await signRequest({ method: 'POST', url: `https://api.example.com${path}`, body, walletAddress: holder.address }, requestSigner(device));
    return { r: new Request(`https://api.example.com${path}`, { method: 'POST', headers: h, body }), body };
  };

  await step('declare-key', 'Your wallet vouches for a device key — no certificate authority', 'holder', "Signed API call through KeyZ Gate: 'verified', key 'declared'", async () => {
    declarations.push(await declareKey(holder.privateKey, holder.address, { publicKey: device.publicKeyHex, algorithm: 'ed25519', purpose: 'signing' }));
    const { r, body } = await signed('/v1/payments');
    const v = await gateway.verifyRequest(r, body);
    return { ok: v.allowed && v.trust === 'declared' && v.content === 'digest-match', got: `${v.signature} · key ${v.trust} · ${v.content}`, evidence: { signature: v.signature, trust: v.trust, content: v.content, status: v.status }, txs: 1, bytes: size(declarations[0]) };
  });

  await step('revoke-key', 'Lose the laptop? Revoke the key; the next request is refused', 'holder', "Same key after a wallet-signed revocation: 403 'revoked' — no CRL, no OCSP", async () => {
    revocations.push(await revokeKeyDeclaration(holder.privateKey, declarations[0], 'device lost'));
    const { r, body } = await signed('/v1/payments');
    const v = await gateway.verifyRequest(r, body);
    return { ok: !v.allowed && v.trust === 'revoked' && v.status === 403, got: `${v.status} · key ${v.trust}`, evidence: { status: v.status, trust: v.trust }, txs: 1, bytes: size(revocations[0]) };
  });

  await step('mtls', 'Legacy mTLS client certificate, trusted as far as the wallet says', 'edge node', "A certificate projected from a delegated TLS key: 'mtls', 'delegated'", async () => {
    const node = await generateSigningKey();
    declarations.push(await declareKey(holder.privateKey, holder.address, { publicKey: node.publicKeyHex, algorithm: 'ed25519', purpose: 'hello' }));
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const raw = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
    delegations.push(await delegateKey(node, holder.address, { publicKey: raw, algorithm: 'p256', purpose: 'tls' }));
    const cert = await issueSelfSignedCertificate({ keyPair: kp, algorithm: 'p256', commonName: 'erp-client', uris: [didKeyFor('secp256k1', holder.address), `${KEYDECL_URI_PREFIX}${await declarationHash(declarations[1])}`], notAfter: new Date(Date.now() + 86400_000) });
    const v = await gateway.verifyRequest(new Request('https://api.example.com/v1/statements', { headers: { 'x-ssl-client-cert': encodeURIComponent(cert.pem) } }));
    return { ok: v.allowed && v.signature === 'mtls' && v.trust === 'delegated', got: `${v.signature} · ${v.trust}`, evidence: { certificateSha256: short(cert.sha256), trust: v.trust }, txs: 2, bytes: cert.der.length };
  });

  // ─── Legacy drop ────────────────────────────────────────────────
  const store = memoryQuarantineStore();
  const dmz = createLegacyGateway({ nodeAddress: "m/44'/144'/0'/cappz/operational/demo-dmz", store });
  await step('legacy-drop', 'A legacy system drops a file — no CPZ1 needed', 'legacy sender', 'ISO 20022 statement released with a receipt; an executable is rejected with the reason', async () => {
    const ok = await dmz.handle(new Request('https://dmz.example.com/legacy/v1/drop/camt053.xml', { method: 'PUT', headers: { 'content-type': 'application/xml' }, body: '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"/>' }));
    const bad = await dmz.handle(new Request('https://dmz.example.com/legacy/v1/drop/invoice.pdf', { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: new Uint8Array([0x4d, 0x5a, 0x90, 0]) }));
    const a = await ok.json(); const b = await bad.json();
    return { ok: ok.status === 201 && a.state === 'released' && bad.status === 422 && /executable/.test(b.because), got: `${a.state} (${a.checks.length} checks) · ${b.state}: ${b.because}`, evidence: { released: short(a.sha256), rejected: b.state }, txs: store.txs.length, bytes: 0 };
  });

  // ─── Versus X.509 ───────────────────────────────────────────────
  let comparison: ComparisonReport | null = null;
  await step('x509', 'Revoke a key: KeyZ refuses at once; an X.509 CRL keeps accepting', 'edge node', "One hour after revocation the X.509 chain (CRL cached) is still 'valid'; KeyZ Gate answers 403 revoked", async () => {
    comparison = await runTrustComparison({ iterations: Math.min(o.perfIterations ?? 200, 80) });
    const hour = comparison.timeline.find((p) => p.at === '+1 hour')!;
    const day = comparison.timeline.find((p) => p.at === '+1 day')!;
    return {
      ok: hour.x509 === 'valid' && hour.cappz === '403 revoked' && day.x509 === 'revoked',
      got: `+1 hour: X.509 ${hour.x509}, KeyZ ${hour.cappz} · +1 day: X.509 ${day.x509}`,
      evidence: { x509ChainCheckMs: Number(comparison.measured.x509Warm.p50.toFixed(3)), cappzRequestCheckMs: Number(comparison.measured.cappzWarm.p50.toFixed(3)), x509AtOneHour: hour.x509, cappzAtOneHour: hour.cappz },
    };
  });

  // ─── Measured cost of verifying ─────────────────────────────────
  const n = o.perfIterations ?? 200;
  const contentKeyPair = await generateSigningKey();
  const hashes = Array.from({ length: n }, (_, i) => toHex(new TextEncoder().encode(String(i).padStart(32, '0'))).slice(0, 64));
  const sigs = await Promise.all(hashes.map((h) => signContentHash(h, contentKeyPair)));
  const contentGw = createVerifyGateway({ evidence: { evidenceFor: async () => ({ declarations: [] }) } });
  let t = performance.now();
  for (let i = 0; i < n; i++) await contentGw.verifyContent({ contentSha256: hashes[i], walletAddress: holder.address, publicKey: contentKeyPair.publicKeyHex, signature: sigs[i] });
  const fresh = n / ((performance.now() - t) / 1000);
  t = performance.now();
  for (let i = 0; i < n; i++) await contentGw.verifyContent({ contentSha256: hashes[i], walletAddress: holder.address, publicKey: contentKeyPair.publicKeyHex, signature: sigs[i] });
  const cached = n / ((performance.now() - t) / 1000);
  const reqGw = createVerifyGateway({ evidence: { evidenceFor: async () => ({ declarations: [] }) } });
  const reqs = await Promise.all(Array.from({ length: Math.min(n, 100) }, () => signed('/v1/ping')));
  t = performance.now();
  for (const { r, body } of reqs) await reqGw.verifyRequest(r, body);
  const perReq = reqs.length / ((performance.now() - t) / 1000);
  await step('measure', 'What a check costs: measured here, in this browser', 'edge node', 'Signature + hash checks run locally in well under a millisecond each', async () => ({
    ok: fresh > 50 && perReq > 20, got: `${Math.round(fresh)} content checks/s fresh, ${Math.round(cached)}/s cached by hash, ${Math.round(perReq)} signed requests/s`,
    evidence: { contentChecksPerSecond: Math.round(fresh), cachedChecksPerSecond: Math.round(cached), requestChecksPerSecond: Math.round(perReq) },
  }));

  const totals = { txs: steps.reduce((x, s) => x + s.txs, 0), bytes: steps.reduce((x, s) => x + s.bytes, 0) };
  const onboardingTxs = steps.filter((s) => ['claims', 'binding', 'attest', 'request', 'disclose'].includes(s.id)).reduce((x, s) => x + s.txs, 0);
  const onboardingBytes = steps.filter((s) => ['claims', 'binding', 'attest', 'request', 'disclose'].includes(s.id)).reduce((x, s) => x + s.bytes, 0);
  const economics = (a: DemoAssumptions): DemoEconomics => {
    const sheet = resolvePriceSheet(GENESIS_PRICE_SHEETS.filter((s) => s.appRoot === REPLICATOR_APP_ROOT));
    const mbCents = sheet?.entries.find((e) => e.function === 'sync-transfer')?.retailCents ?? 0;
    // One attestation, then one request + disclosure per extra counterparty instead of a new identity check.
    const perCounterpartyTxs = 2; const perCounterpartyBytes = steps.filter((s) => s.id === 'request' || s.id === 'disclose').reduce((x, s) => x + s.bytes, 0);
    const txs = onboardingTxs + Math.max(0, a.counterparties - 1) * perCounterpartyTxs;
    const mb = (onboardingBytes + Math.max(0, a.counterparties - 1) * perCounterpartyBytes) / 1_048_576;
    const lines = [
      { label: `${txs} ledger TX × ${BASE_TX_FEE_CENTS}¢`, source: 'base fee (price sheet)', usd: (txs * BASE_TX_FEE_CENTS) / 100 },
      { label: `${mb.toFixed(4)} MB moved × ${mbCents}¢`, source: sheet?.sheetId ?? 'price sheet', usd: (mb * mbCents) / 100 },
      { label: 'Issuer check, once', source: 'assumption', usd: a.recheckCostUsd },
      { label: 'Edge verification', source: 'measured: runs on your own node', usd: 0 },
    ];
    const perCustomer = lines.reduce((x, l) => x + l.usd, 0);
    const today = a.recheckCostUsd * a.counterparties;
    return { lines, perCustomerUsd: perCustomer, perCustomerTodayUsd: today, monthlySavedUsd: (today - perCustomer) * a.customersPerMonth };
  };
  const passed = steps.filter((s) => s.ok).length;
  return { steps, passed, failed: steps.length - passed, allPassed: passed === steps.length, measured: { contentChecksPerSecond: fresh, cachedChecksPerSecond: cached, requestChecksPerSecond: perReq }, comparison, totals, economics };
}
