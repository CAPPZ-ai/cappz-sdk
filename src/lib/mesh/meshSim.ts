/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-sim
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * A discrete-time simulator for the resilience mesh. It runs the real
 * MeshNode (real Ed25519 / secp256k1 / AES-GCM, the real gate, store and
 * routing) over simulated radios: devices move, links come up when two are in
 * range and go down when they part, each link carries a bounded number of
 * bytes per tick, and hostile devices take part. Only time, space and the
 * radio are simulated; the topology is seeded, so runs are reproducible up to
 * key material.
 *
 * What it does not model: radio contention and interference, battery, the
 * cost of discovery, OS background limits on phones. Results are an upper
 * bound for the protocol, not a field measurement.
 */

import { generateRecoveryPhrase, keyPairFromPhrase, type WalletKeyPair } from '../auth/wallet/session.ts';
import { revokeKeyDeclaration, type KeyDeclaration } from '../identity/keyDeclaration.ts';
import { encodeJsonFrame } from '../sync/frameCodec.ts';
import { utf8 } from '../identity/canonical.ts';
import { createBundle, bundleId, jsonBody, type MeshBundle } from './meshBundle.ts';
import { createCharter, grantMembership, meshIdOf, DEFAULT_MESH_POLICY, type MeshCharter, type MeshPolicy, type Precedence, type MeshRole } from './meshIdentity.ts';
import { MeshNode, provisionMeshDevice, type MeshLink, type MeshNodeIdentity, type MeshNodeOptions, type RouterMode, type Delivery } from './meshNode.ts';
import { fragmentFrame, Reassembler } from './meshFragment.ts';
import type { GateVerdict } from './meshGate.ts';

// ─── seeded randomness (topology and traffic only) ──────────────

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── links ───────────────────────────────────────────────────────

/** Two MeshLinks joined in memory, delivering immediately (tests). */
export function memoryLinkPair(a: MeshNode, b: MeshNode, id = `${Math.random().toString(36).slice(2)}`): { ab: MeshLink; ba: MeshLink; up(): Promise<void>; down(): void } {
  const ab: MeshLink = { id: `${id}:a`, carrier: 'direct', send: (bytes) => { void b.receive(ba.id, bytes); }, close: () => { a.linkDown(ab.id); b.linkDown(ba.id); } };
  const ba: MeshLink = { id: `${id}:b`, carrier: 'direct', send: (bytes) => { void a.receive(ab.id, bytes); }, close: () => { a.linkDown(ab.id); b.linkDown(ba.id); } };
  return {
    ab, ba,
    async up() { await Promise.all([a.linkUp(ab), b.linkUp(ba)]); },
    down() { a.linkDown(ab.id); b.linkDown(ba.id); },
  };
}

// ─── scenario configuration ─────────────────────────────────────

export type Mobility =
  | { kind: 'random-waypoint'; speed: [number, number]; pauseS: number }
  /** People mostly at a few shelters; couriers walk between them. */
  | { kind: 'shelters'; shelters: number; couriers: number; speed: [number, number]; pauseS: number }
  /** Devices that do not move; `connected` places each within range of one already placed, so one multi-hop mesh exists. */
  | { kind: 'static'; connected?: boolean };

export interface AdversaryMix {
  /** Members that originate valid traffic far above their rate. */
  flooders?: number;
  /** Members that alter bundles they carry (body, precedence) and forward them. */
  forgers?: number;
  /** Devices with a valid wallet and declared key but no grant, sending FLASH broadcasts. */
  outsiders?: number;
  /** Devices that copy a coordinator's credentials into bundles signed with their own key. */
  impersonators?: number;
  /** Members that accept custody and drop everything (claiming to relay). */
  blackholes?: number;
  /** Members that send signed receipts for bundles they never received, to purge them. */
  ackForgers?: number;
  /** Members that re-inject every bundle they have seen, later. */
  replayers?: number;
  /** One member device captured at this second; its wallet revokes the key `revokeAfterS` later, from wherever the wallet's owner is. */
  captured?: { atS: number; revokeAfterS: number };
}

export interface SimConfig {
  name: string;
  seed: number;
  nodes: number;
  areaM: number;
  rangeM: number;
  durationS: number;
  tickS: number;
  mobility: Mobility;
  /** Bytes per second each direction of a link carries (Wi-Fi Direct ≈ 1e6+, BLE ≈ 1e4–1e5, LoRa ≈ 1e3). */
  bandwidthBps: number;
  /** Radio packet size; frames above it are fragmented (BLE, LoRa). */
  mtu?: number;
  /** Chance a live link fails in a tick (jamming, interference). */
  linkFailPerTick?: number;
  router: RouterMode;
  sprayCopies?: number;
  /** Credentials by reference after first use per link (default true). */
  credentialRefs?: boolean;
  storeBytes?: number;
  policy?: MeshPolicy;
  coordinators: number;
  responders: number;
  guests: number;
  /** Direct messages between random honest nodes, spread over the first `trafficWindow` of the run. */
  messages: number;
  messageBytes: number;
  precedenceMix: Partial<Record<Precedence, number>>;
  /** Alerts broadcast by coordinators on 'alerts' (every honest node reads it). */
  alerts: number;
  trafficWindow?: number;
  adversaries?: AdversaryMix;
}

// ─── results ─────────────────────────────────────────────────────

export interface SimResult {
  name: string;
  config: Omit<SimConfig, 'policy'>;
  messages: { sent: number; delivered: number; ratio: number; byPrecedence: Record<string, { sent: number; delivered: number; ratio: number }>; latencyP50S: number | null; latencyP95S: number | null; meanHops: number | null };
  alerts: { sent: number; meanCoverage: number; p95TimeTo90PctS: number | null };
  overhead: { bundleTransmissions: number; perDelivered: number | null; bytesOut: number; peakStoreBytes: number; purgedByReceipt: number };
  security: {
    attackBundlesInjected: number;
    /** Forged content (altered bundles, someone else's credentials, no grant above guest rights) some honest node admitted. Must be 0. */
    forgedAdmitted: number;
    /** Replayed bundles admitted by a node that had already seen them. Must be 0. */
    replayAdmittedAfterSeen: number;
    /** Honest bundles purged by a forged receipt. Must be 0. */
    illegitimatePurges: number;
    /** Captured-key bundles admitted by a node after that node had learned the revocation. Must be 0. */
    revokedAdmittedAfterLearned: number;
    /** Captured-key bundles admitted before the revocation reached that node (the exposure window). */
    revokedAdmittedBeforeLearned: number;
    revocationReach: number | null;
    revocationP90S: number | null;
    flooderStoreShareMax: number | null;
    linksClosedForAbuse: number;
    verdicts: Partial<Record<GateVerdict, number>>;
  };
  cpu: { gateChecks: number; wallMs: number };
}

// ─── the world ──────────────────────────────────────────────────

type ActorKind = 'honest' | 'flooder' | 'forger' | 'outsider' | 'impersonator' | 'blackhole' | 'ackForger' | 'replayer' | 'captured';

interface Actor {
  idx: number;
  kind: ActorKind;
  role: MeshRole;
  wallet: WalletKeyPair;
  identity: MeshNodeIdentity;
  node: MeshNode;
  x: number; y: number; tx: number; ty: number; speed: number; pauseLeft: number;
  shelter?: number; courier?: boolean;
  seenBundles: MeshBundle[];
}

interface SimLink {
  key: string;
  a: Actor; b: Actor;
  ab: MeshLink; ba: MeshLink;
  qab: Uint8Array[]; qba: Uint8Array[];
  rab: Reassembler; rba: Reassembler;
  alive: boolean;
}

/** A node that claims to carry for others and drops everything (it still answers custody as stored). */
class BlackholeNode extends MeshNode {
  protected override keep(): string { return 'stored'; }
}

const SUB_ALERTS = 'alerts';

export async function runSimulation(cfg: SimConfig): Promise<SimResult> {
  const wallStart = performance.now();
  const r = rng(cfg.seed);
  const t0 = Date.now();
  let simMs = 0;
  const now = () => t0 + simMs;
  const policy = cfg.policy ?? DEFAULT_MESH_POLICY;

  // Provision: one authority wallet, a charter, grants — all before "the outage".
  const authority = keyPairFromPhrase(generateRecoveryPhrase());
  const charter: MeshCharter = await createCharter(authority.privateKey, { name: cfg.name, authorities: [authority.address], policy }, t0);
  const meshId = await meshIdOf(charter);

  const adv = cfg.adversaries ?? {};
  const kinds: ActorKind[] = [];
  const push = (k: ActorKind, n = 0) => { for (let i = 0; i < n; i++) kinds.push(k); };
  push('flooder', adv.flooders); push('forger', adv.forgers); push('outsider', adv.outsiders); push('impersonator', adv.impersonators);
  push('blackhole', adv.blackholes); push('ackForger', adv.ackForgers); push('replayer', adv.replayers); push('captured', adv.captured ? 1 : 0);
  const honestCount = cfg.nodes - kinds.length;
  if (honestCount < 2) throw new Error('need at least two honest nodes');
  kinds.unshift(...Array(honestCount).fill('honest'));

  const deliveries = new Map<string, { at: number; hops: number }>();
  const sentById = new Map<string, { to: number }>();
  let illegitimateReceipts = 0; // `${bundleId}|${toIdx}` → first delivery
  const alertSeen = new Map<string, Map<number, number>>(); // alert id → actor idx → time
  const actors: Actor[] = [];
  const nodeOpts = (identity: MeshNodeIdentity, idx: number, relay = true): MeshNodeOptions => ({
    charter, meshId, identity, now, router: cfg.router, sprayCopies: cfg.sprayCopies ?? 8, credentialRefs: cfg.credentialRefs, storeBytes: cfg.storeBytes ?? 8 * 1024 * 1024, relay,
    channels: [SUB_ALERTS],
    // A receipt is illegitimate if, when some node acted on it, the bundle had not reached its recipient.
    onReceipt: (rc) => {
      const m = sentById.get(rc.of);
      if (m && !deliveries.has(`${rc.of}|${m.to}`)) illegitimateReceipts++;
    },
    onDeliver: (d: Delivery) => {
      const at = now();
      if (d.channel === SUB_ALERTS) {
        const m = alertSeen.get(d.id) ?? new Map<number, number>(); if (!m.has(idx)) m.set(idx, at); alertSeen.set(d.id, m);
      } else if (!d.channel) {
        const k = `${d.id}|${idx}`; if (!deliveries.has(k)) deliveries.set(k, { at, hops: d.hops });
      }
    },
  });

  for (let i = 0; i < cfg.nodes; i++) {
    const kind = kinds[i];
    const honestish = kind === 'honest';
    const role: MeshRole = kind === 'outsider' ? 'guest'
      : honestish && i < cfg.coordinators ? 'coordinator'
      : honestish && i < cfg.coordinators + cfg.responders ? 'responder'
      : honestish && i >= honestCount - cfg.guests ? 'guest'
      : 'member';
    const wallet = keyPairFromPhrase(generateRecoveryPhrase());
    const grant = role === 'guest' ? undefined : await grantMembership(authority.privateKey, { meshId, authority: authority.address, member: wallet.address, role }, t0);
    const identity = await provisionMeshDevice({ walletPrivateKey: wallet.privateKey, walletAddress: wallet.address, grant, now: t0 });
    const node = kind === 'blackhole' ? await BlackholeNode.create(nodeOpts(identity, i)) : await MeshNode.create(nodeOpts(identity, i));
    actors.push({ idx: i, kind, role, wallet, identity, node, x: r() * cfg.areaM, y: r() * cfg.areaM, tx: 0, ty: 0, speed: 0, pauseLeft: 0, seenBundles: [] });
  }
  // Contacts were exchanged before the outage (QR at the community meeting); the contact bundle path is tested separately.
  for (const a of actors) for (const b of actors) if (a !== b && b.identity.encryptionDeclaration) a.node.contacts.set(b.wallet.address, b.identity.encryptionDeclaration.publicKey);

  // Mobility setup.
  const mob = cfg.mobility;
  const shelterPos: Array<[number, number]> = [];
  if (mob.kind === 'shelters') {
    for (let s = 0; s < mob.shelters; s++) shelterPos.push([cfg.areaM * (0.15 + 0.7 * r()), cfg.areaM * (0.15 + 0.7 * r())]);
    let couriers = mob.couriers;
    for (const a of actors) {
      a.shelter = Math.floor(r() * mob.shelters);
      a.courier = a.kind === 'honest' && couriers-- > 0 && a.idx >= cfg.coordinators;
      const [sx, sy] = shelterPos[a.shelter];
      a.x = sx + (r() - 0.5) * cfg.rangeM * 0.6; a.y = sy + (r() - 0.5) * cfg.rangeM * 0.6;
    }
  }
  if (mob.kind === 'static' && mob.connected) {
    for (const a of actors.slice(1)) {
      const anchor = actors[Math.floor(r() * a.idx)];
      const ang = r() * 2 * Math.PI, d = cfg.rangeM * (0.3 + 0.6 * r());
      a.x = Math.min(cfg.areaM, Math.max(0, anchor.x + Math.cos(ang) * d));
      a.y = Math.min(cfg.areaM, Math.max(0, anchor.y + Math.sin(ang) * d));
    }
  }
  const pickTarget = (a: Actor) => {
    if (mob.kind === 'random-waypoint') { a.tx = r() * cfg.areaM; a.ty = r() * cfg.areaM; a.speed = mob.speed[0] + r() * (mob.speed[1] - mob.speed[0]); }
    else if (mob.kind === 'shelters' && a.courier) {
      a.shelter = (a.shelter! + 1 + Math.floor(r() * (mob.shelters - 1))) % mob.shelters;
      const [sx, sy] = shelterPos[a.shelter]; a.tx = sx; a.ty = sy; a.speed = mob.speed[0] + r() * (mob.speed[1] - mob.speed[0]);
    }
  };
  for (const a of actors) { pickTarget(a); a.pauseLeft = mob.kind === 'static' ? Infinity : r() * ((mob as { pauseS: number }).pauseS ?? 0); }

  // Traffic plan (honest nodes only).
  const honest = actors.filter((a) => a.kind === 'honest');
  const window = (cfg.trafficWindow ?? 0.5) * cfg.durationS;
  const precs = Object.entries(cfg.precedenceMix) as Array<[Precedence, number]>;
  const pickPrec = () => { let x = r() * precs.reduce((n, [, w]) => n + w, 0); for (const [p, w] of precs) { x -= w; if (x <= 0) return p; } return precs[0][0]; };
  const plan: Array<{ at: number; from: Actor; to?: Actor; prec: Precedence; alert?: boolean }> = [];
  const senders = honest.filter((a) => a.role !== 'guest' || policy.guests === 'routine');
  for (let i = 0; i < cfg.messages; i++) {
    const from = senders[Math.floor(r() * senders.length)];
    let to = honest[Math.floor(r() * honest.length)];
    while (to === from) to = honest[Math.floor(r() * honest.length)];
    const max = policy.roles[from.role].maxPrecedence;
    let prec = pickPrec();
    if (['flash', 'immediate', 'priority', 'routine'].indexOf(prec) < ['flash', 'immediate', 'priority', 'routine'].indexOf(max)) prec = max;
    plan.push({ at: r() * window, from, to, prec });
  }
  const coords = honest.filter((a) => a.role === 'coordinator');
  for (let i = 0; i < cfg.alerts && coords.length; i++) plan.push({ at: r() * window, from: coords[i % coords.length], prec: 'flash', alert: true });
  plan.sort((a, b) => a.at - b.at);

  const sent: Array<{ id: string; to: number; prec: Precedence; at: number }> = [];
  const alertsSent: Array<{ id: string; at: number; from: number }> = [];
  const forgeries = new Set<string>();
  const replays = new Set<string>();
  let replayAdmittedAfterSeen = 0;
  const honestPurgeTargets = new Set<string>();
  let attackInjected = 0;

  // Links.
  const links = new Map<string, SimLink>();
  const keyOf = (a: Actor, b: Actor) => (a.idx < b.idx ? `${a.idx}-${b.idx}` : `${b.idx}-${a.idx}`);
  const mtu = cfg.mtu;
  const makeLink = async (a: Actor, b: Actor) => {
    const key = keyOf(a, b);
    const l: SimLink = {
      key, a, b, qab: [], qba: [], rab: new Reassembler({ now }), rba: new Reassembler({ now }), alive: true,
      ab: { id: `${key}:${a.idx}`, carrier: mtu ? 'ble-gatt' : 'tcp', send: (bytes) => { if (l.alive) l.qab.push(...(mtu ? fragmentFrame(fragId++, bytes, mtu) : [bytes])); }, close: () => breakLink(l) },
      ba: { id: `${key}:${b.idx}`, carrier: mtu ? 'ble-gatt' : 'tcp', send: (bytes) => { if (l.alive) l.qba.push(...(mtu ? fragmentFrame(fragId++, bytes, mtu) : [bytes])); }, close: () => breakLink(l) },
    };
    links.set(key, l);
    await a.node.linkUp(l.ab); await b.node.linkUp(l.ba);
    await onContact(a, l, 'ab'); await onContact(b, l, 'ba');
  };
  let fragId = 1;
  const breakLink = (l: SimLink) => {
    if (!l.alive) return;
    l.alive = false; l.qab.length = 0; l.qba.length = 0;
    l.a.node.linkDown(l.ab.id); l.b.node.linkDown(l.ba.id);
    links.delete(l.key);
  };

  // What hostile actors do when they meet someone.
  // Attack bundles by class. A forgery is admitted if a node accepts that exact content (an altered body keeps the
  // genuine id, so content is fingerprinted). A replay breaches only if a node admits it after having seen it.
  // Flood and receipt bundles are validly signed by their (hostile) member: admitting them is correct; what is
  // measured is the rate limit, the store share and whether a receipt purges anything.
  const fingerprint = (b: MeshBundle) => `${b.sig}|${JSON.stringify(b.h)}|${b.body}`;
  const inject = async (_from: Actor, l: SimLink, dir: 'ab' | 'ba', b: MeshBundle, kind: 'forgery' | 'replay' | 'flood' | 'receipt') => {
    attackInjected++;
    if (kind === 'forgery') forgeries.add(fingerprint(b));
    else if (kind === 'replay') replays.add(fingerprint(b));
    (dir === 'ab' ? l.ab : l.ba).send(await encodeJsonFrame('frame', b));
  };
  const coordinator = honest.find((a) => a.role === 'coordinator');
  let capturedAt: number | null = null;
  const capturedActor = actors.find((a) => a.kind === 'captured');
  const capturedKey = capturedActor?.identity.deviceKey.publicKeyHex.toLowerCase();
  const onContact = async (a: Actor, l: SimLink, dir: 'ab' | 'ba') => {
    const k = a.kind;
    const t = now();
    if (k === 'forger') {
      for (const e of [...a.node.store.values()].slice(0, 6)) {
        const b = e.bundle;
        // Header altered (raised precedence, or a stale bundle kept alive): the device-key signature fails.
        await inject(a, l, dir, { ...b, h: { ...b.h, prec: b.h.prec === 'flash' ? 'immediate' : 'flash', expires: b.h.expires + 3600_000 } }, 'forgery');
        // Body altered under an intact header: the body hash fails.
        const tail = b.body.endsWith('AAAA') ? 'BBBB' : 'AAAA';
        await inject(a, l, dir, { ...b, body: b.body.slice(0, -4) + tail, hops: b.hops + 1 }, 'forgery');
      }
    } else if (k === 'outsider' || k === 'impersonator') {
      const decl = k === 'impersonator' && coordinator ? coordinator.identity.credentials : a.identity.credentials;
      const src = k === 'impersonator' && coordinator ? coordinator.wallet.address : a.wallet.address;
      const { bundle } = await createBundle({ walletAddress: src, deviceKey: a.identity.deviceKey, credentials: decl }, 1 + Math.floor(r() * 1e9), { meshId, to: { channel: SUB_ALERTS }, prec: 'flash', body: utf8('EVACUATE NOW — fake'), ttlMs: 3600_000 }, t);
      await inject(a, l, dir, bundle, 'forgery');
    } else if (k === 'ackForger') {
      for (const e of [...a.node.store.values()].filter((x) => x.bundle.h.kind === 'msg' && x.bundle.h.to.t === 'wallet').slice(0, 6)) {
        const target = e.bundle; honestPurgeTargets.add(e.id);
        const { bundle } = await createBundle(a.identity, 1 + Math.floor(r() * 1e9), { meshId, kind: 'ack', to: { wallet: target.h.src }, prec: 'routine', body: jsonBody({ of: e.id, h: target.h }), ttlMs: 3600_000, clear: true }, t);
        await inject(a, l, dir, bundle, 'receipt');
      }
    } else if (k === 'replayer') {
      for (const b of a.seenBundles.slice(-8)) await inject(a, l, dir, b, 'replay');
      a.seenBundles.push(...[...a.node.store.values()].map((e) => e.bundle));
      if (a.seenBundles.length > 200) a.seenBundles.splice(0, a.seenBundles.length - 200);
    }
  };

  // Gate observation: which node admitted what, when, and when it learned the revocation.
  const learnedRevocation = new Map<number, number>();
  let forgedAdmitted = 0, revokedAfter = 0, revokedBefore = 0;
  for (const a of actors) {
    if (a.kind !== 'honest') continue;
    const gate = a.node.gate;
    const check = gate.check.bind(gate);
    gate.check = async (b) => {
      const fp = b?.h ? fingerprint(b) : '';
      const seenBefore = replays.has(fp) && gate.hasSeen(await bundleId(b.h));
      const res = await check(b);
      if (res.verdict === 'admitted' || res.verdict === 'admitted-guest') {
        if (forgeries.has(fp)) forgedAdmitted++;
        if (seenBefore) replayAdmittedAfterSeen++;
        if (capturedKey && b.h.key === capturedKey && capturedAt !== null && b.h.created >= capturedAt) {
          if (learnedRevocation.has(a.idx)) revokedAfter++; else revokedBefore++;
        }
      }
      return res;
    };
    const learn = gate.learnKeyRevocation.bind(gate);
    gate.learnKeyRevocation = async (rv) => { const ok = await learn(rv); if (ok && !learnedRevocation.has(a.idx)) learnedRevocation.set(a.idx, now()); return ok; };
  }

  let revocationIssuedAt: number | null = null;
  let revoked = false;
  let planIdx = 0;
  const ticks = Math.ceil(cfg.durationS / cfg.tickS);
  const budget = Math.max(mtu ?? 1, Math.floor(cfg.bandwidthBps * cfg.tickS));

  for (let tick = 0; tick < ticks; tick++) {
    simMs = tick * cfg.tickS * 1000;
    const tS = simMs / 1000;

    // Move.
    for (const a of actors) {
      if (mob.kind === 'static' || (mob.kind === 'shelters' && !a.courier)) continue;
      if (a.pauseLeft > 0) { a.pauseLeft -= cfg.tickS; continue; }
      const dx = a.tx - a.x, dy = a.ty - a.y, d = Math.hypot(dx, dy), step = a.speed * cfg.tickS;
      if (d <= step) { a.x = a.tx; a.y = a.ty; a.pauseLeft = (mob as { pauseS: number }).pauseS * (0.5 + r()); pickTarget(a); }
      else { a.x += (dx / d) * step; a.y += (dy / d) * step; }
    }

    // Links up / down.
    for (let i = 0; i < actors.length; i++) for (let j = i + 1; j < actors.length; j++) {
      const a = actors[i], b = actors[j];
      const inRange = Math.hypot(a.x - b.x, a.y - b.y) <= cfg.rangeM;
      const l = links.get(keyOf(a, b));
      if (l && (!inRange || (cfg.linkFailPerTick && r() < cfg.linkFailPerTick))) breakLink(l);
      else if (!l && inRange) await makeLink(a, b);
    }

    // Traffic due this tick.
    while (planIdx < plan.length && plan[planIdx].at <= tS) {
      const p = plan[planIdx++];
      if (p.alert) {
        const res = await p.from.node.broadcast({ channel: SUB_ALERTS, body: utf8(`alert ${planIdx} ${'x'.repeat(Math.max(0, cfg.messageBytes - 10))}`), prec: 'flash', ttlMs: cfg.durationS * 1000 });
        if (res.result.verdict === 'admitted') alertsSent.push({ id: res.id, at: now(), from: p.from.idx });
      } else {
        const res = await p.from.node.send({ to: p.to!.wallet.address, body: utf8('m'.repeat(cfg.messageBytes)), prec: p.prec, ttlMs: cfg.durationS * 1000 });
        if (res.result.verdict === 'admitted' || res.result.verdict === 'admitted-guest') { sent.push({ id: res.id, to: p.to!.idx, prec: p.prec, at: now() }); sentById.set(res.id, { to: p.to!.idx }); }
      }
    }

    // Hostile origination.
    for (const a of actors) {
      if (a.kind === 'flooder') {
        for (let i = 0; i < 4; i++) {
          const to = honest[Math.floor(r() * honest.length)];
          // Through its own node's API it would be rate-limited; craft directly to every neighbour instead.
          const { bundle } = await createBundle(a.identity, 1 + Math.floor(r() * 1e9), { meshId, to: { wallet: to.wallet.address, encryptionKey: to.identity.encryptionDeclaration!.publicKey }, prec: 'priority', body: utf8('f'.repeat(cfg.messageBytes)), ttlMs: cfg.durationS * 1000, copies: 8 }, now());
          for (const l of links.values()) if (l.a === a) await inject(a, l, 'ab', bundle, 'flood'); else if (l.b === a) await inject(a, l, 'ba', bundle, 'flood');
        }
      }
    }
    if (capturedActor && adv.captured) {
      if (tS >= adv.captured.atS && capturedAt === null) capturedAt = now();
      if (capturedAt !== null) {
        // The captured device keeps sending valid-looking member traffic.
        const to = honest[Math.floor(r() * honest.length)];
        await capturedActor.node.send({ to: to.wallet.address, body: utf8('c'.repeat(cfg.messageBytes)), prec: 'priority', ttlMs: cfg.durationS * 1000 });
      }
      if (!revoked && tS >= adv.captured.atS + adv.captured.revokeAfterS && coordinator) {
        revoked = true; revocationIssuedAt = now();
        const rev = await revokeKeyDeclaration(capturedActor.wallet.privateKey, capturedActor.identity.credentials.decl as KeyDeclaration, 'device captured', now());
        // The owner reports the loss to the nearest coordinator, who puts the revocation on the mesh.
        await coordinator.node.publishKeyRevocation(rev);
      }
    }

    // Move bytes: each direction of each link carries up to `budget` bytes per tick.
    const spent = new Map<string, [number, number]>();
    for (let round = 0; round < 64; round++) {
      let moved = false;
      for (const l of [...links.values()]) {
        if (!l.alive) continue;
        const s = spent.get(l.key) ?? [0, 0];
        for (const dir of [0, 1] as const) {
          const q = dir === 0 ? l.qab : l.qba;
          if (!q.length || s[dir] >= budget) continue;
          let chunk = q[0];
          const room = budget - s[dir];
          if (chunk.byteLength > room) {
            if (mtu) { s[dir] = budget; continue; } // a radio packet goes whole, next tick
            q[0] = chunk.subarray(room); chunk = chunk.subarray(0, room);
          } else q.shift();
          s[dir] += chunk.byteLength; moved = true;
          const to = dir === 0 ? l.b : l.a;
          const linkId = dir === 0 ? l.ba.id : l.ab.id;
          if (mtu) {
            const frame = (dir === 0 ? l.rba : l.rab).push(chunk);
            if (frame) await to.node.receive(linkId, frame);
          } else await to.node.receive(linkId, chunk);
        }
        spent.set(l.key, s);
      }
      if (!moved) break;
    }
    if (tick % Math.max(1, Math.round(60 / cfg.tickS)) === 0) for (const a of actors) a.node.tick();
  }

  // ─── results ──────────────────────────────────────────────────
  const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const lat: number[] = []; const hops: number[] = [];
  const byPrec: Record<string, { sent: number; delivered: number; ratio: number }> = {};
  let delivered = 0;
  for (const m of sent) {
    const d = deliveries.get(`${m.id}|${m.to}`);
    const bp = (byPrec[m.prec] ??= { sent: 0, delivered: 0, ratio: 0 });
    bp.sent++;
    if (d) { delivered++; bp.delivered++; lat.push((d.at - m.at) / 1000); hops.push(d.hops); }
  }
  for (const v of Object.values(byPrec)) v.ratio = v.sent ? v.delivered / v.sent : 0;

  const honestIdx = new Set(honest.map((a) => a.idx));
  const coverage: number[] = []; const t90: number[] = [];
  for (const a of alertsSent) {
    const seen = alertSeen.get(a.id) ?? new Map();
    const times = [...seen.entries()].filter(([i]) => honestIdx.has(i) && i !== a.from).map(([, t]) => (t - a.at) / 1000).sort((x, y) => x - y);
    const others = honest.length - 1;
    coverage.push(times.length / others);
    const need = Math.ceil(0.9 * others);
    if (times.length >= need) t90.push(times[need - 1]);
  }

  const purgedByReceipt = honest.reduce((n, a) => n + a.node.stats.purgedByReceipt, 0);

  const flooders = actors.filter((a) => a.kind === 'flooder');
  let flooderShare: number | null = null;
  if (flooders.length) {
    flooderShare = 0;
    for (const a of honest) {
      let fb = 0;
      for (const e of a.node.store.values()) if (flooders.some((f) => f.wallet.address === e.bundle.h.src)) fb += e.bytes;
      flooderShare = Math.max(flooderShare, fb / a.node.store.capacityBytes);
    }
  }

  const revTimes = [...learnedRevocation.entries()].filter(([i]) => honestIdx.has(i)).map(([, t]) => (t - (revocationIssuedAt ?? t)) / 1000);
  const verdicts: Partial<Record<GateVerdict, number>> = {};
  let gateChecks = 0;
  for (const a of honest) for (const [k, v] of Object.entries(a.node.gate.counts)) { verdicts[k as GateVerdict] = (verdicts[k as GateVerdict] ?? 0) + v!; gateChecks += v!; }

  const { policy: _p, ...config } = cfg;
  return {
    name: cfg.name,
    config,
    messages: { sent: sent.length, delivered, ratio: sent.length ? delivered / sent.length : 0, byPrecedence: byPrec, latencyP50S: pct(lat, 0.5), latencyP95S: pct(lat, 0.95), meanHops: hops.length ? hops.reduce((a, b) => a + b, 0) / hops.length : null },
    alerts: { sent: alertsSent.length, meanCoverage: coverage.length ? coverage.reduce((a, b) => a + b, 0) / coverage.length : 0, p95TimeTo90PctS: t90.length === alertsSent.length ? pct(t90, 0.95) : null },
    overhead: {
      bundleTransmissions: actors.reduce((n, a) => n + a.node.stats.bundlesOut, 0),
      perDelivered: delivered ? actors.filter((a) => a.kind === 'honest').reduce((n, a) => n + a.node.stats.bundlesOut, 0) / delivered : null,
      bytesOut: actors.reduce((n, a) => n + a.node.stats.bytesOut, 0),
      peakStoreBytes: Math.max(...honest.map((a) => a.node.store.peakBytes)),
      purgedByReceipt,
    },
    security: {
      attackBundlesInjected: attackInjected,
      forgedAdmitted,
      replayAdmittedAfterSeen,
      illegitimatePurges: illegitimateReceipts,
      revokedAdmittedAfterLearned: revokedAfter,
      revokedAdmittedBeforeLearned: revokedBefore,
      revocationReach: revocationIssuedAt === null ? null : revTimes.length / honest.length,
      revocationP90S: revocationIssuedAt === null ? null : pct(revTimes, 0.9),
      flooderStoreShareMax: flooderShare,
      linksClosedForAbuse: honest.reduce((n, a) => n + a.node.stats.linksClosedForAbuse, 0),
      verdicts,
    },
    cpu: { gateChecks, wallMs: Math.round(performance.now() - wallStart) },
  };
}

