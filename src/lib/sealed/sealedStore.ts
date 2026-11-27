/**
 * Sealed shared storage (16.5.0) — a group of wallets shares objects only its members can open.
 *
 * Any host (a CAPPZ edge node's `sealed-store` agent, or anything else that keeps the rules) stores
 * and serves ciphertext only. Encryption happens on the writer's machine with the shared wallet
 * envelope (cw2: one data key, wrapped for the writer's wallet and for each recipient's wallet-
 * declared encryption key; hybrid ML-KEM-768 + P-256 when the recipient's key is hybrid). The
 * envelope's context names the writer, the box and the object, so a sealed object moved anywhere
 * else does not open.
 *
 *   Key directory   recipients publish wallet-signed KeyDeclarations (purpose 'encryption'); a
 *                   reader of the directory verifies them itself (evaluateKey): the host is a carrier.
 *   Box             a storage space with a fixed set of writer wallets and a quota, rented in 30-day
 *                   periods. Reading is open (the bytes are ciphertext); writing needs a writer's
 *                   wallet signature over the write record.
 *   Write record    wallet-signed {box, object, parent version, SHA-256 and size of the stored bytes};
 *                   versions form a chain per object (the first names no parent, each later one names
 *                   the head it replaces). The host serializes writes, so an object never forks.
 *   Purge record    wallet-signed: free one version's bytes; the record stays, so history keeps its
 *                   shape (ContentPurged semantics).
 *
 * Group changes are reseals: add or remove a member by sealing a new version for the new group
 * (what a removed member opened before, they may have kept). Everything a reader needs to check
 * the history — signatures, writers, the chain — is in the records; the host's receipts add when.
 *
 * Pure apart from fetch in the client; runs in browsers, Node and Deno.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { signMessage, verifySignature } from '../auth/wallet/session.ts';
import { canonicalJson } from '../identity/canonical.ts';
import { evaluateKey, type KeyDeclaration, type KeyEvidence, type KeyRevocation } from '../identity/keyDeclaration.ts';
import { envelopeRecipients, openSharedEnvelope, sealForRecipients, type EnvelopeRecipient } from '../crypto/walletEnvelope.ts';

export const SEALED_STORE_VERSION = 1;
/** Box ids are the host's job ids; object ids are path-like names (no "..", no leading slash). */
export const OBJECT_ID = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._\/-]{1,200}$/;
export const WALLET = /^0[23][0-9a-f]{64}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
/** A write signed more than this far from the host's clock is refused (a stale record cannot be replayed into a new box state). */
export const WRITE_CLOCK_SKEW_MS = 10 * 60_000;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const sha256Hex = (b: Uint8Array | string): string => hex(sha256(typeof b === 'string' ? new TextEncoder().encode(b) : b));

// ─── Records ─────────────────────────────────────────────────────────────────

export interface SealedWrite {
  v: 1;
  kind: 'write';
  boxId: string;
  objectId: string;
  /** The id of the write record this version replaces (null for the first version). */
  parent: string | null;
  sha256: string;
  size: number;
  writer: string;
  writtenAt: string;
  signature: string;
}

export interface SealedPurge {
  v: 1;
  kind: 'purge';
  boxId: string;
  /** The write record whose bytes are freed. */
  writeId: string;
  writer: string;
  writtenAt: string;
  signature: string;
}

export type SealedRecord = SealedWrite | SealedPurge;

const body = (r: SealedRecord) => { const { signature: _s, ...rest } = r; return rest; };
export const canonicalRecord = (r: Omit<SealedRecord, 'signature'> | SealedRecord): string => canonicalJson('signature' in r ? body(r as SealedRecord) : r);
/** A record's id: the SHA-256 of its signed text and signature. */
export const recordId = (r: SealedRecord): string => sha256Hex(`${canonicalRecord(r)}|${r.signature}`);

export async function signWrite(walletPrivateKey: Uint8Array, writer: string, w: { boxId: string; objectId: string; parent: string | null; bytes: Uint8Array }, now = Date.now()): Promise<SealedWrite> {
  const r: Omit<SealedWrite, 'signature'> = { v: 1, kind: 'write', boxId: w.boxId, objectId: w.objectId, parent: w.parent, sha256: sha256Hex(w.bytes), size: w.bytes.length, writer: writer.toLowerCase(), writtenAt: new Date(now).toISOString() };
  return { ...r, signature: await signMessage(walletPrivateKey, canonicalRecord(r)) };
}

export async function signPurge(walletPrivateKey: Uint8Array, writer: string, p: { boxId: string; writeId: string }, now = Date.now()): Promise<SealedPurge> {
  const r: Omit<SealedPurge, 'signature'> = { v: 1, kind: 'purge', boxId: p.boxId, writeId: p.writeId, writer: writer.toLowerCase(), writtenAt: new Date(now).toISOString() };
  return { ...r, signature: await signMessage(walletPrivateKey, canonicalRecord(r)) };
}

/** Shape and signature of one record (not its place in the box: replayBox checks that). */
export async function recordProblem(r: unknown): Promise<string | null> {
  const x = r as SealedRecord;
  if (!x || x.v !== 1 || (x.kind !== 'write' && x.kind !== 'purge')) return 'not a sealed-store record (v 1, kind write or purge)';
  if (typeof x.boxId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(x.boxId)) return 'boxId is missing or malformed';
  if (typeof x.writer !== 'string' || !WALLET.test(x.writer)) return 'writer must be a wallet address (compressed secp256k1 public key, hex)';
  if (typeof x.writtenAt !== 'string' || !Number.isFinite(Date.parse(x.writtenAt))) return 'writtenAt must be an ISO time';
  if (typeof x.signature !== 'string' || !/^[0-9a-f]{128}$/i.test(x.signature)) return 'signature is missing or malformed';
  if (x.kind === 'write') {
    if (typeof x.objectId !== 'string' || !OBJECT_ID.test(x.objectId)) return 'objectId must be 1-200 characters of A-Z a-z 0-9 . _ / - with no ".." and no leading "/"';
    if (x.parent !== null && (typeof x.parent !== 'string' || !SHA256.test(x.parent))) return 'parent must be null or the id of the version it replaces';
    if (typeof x.sha256 !== 'string' || !SHA256.test(x.sha256)) return 'sha256 must be 64 lowercase hex characters';
    if (!Number.isSafeInteger(x.size) || x.size < 0) return 'size must be a whole number of bytes';
  } else if (typeof x.writeId !== 'string' || !SHA256.test(x.writeId)) return 'writeId must be the id of a write record';
  if (!(await verifySignature(canonicalRecord(x), x.signature, x.writer))) return 'the writer\'s signature does not match the record';
  return null;
}

// ─── Replay (pure apart from signature checks) ───────────────────────────────

export interface ObjectVersion { writeId: string; objectId: string; version: number; sha256: string; size: number; writer: string; writtenAt: string; parent: string | null; purged: boolean }
export interface ObjectHistory { objectId: string; versions: ObjectVersion[]; heads: ObjectVersion[] }
export interface BoxState {
  boxId: string;
  objects: Map<string, ObjectHistory>;
  /** Bytes held now (purged versions excluded). */
  usedBytes: number;
  /** Records that break the box's rules, with why: shown, never applied. */
  rejected: Array<{ id: string; because: string }>;
}

/**
 * Replay a box's records in the order the host accepted them. A record is applied only when its
 * signature verifies, its writer is one of the box's writers, and it fits the history (a parent
 * that exists for the same object, a purge of a write in this box). A host keeps one head per
 * object; a reader still reports more than one if a host ever accepted a fork.
 */
export async function replayBox(boxId: string, writers: readonly string[], records: readonly SealedRecord[]): Promise<BoxState> {
  const allowed = new Set(writers.map((w) => w.toLowerCase()));
  const versions = new Map<string, ObjectVersion>();
  const rejected: BoxState['rejected'] = [];
  for (const r of records) {
    const id = recordId(r);
    const problem = await recordProblem(r);
    if (problem) { rejected.push({ id, because: problem }); continue; }
    if (r.boxId !== boxId) { rejected.push({ id, because: `record for box ${r.boxId}, not ${boxId}` }); continue; }
    if (!allowed.has(r.writer)) { rejected.push({ id, because: 'the writer is not one of the box\'s writers' }); continue; }
    if (r.kind === 'write') {
      if (versions.has(id)) continue; // the same signed record twice is one version
      const parent = r.parent ? versions.get(r.parent) : undefined;
      if (r.parent && (!parent || parent.objectId !== r.objectId)) { rejected.push({ id, because: 'its parent is not a version of this object' }); continue; }
      versions.set(id, { writeId: id, objectId: r.objectId, version: parent ? parent.version + 1 : 1, sha256: r.sha256, size: r.size, writer: r.writer, writtenAt: r.writtenAt, parent: r.parent, purged: false });
    } else {
      const target = versions.get(r.writeId);
      if (!target) { rejected.push({ id, because: 'purges a version this box does not hold' }); continue; }
      target.purged = true;
    }
  }
  const replaced = new Set([...versions.values()].map((v) => v.parent).filter(Boolean) as string[]);
  const objects = new Map<string, ObjectHistory>();
  let usedBytes = 0;
  for (const v of versions.values()) {
    const h = objects.get(v.objectId) ?? { objectId: v.objectId, versions: [], heads: [] };
    h.versions.push(v);
    if (!replaced.has(v.writeId)) h.heads.push(v);
    objects.set(v.objectId, h);
    if (!v.purged) usedBytes += v.size;
  }
  return { boxId, objects, usedBytes, rejected };
}

/** The version a new write of `objectId` must name as its parent (null for a new object). */
export function currentHead(state: BoxState, objectId: string): ObjectVersion | null {
  const h = state.objects.get(objectId);
  return h?.heads.length === 1 ? h.heads[0] : null;
}

// ─── Encryption for a group ──────────────────────────────────────────────────

const contextOf = (writer: string, boxId: string, objectId: string) => `cappz.sealed-store|${writer.toLowerCase()}|${boxId}/${objectId}`;

/** Seal bytes for the writer (owner wrap) and the recipients; returns the bytes to store (a cw2 envelope, UTF-8). */
export async function sealObject(plain: Uint8Array, o: { writer: { address: string; privateKey: Uint8Array; pqSeed?: Uint8Array }; boxId: string; objectId: string; recipients: readonly EnvelopeRecipient[] }): Promise<Uint8Array> {
  const others = o.recipients.filter((r) => r.id.toLowerCase() !== o.writer.address.toLowerCase());
  const env = await sealForRecipients(plain, contextOf(o.writer.address, o.boxId, o.objectId), { ownerPrivateKey: o.writer.privateKey, ownerPqSeed: o.writer.pqSeed, recipients: others });
  return new TextEncoder().encode(env);
}

/** Open stored bytes: as their writer (wallet key) or as a recipient (its encryption private key). Null when not sealed for you. */
export async function openObject(stored: Uint8Array, o: { writer: string; boxId: string; objectId: string } & ({ asWriter: { privateKey: Uint8Array; pqSeed?: Uint8Array } } | { asRecipient: { id: string; encryptionPrivateKey: JsonWebKey } })): Promise<Uint8Array | null> {
  const env = new TextDecoder().decode(stored);
  const context = contextOf(o.writer, o.boxId, o.objectId);
  try {
    if ('asWriter' in o) return await openSharedEnvelope(env, context, { ownerPrivateKey: o.asWriter.privateKey, ownerPqSeed: o.asWriter.pqSeed });
    return await openSharedEnvelope(env, context, { recipientId: o.asRecipient.id, encryptionPrivateKey: o.asRecipient.encryptionPrivateKey });
  } catch {
    return null;
  }
}

/** Who stored bytes are sealed for, besides their writer. */
export const sealedFor = (stored: Uint8Array): string[] => {
  try { return envelopeRecipients(new TextDecoder().decode(stored)).filter((id) => id !== 'owner'); } catch { return []; }
};

/** Does a version need sealing again for this group (someone added or removed)? */
export function needsReseal(sealedForIds: readonly string[], writer: string, group: readonly string[]): boolean {
  const want = new Set(group.map((g) => g.toLowerCase()).filter((g) => g !== writer.toLowerCase()));
  const have = new Set(sealedForIds.map((g) => g.toLowerCase()));
  return want.size !== have.size || [...want].some((g) => !have.has(g));
}

// ─── Key directory ───────────────────────────────────────────────────────────

/** What a directory returns for a wallet: its published declarations and revocations, to verify yourself. */
export interface DirectoryEntry { wallet: string; declarations: KeyDeclaration[]; revocations: KeyRevocation[] }

/**
 * Recipients from directory entries: for each wallet, its newest declaration that evaluates as
 * 'declared' for encryption. Wallets without one are returned in `missing` with the reason.
 */
export async function recipientsFrom(entries: readonly DirectoryEntry[], now = Date.now()): Promise<{ recipients: EnvelopeRecipient[]; missing: Array<{ wallet: string; because: string }> }> {
  const recipients: EnvelopeRecipient[] = [];
  const missing: Array<{ wallet: string; because: string }> = [];
  for (const e of entries) {
    const ev: KeyEvidence = { declarations: e.declarations, revocations: e.revocations };
    let because = 'no encryption key published';
    let found: EnvelopeRecipient | null = null;
    for (const d of [...e.declarations].filter((d) => d.walletAddress?.toLowerCase() === e.wallet.toLowerCase()).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))) {
      const t = await evaluateKey(d.walletAddress, d.publicKey, 'encryption', ev, now);
      if (t.state === 'declared') { found = { id: e.wallet.toLowerCase(), publicKey: d.publicKey.toLowerCase() }; break; }
      because = `${t.state}: ${t.because}`;
    }
    if (found) recipients.push(found); else missing.push({ wallet: e.wallet, because });
  }
  return { recipients, missing };
}

// ─── Client for a host speaking the sealed-store protocol ────────────────────

export interface StoredReceipt { receipt: Record<string, unknown>; writeId: string }
export interface BoxView {
  boxId: string;
  writers: string[];
  quotaBytes: number;
  usedBytes: number;
  state: 'active' | 'grace' | 'purged';
  periodEnd: string;
  records: Array<{ record: SealedRecord; receipt: Record<string, unknown> }>;
}

/**
 * A client for `<base>` = a host's sealed-store URL, e.g. https://node.example/agents/sealed-store.
 * Opening and renewing boxes is a paid job (cappz-market hire); everything here is free.
 */
export function sealedStoreClient(base: string, fetchImpl: typeof fetch = fetch) {
  const url = (p: string) => `${base.replace(/\/+$/, '')}${p}`;
  const ok = async (res: Response) => {
    if (!res.ok) { let why = `${res.status}`; try { const j = await res.json(); why = `${res.status}: ${j.error ?? JSON.stringify(j)}`; } catch { /* body not JSON */ } throw new Error(`sealed-store ${why}`); }
    return res;
  };
  const enc = (o: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return {
    /** Publish your wallet-signed encryption key (declareKey with purpose 'encryption'). */
    publishKey: async (declaration: KeyDeclaration) => (await ok(await fetchImpl(url('/keys'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ declaration }) }))).json(),
    publishRevocation: async (revocation: KeyRevocation) => (await ok(await fetchImpl(url('/keys/revocations'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revocation }) }))).json(),
    lookupKeys: async (wallet: string): Promise<DirectoryEntry> => (await ok(await fetchImpl(url(`/keys/${wallet.toLowerCase()}`)))).json(),
    box: async (boxId: string): Promise<BoxView> => (await ok(await fetchImpl(url(`/boxes/${boxId}`)))).json(),
    /** Store sealed bytes under a signed write record (signWrite over the same bytes). */
    put: async (record: SealedWrite, bytes: Uint8Array): Promise<StoredReceipt> =>
      (await ok(await fetchImpl(url(`/boxes/${record.boxId}/objects`), { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-cappz-sealed-record': enc(record) }, body: bytes as BodyInit }))).json(),
    purge: async (record: SealedPurge): Promise<StoredReceipt> =>
      (await ok(await fetchImpl(url(`/boxes/${record.boxId}/purges`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ record }) }))).json(),
    /** The stored bytes of a version; checked against the record's SHA-256 before they are returned. */
    get: async (boxId: string, version: { sha256: string }): Promise<Uint8Array> => {
      const bytes = new Uint8Array(await (await ok(await fetchImpl(url(`/boxes/${boxId}/blobs/${version.sha256}`)))).arrayBuffer());
      if (sha256Hex(bytes) !== version.sha256) throw new Error('sealed-store: the host returned bytes that do not match the record');
      return bytes;
    },
  };
}
