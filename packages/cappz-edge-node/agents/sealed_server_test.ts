/**
 * The sealed-store agent's routes end to end under Deno (16.5.0): a temporary folder stands in for the drive.
 * Run: deno test --config deno.json --allow-read --allow-write --allow-env packages/cappz-edge-node/agents/sealed_server_test.ts
 * (vitest does not pick this file up; the rules it relies on are tested in src/test/edge-node-sealed.test.ts.)
 */
import { createSealedStore } from './sealedServer.ts';
import type { JobEvent, JobStore } from '../../../src/lib/agentKit/paidAgent.ts';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../../../src/lib/auth/wallet/session.ts';
import { walletEncryptionKey } from '../../../src/lib/crypto/walletEnvelope.ts';
import { declareKey } from '../../../src/lib/identity/keyDeclaration.ts';
import { currentHead, openObject, recipientsFrom, recordId, replayBox, sealObject, sealedStoreClient, signPurge, signWrite, type BoxView } from '../../../src/lib/sealed/sealedStore.ts';

const eq = (a: unknown, b: unknown, what: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

function memoryStore(): JobStore & { log: JobEvent[] } {
  const log: JobEvent[] = []; const results = new Map<string, Uint8Array>();
  return {
    log,
    async append(e) { log.push(e); }, async events() { return [...log]; }, async eventsFor(id) { return log.filter((e) => e.jobId === id); },
    async paymentUsed(h) { return log.some((e) => e.type === 'StagePaid' && e.txHash === h); },
    async putResult(j, s, b) { results.set(`${j}-${s}`, b); }, async getResult(j, s) { return results.get(`${j}-${s}`) ?? null; },
  };
}

Deno.test('sealed store: open, publish keys, seal, write, read, version, purge, quota and capacity', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'cappz-sealed-' });
  const stores: Record<string, ReturnType<typeof memoryStore>> = {};
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
  const sealed = await createSealedStore({
    network: 'testnet', payTo: 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH', pow: 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH', publicBase: 'https://node.test/agents', nodeKeyHex: 'ab'.repeat(32),
    jobDir: `${dir}/jobs`, storeDir: `${dir}/drive`, pricePerGb: 0.25,
    settings: { days: 30, graceDays: 7, maxGb: 3, maxBoxGb: 2, maxObjectBytes: 1024 * 1024, maxWriters: 20 },
    fileJobStore: async (d) => (stores[d] ??= memoryStore()),
    signed: async (eventType, targetAddress, payload) => ({ eventType, targetAddress, payload, txHash: crypto.randomUUID() }),
    evidenceFor: () => ({}), verifyHow: 'test', json, cors: {},
  });
  const store = stores[`${dir}/jobs`];
  const route = (u: string, init?: RequestInit) => sealed.route(new Request(`https://node.test${u}`, init), new URL(`https://node.test${u}`)).then((r) => r!);
  const fetchImpl = ((u: string, init?: RequestInit) => route(new URL(u).pathname, init)) as typeof fetch;
  const client = sealedStoreClient('https://node.test/agents/sealed-store', fetchImpl);

  const ann = keyPairFromPhrase(generateRecoveryPhrase()), bob = keyPairFromPhrase(generateRecoveryPhrase()), eve = keyPairFromPhrase(generateRecoveryPhrase());
  // Key directory: bob publishes; a declaration for another purpose is refused.
  const bk = await walletEncryptionKey(bob.privateKey, { pqSeed: bob.pqSeed });
  await client.publishKey(await declareKey(bob.privateKey, bob.address, { publicKey: bk.publicKey, algorithm: bk.algorithm, purpose: 'encryption' }));
  let refused = false; try { await client.publishKey(await declareKey(bob.privateKey, bob.address, { publicKey: bk.publicKey, algorithm: bk.algorithm, purpose: 'signing' })); } catch { refused = true; }
  eq(refused, true, 'a signing declaration is refused');
  const { recipients } = await recipientsFrom([await client.lookupKeys(bob.address)]);
  eq(recipients.map((r) => r.id), [bob.address], 'bob is a recipient');

  // Capacity: 3 GB sold in all; a 2 GB box fits, then a second 2 GB box does not.
  eq(await sealed.check({ gb: 2, writers: [ann.address, bob.address] }), null, 'first box fits');
  const { job } = await sealed.agent.openJob({ gb: 2, writers: [ann.address, bob.address], label: 'team' });
  eq(job.terms.price, 0.5, 'priced by gigabytes');
  eq(typeof await sealed.check({ gb: 2, writers: [ann.address] }), 'string', 'over capacity while the first is unpaid');
  const boxId = job.jobId;

  // Unpaid: writes refused.
  const bytes0 = await sealObject(new TextEncoder().encode('draft one'), { writer: ann, boxId, objectId: 'docs/plan.md', recipients });
  let code = 0; try { await client.put(await signWrite(ann.privateKey, ann.address, { boxId, objectId: 'docs/plan.md', parent: null, bytes: bytes0 }), bytes0); } catch (e) { code = Number(/sealed-store (\d+)/.exec((e as Error).message)?.[1]); }
  eq(code, 402, 'unpaid box refuses writes');
  await store.append({ type: 'StagePaid', jobId: boxId, at: new Date().toISOString(), stage: 0, txHash: 'T'.repeat(64), delivered: '0.5' });

  // Write v1, read it back as bob, write v2 as bob naming v1.
  const w1 = await signWrite(ann.privateKey, ann.address, { boxId, objectId: 'docs/plan.md', parent: null, bytes: bytes0 });
  const r1 = await client.put(w1, bytes0);
  eq(r1.writeId, recordId(w1), 'write id');
  eq((await client.put(w1, bytes0) as unknown as { repeated: boolean }).repeated, true, 'the same record twice is one version');
  let box: BoxView = await client.box(boxId);
  let state = await replayBox(boxId, box.writers, box.records.map((r) => r.record));
  const v1 = currentHead(state, 'docs/plan.md')!;
  const got = await client.get(boxId, v1);
  const plain = await openObject(got, { writer: v1.writer, boxId, objectId: v1.objectId, asRecipient: { id: bob.address, encryptionPrivateKey: bk.privateKey } });
  eq(new TextDecoder().decode(plain!), 'draft one', 'bob opens what ann sealed');
  const bytes1 = await sealObject(new TextEncoder().encode('draft two'), { writer: bob, boxId, objectId: 'docs/plan.md', recipients: [] });
  // A fork (naming no parent) is refused; naming the head is accepted.
  code = 0; try { await client.put(await signWrite(bob.privateKey, bob.address, { boxId, objectId: 'docs/plan.md', parent: null, bytes: bytes1 }), bytes1); } catch (e) { code = Number(/sealed-store (\d+)/.exec((e as Error).message)?.[1]); }
  eq(code, 409, 'a second first version is refused');
  await client.put(await signWrite(bob.privateKey, bob.address, { boxId, objectId: 'docs/plan.md', parent: v1.writeId, bytes: bytes1 }), bytes1);
  // An outsider cannot write; tampered bytes are refused.
  code = 0; try { await client.put(await signWrite(eve.privateKey, eve.address, { boxId, objectId: 'x', parent: null, bytes: bytes1 }), bytes1); } catch (e) { code = Number(/sealed-store (\d+)/.exec((e as Error).message)?.[1]); }
  eq(code, 403, 'outsider refused');
  const w3 = await signWrite(ann.privateKey, ann.address, { boxId, objectId: 'y', parent: null, bytes: bytes1 });
  const res = await route(`/agents/sealed-store/boxes/${boxId}/objects`, { method: 'POST', headers: { 'content-length': String(bytes1.length), 'x-cappz-sealed-record': btoa(JSON.stringify(w3)) }, body: bytes1.map((b, i) => (i === 0 ? b ^ 1 : b)) });
  eq(res.status, 422, 'bytes that do not match the record are refused');

  // Purge v1: its bytes go, the record stays; the blob is no longer served.
  await client.purge(await signPurge(ann.privateKey, ann.address, { boxId, writeId: v1.writeId }));
  box = await client.box(boxId);
  state = await replayBox(boxId, box.writers, box.records.map((r) => r.record));
  eq(state.objects.get('docs/plan.md')!.versions.map((v) => [v.version, v.purged]), [[1, true], [2, false]], 'history after purge');
  eq(box.usedBytes, bytes1.length, 'used bytes');
  eq((await route(`/agents/sealed-store/boxes/${boxId}/blobs/${v1.sha256}`)).status, 404, 'purged bytes not served');
  try { await Deno.stat(`${dir}/drive/testnet/boxes/${boxId}/blobs/${v1.sha256}`); throw new Error('purged blob still on disk'); } catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; }
  eq(state.rejected, [], 'nothing rejected');

  // Renewal priced from the box's quota; a renewal of an unknown box is refused.
  eq(await sealed.check({ renews: boxId }), null, 'renewal ok');
  eq((await sealed.agent.openJob({ renews: boxId })).job.terms.price, 0.5, 'renewal priced by current quota');
  eq(typeof await sealed.check({ renews: 'job-0000000000000000' }), 'string', 'unknown box');
  await Deno.remove(dir, { recursive: true });
});
