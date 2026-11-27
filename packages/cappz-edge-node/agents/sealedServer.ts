/**
 * The sealed-store agent's I/O (16.5.0): job wiring, the box and key-directory stores on disk, and its HTTP
 * routes. Rules live in sealed.ts (pure, tested under Node); this file only reads, writes and signs.
 *
 * Storage: CAPPZ_SEALED_STORE_DIR (default <CAPPZ_AGENT_DATA>/sealed-store), one folder per network so the
 * mainnet and testnet instances never share a box. Put it on any drive (e.g. a USB disk, D:\cappz-sealed on Windows);
 * run-agents.ps1 grants the agents read and write there and nowhere else beside their data folder.
 *
 *   <dir>/<network>/boxes/<boxId>/records.jsonl     {record, receipt} per accepted write or purge
 *   <dir>/<network>/boxes/<boxId>/blobs/<sha256>    the stored (sealed) bytes of each live version
 *   <dir>/<network>/boxes/<boxId>/purged.json       the signed SealedBoxPurged record, once the grace has passed
 *   <dir>/<network>/keys/<wallet>.json              published declarations and revocations (key directory)
 */
import { sha256 } from '@noble/hashes/sha2.js';
import {
  createPaidAgent, defineAgentOffer, type JobEvent, type JobStore, type PaidAgent, type XrplNetwork,
} from '../../../src/lib/agentKit/paidAgent.ts';
import { declarationHash, verifyKeyDeclaration, verifyKeyRevocation, type KeyDeclaration, type KeyRevocation } from '../../../src/lib/identity/keyDeclaration.ts';
import { recordId, replayBox, WALLET, WRITE_CLOCK_SKEW_MS, type SealedPurge, type SealedRecord, type SealedWrite } from '../../../src/lib/sealed/sealedStore.ts';
import {
  BOX_ID, GB, boxProblem, isRenewal, purgeProblem, replayBoxes, sealedInputProblem, writeProblem,
  type Box, type SealedInput, type SealedJob, type SealedSettings,
} from './sealed.ts';

const DAY = 86_400_000;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const onlyMissing = (e: unknown): void => { if (!(e instanceof Deno.errors.NotFound)) throw e; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// deno-lint-ignore no-explicit-any
type Signed = any;
type Json = (code: number, body: unknown) => Response;

export interface SealedDeps {
  network: XrplNetwork;
  payTo: string;
  pow: string;
  publicBase: string;
  nodeKeyHex: string;
  /** Folder for the agent's job log (inside CAPPZ_AGENT_DATA). */
  jobDir: string;
  /** Root of the box and key stores (CAPPZ_SEALED_STORE_DIR); the network is appended. */
  storeDir: string;
  pricePerGb: number;
  settings: SealedSettings;
  fileJobStore: (dir: string) => Promise<JobStore>;
  signed: (eventType: string, targetAddress: string, payload: Record<string, unknown>) => Promise<Signed>;
  evidenceFor: (hashes: Iterable<unknown>) => Record<string, unknown>;
  verifyHow: string;
  json: Json;
  cors: Record<string, string>;
}

export async function createSealedStore(d: SealedDeps) {
  const S = d.settings;
  const root = `${d.storeDir.replace(/[\\/]+$/, '')}/${d.network}`;
  await Deno.mkdir(`${root}/boxes`, { recursive: true });
  await Deno.mkdir(`${root}/keys`, { recursive: true });
  const store = await d.fileJobStore(d.jobDir);
  const boxDir = (id: string) => `${root}/boxes/${id}`;

  // One operation at a time per box (and per key-directory wallet): heads and quotas never race.
  const locks = new Map<string, Promise<unknown>>();
  function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    const p = prev.then(fn, fn);
    locks.set(key, p.catch(() => null));
    return p;
  }

  async function jobs(): Promise<SealedJob[]> {
    const events = await store.events();
    const paid = new Map<string, string>();
    const cancelled = new Set<string>();
    for (const e of events) {
      if (e.type === 'StagePaid' && e.stage === 0) paid.set(e.jobId, e.at);
      if (e.type === 'JobCancelled') cancelled.add(e.jobId);
    }
    return events.filter((e): e is Extract<JobEvent, { type: 'JobOpened' }> => e.type === 'JobOpened')
      .map((e) => ({ jobId: e.jobId, input: e.input as SealedInput, openedAt: e.at, paidAt: paid.get(e.jobId) ?? null, cancelled: cancelled.has(e.jobId) }));
  }
  let boxCache = new Map<string, Box>();
  async function boxes() {
    const r = replayBoxes(await jobs(), Date.now(), S);
    boxCache = r.boxes;
    return r;
  }
  async function readRecords(id: string): Promise<Array<{ record: SealedRecord; receipt: Signed }>> {
    try { return (await Deno.readTextFile(`${boxDir(id)}/records.jsonl`)).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)); }
    catch (e) { onlyMissing(e); return []; }
  }
  async function boxState(box: Box) {
    const recs = await readRecords(box.boxId);
    return { recs, state: await replayBox(box.boxId, box.writers, recs.map((r) => r.record)) };
  }
  const usedNow = new Map<string, number>();

  const agent: PaidAgent = createPaidAgent({
    offer: defineAgentOffer({
      name: 'CAPPZ sealed store',
      description: `Storage only your group can open: a box of whole gigabytes for ${S.days} days on CAPPZ edge node ${d.nodeKeyHex.slice(0, 16)}…, written by the wallets you name. You seal each object on your own machine for the wallets that may read it (@cappz/sdk/sealed; post-quantum hybrid when their keys are); the node keeps ciphertext only, checks every write's wallet signature and signs a receipt. ${d.pricePerGb} XRP per GB per ${S.days} days, paid up front; renew to keep the box. Reads and the key directory are free.`,
      payTo: d.payTo, network: d.network, currency: 'XRP', price: d.pricePerGb,
      stages: [
        { label: `Pay: box open for ${S.days} days`, kind: 'upfront', share: 1, deliverable: `${d.publicBase}/sealed-store/boxes/<jobId> accepts signed writes from the box's wallets for ${S.days} days` },
        { label: 'Period ended: signed report', kind: 'completion', share: 0, deliverable: 'A signed report of the period: objects, versions, bytes held and the hash of every record (JSON). Nothing more to pay.' },
      ],
    }),
    store,
    priceFor: (input) => {
      const x = input as SealedInput;
      const gb = isRenewal(x) ? (x.gb ?? Math.max(1, (boxCache.get(x.renews)?.quotaBytes ?? GB) / GB)) : x.gb;
      return Number((d.pricePerGb * gb).toFixed(6));
    },
    // Runs once the period is paid: wait for its end, then sign the period report.
    work: async ({ jobId }) => {
      const { boxes: all, orphans } = await boxes();
      if (orphans.some((o) => o.jobId === jobId)) throw new Error('The box this job renews was past its grace period when the payment arrived, so its bytes were already deleted. Ask the node operator for a refund.');
      const box = [...all.values()].find((b) => b.periods.some((p) => p.jobId === jobId));
      if (!box) throw new Error('The payment is not recorded yet.');
      const p = box.periods.find((x) => x.jobId === jobId)!;
      while (Date.now() < p.end) await sleep(Math.min(DAY, p.end - Date.now()));
      const { recs, state } = await boxState(box);
      const report = await d.signed('SealedPeriodClosed', `${d.pow}/sealed/${box.boxId}`, {
        boxId: box.boxId, jobId, periodStart: new Date(p.start).toISOString(), periodEnd: new Date(p.end).toISOString(), quotaGb: p.gb,
        objects: state.objects.size, versions: [...state.objects.values()].reduce((n, o) => n + o.versions.length, 0), usedBytes: state.usedBytes,
        records: recs.length, recordsSha256: hex(sha256(new TextEncoder().encode(JSON.stringify(recs.map((r) => r.record))))),
      });
      return { report, box: `${d.publicBase}/sealed-store/boxes/${box.boxId}`, ...d.evidenceFor([report.payload.signerDeclaration]), verify: d.verifyHow };
    },
  });

  /** Before a job opens: the box it renews exists and the node has the capacity. */
  async function check(input: unknown): Promise<string | null> {
    const problem = sealedInputProblem(input, S);
    if (problem) return problem;
    const { boxes: all } = await boxes();
    return boxProblem(input as SealedInput, all, await jobs(), Date.now(), S, (id) => usedNow.get(id) ?? 0);
  }

  /** Boxes past their grace lose their bytes; the records and a signed purge record stay. */
  async function purgeExpired(): Promise<void> {
    const { boxes: all } = await boxes();
    for (const box of all.values()) {
      if (box.state === 'active' || box.state === 'grace') { if (!usedNow.has(box.boxId)) usedNow.set(box.boxId, (await boxState(box)).state.usedBytes); continue; }
      if (box.state !== 'expired') continue;
      await serial(box.boxId, async () => {
        try { await Deno.stat(`${boxDir(box.boxId)}/purged.json`); return; } catch (e) { onlyMissing(e); }
        const { state } = await boxState(box);
        try { await Deno.remove(`${boxDir(box.boxId)}/blobs`, { recursive: true }); } catch (e) { onlyMissing(e); }
        await Deno.mkdir(boxDir(box.boxId), { recursive: true });
        const rec = await d.signed('SealedBoxPurged', `${d.pow}/sealed/${box.boxId}`, { boxId: box.boxId, periodEnd: new Date(box.periodEnd!).toISOString(), graceEnd: new Date(box.graceEnd!).toISOString(), freedBytes: state.usedBytes });
        await Deno.writeTextFile(`${boxDir(box.boxId)}/purged.json`, JSON.stringify(rec, null, 2));
        usedNow.delete(box.boxId);
        console.log(`[agents] sealed box ${box.boxId} purged after its grace period (${(state.usedBytes / GB).toFixed(3)} GB freed)`);
      });
    }
  }

  const decodeRecord = (h: string | null): unknown => {
    if (!h) return null;
    try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(h.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((h.length + 3) % 4)), (c) => c.charCodeAt(0)))); } catch { return null; }
  };

  async function put(req: Request, id: string): Promise<Response> {
    const rec = decodeRecord(req.headers.get('x-cappz-sealed-record')) as SealedWrite | null;
    if (!rec) return d.json(422, { error: 'Send the signed write record (signWrite in @cappz/sdk/sealed) as base64url JSON in the x-cappz-sealed-record header, and the sealed bytes as the body.' });
    // Content-Length, when sent, must agree; a streamed body (no length) is checked byte by byte below.
    const lenHeader = req.headers.get('content-length');
    const len = lenHeader === null ? rec.size : Number(lenHeader);
    if (len !== rec.size) return d.json(422, { error: `The record says ${rec.size} bytes; Content-Length is ${lenHeader}.` });
    if (len > S.maxObjectBytes) return d.json(413, { error: `Objects are limited to ${Math.floor(S.maxObjectBytes / 1024 ** 2)} MB: split larger files into parts.` });
    return serial(id, async () => {
      const { boxes: all } = await boxes();
      const box = all.get(id);
      const { recs, state } = box ? await boxState(box) : { recs: [], state: await replayBox(id, [], []) };
      const writeId = recordId(rec);
      const existing = recs.find((r) => recordId(r.record) === writeId);
      if (existing) return d.json(200, { writeId, receipt: existing.receipt, repeated: true });
      const pre = await writeProblem(rec, { length: rec.size, sha256: rec.sha256 }, box, state, Date.now(), S, WRITE_CLOCK_SKEW_MS);
      if (pre) return d.json(pre.code, { error: pre.error });
      await Deno.mkdir(`${boxDir(id)}/blobs`, { recursive: true });
      const tmp = `${boxDir(id)}/blobs/.upload-${crypto.randomUUID()}`;
      const f = await Deno.open(tmp, { write: true, create: true, truncate: true });
      const h = sha256.create();
      let n = 0;
      try {
        if (req.body) for await (const chunk of req.body) {
          n += chunk.length;
          if (n > rec.size) break;
          h.update(chunk);
          for (let o = 0; o < chunk.length;) o += await f.write(chunk.subarray(o));
        }
      } finally { f.close(); }
      const got = hex(h.digest());
      if (n !== rec.size || got !== rec.sha256) { await Deno.remove(tmp).catch(() => {}); return d.json(422, { error: n !== rec.size ? `${n} bytes arrived; the record says ${rec.size}.` : 'The bytes do not match the record\'s SHA-256.' }); }
      const blob = `${boxDir(id)}/blobs/${got}`;
      try { await Deno.stat(blob); await Deno.remove(tmp); } catch (e) { onlyMissing(e); await Deno.rename(tmp, blob); }
      const receipt = await d.signed('SealedObjectStored', `${d.pow}/sealed/${id}/${rec.objectId}`, { boxId: id, writeId, objectId: rec.objectId, parent: rec.parent, sha256: rec.sha256, size: rec.size, writer: rec.writer });
      await Deno.writeTextFile(`${boxDir(id)}/records.jsonl`, JSON.stringify({ record: rec, receipt }) + '\n', { append: true });
      usedNow.set(id, state.usedBytes + rec.size);
      return d.json(200, { writeId, receipt, ...d.evidenceFor([receipt.payload.signerDeclaration]) });
    });
  }

  async function purge(req: Request, id: string): Promise<Response> {
    const b = await req.json().catch(() => null) as { record?: SealedPurge } | null;
    const rec = b?.record;
    return serial(id, async () => {
      const { boxes: all } = await boxes();
      const box = all.get(id);
      const { state } = box ? await boxState(box) : { state: await replayBox(id, [], []) };
      const pre = await purgeProblem(rec, box, state, Date.now(), WRITE_CLOCK_SKEW_MS);
      if (pre) return d.json(pre.code, { error: pre.error });
      const target = [...state.objects.values()].flatMap((o) => o.versions).find((v) => v.writeId === rec!.writeId)!;
      // Bytes shared by another live version (the same sealed bytes written twice) stay.
      const stillUsed = [...state.objects.values()].flatMap((o) => o.versions).some((v) => !v.purged && v.writeId !== target.writeId && v.sha256 === target.sha256);
      if (!stillUsed) { try { await Deno.remove(`${boxDir(id)}/blobs/${target.sha256}`); } catch (e) { onlyMissing(e); } }
      const purgeId = recordId(rec!);
      const receipt = await d.signed('SealedVersionPurged', `${d.pow}/sealed/${id}/${target.objectId}`, { boxId: id, purgeId, writeId: target.writeId, objectId: target.objectId, freedBytes: stillUsed ? 0 : target.size, writer: rec!.writer });
      await Deno.writeTextFile(`${boxDir(id)}/records.jsonl`, JSON.stringify({ record: rec, receipt }) + '\n', { append: true });
      usedNow.set(id, state.usedBytes - target.size);
      return d.json(200, { purgeId, receipt, ...d.evidenceFor([receipt.payload.signerDeclaration]) });
    });
  }

  async function blob(id: string, sha: string): Promise<Response> {
    const { boxes: all } = await boxes();
    const box = all.get(id);
    if (!box || box.state === 'unpaid') return d.json(404, { error: 'No box with that id on this node.' });
    if (box.state === 'expired') return d.json(410, { error: 'This box is past its grace period; its bytes are deleted.' });
    const { state } = await boxState(box);
    if (![...state.objects.values()].some((o) => o.versions.some((v) => v.sha256 === sha && !v.purged))) return d.json(404, { error: 'No live version of this box has those bytes (never written, or purged).' });
    try {
      const f = await Deno.open(`${boxDir(id)}/blobs/${sha}`, { read: true });
      const size = (await f.stat()).size;
      return new Response(f.readable, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(size), 'x-sha256': sha, 'cache-control': 'public, max-age=31536000, immutable', ...d.cors } });
    } catch (e) { onlyMissing(e); return d.json(404, { error: 'Not stored here.' }); }
  }

  async function boxView(id: string): Promise<Response> {
    const { boxes: all } = await boxes();
    const box = all.get(id);
    if (!box) return d.json(404, { error: 'No box with that id on this node.' });
    const { recs, state } = await boxState(box);
    let purged: Signed = null;
    try { purged = JSON.parse(await Deno.readTextFile(`${boxDir(id)}/purged.json`)); } catch (e) { onlyMissing(e); }
    return d.json(200, {
      boxId: id, writers: box.writers, label: box.label, quotaBytes: box.quotaBytes, usedBytes: state.usedBytes,
      state: purged ? 'purged' : box.state, periodEnd: box.periodEnd ? new Date(box.periodEnd).toISOString() : null,
      graceEnd: box.graceEnd ? new Date(box.graceEnd).toISOString() : null, periods: box.periods.map((p) => ({ jobId: p.jobId, start: new Date(p.start).toISOString(), end: new Date(p.end).toISOString(), gb: p.gb })),
      records: recs, ...(purged ? { purgedRecord: purged } : {}), network: d.network,
    });
  }

  // ── Key directory (free): the node carries wallet-signed declarations; readers verify them themselves ──
  const keyFile = (w: string) => `${root}/keys/${w}.json`;
  async function readKeys(w: string): Promise<{ wallet: string; declarations: KeyDeclaration[]; revocations: KeyRevocation[] }> {
    try { return JSON.parse(await Deno.readTextFile(keyFile(w))); } catch (e) { onlyMissing(e); return { wallet: w, declarations: [], revocations: [] }; }
  }
  async function publishKey(req: Request): Promise<Response> {
    if (Number(req.headers.get('content-length') ?? 0) > 32 * 1024) return d.json(413, { error: 'A declaration is a few KB at most.' });
    const b = await req.json().catch(() => null) as { declaration?: KeyDeclaration } | null;
    const decl = b?.declaration;
    if (!decl || decl.v !== 2 || decl.purpose !== 'encryption' || typeof decl.walletAddress !== 'string' || !WALLET.test(decl.walletAddress.toLowerCase())) return d.json(422, { error: 'Send {"declaration": <a v2 KeyDeclaration with purpose "encryption" for a wallet address>} (declareKey + walletEncryptionKey in @cappz/sdk/sealed).' });
    const check = await verifyKeyDeclaration(decl);
    if (check !== 'valid') return d.json(422, { error: `The declaration is ${check}.` });
    const w = decl.walletAddress.toLowerCase();
    return serial(`keys:${w}`, async () => {
      const cur = await readKeys(w);
      const hash = await declarationHash(decl);
      const hashes = await Promise.all(cur.declarations.map((x) => declarationHash(x)));
      if (!hashes.includes(hash)) {
        const live = cur.declarations.filter((x) => Date.parse(x.expiresAt) > Date.now());
        cur.declarations = [...live, decl].sort((a, c) => a.issuedAt.localeCompare(c.issuedAt)).slice(-20);
        await Deno.writeTextFile(keyFile(w), JSON.stringify(cur, null, 2));
      }
      return d.json(200, { wallet: w, declarationHash: hash, declarations: cur.declarations.length });
    });
  }
  async function publishRevocation(req: Request): Promise<Response> {
    if (Number(req.headers.get('content-length') ?? 0) > 16 * 1024) return d.json(413, { error: 'A revocation is under 1 KB.' });
    const b = await req.json().catch(() => null) as { revocation?: KeyRevocation } | null;
    const r = b?.revocation;
    if (!r || typeof r.walletAddress !== 'string' || !WALLET.test(r.walletAddress.toLowerCase())) return d.json(422, { error: 'Send {"revocation": <a KeyRevocation signed by the wallet>}.' });
    const check = await verifyKeyRevocation(r);
    if (check !== 'valid') return d.json(422, { error: `The revocation is ${check}.` });
    const w = r.walletAddress.toLowerCase();
    return serial(`keys:${w}`, async () => {
      const cur = await readKeys(w);
      if (!cur.revocations.some((x) => x.signature === r.signature)) {
        cur.revocations = [...cur.revocations, r].slice(-50);
        await Deno.writeTextFile(keyFile(w), JSON.stringify(cur, null, 2));
      }
      return d.json(200, { wallet: w, revocations: cur.revocations.length });
    });
  }

  const ROUTE = /^\/agents\/sealed-store\/(keys|boxes)(?:\/([A-Za-z0-9-]+))?(?:\/(objects|purges|blobs)(?:\/([0-9a-f]{64}))?)?\/?$/;
  /** Routes below /agents/sealed-store other than the paid-agent protocol; null when the path is not one. */
  async function route(req: Request, url: URL): Promise<Response | null> {
    const m = ROUTE.exec(url.pathname);
    if (!m) return null;
    const [, area, id, sub, sha] = m;
    if (area === 'keys') {
      if (req.method === 'POST' && !id) return publishKey(req);
      if (req.method === 'POST' && id === 'revocations') return publishRevocation(req);
      if (req.method === 'GET' && id && WALLET.test(id.toLowerCase()) && !sub) return d.json(200, await readKeys(id.toLowerCase()));
      return d.json(404, { error: 'Key directory: POST /keys {declaration}, POST /keys/revocations {revocation}, GET /keys/<wallet address>.' });
    }
    if (!id || !BOX_ID.test(id)) return d.json(404, { error: 'Boxes are addressed by the job id that opened them (job-<16 hex>).' });
    if (req.method === 'GET' && !sub) return boxView(id);
    if (req.method === 'POST' && sub === 'objects' && !sha) return put(req, id);
    if (req.method === 'POST' && sub === 'purges' && !sha) return purge(req, id);
    if (req.method === 'GET' && sub === 'blobs' && sha) return blob(id, sha);
    return d.json(405, { error: 'Method not allowed.' });
  }

  console.log(`[agents] sealed store: ${root} — sells up to ${S.maxGb} GB, ${d.pricePerGb} XRP per GB per ${S.days} days, objects up to ${Math.floor(S.maxObjectBytes / 1024 ** 2)} MB`);
  return { agent, check, route, purgeExpired, root };
}
