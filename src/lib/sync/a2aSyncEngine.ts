/**
 * COPE node crystallized.
 * Node ID: v12-21-00-a2a-sync-engine
 * Provenance: m/44'/144'/100'/principles/cope/v1
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Executes src/bpmn/substrate/a2a-sync.bpmn — wallet copies sync with each
 * other with no TLS and no second persisted copy of the data.
 *
 *   ProposeSyncBlock      DataSyncRequested → requester's own admin in-queue
 *                         (nonce, expiry, visited set, SALTED address hashes)
 *   A2ASend               SyncSessionOpened in the session wallet (manifest
 *                         hash + public keys only; plaintext manifest travels
 *                         sealed over the channel)
 *   Canonicalize          fork check along prevEvent links (escrow canonical)
 *   AnchorToXRPL          SyncHeadersBatched — header Merkle root rides the
 *                         next ChainletBatchAnchored stamp (no memo per event)
 *   A2APushToSubscribers  SyncItemOffered | SyncItemRejected (access check)
 *   ApplyRemoteBlocks     SyncItemDelivered after chunk + content hash verify
 *   RefreshCache          SyncSessionClosed
 *
 * Transport order: direct peer → in-memory relay → encrypted
 * store-and-forward (shredded with SyncBlobShredded once delivered).
 * State comes from replaying these events — no status flags (AP-12).
 */

import {
  A2A_SYNC_GOVERNING_PRINCIPLE,
  adminInQueueAddress,
  sessionWalletAddress,
  type A2ASyncEvent,
  type A2ASyncEventType,
  type LifecycleHeader,
  type MissingItem,
} from './a2aSyncEvents';
import { resolveMissingState, type SyncFork } from './missingStateResolver';
import {
  b64ToBytes,
  bytesToB64,
  generateChannelKeyPair,
  openSecureChannel,
  sha256Hex,
  toHex,
  type ChannelKeyPair,
  type SealedFrame,
} from './a2aSecureChannel';
import type { SyncTransport, TransportKind } from './syncTransport';
export type { SyncTransport, TransportKind } from './syncTransport';

// ─── Ports ────────────────────────────────────────────────────

export interface SyncEventLedger {
  append(event: A2ASyncEvent): Promise<void>;
  /** All-or-nothing batch (correlated records that must land together). */
  appendMany?(events: A2ASyncEvent[]): Promise<void>;
  list(): Promise<A2ASyncEvent[]>;
}

export interface SyncCopy {
  copyId: string;
  walletAddress: string;
  /** 'escrow' copies are canonical on a fork; 'edge' copies only propose. */
  role: 'escrow' | 'edge';
  listHeaders(): Promise<LifecycleHeader[]>;
  localTxIds(): Promise<Set<string>>;
  readPayload(txId: string): Promise<Uint8Array | null>;
  writePayload(item: MissingItem, bytes: Uint8Array): Promise<void>;
  /** v12-21-01 — verified parts from an interrupted transfer (index → bytes). */
  readPartialChunks?(txId: string): Promise<Array<Uint8Array | undefined>>;
  writePartialChunk?(txId: string, index: number, bytes: Uint8Array): Promise<void>;
  clearPartialChunks?(txId: string): Promise<void>;
  refresh?(): Promise<void>;
  /** In-memory channel key derived from the wallet key (never stored). */
  channelKey?: ChannelKeyPair;
}

export interface BlobStore {
  put(key: string, value: string, ttlMs: number): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}


// ─── Transports ───────────────────────────────────────────────

export function directTransport(isReachable: () => boolean = () => true): SyncTransport {
  return { kind: 'direct', available: isReachable, carry: async (frame) => ({ frame }) };
}

/** Forwards ciphertext in memory. Keeps a byte counter — never the frame. */
export function relayTransport(isReachable: () => boolean = () => true) {
  let bytesForwarded = 0;
  const t: SyncTransport & { bytesForwarded: () => number } = {
    kind: 'relay',
    available: isReachable,
    carry: async (frame) => {
      bytesForwarded += frame.ct.length;
      return { frame: { ...frame } };
    },
    bytesForwarded: () => bytesForwarded,
  };
  return t;
}

/** Source offline: frame parked encrypted to the receiver, TTL-bound, shredded on delivery. */
export function storeForwardTransport(store: BlobStore, ttlMs = 24 * 3600_000): SyncTransport {
  return {
    kind: 'store-forward',
    available: () => true,
    carry: async (frame) => {
      const body = JSON.stringify(frame);
      const blobKey = `cappz:a2a/blob/${await sha256Hex(body)}`;
      await store.put(blobKey, body, ttlMs);
      const back = await store.get(blobKey);
      if (!back) throw new Error('store-forward blob expired before pickup');
      return { frame: JSON.parse(back) as SealedFrame, blobKey };
    },
    release: (blobKey) => store.delete(blobKey),
  };
}

export function selectTransport(transports: SyncTransport[]): SyncTransport {
  const t = transports.find((x) => x.available());
  if (!t) throw new Error('no transport available');
  return t;
}

// ─── Helpers ──────────────────────────────────────────────────

const CHUNK_BYTES = 16 * 1024;
const REQUEST_TTL_MS = 5 * 60_000;

let seq = 0;
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function saltedAddressHash(salt: string, address: string): Promise<string> {
  return (await sha256Hex(`${salt}:${address}`)).slice(0, 32);
}

async function headerRoot(items: MissingItem[]): Promise<string> {
  let level = await Promise.all(items.map((i) => sha256Hex(`${i.address}|${i.txId}|${i.contentHash}`)));
  if (level.length === 0) return await sha256Hex('');
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(await sha256Hex(level[i] + (level[i + 1] ?? level[i])));
    level = next;
  }
  return level[0];
}

// ─── Engine ───────────────────────────────────────────────────

export interface SyncRequest {
  requestId: string;
  nonce: string;
  expiresAt: number;
  visited: string[];
  salt: string;
  missing: MissingItem[];
}

export interface SyncSessionResult {
  sessionId: string | null;
  transport: TransportKind | null;
  delivered: string[];
  rejected: Array<{ txId: string; reason: string }>;
  forks: SyncFork[];
  refused?: string;
  /** v12-21-09 — session stopped cleanly between verified chunks. */
  paused?: boolean;
  /** v12-21-09 — per-item High-QoS checksum receipts. */
  receipts?: SyncChecksumReceipt[];
}

/** v12-21-09 — hash-print receipt for one delivered item. */
export interface SyncChecksumReceipt {
  txId: string;
  contentHash: string;
  chunkRoot: string;
  chunkCount: number;
  resumeFrom: number;
  byteCount: number;
  requester: string;
  source: string;
  requesterPublicKey: string;
  sourcePublicKey: string;
}

export type SyncSessionControlState = 'running' | 'paused' | 'restart';

/** Merkle-style root over ordered chunk hashes. */
export async function chunkHashRoot(hashes: string[]): Promise<string> {
  if (hashes.length === 0) return sha256Hex('');
  let level = hashes.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(await sha256Hex(level[i] + (level[i + 1] ?? level[i])));
    level = next;
  }
  return level[0];
}

export interface A2ASyncEngineOptions {
  ledger: SyncEventLedger;
  transports: SyncTransport[];
  deprecatedAddresses?: ReadonlySet<string>;
  now?: () => number;
}

export class A2ASyncEngine {
  private usedNonces = new Set<string>();
  /** Cooperative pause/restart control, checked between chunks. */
  private control = new Map<string, { state: SyncSessionControlState; corr: string; requester: SyncCopy; txIds: string[] }>();

  activeSessionIds(): string[] {
    return [...this.control.keys()];
  }

  private sessionEntry(sessionId: string) {
    const c = this.control.get(sessionId);
    if (!c) throw new Error(`No active sync session ${sessionId}`);
    return c;
  }

  /** Pause — the session stops after the current verified chunk; partials are held. */
  async pauseSession(sessionId: string, reason = 'operator'): Promise<void> {
    const c = this.sessionEntry(sessionId);
    c.state = 'paused';
    await this.emit('SyncSessionPaused', sessionWalletAddress(sessionId), c.corr, { reason }, ['PauseSession'], sessionId);
  }

  /** Resume — opens a continuation session that skips already verified chunks. */
  async resumeSession(sessionId: string, requester: SyncCopy, source: SyncCopy): Promise<SyncSessionResult> {
    const c = this.control.get(sessionId);
    const corr = c?.corr ?? sessionId;
    await this.emit('SyncSessionResumed', sessionWalletAddress(sessionId), corr, {}, ['ResumeSession'], sessionId);
    this.control.delete(sessionId);
    return this.runSyncSession(requester, source, undefined, { resumeOf: sessionId });
  }

  /** Restart — discards verified partial chunks; the next run starts at chunk 0. */
  async restartSession(sessionId: string): Promise<void> {
    const c = this.sessionEntry(sessionId);
    c.state = 'restart';
    for (const t of c.txIds) await c.requester.clearPartialChunks?.(t);
    await this.emit('SyncSessionRestarted', sessionWalletAddress(sessionId), c.corr, { clearedItems: c.txIds.length }, ['RestartSession'], sessionId);
  }
  constructor(private readonly opts: A2ASyncEngineOptions) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private async emit(
    eventType: A2ASyncEventType,
    address: string,
    correlationId: string,
    data: Record<string, unknown>,
    bpmnSteps: string[],
    sessionId?: string,
  ): Promise<A2ASyncEvent> {
    const ev: A2ASyncEvent = {
      txId: newId('tx'),
      eventType,
      address,
      sessionId,
      correlationId,
      governingPrinciple: A2A_SYNC_GOVERNING_PRINCIPLE,
      bpmnSteps,
      timestamp: new Date(this.now()).toISOString(),
      data,
    };
    await this.opts.ledger.append(ev);
    return ev;
  }

  /** ProposeSyncBlock — requester posts DataSyncRequested to its own admin in-queue. */
  async requestDataSync(requester: SyncCopy, visited: string[] = [], onlyTxIds?: ReadonlySet<string>): Promise<SyncRequest> {
    const report = resolveMissingState(await requester.listHeaders(), await requester.localTxIds());
    if (onlyTxIds) report.missing = report.missing.filter((m) => onlyTxIds.has(m.txId));
    const req: SyncRequest = {
      requestId: newId('req'),
      nonce: newId('n'),
      expiresAt: this.now() + REQUEST_TTL_MS,
      visited: [...visited, requester.copyId],
      salt: newId('salt'),
      missing: report.missing,
    };
    const addressHashes = await Promise.all(
      [...new Set(req.missing.map((m) => m.address))].map((a) => saltedAddressHash(req.salt, a)),
    );
    await this.emit(
      'DataSyncRequested',
      adminInQueueAddress(requester.walletAddress),
      req.requestId,
      {
        nonce: req.nonce,
        expiresAt: req.expiresAt,
        visited: req.visited,
        txIds: req.missing.map((m) => m.txId),
        addressHashes,
        missingCount: req.missing.length,
        forkCount: report.forks.length,
      },
      ['LocalWriteObserved', 'ProposeSyncBlock'],
    );
    return req;
  }

  /** Full session: requester pulls what it lacks from source. */
  async runSyncSession(requester: SyncCopy, source: SyncCopy, request?: SyncRequest, opts: { resumeOf?: string } = {}): Promise<SyncSessionResult> {
    const req = request ?? (await this.requestDataSync(requester));
    const empty: SyncSessionResult = { sessionId: null, transport: null, delivered: [], rejected: [], forks: [] };

    // Freshness / replay / loop / rotation guards.
    const refuse = async (reason: string) => {
      await this.emit('SyncItemRejected', adminInQueueAddress(requester.walletAddress), req.requestId, { reason, requestId: req.requestId }, ['A2APushToSubscribers']);
      return { ...empty, refused: reason };
    };
    if (this.now() > req.expiresAt) return refuse('request-expired');
    if (this.usedNonces.has(req.nonce)) return refuse('nonce-replayed');
    if (req.visited.includes(source.copyId)) return refuse('fan-out-loop');
    if (this.opts.deprecatedAddresses?.has(requester.walletAddress)) return refuse('requester-address-deprecated');
    this.usedNonces.add(req.nonce);

    const transport = selectTransport(this.opts.transports);
    const sessionId = newId('ses');
    const sessionAddr = sessionWalletAddress(sessionId);
    const corr = req.requestId;
    const reqKey = requester.channelKey ?? generateChannelKeyPair();
    const srcKey = source.channelKey ?? generateChannelKeyPair();
    const srcChannel = await openSecureChannel({ sessionId, mine: srcKey, peerPublicKey: reqKey.publicKey });
    const reqChannel = await openSecureChannel({ sessionId, mine: reqKey, peerPublicKey: srcKey.publicKey });

    // A2ASend — session wallet gets hashes + public keys only.
    const manifestHash = await sha256Hex(JSON.stringify(req.missing));
    await this.emit(
      'SyncSessionOpened',
      sessionAddr,
      corr,
      {
        requester: requester.copyId,
        source: source.copyId,
        requesterPublicKey: toHex(reqKey.publicKey),
        sourcePublicKey: toHex(srcKey.publicKey),
        manifestHash,
        itemCount: req.missing.length,
        transport: transport.kind,
        ...(opts.resumeOf ? { resumeOf: opts.resumeOf } : {}),
      },
      ['A2ASend'],
      sessionId,
    );
    // Plaintext manifest crosses sealed.
    const manifestFrame = await transport.carry(await reqChannel.seal({ manifest: req.missing }));
    const { manifest } = await srcChannel.open<{ manifest: MissingItem[] }>(manifestFrame.frame);
    if (manifestFrame.blobKey) await transport.release?.(manifestFrame.blobKey);

    // Canonicalize — forks at requested addresses on the source chain.
    const srcHeaders = await source.listHeaders();
    const srcReport = resolveMissingState(srcHeaders, new Set());
    const requestedAddrs = new Set(manifest.map((m) => m.address));
    const forks = srcReport.forks.filter((f) => requestedAddrs.has(f.address));
    const forkedTx = new Set<string>();
    for (const f of forks) {
      await this.emit('SyncForkDetected', sessionAddr, corr, { addressHash: await saltedAddressHash(req.salt, f.address), prevTxId: f.prevTxId, branchTxIds: f.branchTxIds, canonical: source.role === 'escrow' ? 'source' : 'unresolved' }, ['Canonicalize'], sessionId);
      if (source.role !== 'escrow') f.branchTxIds.forEach((t) => forkedTx.add(t));
    }

    // AnchorToXRPL — batch header root rides the next Merkle stamp.
    await this.emit('SyncHeadersBatched', sessionAddr, corr, { headerRoot: await headerRoot(manifest), count: manifest.length, forkCount: forks.length, stamp: 'next ChainletBatchAnchored' }, ['Canonicalize', 'AnchorToXRPL'], sessionId);

    const ctl = { state: 'running' as SyncSessionControlState, corr, requester, txIds: manifest.map((m) => m.txId) };
    this.control.set(sessionId, ctl);
    const receipts: SyncChecksumReceipt[] = [];
    const reqPub = toHex(reqKey.publicKey);
    const srcPub = toHex(srcKey.publicKey);
    const srcByTx = new Map(srcHeaders.map((h) => [h.txId, h]));
    const delivered: string[] = [];
    const rejected: Array<{ txId: string; reason: string }> = [];

    for (const item of manifest) {
      if (ctl.state !== 'running') break;
      const header = srcByTx.get(item.txId);
      const reject = async (reason: string) => {
        rejected.push({ txId: item.txId, reason });
        await this.emit('SyncItemRejected', sessionAddr, corr, { txId: item.txId, reason }, ['A2APushToSubscribers'], sessionId);
      };
      if (!header) { await reject('not-held-by-source'); continue; }
      if (header.visibility === 'private') { await reject('private-never-offered'); continue; }
      if (forkedTx.has(item.txId)) { await reject('fork-unresolved'); continue; }
      const bytes = await source.readPayload(item.txId);
      if (!bytes) { await reject('payload-absent'); continue; }

      const chunkCount = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
      // v12-21-01 — resume: parts the requester already verified are not re-sent.
      const held = (await requester.readPartialChunks?.(item.txId)) ?? [];
      const resumeFrom = held.filter(Boolean).length;
      await this.emit('SyncItemOffered', sessionAddr, corr, { txId: item.txId, contentHash: item.contentHash, chunkCount, resumeFrom }, ['A2APushToSubscribers'], sessionId);

      const parts: Uint8Array[] = [];
      let ok = true;
      let stopped = false;
      for (let i = 0; i < chunkCount; i += 1) {
        if (ctl.state !== 'running') { stopped = true; break; }
        if (held[i]) { parts.push(held[i]!); continue; }
        const chunk = bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
        const sealed = await srcChannel.seal({ txId: item.txId, index: i, hash: await sha256Hex(chunk), data: bytesToB64(chunk) });
        const arrived = await transport.carry(sealed);
        const opened = await reqChannel.open<{ txId: string; index: number; hash: string; data: string }>(arrived.frame);
        const got = b64ToBytes(opened.data);
        const partOk = (await sha256Hex(got)) === opened.hash;
        if (ctl.state !== 'running') { stopped = true; break; }
        if (!partOk) ok = false;
        else await requester.writePartialChunk?.(item.txId, i, got);
        parts.push(got);
        if (arrived.blobKey) {
          await transport.release?.(arrived.blobKey);
          await this.emit('SyncBlobShredded', sessionAddr, corr, { txId: item.txId, chunk: i, blobKeyHash: (await sha256Hex(arrived.blobKey)).slice(0, 16) }, ['ApplyRemoteBlocks'], sessionId);
        }
      }
      if (stopped) break;
      const whole = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let off = 0;
      for (const p of parts) { whole.set(p, off); off += p.length; }
      if (!ok || (await sha256Hex(whole)) !== item.contentHash) {
        await requester.clearPartialChunks?.(item.txId);
        await reject('hash-mismatch');
        continue;
      }

      await requester.writePayload(item, whole);
      await requester.clearPartialChunks?.(item.txId);
      delivered.push(item.txId);
      await this.emit('SyncItemDelivered', sessionAddr, corr, { txId: item.txId, contentHash: item.contentHash, chunkCount, resumeFrom }, ['ApplyRemoteBlocks'], sessionId);
      // v12-21-09 — High-QoS checksum delivery: hash-print receipt per item.
      const chunkHashes = await Promise.all(parts.map((p) => sha256Hex(p)));
      const receipt: SyncChecksumReceipt = {
        txId: item.txId, contentHash: item.contentHash, chunkRoot: await chunkHashRoot(chunkHashes),
        chunkCount, resumeFrom, byteCount: whole.length,
        requester: requester.copyId, source: source.copyId, requesterPublicKey: reqPub, sourcePublicKey: srcPub,
      };
      receipts.push(receipt);
      await this.emit('SyncChecksumReceiptIssued', sessionAddr, corr, { ...receipt }, ['VerifyChecksum', 'IssueChecksumReceipt'], sessionId);
    }

    if (ctl.state !== 'running') {
      // Paused or restarted: leave the session open; no close event.
      return { sessionId, transport: transport.kind, delivered, rejected, forks, paused: ctl.state === 'paused', receipts };
    }
    this.control.delete(sessionId);
    const receiptRoot = await chunkHashRoot(await Promise.all(receipts.map((x) => sha256Hex(x.contentHash + x.chunkRoot))));

    await requester.refresh?.();
    await this.emit('SyncSessionClosed', sessionAddr, corr, { delivered: delivered.length, rejected: rejected.length, transport: transport.kind, receiptRoot, receipts: receipts.length }, ['RefreshCache'], sessionId);

    return { sessionId, transport: transport.kind, delivered, rejected, forks, receipts };
  }
}

// ─── Replay ───────────────────────────────────────────────────

export const A2A_SYNC_STEPS = [
  'ProposeSyncBlock', 'A2ASend', 'Canonicalize', 'AnchorToXRPL',
  'A2APushToSubscribers', 'ApplyRemoteBlocks', 'VerifyChecksum', 'IssueChecksumReceipt', 'RefreshCache',
] as const;

export interface SyncSessionView {
  sessionId: string;
  correlationId: string;
  requester?: string;
  source?: string;
  transport?: string;
  delivered: number;
  rejected: Array<{ txId: string; reason: string }>;
  forks: number;
  shredded: number;
  closed: boolean;
  /** v12-21-09 — latest-wins control status. */
  status: 'open' | 'paused' | 'restarting' | 'resumed' | 'closed';
  resumeOf?: string;
  receipts: SyncChecksumReceipt[];
  receiptRoot?: string;
  /** Steps with no evidencing event — drift. */
  drift: string[];
}

const CONTROL_EVENTS = new Set(['SyncSessionPaused', 'SyncSessionResumed', 'SyncSessionRestarted', 'SyncSessionClosed']);

/** Latest-wins session status from control events (no boolean flags). */
export function deriveSessionStatus(evs: A2ASyncEvent[]): SyncSessionView['status'] {
  const last = evs.filter((e) => CONTROL_EVENTS.has(e.eventType)).sort((a, b) => a.timestamp.localeCompare(b.timestamp)).at(-1);
  switch (last?.eventType) {
    case 'SyncSessionClosed': return 'closed';
    case 'SyncSessionPaused': return 'paused';
    case 'SyncSessionRestarted': return 'restarting';
    case 'SyncSessionResumed': return 'resumed'; // continued in a resumeOf session
    default: return 'open';
  }
}

/** Rebuild every session from the ledger. */
export function replaySyncSessions(events: A2ASyncEvent[]): SyncSessionView[] {
  const byCorr = new Map<string, A2ASyncEvent[]>();
  for (const e of events) {
    const list = byCorr.get(e.correlationId) ?? [];
    list.push(e);
    byCorr.set(e.correlationId, list);
  }
  const out: SyncSessionView[] = [];
  for (const [corr, evs] of byCorr) {
    const opened = evs.find((e) => e.eventType === 'SyncSessionOpened');
    if (!opened) continue;
    const steps = new Set(evs.flatMap((e) => e.bpmnSteps ?? []));
    out.push({
      sessionId: opened.sessionId!,
      correlationId: corr,
      requester: opened.data.requester as string,
      source: opened.data.source as string,
      transport: opened.data.transport as string,
      delivered: evs.filter((e) => e.eventType === 'SyncItemDelivered').length,
      rejected: evs.filter((e) => e.eventType === 'SyncItemRejected' && e.sessionId).map((e) => ({ txId: String(e.data.txId), reason: String(e.data.reason) })),
      forks: evs.filter((e) => e.eventType === 'SyncForkDetected').length,
      shredded: evs.filter((e) => e.eventType === 'SyncBlobShredded').length,
      closed: evs.some((e) => e.eventType === 'SyncSessionClosed' && e.sessionId === opened.sessionId),
      status: deriveSessionStatus(evs.filter((e) => e.sessionId === opened.sessionId)),
      resumeOf: opened.data.resumeOf as string | undefined,
      receipts: evs.filter((e) => e.eventType === 'SyncChecksumReceiptIssued' && e.sessionId === opened.sessionId).map((e) => e.data as unknown as SyncChecksumReceipt),
      receiptRoot: evs.find((e) => e.eventType === 'SyncSessionClosed' && e.sessionId === opened.sessionId)?.data.receiptRoot as string | undefined,
      drift: A2A_SYNC_STEPS.filter((s) => !steps.has(s)),
    });
  }
  return out.sort((a, b) => b.sessionId.localeCompare(a.sessionId));
}

// ─── In-memory adapters (tests + self-check) ──────────────────

export function inMemoryLedger(): SyncEventLedger & { events: A2ASyncEvent[] } {
  const events: A2ASyncEvent[] = [];
  return { events, append: async (e) => { events.push(e); }, list: async () => events.slice() };
}

export function inMemoryBlobStore(): BlobStore & { size: () => number } {
  const m = new Map<string, { v: string; exp: number }>();
  return {
    put: async (k, v, ttl) => { m.set(k, { v, exp: Date.now() + ttl }); },
    get: async (k) => { const e = m.get(k); if (!e || e.exp < Date.now()) return null; return e.v; },
    delete: async (k) => { m.delete(k); },
    size: () => m.size,
  };
}

export function inMemoryCopy(
  copyId: string,
  walletAddress: string,
  role: 'escrow' | 'edge',
  headers: LifecycleHeader[],
  payloads: Record<string, Uint8Array>,
): SyncCopy & { payloads: Map<string, Uint8Array> } {
  const store = new Map(Object.entries(payloads));
  const partial = new Map<string, Array<Uint8Array | undefined>>();
  return {
    readPartialChunks: async (t) => (partial.get(t) ?? []).slice(),
    writePartialChunk: async (t, i, b) => { const a = partial.get(t) ?? []; a[i] = b; partial.set(t, a); },
    clearPartialChunks: async (t) => { partial.delete(t); },
    copyId, walletAddress, role, payloads: store,
    listHeaders: async () => headers.slice(),
    localTxIds: async () => new Set(store.keys()),
    readPayload: async (t) => store.get(t) ?? null,
    writePayload: async (item, bytes) => { store.set(item.txId, bytes); },
  };
}
