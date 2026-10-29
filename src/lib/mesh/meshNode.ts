/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-node
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * A resilience mesh node: phones, laptops and small boards that carry each
 * other's traffic when the internet is gone. It is a Transporter carrier
 * (transport type `mesh-dtn`): it moves sealed payloads one contact at a time
 * and hands what is addressed to this device to the app or the Replicator,
 * whose sync semantics do not change.
 *
 * Links are anything that moves bytes between two devices in range — TCP over
 * a Wi-Fi hotspot, Wi-Fi Direct or ad-hoc network, a WebRTC data channel,
 * BLE, LoRa (through meshFragment.ts), a USB stick (meshCarry.ts). The node
 * speaks the same CPZ1 frames on all of them:
 *
 *   hello  signed by the device key, with its KeyZ declaration and membership
 *          grant (verified like a bundle), its recipient tag and its delivery
 *          predictabilities
 *   inv    ids the node holds or has seen (it wants none of those)
 *   frame  one bundle; the receiver gates it and answers
 *   ack    custody answer for one frame: the sender splits or hands over its copy
 *   bye
 *
 * Routing: channel bundles and control bundles (revocations, receipts,
 * contacts) spread epidemically, deduped by id. Direct bundles use binary
 * spray-and-wait (N copies, halved at each hand-off) and, in the wait phase,
 * hand custody to a neighbour whose PRoPHET delivery predictability for the
 * recipient is higher — so traffic is bounded and follows people who meet the
 * recipient. A receipt signed by the recipient purges carried copies; any node
 * can verify it because it carries the original header.
 */

import { encodeJsonFrame, decodeJsonFrame, FrameDecoder, type FrameCommand } from '../sync/frameCodec.ts';
import { signCanonical, verifyCanonical, generateSigningKey, importSigningKey, type SigningKey } from '../sync/helloSignature.ts';
import { declareKey, evaluateKey, verifyKeyDeclaration, type KeyDeclaration, type KeyRevocation } from '../identity/keyDeclaration.ts';
import { canonicalJson, fromBase64Url, sha256HexOf } from '../identity/canonical.ts';
import { generateBoxKeyPair, p256HexFromJwk } from '../crypto/sealedBox.ts';
import {
  createBundle, bundleId, openBody, jsonBody, readJsonBody,
  type MeshBundle, type MeshBundleHeader, type MeshCredentials, type BundleKind,
} from './meshBundle.ts';
import { MeshGate, ACCEPTED, type GateResult, type GateVerdict } from './meshGate.ts';
import { BundleStore, PREFIX } from './meshStore.ts';
import {
  evaluateMembership, meshIdOf, recipientTag, precedenceRank, PRECEDENCE,
  type MeshCharter, type MeshMembership, type MeshMembershipRevocation, type MeshRole, type Precedence,
} from './meshIdentity.ts';

/** Anything that moves bytes between two devices. `send` takes whole CPZ1 frames; the far side may receive them in any chunking. */
export interface MeshLink {
  id: string;
  /** Transport type id (transportTypes.ts): 'tcp', 'webrtc-datachannel', 'ble-gatt', 'lora', 'bundle', … */
  carrier: string;
  send(bytes: Uint8Array): void | Promise<void>;
  close(): void;
}

export interface MeshNodeIdentity {
  walletAddress: string;
  deviceKey: SigningKey;
  credentials: MeshCredentials;
  /** P-256 box key; its public half is declared by the wallet (purpose 'encryption') and published as a contact. */
  encryptionPrivateKey?: JsonWebKey;
  encryptionDeclaration?: KeyDeclaration;
}

export interface Delivery {
  id: string;
  kind: BundleKind;
  from: string;
  fromRole: MeshRole;
  channel?: string;
  prec: Precedence;
  body: Uint8Array;
  created: number;
  receivedAt: number;
  hops: number;
}

export type RouterMode = 'spray-prophet' | 'epidemic' | 'direct';

export interface MeshNodeOptions {
  charter: MeshCharter;
  meshId?: string;
  identity: MeshNodeIdentity;
  /** Channels this device reads (it relays all channels either way). */
  channels?: string[];
  channelKeys?: Record<string, string>;
  router?: RouterMode;
  sprayCopies?: number;
  storeBytes?: number;
  /** false = battery saver: originate and receive, carry nothing for others. */
  relay?: boolean;
  now?: () => number;
  onDeliver?: (d: Delivery) => void;
  /** A wallet's contact arrived (its encryption key, and the alias it chose, if any). */
  onContact?: (c: { wallet: string; alias?: string }) => void;
  /** Personal block list: messages from these wallets are neither shown nor carried (control bundles still apply). */
  isBlocked?: (wallet: string) => boolean;
  /** A receipt signed by the recipient of bundle `of` was verified here (`forMe`: this node sent it). */
  onReceipt?: (r: { of: string; recipient: string; forMe: boolean; purged: boolean }) => void;
  /** Invalid frames from one link before it is closed and its key shunned. */
  maxInvalidPerLink?: number;
  shunMs?: number;
  /** Time unit for PRoPHET aging. */
  agingUnitMs?: number;
  /** Max ids in one inv (newest first). */
  invLimit?: number;
  /** Send credentials by hash after their first use on a link (default true). */
  credentialRefs?: boolean;
}

interface PeerState {
  link: MeshLink;
  decoder: FrameDecoder;
  queue: Promise<void>;
  hello?: { wallet: string; key: string; tag: string; role: MeshRole; relay: boolean; preds: Map<string, number> };
  /** Ids (prefixes) the peer holds, has seen, or we exchanged with it on this link. */
  known: Set<string>;
  invalid: number;
  pending: Map<string, { give: number; handover: boolean }>;
  /** Credential hashes this peer holds from us: shared across its links (by device key once its hello is in), so reconnects keep using references. */
  credsSent: Set<string>;
}

/** A bundle on the wire: credentials in full, or a reference to credentials this link already carried. */
type WireBundle = Omit<MeshBundle, 'cred'> & { cred: MeshCredentials | { ref: string } };

const credHashes = new WeakMap<MeshCredentials, Promise<string>>();
/** sha256 of the canonical credentials (memoised per object). */
export function credentialsHash(c: MeshCredentials): Promise<string> {
  let h = credHashes.get(c);
  if (!h) { h = sha256HexOf(canonicalJson(c)); credHashes.set(c, h); }
  return h;
}

interface HelloFrame {
  v: 1; meshId: string; wallet: string; key: string; tag: string; sentAt: number; relay: boolean;
  cred: MeshCredentials; preds: Array<[string, number]>; sig?: string;
}

export interface NodeStats {
  framesOut: number; bytesOut: number; framesIn: number; bytesIn: number;
  bundlesOut: number; bundlesIn: number; delivered: number; originated: number;
  purgedByReceipt: number; linksClosedForAbuse: number; helloRejected: number;
}

/**
 * Verdicts no honest relay produces: every node applies the same charter, so these mean the link
 * forged or corrupted the bundle. State-dependent verdicts (a revocation this relay has not heard
 * yet, a rate it counted differently, an expiry crossed on the way) never count against a link.
 */
const FORGERY: ReadonlySet<GateVerdict> = new Set(['malformed', 'too-large', 'wrong-mesh', 'bad-signature', 'body-mismatch', 'bad-control', 'precedence-denied', 'broadcast-denied']);


const REQUEST_TIMEOUT_MS = 30_000;
/** Delivery predictabilities a hello carries (the strongest ones): enough to route on, small enough for thin links. */
const HELLO_PREDS = 24;
/** Hex chars of a credentials hash in inv / getdata (64 bits: a collision only costs a need-cred round trip). */
const CRED_PREFIX = 16;
const P_INIT = 0.75, P_BETA = 0.25, P_GAMMA = 0.98;
const HELLO_MAX_AGE_MS = 15 * 60_000;

export class MeshNode {
  readonly meshId: string;
  readonly gate: MeshGate;
  readonly store: BundleStore;
  readonly identity: MeshNodeIdentity;
  readonly stats: NodeStats = { framesOut: 0, bytesOut: 0, framesIn: 0, bytesIn: 0, bundlesOut: 0, bundlesIn: 0, delivered: 0, originated: 0, purgedByReceipt: 0, linksClosedForAbuse: 0, helloRejected: 0 };
  readonly contacts = new Map<string, string>(); // wallet → declared P-256 encryption key (hex)
  readonly tag: Promise<string>;
  private myTag = '';
  private readonly peers = new Map<string, PeerState>();
  private readonly preds = new Map<string, number>(); // recipient tag → delivery predictability
  private lastAged: number;
  private seq = 0;
  private readonly shunned = new Map<string, number>(); // device key → until
  private readonly abuseByKey = new Map<string, number>(); // device key → forgeries seen
  private readonly requested = new Map<string, number>();
  private readonly credsSentByKey = new Map<string, Set<string>>(); // peer device key → credential hashes it holds from us
  private readonly creds = new Map<string, MeshCredentials>();
  private readonly credPrefixes = new Map<string, string>(); // hash prefix (as in inv / getdata) → hash // credentials hash → credentials (from accepted hellos and bundles) // id prefix → fetch pending until
  private readonly o: Required<Pick<MeshNodeOptions, 'router' | 'sprayCopies' | 'relay' | 'maxInvalidPerLink' | 'shunMs' | 'agingUnitMs' | 'invLimit'>> & MeshNodeOptions;
  private readonly now: () => number;
  private readonly channels: Set<string>;

  /** Use MeshNode.create (it derives the mesh id and the recipient tag). */
  constructor(o: MeshNodeOptions, meshId: string) {
    this.o = { router: 'spray-prophet', sprayCopies: 8, relay: true, maxInvalidPerLink: 16, shunMs: 10 * 60_000, agingUnitMs: 60_000, invLimit: 4096, ...o };
    this.meshId = meshId;
    this.now = o.now ?? Date.now;
    this.identity = o.identity;
    this.channels = new Set(o.channels ?? []);
    this.gate = new MeshGate({ charter: o.charter, meshId, now: this.now });
    this.store = new BundleStore(o.storeBytes ?? 32 * 1024 * 1024);
    this.lastAged = this.now();
    this.tag = recipientTag(meshId, o.identity.walletAddress).then((t) => (this.myTag = t));
  }

  static async create<T extends MeshNode>(this: new (o: MeshNodeOptions, meshId: string) => T, o: MeshNodeOptions): Promise<T> {
    const n = new this(o, o.meshId ?? (await meshIdOf(o.charter)));
    await n.tag;
    return n;
  }

  get role(): MeshRole { return this.identity.credentials.grant?.role ?? 'guest'; }
  get links(): string[] { return [...this.peers.keys()]; }
  get peerCount(): number { return this.peers.size; }

  // ─── originating ───────────────────────────────────────────────

  private clampPrec(p: Precedence): Precedence {
    const max = this.o.charter.policy.roles[this.role].maxPrecedence;
    return precedenceRank(p) > precedenceRank(max) ? max : p;
  }

  private async originate(kind: BundleKind, to: Parameters<typeof createBundle>[2]['to'], prec: Precedence, body: Uint8Array, ttlMs: number, clear: boolean, copies: number): Promise<{ id: string; result: GateResult }> {
    const ttl = Math.min(ttlMs, this.o.charter.policy.maxTtlMs);
    const { id, bundle } = await createBundle(this.identity, ++this.seq, { meshId: this.meshId, kind, to, prec, body, ttlMs: ttl, clear, copies }, this.now());
    const result = await this.gate.check(bundle);
    if (!ACCEPTED.has(result.verdict)) return { id, result };
    this.gate.markSeen(id, bundle.h.expires);
    this.stats.originated++;
    this.keep(id, bundle, result.role ?? 'guest', true);
    if (kind === 'key-revocation' || kind === 'mesh-revocation' || kind === 'contact') await this.applyControl(bundle);
    await this.offerToAll(id);
    return { id, result };
  }

  /** A direct message, sealed to the recipient's declared encryption key (from its contact), unless `clear`. */
  async send(m: { to: string; body: Uint8Array; prec?: Precedence; ttlMs?: number; clear?: boolean; encryptionKey?: string }): Promise<{ id: string; result: GateResult }> {
    const encryptionKey = m.encryptionKey ?? this.contacts.get(m.to);
    return this.originate('msg', { wallet: m.to, encryptionKey }, this.clampPrec(m.prec ?? 'routine'), m.body, m.ttlMs ?? 24 * 3600_000, !!m.clear, this.o.router === 'spray-prophet' ? this.o.sprayCopies : 1);
  }

  /** One-to-many on a channel; under the channel key when this node has it, else in the clear (public alerts). */
  async broadcast(m: { channel: string; body: Uint8Array; prec?: Precedence; ttlMs?: number }): Promise<{ id: string; result: GateResult }> {
    return this.originate('msg', { channel: m.channel, channelKey: this.o.channelKeys?.[m.channel] }, this.clampPrec(m.prec ?? 'routine'), m.body, m.ttlMs ?? 12 * 3600_000, true, 1);
  }

  /** Spread a KeyZ revocation (a lost or captured device) to the whole mesh. */
  publishKeyRevocation(r: KeyRevocation): Promise<{ id: string; result: GateResult }> {
    return this.originate('key-revocation', { channel: 'keyz' }, 'flash', jsonBody(r), this.o.charter.policy.maxTtlMs, true, 1);
  }

  publishMembershipRevocation(r: MeshMembershipRevocation): Promise<{ id: string; result: GateResult }> {
    return this.originate('mesh-revocation', { channel: 'keyz' }, 'flash', jsonBody(r), this.o.charter.policy.maxTtlMs, true, 1);
  }

  /** Publish this wallet's declared encryption key so others can seal to it, with the name it goes by (display only). */
  async publishContact(alias?: string): Promise<{ id: string; result: GateResult } | null> {
    if (!this.identity.encryptionDeclaration) return null;
    return this.originate('contact', { channel: 'directory' }, 'routine', jsonBody({ decl: this.identity.encryptionDeclaration, ...(alias ? { alias: alias.slice(0, 64) } : {}) }), this.o.charter.policy.maxTtlMs, true, 1);
  }

  /** After a block: drop the messages this node was carrying from that wallet. Returns how many. */
  dropFrom(wallet: string): number {
    let n = 0;
    for (const e of [...this.store.values()]) if (e.bundle.h.src === wallet && e.bundle.h.kind === 'msg' && this.store.delete(e.id)) n++;
    return n;
  }

  // ─── links ─────────────────────────────────────────────────────

  async linkUp(link: MeshLink): Promise<void> {
    const peer: PeerState = { link, decoder: new FrameDecoder(), queue: Promise.resolve(), known: new Set(), invalid: 0, pending: new Map(), credsSent: new Set() };
    this.peers.set(link.id, peer);
    const preds = [...this.preds.entries()].sort((a, b) => b[1] - a[1]).slice(0, HELLO_PREDS).map(([t, p]) => [t, Math.round(p * 1000) / 1000] as [string, number]);
    const hello: HelloFrame = { v: 1, meshId: this.meshId, wallet: this.identity.walletAddress, key: this.identity.deviceKey.publicKeyHex.toLowerCase(), tag: this.myTag, sentAt: this.now(), relay: this.o.relay, cred: this.identity.credentials, preds };
    hello.sig = await signCanonical(canonicalJson(hello), this.identity.deviceKey);
    await this.sendFrame(peer, 'hello', hello);
    peer.credsSent.add(await credentialsHash(this.identity.credentials)); // the peer caches them from the hello
  }

  linkDown(linkId: string): void {
    this.peers.delete(linkId);
  }

  /** Bytes from a link, any chunking. Frames from one link are handled in order. */
  receive(linkId: string, bytes: Uint8Array): Promise<void> {
    const peer = this.peers.get(linkId);
    if (!peer) return Promise.resolve();
    this.stats.bytesIn += bytes.byteLength;
    peer.queue = peer.queue.then(async () => {
      if (!this.peers.has(linkId)) return;
      let frames;
      try { frames = await peer.decoder.feed(bytes); } catch { this.abuse(peer, 'undecodable bytes', true); return; }
      for (const f of frames) {
        if (!this.peers.has(linkId)) return;
        this.stats.framesIn++;
        try { await this.onFrame(peer, f.command, decodeJsonFrame<unknown>(f)); } catch { this.abuse(peer, 'bad frame'); }
      }
    });
    return peer.queue;
  }

  /** Wait until every link's queued frames are handled (tests, simulator). */
  async settle(): Promise<void> {
    await Promise.all([...this.peers.values()].map((p) => p.queue));
  }

  private async sendFrame(peer: PeerState, cmd: FrameCommand, value: unknown): Promise<void> {
    const bytes = await encodeJsonFrame(cmd, value);
    this.stats.framesOut++; this.stats.bytesOut += bytes.byteLength;
    await peer.link.send(bytes);
  }

  /**
   * Count a forgery against the link and, once its hello is known, against the device key — so
   * dropping and re-dialling does not reset the count. Past the limit the link closes and the key is
   * shunned for a while.
   */
  private abuse(peer: PeerState, _why: string, fatal = false): void {
    peer.invalid++;
    let count = peer.invalid;
    if (peer.hello) {
      const k = peer.hello.key;
      count = (this.abuseByKey.get(k) ?? 0) + 1;
      this.abuseByKey.set(k, count);
      if (this.abuseByKey.size > 10_000) this.abuseByKey.delete(this.abuseByKey.keys().next().value!);
    }
    if (!fatal && count < this.o.maxInvalidPerLink) return;
    if (peer.hello) { this.shunned.set(peer.hello.key, this.now() + this.o.shunMs); this.abuseByKey.delete(peer.hello.key); }
    this.stats.linksClosedForAbuse++;
    this.peers.delete(peer.link.id);
    try { peer.link.close(); } catch { /* already closed */ }
  }

  private async onFrame(peer: PeerState, cmd: FrameCommand, v: unknown): Promise<void> {
    if (cmd === 'hello') return this.onHello(peer, v as HelloFrame);
    if (!peer.hello) { this.abuse(peer, `${cmd} before hello`); return; }
    if (cmd === 'inv') return this.onInv(peer, v as { ids: string[] });
    if (cmd === 'getdata') return this.onGetdata(peer, v as { ids: string[]; haveCred?: string[] });
    if (cmd === 'frame') return this.onBundle(peer, v as MeshBundle);
    if (cmd === 'ack') return this.onCustody(peer, v as { id: string; verdict: GateVerdict | 'stored' | 'no-room' });
    if (cmd === 'bye') { this.linkDown(peer.link.id); return; }
  }

  private async onHello(peer: PeerState, h: HelloFrame): Promise<void> {
    const reject = () => { this.stats.helloRejected++; this.abuse(peer, 'hello rejected', true); };
    if (!h || h.v !== 1 || h.meshId !== this.meshId || !h.sig || !h.cred?.decl || !Array.isArray(h.preds)) return reject();
    if ((this.shunned.get(h.key) ?? 0) > this.now()) return reject();
    if (Math.abs(this.now() - h.sentAt) > HELLO_MAX_AGE_MS) return reject();
    const { sig, ...unsigned } = h;
    if (!(await verifyCanonical(canonicalJson(unsigned), sig, h.key))) return reject();
    if (h.tag !== (await recipientTag(this.meshId, h.wallet))) return reject();
    let trust = await evaluateKey(h.wallet, h.key, 'hello', { declarations: [h.cred.decl], revocations: this.gate.keyRevocations }, this.now());
    if (trust.state !== 'declared') trust = await evaluateKey(h.wallet, h.key, 'signing', { declarations: [h.cred.decl], revocations: this.gate.keyRevocations }, this.now());
    if (trust.state !== 'declared') return reject();
    const m = await evaluateMembership(h.wallet, h.cred.grant, { charter: this.o.charter, meshId: this.meshId, revokedGrants: this.gate.revokedGrants, now: this.now() });
    if (m.state !== 'granted' && !(m.state === 'guest' && this.o.charter.policy.guests === 'routine')) return reject();
    const preds = new Map<string, number>();
    for (const [t, p] of h.preds.slice(0, HELLO_PREDS)) if (typeof t === 'string' && typeof p === 'number' && p >= 0 && p <= 1) preds.set(t, p);
    peer.hello = { wallet: h.wallet, key: h.key, tag: h.tag, role: m.role, relay: h.relay !== false, preds };
    // Same device as before (a reconnect): it still holds what we sent it then.
    const prior = this.credsSentByKey.get(h.key);
    if (prior) { for (const x of peer.credsSent) prior.add(x); peer.credsSent = prior; }
    else { if (this.credsSentByKey.size >= 2000) this.credsSentByKey.delete(this.credsSentByKey.keys().next().value!); this.credsSentByKey.set(h.key, peer.credsSent); }
    await this.rememberCredentials(h.cred);
    this.encounter(h.tag, preds);
    // Announce what this peer would get from us, highest rank first; it pulls what it lacks.
    const order = [...this.store.values()].sort((a, b) => b.rank - a.rank || a.bundle.h.created - b.bundle.h.created);
    const ids: string[] = [];
    for (const e of order) {
      if (ids.length >= this.o.invLimit) break;
      if (this.decide(peer, e.id)) { ids.push(await this.announce(e.id)); peer.known.add(e.id.slice(0, PREFIX)); }
    }
    await this.sendFrame(peer, 'inv', { ids });
  }

  /** The peer has these and offers them: ask for the ones this node has neither held nor seen, and is not already fetching. */
  private async onInv(peer: PeerState, inv: { ids: string[] }): Promise<void> {
    if (!Array.isArray(inv?.ids)) { this.abuse(peer, 'bad inv'); return; }
    const t = this.now();
    const want: string[] = [];
    const haveCred: string[] = [];
    for (const raw of inv.ids.slice(0, this.o.invLimit)) {
      if (typeof raw !== 'string') continue;
      const id = raw.slice(0, PREFIX);
      const credPrefix = raw.length > PREFIX + 1 && raw[PREFIX] === ':' ? raw.slice(PREFIX + 1, PREFIX + 1 + CRED_PREFIX) : '';
      peer.known.add(id);
      if (this.store.hasPrefix(id) || this.gate.hasSeen(id) || (this.requested.get(id) ?? 0) > t) continue;
      this.requested.set(id, t + REQUEST_TIMEOUT_MS);
      want.push(id);
      if (credPrefix && this.credPrefixes.has(credPrefix) && !haveCred.includes(credPrefix)) haveCred.push(credPrefix);
    }
    if (this.requested.size > 20_000) for (const [k, until] of this.requested) if (until <= t) this.requested.delete(k);
    if (want.length) await this.sendFrame(peer, 'getdata', haveCred.length ? { ids: want, haveCred } : { ids: want });
  }

  private async onGetdata(peer: PeerState, req: { ids: string[]; haveCred?: string[] }): Promise<void> {
    if (!Array.isArray(req?.ids)) { this.abuse(peer, 'bad getdata'); return; }
    const have = new Set(Array.isArray(req.haveCred) ? req.haveCred.slice(0, this.o.invLimit).filter((x) => typeof x === 'string') : []);
    for (const raw of req.ids.slice(0, this.o.invLimit)) {
      const id = typeof raw === 'string' ? this.store.idOfPrefix(raw.slice(0, PREFIX)) : undefined;
      if (id) await this.give(peer, id, have);
    }
  }

  /** An inv entry: id prefix, and the credentials' hash prefix so the receiver can say it already holds them. */
  private async announce(id: string): Promise<string> {
    const e = this.store.get(id);
    return e ? `${id.slice(0, PREFIX)}:${(await credentialsHash(e.bundle.cred)).slice(0, CRED_PREFIX)}` : id.slice(0, PREFIX);
  }

  /** A new bundle here: announce it to each neighbour that routing would give it to. */
  private async offerToAll(id: string): Promise<void> {
    const prefix = id.slice(0, PREFIX);
    for (const peer of [...this.peers.values()]) {
      if (!peer.hello || peer.known.has(prefix) || !this.decide(peer, id)) continue;
      peer.known.add(prefix);
      await this.sendFrame(peer, 'inv', { ids: [await this.announce(id)] });
    }
  }

  /**
   * Routing: would this neighbour get a copy of this bundle, and how many copies / custody?
   * Channel and control bundles spread to everyone; direct bundles (messages and receipts) go
   * straight to their recipient, are sprayed while this node holds more than one copy, and
   * otherwise move only to a neighbour likelier to meet the recipient.
   */
  private decide(peer: PeerState, id: string): { give: number; handover: boolean } | null {
    const e = this.store.get(id);
    if (!e || !peer.hello || peer.pending.has(id)) return null;
    const b = e.bundle;
    if (b.h.expires <= this.now()) return null;
    const own = b.h.src === this.identity.walletAddress;
    const forPeer = b.h.to.t === 'wallet' && b.h.to.tag === peer.hello.tag;
    if (forPeer) return { give: b.copies, handover: true };
    if (!peer.hello.relay) return null; // it would not carry it
    if (!this.o.relay && !own) return null;
    if (b.h.to.t === 'channel') return { give: 1, handover: false };
    if (this.o.router === 'epidemic') return { give: 1, handover: false };
    if (this.o.router === 'direct') return null;
    if (b.copies > 1) return { give: Math.floor(b.copies / 2), handover: false };
    const theirs = peer.hello.preds.get(b.h.to.tag) ?? 0;
    const mine = this.preds.get(b.h.to.tag) ?? 0;
    return theirs > mine ? { give: 1, handover: true } : null;
  }

  private async give(peer: PeerState, id: string, peerHasCred: ReadonlySet<string> = new Set()): Promise<void> {
    const d = this.decide(peer, id);
    if (!d) return;
    const b = this.store.get(id)!.bundle;
    peer.known.add(id.slice(0, PREFIX));
    peer.pending.set(id, d);
    this.stats.bundlesOut++;
    // Credentials go in full once per link; after that, by reference (≈1.3 kB saved per bundle, which is what makes LoRa usable).
    const ch = await credentialsHash(b.cred);
    const cred = this.o.credentialRefs !== false && (peer.credsSent.has(ch) || peerHasCred.has(ch.slice(0, CRED_PREFIX))) ? { ref: ch } : b.cred;
    peer.credsSent.add(ch);
    await this.sendFrame(peer, 'frame', { ...b, cred, hops: b.hops + 1, copies: d.give } satisfies WireBundle);
  }

  /** Credentials seen in an accepted hello or bundle, so a later bundle may name them by hash. Bounded. */
  private async rememberCredentials(c: MeshCredentials): Promise<void> {
    const h = await credentialsHash(c);
    if (this.creds.has(h)) return;
    if (this.creds.size >= 5000) { const old = this.creds.keys().next().value!; this.creds.delete(old); this.credPrefixes.delete(old.slice(0, CRED_PREFIX)); }
    this.creds.set(h, c);
    this.credPrefixes.set(h.slice(0, CRED_PREFIX), h);
  }

  private async onCustody(peer: PeerState, a: { id: string; verdict: string }): Promise<void> {
    const p = peer.pending.get(a?.id);
    if (!p) return;
    peer.pending.delete(a.id);
    if (a.verdict === 'need-cred') {
      // The peer dropped the credentials we referenced: send this bundle again in full.
      const e = this.store.get(a.id);
      if (e) { peer.credsSent.delete(await credentialsHash(e.bundle.cred)); peer.known.delete(a.id.slice(0, PREFIX)); await this.give(peer, a.id); }
      return;
    }
    if (!['admitted', 'admitted-guest', 'stored', 'delivered'].includes(a.verdict)) return;
    const e = this.store.get(a.id);
    if (!e || e.bundle.h.to.t !== 'wallet' || this.o.router === 'epidemic') return;
    if (p.handover) this.store.delete(a.id);
    else e.bundle.copies = Math.max(1, e.bundle.copies - p.give);
  }

  private async onBundle(peer: PeerState, wire: WireBundle): Promise<void> {
    this.stats.bundlesIn++;
    let b = wire as MeshBundle;
    const ref = wire?.cred && 'ref' in wire.cred ? wire.cred.ref : null;
    if (ref !== null) {
      const c = typeof ref === 'string' ? this.creds.get(ref) ?? this.creds.get(this.credPrefixes.get(ref.slice(0, CRED_PREFIX)) ?? '') : undefined;
      if (!c) { await this.sendFrame(peer, 'ack', { id: wire.h ? await bundleId(wire.h) : undefined, verdict: 'need-cred' }); return; }
      b = { ...wire, cred: c };
    }
    const r = await this.gate.check(b);
    if (!ACCEPTED.has(r.verdict)) {
      if (r.id) peer.known.add(r.id.slice(0, PREFIX));
      if (FORGERY.has(r.verdict)) this.abuse(peer, r.verdict);
      await this.sendFrame(peer, 'ack', { id: r.id, verdict: r.verdict });
      return;
    }
    const id = r.id!;
    peer.known.add(id.slice(0, PREFIX));
    this.requested.delete(id.slice(0, PREFIX));
    await this.rememberCredentials(b.cred);
    this.gate.markSeen(id, b.h.expires);
    const outcome = await this.accept(id, b, r.role ?? 'guest', peer);
    await this.sendFrame(peer, 'ack', { id, verdict: outcome });
    await this.offerToAll(id);
  }

  /** An admitted bundle: deliver what is for this device, apply control bundles, keep the rest to carry. */
  private async accept(id: string, b: MeshBundle, role: MeshRole, _from?: PeerState): Promise<string> {
    const forMe = b.h.to.t === 'wallet' && b.h.to.tag === this.myTag;
    if (b.h.kind === 'msg' && this.o.isBlocked?.(b.h.src)) return 'blocked'; // not shown, not carried; the sender keeps its copy
    if (b.h.kind === 'msg' && forMe) {
      await this.deliver(id, b, role);
      await this.sendReceipt(id, b);
      return 'delivered';
    }
    if (b.h.kind !== 'msg') await this.applyControl(b);
    else if (b.h.to.t === 'channel' && this.channels.has(b.h.to.ch)) await this.deliver(id, b, role);
    if (b.h.kind === 'ack' && forMe) return 'delivered';
    return this.keep(id, b, role, false);
  }

  /** Hold a bundle to carry. Protected so a simulator can model a node that lies about carrying (a black hole). */
  protected keep(id: string, b: MeshBundle, role: MeshRole, own: boolean): string {
    if (!own && !this.o.relay && b.h.kind === 'msg') return 'not-carried';
    return this.store.put(id, b, this.o.charter.policy.roles[role].storeShare, this.now());
  }

  private async deliver(id: string, b: MeshBundle, role: MeshRole): Promise<void> {
    let body: Uint8Array;
    try { body = await openBody(b, { encryptionPrivateKey: this.identity.encryptionPrivateKey, channelKeys: this.o.channelKeys }); } catch { return; }
    this.stats.delivered++;
    this.o.onDeliver?.({ id, kind: b.h.kind, from: b.h.src, fromRole: role, channel: b.h.to.t === 'channel' ? b.h.to.ch : undefined, prec: b.h.prec, body, created: b.h.created, receivedAt: this.now(), hops: b.hops });
  }

  /** Signed receipt carrying the original header, so every carrier can verify it and purge its copy. */
  private async sendReceipt(id: string, b: MeshBundle): Promise<void> {
    const prec = this.clampPrec(b.h.prec);
    await this.originate('ack', { wallet: b.h.src }, prec, jsonBody({ of: id, h: b.h }), Math.max(60_000, b.h.expires - this.now()), true, this.o.router === 'spray-prophet' ? this.o.sprayCopies : 1);
  }

  private async applyControl(b: MeshBundle): Promise<void> {
    const payload = readJsonBody<Record<string, unknown>>(fromBase64Url(b.body));
    if (b.h.kind === 'key-revocation') await this.gate.learnKeyRevocation(payload as unknown as KeyRevocation);
    else if (b.h.kind === 'mesh-revocation') await this.gate.learnMembershipRevocation(payload as unknown as MeshMembershipRevocation);
    else if (b.h.kind === 'contact') {
      // { decl, alias } (a bare declaration from older nodes). The bundle is signed by the wallet's device key, so the alias is the wallet's own.
      const d = ('decl' in payload ? payload.decl : payload) as KeyDeclaration;
      if (d?.walletAddress === b.h.src && d.purpose === 'encryption' && d.algorithm === 'p256' && (await verifyKeyDeclaration(d, this.now())) === 'valid') {
        this.contacts.set(d.walletAddress, d.publicKey);
        this.o.onContact?.({ wallet: d.walletAddress, alias: typeof payload.alias === 'string' ? payload.alias : undefined });
      }
    } else if (b.h.kind === 'ack') {
      const { of, h } = payload as { of: string; h: MeshBundleHeader };
      if (!h || h.to?.t !== 'wallet' || (await bundleId(h)) !== of) return;
      if ((await recipientTag(this.meshId, b.h.src)) !== h.to.tag) return; // only the recipient can acknowledge
      const purged = this.store.delete(of);
      if (purged) this.stats.purgedByReceipt++;
      this.gate.markSeen(of, h.expires);
      this.o.onReceipt?.({ of, recipient: b.h.src, forMe: h.src === this.identity.walletAddress, purged });
    }
  }

  // ─── PRoPHET delivery predictability ───────────────────────────

  private age(): void {
    const k = Math.floor((this.now() - this.lastAged) / this.o.agingUnitMs);
    if (k <= 0) return;
    const f = Math.pow(P_GAMMA, k);
    for (const [t, p] of this.preds) { const q = p * f; if (q < 0.001) this.preds.delete(t); else this.preds.set(t, q); }
    this.lastAged += k * this.o.agingUnitMs;
  }

  private encounter(tag: string, theirs: Map<string, number>): void {
    this.age();
    const p = this.preds.get(tag) ?? 0;
    const pb = p + (1 - p) * P_INIT;
    this.preds.set(tag, pb);
    for (const [c, pbc] of theirs) {
      if (c === this.myTag) continue;
      const pc = this.preds.get(c) ?? 0;
      this.preds.set(c, Math.max(pc, pb * pbc * P_BETA));
    }
    if (this.preds.size > 2048) {
      const keep = [...this.preds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1024);
      this.preds.clear(); for (const [t, q] of keep) this.preds.set(t, q);
    }
  }

  predictability(wallet: string): Promise<number> {
    return recipientTag(this.meshId, wallet).then((t) => this.preds.get(t) ?? 0);
  }

  /** Periodic upkeep: drop expired bundles, age predictabilities. */
  tick(): void {
    this.store.purgeExpired(this.now());
    this.age();
  }

  // ─── carrying bundles by hand (USB stick, SD card, QR) ─────────

  /** Every held bundle, highest rank first, for a carry file (meshCarry.ts). */
  exportBundles(limit = Infinity): MeshBundle[] {
    return [...this.store.values()].sort((a, b) => b.rank - a.rank).slice(0, limit).map((e) => ({ ...e.bundle, hops: e.bundle.hops + 1 }));
  }

  /** Bundles from a carry file go through the same gate as any link. */
  async importBundles(bundles: MeshBundle[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const b of bundles) {
      const r = await this.gate.check(b);
      let v: string = r.verdict;
      if (ACCEPTED.has(r.verdict)) { this.gate.markSeen(r.id!, b.h.expires); v = await this.accept(r.id!, b, r.role ?? 'guest'); await this.offerToAll(r.id!); }
      out[v] = (out[v] ?? 0) + 1;
    }
    return out;
  }
}

export { PRECEDENCE };

/**
 * Provision a device for a mesh before the outage: a device key and a P-256
 * box key, both declared by the wallet (KeyZ), plus the membership grant the
 * device presents. Everything a node later needs to verify and be verified
 * is in the result and the charter; no server is involved.
 */
export async function provisionMeshDevice(p: {
  walletPrivateKey: Uint8Array;
  walletAddress: string;
  grant?: MeshMembership;
  ttlMs?: number;
  now?: number;
}): Promise<MeshNodeIdentity> {
  const now = p.now ?? Date.now();
  const deviceKey = await generateSigningKey();
  const decl = await declareKey(p.walletPrivateKey, p.walletAddress, { publicKey: deviceKey.publicKeyHex, algorithm: 'ed25519', purpose: 'hello' }, p.ttlMs, now);
  const box = await generateBoxKeyPair();
  const encryptionDeclaration = await declareKey(p.walletPrivateKey, p.walletAddress, { publicKey: p256HexFromJwk(box.publicKey), algorithm: 'p256', purpose: 'encryption' }, p.ttlMs, now);
  return { walletAddress: p.walletAddress, deviceKey, credentials: { decl, ...(p.grant ? { grant: p.grant } : {}) }, encryptionPrivateKey: box.privateKey, encryptionDeclaration };
}

/** A provisioned device as JSON (a file on a laptop, local storage in a browser). Holds private keys: keep it private. */
export interface SavedMeshDevice {
  v: 1;
  meshId: string;
  walletAddress: string;
  device: { publicKeyHex: string; pkcs8?: string; secretHex?: string };
  credentials: MeshCredentials;
  encryptionPrivateKey: JsonWebKey;
  encryptionDeclaration: KeyDeclaration;
}

const b64 = (u: Uint8Array) => { let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s); };
const hexOf = (u: Uint8Array) => Array.from(u, (x) => x.toString(16).padStart(2, '0')).join('');

export async function saveMeshDevice(meshId: string, id: MeshNodeIdentity): Promise<SavedMeshDevice> {
  if (!id.encryptionPrivateKey || !id.encryptionDeclaration) throw new Error('device has no encryption key');
  const k = id.deviceKey;
  const device = k.privateKey
    ? { publicKeyHex: k.publicKeyHex, pkcs8: b64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', k.privateKey))) }
    : { publicKeyHex: k.publicKeyHex, secretHex: hexOf(k.secretKey!) };
  return { v: 1, meshId, walletAddress: id.walletAddress, device, credentials: id.credentials, encryptionPrivateKey: id.encryptionPrivateKey, encryptionDeclaration: id.encryptionDeclaration };
}

export async function loadMeshDevice(d: SavedMeshDevice): Promise<MeshNodeIdentity> {
  const deviceKey: SigningKey = d.device.pkcs8
    ? await importSigningKey(d.device.pkcs8, d.device.publicKeyHex)
    : { publicKeyHex: d.device.publicKeyHex, secretKey: Uint8Array.from(d.device.secretHex!.match(/../g)!, (x) => parseInt(x, 16)) };
  return { walletAddress: d.walletAddress, deviceKey, credentials: d.credentials, encryptionPrivateKey: d.encryptionPrivateKey, encryptionDeclaration: d.encryptionDeclaration };
}
