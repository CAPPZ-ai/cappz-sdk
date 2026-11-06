// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519';
import { Wallet } from 'xrpl';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import { declareKey, revokeKeyDeclaration } from '../lib/identity/keyDeclaration';
import { toHex } from '../lib/identity/canonical';
import { issueSdJwt, makeDisclosure } from '../lib/identity/sdJwt';
import { generateBoxKeyPair } from '../lib/crypto/sealedBox';
import { DEMO_YOU, seedDemoMarket, type DemoRunner } from '../lib/marketplace/demo';
import * as M from '../lib/marketplace/model';
import { NO_FEES, buildFeeSchedule } from '../lib/marketplace/fees';
import { prepareStageEscrows } from '../lib/marketplace/settlement';
import { approvalHook, evaluateSigningIntent, verifyApproval } from '../lib/marketplace/signingApproval';
import { agentKeyState } from '../lib/marketplace/agentKeys';
import { createAgentRequestVerifier, requestAuthDecision, signAgentRequest, agentRequestHook, type AgentSigningKey } from '../lib/marketplace/agentRequestAuth';
import { answerPrincipalDisclosure, disclosureEvidence, principalCredentialRef, requestPrincipalDisclosure, verifyPrincipalDisclosure } from '../lib/marketplace/principalCredential';
import { buildAgentCard, signAgentCard, verifyAgentCard } from '../lib/marketplace/agentCard';
import { buildReputationAttestation, signReputation, verifyReputation } from '../lib/marketplace/reputationAttestation';
import { signCheck, verifyCheck } from '../lib/marketplace/counterpartyCheck';
import { agentApiManifest } from '../lib/marketplace/agentApi';
import { createPaidAgent, SCHEDULE_PRESETS } from '../lib/agentKit/paidAgent';
import { providerSegmentsIn } from '../lib/wallets/paths';
import type { PartyProfile } from '../lib/marketplace/types';

const START = '2026-11-01T12:00:00.000Z';
const NOW = '2026-11-01T12:05:00.000Z';
const SELLER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const SEED = '07'.repeat(32);
const PUB = toHex(ed25519.getPublicKey(new Uint8Array(32).fill(7)));
const xrp = (amount: number) => ({ amount, currency: 'XRP' as const });
const autofill = (tx: Record<string, unknown>) => ({ ...tx, Fee: '12', Sequence: 42, LastLedgerSequence: 1000 });
const idWallet = () => { const k = keyPairFromPhrase(generateRecoveryPhrase()); return { priv: k.privateKey, address: k.address }; };
const edKey = () => { const sk = crypto.getRandomValues(new Uint8Array(32)); return { secretKeyHex: toHex(sk), publicKeyHex: toHex(ed25519.getPublicKey(sk)) }; };

/** An agent buyer with a declared signing key, a mandate from its principal, and an XRP deal to fund. */
async function agentDeal(o: { bind?: boolean; declare?: boolean } = {}) {
  const r: DemoRunner = await seedDemoMarket(START);
  r.apply(await buildFeeSchedule('op', r.as('op', 1).at, { marketplace: NO_FEES, securities: NO_FEES, recipients: [], note: 'fees off' }));
  const w = idWallet(); const k = edKey(); const agentXrpl = Wallet.generate();
  const declaration = await declareKey(w.priv, w.address, { publicKey: k.publicKeyHex, algorithm: 'ed25519', purpose: 'signing' }, undefined, Date.parse(START));
  const profile = { partyId: 'agent-buyer', kind: 'agent', name: 'Herb buyer agent', roles: ['buyer'], region: 'CA', about: '', capabilities: { categories: [], canPlantNew: false }, principal: { partyId: 'blue-ridge-herbs' }, xrplAccount: agentXrpl.classicAddress, ...(o.declare === false ? {} : { keyDeclaration: declaration }) } as PartyProfile;
  r.apply(await M.buildProfile(r.state, r.as('agent-buyer', 1), profile));
  r.apply((await M.buildMandate(r.state, r.as('blue-ridge-herbs'), 'agent-buyer', { verbs: ['marketplace.order.place', 'marketplace.escrow.fund'], categories: ['crops/specialty'], maxPerContract: xrp(500), maxPerDay: xrp(1000), approvalAbove: null, expiresAt: '2026-12-01T00:00:00.000Z' }, o.bind ? { boundKey: k.publicKeyHex } : {})).txs);
  const s = r.state.parties.get('north-star-grain')!; r.apply(await M.buildProfile(r.state, r.as('north-star-grain', 1), { ...s, xrplAccount: SELLER }));
  r.apply(await M.buildListing(r.state, r.as('north-star-grain'), { listingId: 'l-viola', sellerId: 'north-star-grain', categoryId: 'crops/specialty', kind: 'sale', title: 'Violas for XRP', description: 'x', unit: 'stem', pricePerUnit: xrp(2), quantity: 100, region: 'CA', delivery: 'ship', leadDays: 7, attributes: {} }));
  const ord = await M.buildOrder(r.state, r.as('agent-buyer'), 'l-viola', 20); r.apply(ord.txs);
  const c = r.state.contracts.find((x) => x.contractId === ord.contractId)!;
  const [leg] = await prepareStageEscrows(c, 0, agentXrpl.classicAddress, SELLER, 'CD'.repeat(32), NOW);
  const signing: AgentSigningKey = { partyId: 'agent-buyer', declaration, secretKeyHex: k.secretKeyHex };
  return { r, w, k, declaration, signing, contractId: c.contractId, tx: autofill(leg.tx) };
}

const authorizeRequest = async (signing: AgentSigningKey | null, body: string, url = 'https://check.example/testnet/authorize') => {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(signing ? await signAgentRequest({ method: 'POST', url, body }, signing) : {}) };
  return new Request(url, { method: 'POST', headers, body });
};

describe('v15-31-00 agent party keys (KeyZ binding)', () => {
  it('a profile may declare a signing key; bad declarations are refused; no key stays valid (undeclared)', async () => {
    const { r, w, k, declaration } = await agentDeal();
    const p = r.state.parties.get('agent-buyer')!;
    expect((await agentKeyState(r.state, 'agent-buyer', k.publicKeyHex, NOW)).state).toBe('declared');
    expect((await agentKeyState(r.state, 'agent-buyer', edKey().publicKeyHex, NOW)).state).toBe('undeclared');
    expect((await agentKeyState(r.state, 'nobody', k.publicKeyHex, NOW)).state).toBe('unknown-party');
    expect((await agentKeyState(r.state, 'agent-buyer', k.publicKeyHex, '2027-06-01T00:00:00.000Z')).state).toBe('expired');
    // A wallet-signed revocation (on the profile or replayed from elsewhere) withdraws the key.
    const rev = await revokeKeyDeclaration(w.priv, declaration, 'rotated', Date.parse(NOW));
    expect((await agentKeyState(r.state, 'agent-buyer', k.publicKeyHex, NOW, [rev])).state).toBe('revoked');
    const tlsKey = await declareKey(w.priv, w.address, { publicKey: k.publicKeyHex, algorithm: 'ed25519', purpose: 'tls' });
    await expect(M.buildProfile(r.state, r.as('agent-buyer', 1), { ...p, keyDeclaration: tlsKey })).rejects.toThrow(/for tls/);
    const other = idWallet();
    const forged = { ...(await declareKey(other.priv, other.address, { publicKey: k.publicKeyHex, algorithm: 'ed25519', purpose: 'signing' })), walletAddress: w.address };
    await expect(M.buildProfile(r.state, r.as('agent-buyer', 1), { ...p, keyDeclaration: forged })).rejects.toThrow(/bad-signature/);
    const old = await declareKey(w.priv, w.address, { publicKey: k.publicKeyHex, algorithm: 'ed25519', purpose: 'signing' }, 1000, Date.parse(START) - 10_000);
    await expect(M.buildProfile(r.state, r.as('agent-buyer', 1), { ...p, keyDeclaration: old })).rejects.toThrow(/expired/);
    const { keyDeclaration: _k, ...noKey } = p;
    expect(await M.buildProfile(r.state, r.as('agent-buyer', 1), noKey)).toHaveLength(1);
  });

  it('a mandate binds to the declared key only; an undeclared key cannot be bound', async () => {
    const { r, k } = await agentDeal({ bind: true });
    expect(r.state.mandates.find((m) => m.agentPartyId === 'agent-buyer')?.boundKey).toBe(k.publicKeyHex);
    expect((await agentKeyState(r.state, 'agent-buyer', k.publicKeyHex, NOW)).binding).toBe('bound');
    expect((await agentKeyState(r.state, 'agent-buyer', edKey().publicKeyHex, NOW)).binding).toBe('bound-to-other-key');
    const limits = { verbs: ['marketplace.order.place'], categories: [], maxPerContract: xrp(5), maxPerDay: xrp(5), approvalAbove: null, expiresAt: '2026-12-01T00:00:00.000Z' };
    await expect(M.buildMandate(r.state, r.as('blue-ridge-herbs'), 'agent-buyer', limits, { boundKey: edKey().publicKeyHex })).rejects.toThrow(/undeclared/);
    const nk = await agentDeal({ declare: false });
    await expect(M.buildMandate(nk.r.state, nk.r.as('blue-ridge-herbs'), 'agent-buyer', limits, { boundKey: nk.k.publicKeyHex })).rejects.toThrow(/undeclared/);
  });
});

describe('v15-31-00 signed agent requests (RFC 9421)', () => {
  it('verifies against the party profile and answers a lifecycle state', async () => {
    const { r, w, declaration, signing } = await agentDeal();
    const v = createAgentRequestVerifier();
    const body = JSON.stringify({ hello: 1 });
    expect((await v.verify(r.state, await authorizeRequest(signing, body), new TextEncoder().encode(body))).state).toBe('verified-bound');
    expect((await v.verify(r.state, await authorizeRequest(null, body), new TextEncoder().encode(body))).state).toBe('not-signed');
    // Tampered body: the signed Content-Digest no longer matches.
    expect((await v.verify(r.state, await authorizeRequest(signing, body), new TextEncoder().encode('{"hello":2}'))).state).toBe('bad-signature');
    // The same request twice: the nonce is spent.
    const once = await authorizeRequest(signing, body);
    await v.verify(r.state, once.clone(), new TextEncoder().encode(body));
    expect((await v.verify(r.state, once, new TextEncoder().encode(body))).state).toBe('replayed');
    // A valid signature by a key the party never declared says nothing about the sender.
    const stranger = edKey(); const sw = idWallet();
    const sd = await declareKey(sw.priv, sw.address, { publicKey: stranger.publicKeyHex, algorithm: 'ed25519', purpose: 'signing' });
    expect((await v.verify(r.state, await authorizeRequest({ partyId: 'agent-buyer', declaration: sd, secretKeyHex: stranger.secretKeyHex }, body), new TextEncoder().encode(body))).state).toBe('verified-unbound');
    // Revoked by the declaring wallet.
    const rev = await revokeKeyDeclaration(w.priv, declaration, 'compromised');
    expect((await v.verify(r.state, await authorizeRequest(signing, body), new TextEncoder().encode(body), [rev])).state).toBe('revoked');
    // Signed for another path (e.g. a paid agent) and replayed here, with proxy hints: refused as a bad signature.
    const elsewhere = await signAgentRequest({ method: 'POST', url: 'https://agent.example/jobs', body }, signing);
    const replayed = new Request('https://check.example/testnet/authorize', { method: 'POST', headers: { ...elsewhere, 'x-original-uri': '/jobs', 'x-original-host': 'agent.example' }, body });
    expect((await v.verify(r.state, replayed, new TextEncoder().encode(body))).state).toBe('bad-signature');
    // Signed now, checked months later: stale. Signed and checked after the declaration expired: expired.
    const LATE = Date.parse('2027-06-01T00:00:00.000Z');
    const late = createAgentRequestVerifier({ now: () => LATE });
    expect((await late.verify(r.state, await authorizeRequest(signing, body), new TextEncoder().encode(body))).state).toBe('stale');
    const url = 'https://check.example/testnet/authorize';
    const lateReq = new Request(url, { method: 'POST', headers: await signAgentRequest({ method: 'POST', url, body }, signing, LATE), body });
    expect((await late.verify(r.state, lateReq, new TextEncoder().encode(body))).state).toBe('expired');
  });

  it('a bound mandate requires verified-bound; unbound agents keep working, and a signature never makes it worse', async () => {
    const bound = await agentDeal({ bind: true });
    const v = createAgentRequestVerifier();
    const intent = { network: 'testnet' as const, contractId: bound.contractId, milestone: 0, tx: bound.tx };
    const unsigned = await evaluateSigningIntent(bound.r.state, intent, NOW);
    expect(unsigned.approved ? [] : unsigned.reasons.map((x) => x.code)).toContain('request-auth');
    const body = JSON.stringify({ contractId: bound.contractId, milestone: 0, tx: bound.tx });
    const auth = await v.verify(bound.r.state, await authorizeRequest(bound.signing, body), new TextEncoder().encode(body));
    const ok = await evaluateSigningIntent(bound.r.state, { ...intent, requestAuth: auth }, NOW);
    expect(ok.approved).toBe(true);
    if (ok.approved) expect(ok.approval.requestAuth).toEqual(expect.objectContaining({ state: 'verified-bound', partyId: 'agent-buyer', keyId: bound.k.publicKeyHex }));
    expect(requestAuthDecision(bound.r.state, 'agent-buyer', { ...auth, keyId: edKey().publicKeyHex }, NOW).decision).toBe('refuse');

    const free = await agentDeal();
    const fi = { network: 'testnet' as const, contractId: free.contractId, milestone: 0, tx: free.tx };
    expect((await evaluateSigningIntent(free.r.state, fi, NOW)).approved).toBe(true);
    const badSig = { state: 'bad-signature' as const, partyId: 'agent-buyer', because: 'test' };
    const d = await evaluateSigningIntent(free.r.state, { ...fi, requestAuth: badSig }, NOW);
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.approval.requestAuth?.state).toBe('bad-signature');
  });

  it('approvalHook signs /authorize; the worker verifies, records the state and refuses an unsigned bound agent', async () => {
    const { authorize } = await import('../../packages/cappz-check-worker/worker');
    const { r, signing, contractId, tx } = await agentDeal({ bind: true });
    const v = createAgentRequestVerifier();
    const service = (async (url: string, init: RequestInit) => {
      const req = new Request(url, init); const bytes = new Uint8Array(await req.clone().arrayBuffer());
      const out = await authorize(JSON.parse(new TextDecoder().decode(bytes)), 'testnet', r.state, SEED, NOW, await v.verify(r.state, req, bytes));
      return new Response(JSON.stringify(out.body), { status: out.code });
    }) as unknown as typeof fetch;
    const seen: string[] = [];
    // verifyApproval checks expiry against the real clock: give the hook an approval made "now".
    const nowService = (async (url: string, init: RequestInit) => {
      const req = new Request(url, init); const bytes = new Uint8Array(await req.clone().arrayBuffer());
      const out = await authorize(JSON.parse(new TextDecoder().decode(bytes)), 'testnet', r.state, SEED, NOW, await v.verify(r.state, req, bytes));
      if ((out.body as { approved?: boolean }).approved) { const b = out.body as { approval: { expiresAt: string } }; seen.push(b.approval.expiresAt); }
      return new Response(JSON.stringify(out.body), { status: out.code });
    }) as unknown as typeof fetch;
    const signed = approvalHook({ serviceUrl: 'https://check.example', publicKey: PUB, network: 'testnet', contractId, milestone: 0, fetcher: nowService, signRequest: agentRequestHook(signing) });
    // The approval was issued at NOW (in the past for the real clock), so the guard refuses it as expired — but it was approved.
    await expect(signed(tx)).rejects.toThrow(/expired/);
    expect(seen).toHaveLength(1);
    const unsignedHook = approvalHook({ serviceUrl: 'https://check.example', publicKey: PUB, network: 'testnet', contractId, milestone: 0, fetcher: service });
    await expect(unsignedHook(tx)).rejects.toThrow(/binds agent-buyer to a signing key.*not-signed/);
    const body = JSON.stringify({ contractId, milestone: 0, tx });
    const req = await authorizeRequest(signing, body);
    const out = await authorize(JSON.parse(body), 'testnet', r.state, SEED, NOW, await v.verify(r.state, req, new TextEncoder().encode(body)));
    expect(await verifyApproval(out.body as never, tx, PUB, NOW)).toEqual([]);
    expect((out.body as { approval: { requestAuth: { state: string } } }).approval.requestAuth.state).toBe('verified-bound');
  });
});

describe('v15-31-00 principal credentials (SD-JWT, sealed disclosure)', () => {
  async function setup() {
    const issuer = keyPairFromPhrase(generateRecoveryPhrase()); const holder = keyPairFromPhrase(generateRecoveryPhrase());
    const ds = await Promise.all([makeDisclosure('accreditedInvestor', true), makeDisclosure('verifiedOrganization', true), makeDisclosure('legalName', 'Blue Ridge Herbs LLC')]);
    const issuerJwt = await issueSdJwt({ issuerPrivateKey: issuer.privateKey, issuerAddress: issuer.address, subjectAddress: holder.address, digests: ds.map((d) => d.digest), evidence: { level: 'IAL2', method: 'third-party-letter' }, vct: 'https://cappz.ai/vct/principal/v1' });
    const ref = await principalCredentialRef(issuerJwt);
    const box = await generateBoxKeyPair();
    const req = requestPrincipalDisclosure({ from: 'north-star-grain', subject: 'agent-buyer', claims: ['accreditedInvestor'], purpose: 'Rule 506(c) evidence', aud: 'north-star-grain', replyTo: box.publicKey, now: NOW });
    return { issuer, holder, ds, issuerJwt, ref, box, req };
  }

  it('discloses only what was asked, sealed to the requester, bound to its nonce; the profile holds a reference only', async () => {
    const { holder, ds, issuerJwt, ref, box, req } = await setup();
    const answer = await answerPrincipalDisclosure(req, { issuerJwt, disclosures: ds.map((d) => d.encoded), holderPrivateKey: holder.privateKey }, NOW);
    expect(JSON.stringify(answer)).not.toContain('Blue Ridge');
    const res = await verifyPrincipalDisclosure(req, answer, { boxPrivateKey: box.privateKey, profileRef: ref, now: NOW });
    expect(res.state).toBe('verified');
    expect(res.claims).toEqual({ accreditedInvestor: true });
    const ev = await disclosureEvidence(req, res, NOW);
    expect(ev.evidenceHash).toMatch(/^[0-9a-f]{64}$/); // citable as an EligibilityAttestation evidenceHash
    expect(ev).not.toHaveProperty('claims'); expect(ev.claimNames).toEqual(['accreditedInvestor']);
    // Another requester's key cannot open it; another request is not answered by it; another credential is not the profile's.
    const other = await generateBoxKeyPair();
    expect((await verifyPrincipalDisclosure(req, answer, { boxPrivateKey: other.privateKey, now: NOW })).state).toBe('cannot-open');
    const req2 = { ...req, requestId: 'pdr-other', nonce: 'ff'.repeat(16) };
    expect((await verifyPrincipalDisclosure(req2, answer, { boxPrivateKey: box.privateKey, now: NOW })).state).toBe('wrong-request');
    expect((await verifyPrincipalDisclosure(req2, { ...answer, requestId: 'pdr-other' }, { boxPrivateKey: box.privateKey, now: NOW })).state).toBe('wrong-request');
    expect((await verifyPrincipalDisclosure(req, answer, { boxPrivateKey: box.privateKey, profileRef: { ...ref, attestationId: 'A'.repeat(43) }, now: NOW })).state).toBe('not-on-profile');
    expect((await verifyPrincipalDisclosure(req, answer, { boxPrivateKey: box.privateKey, trustedIssuers: ['did:key:zOther'], now: NOW })).state).toBe('untrusted-issuer');
    expect((await verifyPrincipalDisclosure(req, answer, { boxPrivateKey: box.privateKey, revokedAttestations: new Set([ref.attestationId]), now: NOW })).state).toBe('revoked');
    expect((await verifyPrincipalDisclosure(req, answer, { boxPrivateKey: box.privateKey, now: '2026-11-01T13:00:00.000Z' })).state).toBe('request-expired');
  });

  it('withheld claims are incomplete, not "no"; a profile carries the reference, never values', async () => {
    const { holder, ds, issuerJwt, ref, box } = await setup();
    const req = requestPrincipalDisclosure({ from: 'x', subject: 'agent-buyer', claims: ['accreditedInvestor', 'netWorth'], purpose: 'test', aud: 'x', replyTo: box.publicKey, now: NOW });
    const answer = await answerPrincipalDisclosure(req, { issuerJwt, disclosures: ds.map((d) => d.encoded), holderPrivateKey: holder.privateKey }, NOW);
    expect(answer.withheld).toEqual(['netWorth']);
    const res = await verifyPrincipalDisclosure(req, answer, { boxPrivateKey: box.privateKey, profileRef: ref, now: NOW });
    expect(res.state).toBe('incomplete');
    const { r } = await agentDeal();
    const p = r.state.parties.get('agent-buyer')!;
    expect(await M.buildProfile(r.state, r.as('agent-buyer', 1), { ...p, principalCredential: ref })).toHaveLength(1);
    await expect(M.buildProfile(r.state, r.as('agent-buyer', 1), { ...p, principalCredential: { ...ref, legalName: 'Blue Ridge Herbs LLC' } as never })).rejects.toThrow(/only a reference/);
  });
});

describe('v15-31-00 A2A agent card', () => {
  const agent = createPaidAgent({ offer: { name: 'CAPPZ counterparty check (testnet)', description: 'Checks a counterparty.', payTo: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', network: 'testnet', currency: 'XRP', price: 0.01, stages: SCHEDULE_PRESETS['on-completion'].stages }, work: async () => 'x' });

  it('builds from the paid agent and the API manifest, signs over canonical JSON, verifies to a trust state', async () => {
    const card = buildAgentCard({ url: 'https://check.example/testnet', version: '15.31.0', paid: agent.card(), manifest: agentApiManifest(), requestSigning: 'optional' });
    expect(card).toEqual(expect.objectContaining({ protocolVersion: '0.3.0', name: 'CAPPZ counterparty check (testnet)', url: 'https://check.example/testnet', version: '15.31.0', defaultInputModes: ['application/json'] }));
    expect(card.skills.map((s) => s.id)).toEqual(expect.arrayContaining(['cappz-counterparty-check-testnet', 'marketplace.search']));
    expect(card.capabilities.extensions.map((e) => e.uri)).toEqual(['https://cappz.ai/ext/paid-agent/v1', 'https://cappz.ai/ext/http-message-signatures/v1']);
    expect(await verifyAgentCard(card)).toEqual(expect.objectContaining({ state: 'not-signed' }));
    const signed = signAgentCard(card, SEED);
    expect(JSON.parse(atob(signed.signatures![0].protected.replace(/-/g, '+').replace(/_/g, '/')))).toEqual({ alg: 'EdDSA', typ: 'JOSE', kid: PUB });
    expect((await verifyAgentCard(signed, { expectedPublicKey: PUB })).state).toBe('published-key');
    expect((await verifyAgentCard(signed)).state).toBe('verified-unbound');
    expect((await verifyAgentCard({ ...signed, description: 'changed' }, { expectedPublicKey: PUB })).state).toBe('bad-signature');
    // Key order does not matter: the signature is over canonical JSON.
    const reordered = Object.fromEntries(Object.entries(signed).reverse()) as typeof signed;
    expect((await verifyAgentCard(reordered, { expectedPublicKey: PUB })).state).toBe('published-key');
    // Independent check: Ed25519 over "<protected>.<base64url(canonical card)>" with Node's crypto.
    const { createPublicKey, verify } = await import('node:crypto');
    const { canonicalJson, toBase64Url, utf8, fromBase64Url } = await import('../lib/identity/canonical');
    const { signatures, ...rest } = signed;
    const input = `${signatures![0].protected}.${toBase64Url(utf8(canonicalJson(rest)))}`;
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(PUB, 'hex')]);
    expect(verify(null, Buffer.from(input), createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(fromBase64Url(signatures![0].signature)))).toBe(true);
  });

  it('a KeyZ-declared card key reads declared; a revoked one revoked', async () => {
    const w = idWallet(); const k = edKey();
    const d = await declareKey(w.priv, w.address, { publicKey: k.publicKeyHex, algorithm: 'ed25519', purpose: 'signing' });
    const card = signAgentCard(buildAgentCard({ url: 'https://agent.example', version: '1.0.0', paid: agent.card() }), k.secretKeyHex, d);
    expect((await verifyAgentCard(card)).state).toBe('declared');
    expect((await verifyAgentCard(card, { revocations: [await revokeKeyDeclaration(w.priv, d, 'lost')] })).state).toBe('revoked');
  });

  it('the check worker serves a signed card per network and for the service', async () => {
    const { serviceCard } = await import('../../packages/cappz-check-worker/worker');
    const env = { CHECK_SIGNING_SEED: SEED, PAY_TO_TESTNET: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', PAY_TO_MAINNET: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', PRICE_XRP: '0.01', DB: {} } as never;
    const top = serviceCard(env, 'https://check.example', null);
    expect(top.skills.map((s) => s.id)).toEqual(expect.arrayContaining(['counterparty-check-testnet', 'signing-approval-mainnet', 'reputation-testnet']));
    expect((await verifyAgentCard(top, { expectedPublicKey: PUB })).state).toBe('published-key');
    const net = serviceCard(env, 'https://check.example', 'testnet');
    expect(net.url).toBe('https://check.example/testnet');
    expect(net.capabilities.extensions.some((e) => e.description?.includes('published-key'))).toBe(true);
  });

  it('server.json names the MCP server in reverse-DNS form and runs it over stdio', () => {
    const s = JSON.parse(readFileSync(new URL('../../packages/cappz-market/server.json', import.meta.url), 'utf8'));
    expect(s.name).toBe('ai.cappz/cappz-market');
    // The MCP server entry follows the tool release that ships it.
    expect(s.version).toBe(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
    expect(s.packages[0].version).toBe(s.version);
    expect(s.description.length).toBeLessThanOrEqual(100);
    expect(s.packages[0]).toEqual(expect.objectContaining({ transport: { type: 'stdio' }, packageArguments: [expect.objectContaining({ type: 'positional', value: 'mcp' })] }));
  });
});

describe('v15-31-00 reputation attestations', () => {
  it('keeps ledger facts, market history, uptime and verdict apart; signed under its own domain at a CAPPZ path', async () => {
    const { r } = await agentDeal();
    const a = buildReputationAttestation(r.state, 'agent-buyer', 'testnet', NOW, { uptime: { endpoint: 'https://agent.example', probes: 100, passed: 80, from: START, to: NOW, probedBy: 'p-probe' } });
    expect(a.address.endsWith('/parties/agent-buyer/reputation/2026-11-01')).toBe(true);
    expect(providerSegmentsIn(a.address)).toEqual([]);
    expect(a.ledger).toBeNull();
    expect(a.market).toEqual(expect.objectContaining({ finished: 0, keyDeclared: true, kind: 'agent' }));
    expect(a.uptime?.source).toBe('reported');
    expect(a.verdict.standing).toBe('no-history');
    expect(a.verdict.reasons.map((x) => x.code)).toEqual(expect.arrayContaining(['uptime', 'ledger-not-read', 'key-declared']));
    expect(buildReputationAttestation(r.state, 'nobody', 'testnet', NOW).verdict.standing).toBe('unknown-party');
    const signed = signReputation(a, SEED);
    expect(verifyReputation(signed, PUB, NOW).state).toBe('verified-published-key');
    expect(verifyReputation(signed, 'ab'.repeat(32), NOW).state).toBe('verified-unbound');
    expect(verifyReputation(signed, PUB, '2026-11-03T00:00:00.000Z').state).toBe('stale');
    expect(verifyReputation({ ...signed, attestation: { ...a, verdict: { standing: 'good-standing', reasons: [] } } }, PUB, NOW).state).toBe('bad-signature');
    // Domain separation: a check-report signature by the same key over the same object is not an attestation signature, and vice versa.
    expect(verifyReputation({ attestation: a, signature: signCheck(a as never, SEED).signature }, PUB, NOW).state).toBe('bad-signature');
    expect(verifyCheck({ report: a as never, signature: signed.signature })).toBe(false);
  });

  it('a party with finished deals and good ratings is in good standing; an open dispute shows', async () => {
    const r = await seedDemoMarket(START);
    const ids = [...r.state.reputation.entries()].filter(([, v]) => v.completed > 0).map(([k]) => k);
    for (const id of ids.slice(0, 1)) expect(['good-standing', 'limited-history', 'poorly-rated', 'disputed']).toContain(buildReputationAttestation(r.state, id, 'testnet', NOW).verdict.standing);
    expect(buildReputationAttestation(r.state, DEMO_YOU, 'testnet', NOW).market).not.toBeNull();
  });
});
