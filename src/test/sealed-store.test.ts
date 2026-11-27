// @vitest-environment node
// Sealed shared storage (16.5.0, src/lib/sealed/sealedStore.ts): objects sealed on the writer's machine
// for a group of wallets, wallet-signed write records, replay with rejected records shown.
import { describe, expect, it } from 'vitest';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import { walletEncryptionKey } from '../lib/crypto/walletEnvelope';
import { declareKey, revokeKeyDeclaration } from '../lib/identity/keyDeclaration';
import {
  currentHead, needsReseal, openObject, recipientsFrom, recordId, recordProblem, replayBox, sealObject, sealedFor,
  sealedStoreClient, sha256Hex, signPurge, signWrite, type DirectoryEntry,
} from '../lib/sealed/sealedStore';
import { createPaidAgent, defineAgentOffer, SCHEDULE_PRESETS } from '../lib/agentKit/paidAgent';
import { Wallet } from 'xrpl';

const wallet = () => keyPairFromPhrase(generateRecoveryPhrase());
const ann = wallet(), bob = wallet(), cy = wallet(), eve = wallet(), dan = wallet();
const te = new TextEncoder(), td = new TextDecoder();

async function published(w: ReturnType<typeof wallet>, hybrid = true) {
  const k = await walletEncryptionKey(w.privateKey, hybrid ? { pqSeed: w.pqSeed } : {});
  const declaration = await declareKey(w.privateKey, w.address, { publicKey: k.publicKey, algorithm: k.algorithm, purpose: 'encryption' });
  return { k, declaration, entry: { wallet: w.address, declarations: [declaration], revocations: [] } as DirectoryEntry };
}

describe('sealed store: key directory', () => {
  it('uses only keys the wallet itself declared for encryption, newest valid first', async () => {
    const b = await published(bob), c = await published(cy, false);
    const forged = { ...b.declaration, walletAddress: eve.address };
    const revoked = await published(eve);
    const rev = await revokeKeyDeclaration(eve.privateKey, revoked.declaration, 'lost');
    const { recipients, missing } = await recipientsFrom([
      b.entry, c.entry,
      { wallet: eve.address, declarations: [revoked.declaration], revocations: [rev] },
      { wallet: dan.address, declarations: [{ ...forged, walletAddress: dan.address }], revocations: [] },
      { wallet: ann.address, declarations: [], revocations: [] },
    ]);
    expect(recipients.map((r) => r.id)).toEqual([bob.address, cy.address]);
    expect(missing.map((m) => [m.wallet, m.because.split(':')[0]])).toEqual([[eve.address, 'revoked'], [dan.address, 'bad-signature'], [ann.address, 'no encryption key published']]);
  });
});

describe('sealed store: objects and records', () => {
  it('a writer seals for the group; each member opens it, nobody else, and nowhere else', async () => {
    const b = await published(bob), c = await published(cy, false);
    const { recipients } = await recipientsFrom([b.entry, c.entry]);
    const stored = await sealObject(te.encode('quarterly numbers'), { writer: ann, boxId: 'job-1', objectId: 'reports/q3.txt', recipients });
    expect(td.decode(stored)).not.toContain('quarterly');
    expect(sealedFor(stored).sort()).toEqual([bob.address, cy.address].sort());
    const where = { writer: ann.address, boxId: 'job-1', objectId: 'reports/q3.txt' };
    expect(td.decode((await openObject(stored, { ...where, asWriter: ann }))!)).toBe('quarterly numbers');
    expect(td.decode((await openObject(stored, { ...where, asRecipient: { id: bob.address, encryptionPrivateKey: b.k.privateKey } }))!)).toBe('quarterly numbers');
    expect(td.decode((await openObject(stored, { ...where, asRecipient: { id: cy.address, encryptionPrivateKey: c.k.privateKey } }))!)).toBe('quarterly numbers');
    const e = await published(eve);
    expect(await openObject(stored, { ...where, asRecipient: { id: eve.address, encryptionPrivateKey: e.k.privateKey } })).toBeNull();
    expect(await openObject(stored, { ...where, objectId: 'reports/q4.txt', asWriter: ann })).toBeNull();
    expect(await openObject(stored, { ...where, boxId: 'job-2', asRecipient: { id: bob.address, encryptionPrivateKey: b.k.privateKey } })).toBeNull();
    expect(needsReseal(sealedFor(stored), ann.address, [ann.address, bob.address, cy.address])).toBe(false);
    expect(needsReseal(sealedFor(stored), ann.address, [ann.address, bob.address])).toBe(true);
  });

  it('replays versions per object, applies purges, and sets aside what breaks the rules', async () => {
    const v1bytes = te.encode('one'), v2bytes = te.encode('two!');
    const w1 = await signWrite(ann.privateKey, ann.address, { boxId: 'job-1', objectId: 'a', parent: null, bytes: v1bytes });
    const w2 = await signWrite(bob.privateKey, bob.address, { boxId: 'job-1', objectId: 'a', parent: recordId(w1), bytes: v2bytes });
    const purge = await signPurge(ann.privateKey, ann.address, { boxId: 'job-1', writeId: recordId(w1) });
    const outsider = await signWrite(eve.privateKey, eve.address, { boxId: 'job-1', objectId: 'b', parent: null, bytes: v1bytes });
    const otherBox = await signWrite(ann.privateKey, ann.address, { boxId: 'job-9', objectId: 'b', parent: null, bytes: v1bytes });
    const wrongParent = await signWrite(ann.privateKey, ann.address, { boxId: 'job-1', objectId: 'c', parent: recordId(w1), bytes: v1bytes });
    const tampered = { ...w2, size: 999 };
    const state = await replayBox('job-1', [ann.address, bob.address], [w1, w2, w2, purge, outsider, otherBox, wrongParent, tampered]);
    const a = state.objects.get('a')!;
    expect(a.versions.map((v) => [v.version, v.writer, v.purged])).toEqual([[1, ann.address, true], [2, bob.address, false]]);
    expect(currentHead(state, 'a')!.writeId).toBe(recordId(w2));
    expect(currentHead(state, 'new')).toBeNull();
    expect(state.usedBytes).toBe(4);
    expect(state.rejected.map((r) => r.because)).toEqual([
      'the writer is not one of the box\'s writers',
      'record for box job-9, not job-1',
      'its parent is not a version of this object',
      'the writer\'s signature does not match the record',
    ]);
    expect(w1.sha256).toBe(sha256Hex(v1bytes));
  });

  it('refuses malformed records before checking any signature', async () => {
    const ok = await signWrite(ann.privateKey, ann.address, { boxId: 'job-1', objectId: 'x', parent: null, bytes: te.encode('x') });
    expect(await recordProblem(ok)).toBeNull();
    expect(await recordProblem({ ...ok, objectId: '../etc/passwd' })).toMatch(/objectId/);
    expect(await recordProblem({ ...ok, objectId: '/abs' })).toMatch(/objectId/);
    expect(await recordProblem({ ...ok, boxId: 'a/b' })).toMatch(/boxId/);
    expect(await recordProblem({ ...ok, writer: 'rAddress' })).toMatch(/writer/);
    expect(await recordProblem({ ...ok, kind: 'delete' })).toMatch(/not a sealed-store record/);
  });

  it('the client checks returned bytes against the record and sends the record beside the bytes', async () => {
    const bytes = te.encode('sealed bytes');
    const w = await signWrite(ann.privateKey, ann.address, { boxId: 'job-1', objectId: 'x', parent: null, bytes });
    const seen: Array<{ url: string; headers?: HeadersInit }> = [];
    const fake = (async (u: string, init?: RequestInit) => {
      seen.push({ url: u, headers: init?.headers });
      if (u.endsWith('/objects')) return new Response(JSON.stringify({ writeId: recordId(w), receipt: {} }));
      return new Response(u.includes(w.sha256) ? bytes : te.encode('swapped'));
    }) as typeof fetch;
    const client = sealedStoreClient('https://node.example/agents/sealed-store/', fake);
    expect((await client.put(w, bytes)).writeId).toBe(recordId(w));
    const header = (seen[0].headers as Record<string, string>)['x-cappz-sealed-record'];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual(w);
    expect(td.decode(await client.get('job-1', { sha256: w.sha256 }))).toBe('sealed bytes');
    await expect(client.get('job-1', { sha256: 'f'.repeat(64) })).rejects.toThrow(/do not match/);
    expect(seen[0].url).toBe('https://node.example/agents/sealed-store/boxes/job-1/objects');
  });
});

describe('paid agent kit: priceFor (16.5.0)', () => {
  it('records the price each job was opened at and refuses one the stages cannot split', async () => {
    const agent = createPaidAgent({
      offer: defineAgentOffer({ name: 'x', description: 'y', payTo: Wallet.generate().classicAddress, network: 'testnet', currency: 'XRP', price: 0.25, stages: SCHEDULE_PRESETS['on-completion'].stages }),
      work: async () => 'ok',
      priceFor: (i) => 0.25 * (i as { gb: number }).gb,
    });
    const { job } = await agent.openJob({ gb: 8 });
    expect(job.terms.price).toBe(2);
    expect(agent.card().price).toBe('0.25');
    await expect(agent.openJob({ gb: 0 })).rejects.toThrow(/price above zero/);
  });
});
