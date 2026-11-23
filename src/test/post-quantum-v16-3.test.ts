// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import { declareKey, declarePqAnchor, generatePqKey, pqCosign } from '../lib/identity/keyDeclaration';
import { toHex } from '../lib/identity/canonical';
import { parseSignatureInput, signatureBytes, signatureMembers } from '../lib/identity/edgeVerify';
import { seedDemoMarket } from '../lib/marketplace/demo';
import * as M from '../lib/marketplace/model';
import { agentKeyState, profileKeyProblems } from '../lib/marketplace/agentKeys';
import { createAgentRequestVerifier, requestAuthDecision, signAgentRequest, type AgentSigningKey } from '../lib/marketplace/agentRequestAuth';
import {
  isWalletEnvelope, openForWallet, openSharedEnvelope, PQ_WALLET_ENVELOPE_PREFIX, sealForRecipients, sealForWallet, sharedWrapNeeds, walletEncryptionKey, walletEnvelopeNeedsPqSeed,
} from '../lib/crypto/walletEnvelope';
import type { PartyProfile } from '../lib/marketplace/types';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);
const START = '2026-11-01T12:00:00.000Z';

describe('v16-03-00 post-quantum wallet-sealed records (cw3)', () => {
  const w = keyPairFromPhrase(generateRecoveryPhrase());
  const ctx = `notary-file|${w.address}|leaf`;

  it('with pqSeed the record is cw3 and needs both the private key and pqSeed; cw1 still opens', async () => {
    const pq = await sealForWallet(enc('hybrid'), w.privateKey, ctx, { pqSeed: w.pqSeed });
    expect(pq.startsWith(PQ_WALLET_ENVELOPE_PREFIX)).toBe(true);
    expect(isWalletEnvelope(pq) && walletEnvelopeNeedsPqSeed(pq)).toBe(true);
    expect(dec(await openForWallet(pq, w.privateKey, ctx, { pqSeed: w.pqSeed }))).toBe('hybrid');
    // The private key alone — what a quantum computer recovers from the address — opens nothing.
    expect(await openForWallet(pq, w.privateKey, ctx)).toBeNull();
    expect(await openForWallet(pq, w.privateKey, ctx, { pqSeed: new Uint8Array(32) })).toBeNull();
    const old = await sealForWallet(enc('classic'), w.privateKey, ctx);
    expect(walletEnvelopeNeedsPqSeed(old)).toBe(false);
    expect(dec(await openForWallet(old, w.privateKey, ctx, { pqSeed: w.pqSeed }))).toBe('classic');
  });

  it('shared records: the owner wrap is cw3 with pqSeed, and each wrap says what opening it needs', async () => {
    const r = keyPairFromPhrase(generateRecoveryPhrase());
    const rk = await walletEncryptionKey(r.privateKey, { pqSeed: r.pqSeed });
    const stored = await sealForRecipients(enc('rx'), ctx, { ownerPrivateKey: w.privateKey, ownerPqSeed: w.pqSeed, recipients: [{ id: r.address, publicKey: rk.publicKey }] });
    expect(sharedWrapNeeds(stored, 'owner')).toBe('pq-seed');
    expect(sharedWrapNeeds(stored, r.address)).toBe('pq-seed');
    expect(sharedWrapNeeds(stored, 'nobody')).toBeNull();
    expect(dec(await openSharedEnvelope(stored, ctx, { ownerPrivateKey: w.privateKey, ownerPqSeed: w.pqSeed }))).toBe('rx');
    expect(await openSharedEnvelope(stored, ctx, { ownerPrivateKey: w.privateKey })).toBeNull();
    expect(dec(await openSharedEnvelope(stored, ctx, { recipientId: r.address, encryptionPrivateKey: rk.privateKey }))).toBe('rx');
  });
});

describe('v16-03-00 RFC 9421 with several signatures', () => {
  it('splits dictionary members at top-level commas only', () => {
    const input = 'sig1=("@method" "@path");created=1;keyid="a";alg="ed25519";nonce="n", sig2=("@method" "@path");created=1;keyid="b";alg="ml-dsa-65";nonce="n"';
    expect([...signatureMembers(input).keys()]).toEqual(['sig1', 'sig2']);
    expect(parseSignatureInput(input, 'sig2')).toMatchObject({ alg: 'ml-dsa-65', keyid: 'b', components: ['@method', '@path'] });
    expect(parseSignatureInput(input)).toMatchObject({ alg: 'ed25519', keyid: 'a' });
    expect(signatureBytes('sig1=:AAEC:, sig2=:AwQF:', 'sig2')).toEqual(new Uint8Array([3, 4, 5]));
  });
});

describe('v16-03-00 agent requests with an ML-DSA-65 second signature', () => {
  async function agent(o: { pq: boolean; bind?: boolean }) {
    const r = await seedDemoMarket(START);
    const id = keyPairFromPhrase(generateRecoveryPhrase());
    const sk = crypto.getRandomValues(new Uint8Array(32)); const pub = toHex(ed25519.getPublicKey(sk));
    const at = Date.parse(START);
    let declaration = await declareKey(id.privateKey, id.address, { publicKey: pub, algorithm: 'ed25519', purpose: 'signing' }, undefined, at);
    const extra: Partial<PartyProfile> = {};
    let pq: AgentSigningKey['pq'];
    if (o.pq) {
      const anchorKey = generatePqKey(); const signingSeed = crypto.getRandomValues(new Uint8Array(32)); const signingKey = generatePqKey(signingSeed);
      const anchor = await declarePqAnchor(id.privateKey, id.address, anchorKey, { now: at });
      declaration = await pqCosign(declaration, anchor, anchorKey);
      const pqDecl = await pqCosign(await declareKey(id.privateKey, id.address, { publicKey: signingKey.publicKey, algorithm: 'ml-dsa-65', purpose: 'signing' }, undefined, at), anchor, anchorKey);
      Object.assign(extra, { pqAnchor: anchor, pqKeyDeclaration: pqDecl });
      pq = { declaration: pqDecl, seedHex: toHex(signingSeed) };
    }
    const profile = { partyId: 'agent-pq', kind: 'agent', name: 'PQ agent', roles: ['buyer'], region: 'CA', about: '', capabilities: { categories: [], canPlantNew: false }, principal: { partyId: 'blue-ridge-herbs' }, keyDeclaration: declaration, ...extra } as PartyProfile;
    expect(await profileKeyProblems(profile, START)).toEqual([]);
    r.apply(await M.buildProfile(r.state, r.as('agent-pq', 1), profile));
    if (o.bind) r.apply((await M.buildMandate(r.state, r.as('blue-ridge-herbs'), 'agent-pq', { verbs: ['marketplace.order.place'], categories: [], maxPerContract: { amount: 5, currency: 'XRP' }, maxPerDay: { amount: 5, currency: 'XRP' }, approvalAbove: null, expiresAt: '2026-12-31T00:00:00.000Z' }, { boundKey: pub })).txs);
    const signing: AgentSigningKey = { partyId: 'agent-pq', declaration, secretKeyHex: toHex(sk), ...(pq ? { pq } : {}) };
    return { r, signing, pub };
  }
  const url = 'https://check.example/testnet/authorize';
  const req = async (s: AgentSigningKey, body: string, mutate?: (h: Record<string, string>) => void) => {
    const h = { 'content-type': 'application/json', ...(await signAgentRequest({ method: 'POST', url, body }, s)) };
    mutate?.(h);
    return new Request(url, { method: 'POST', headers: h, body });
  };

  it('a party with an ML-DSA key: hybrid when both sign; pq-unsigned without sig2; bad-signature when sig2 is wrong', async () => {
    const { r, signing } = await agent({ pq: true });
    const v = createAgentRequestVerifier();
    const body = '{"a":1}';
    const ok = await v.verify(r.state, await req(signing, body), enc(body));
    expect(ok).toMatchObject({ state: 'verified-bound', postQuantum: 'hybrid' });
    // Ed25519 only (what a forger of the classical key could produce): refused for a mandate, reported otherwise.
    const { pq: _pq, ...classicalOnly } = signing;
    const down = await v.verify(r.state, await req(classicalOnly, body), enc(body));
    expect(down.state).toBe('pq-unsigned');
    const other = generatePqKey();
    const wrong = await v.verify(r.state, await req({ ...signing, pq: { declaration: { ...signing.pq!.declaration, publicKey: other.publicKey }, seedHex: '11'.repeat(32) } }, body), enc(body));
    expect(wrong.state).toBe('bad-signature');
  });

  it('a party without one stays classical-only and verified-bound; the anchor makes an uncosigned key pq-unsigned', async () => {
    const { r, signing, pub } = await agent({ pq: false });
    const v = createAgentRequestVerifier();
    expect(await v.verify(r.state, await req(signing, '{}'), enc('{}'))).toMatchObject({ state: 'verified-bound', postQuantum: 'classical-only' });
    const anchored = await agent({ pq: true, bind: true });
    expect((await agentKeyState(anchored.r.state, 'agent-pq', anchored.pub, START)).state).toBe('declared');
    const auth = await v.verify(anchored.r.state, await req((({ pq: _p, ...s }) => s)(anchored.signing), '{}'), enc('{}'));
    expect(requestAuthDecision(anchored.r.state, 'agent-pq', auth, START).decision).toBe('refuse');
    expect(pub).toHaveLength(64);
  });
});
