import { describe, it, expect } from 'vitest';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import { revokeKeyDeclaration, type KeyDeclaration } from '../lib/identity/keyDeclaration';
import { utf8 } from '../lib/identity/canonical';
import { encodeJsonFrame } from '../lib/sync/frameCodec';
import { resolveTransportType } from '../lib/sync/transportTypes';
import { createCharter, verifyCharter, meshIdOf, grantMembership, revokeMembership, evaluateMembership, DEFAULT_MESH_POLICY, type MeshCharter } from '../lib/mesh/meshIdentity';
import { createBundle, openBody, type MeshBundle } from '../lib/mesh/meshBundle';
import { MeshGate } from '../lib/mesh/meshGate';
import { MeshNode, provisionMeshDevice, type Delivery, type MeshNodeIdentity } from '../lib/mesh/meshNode';
import { fragmentFrame, Reassembler } from '../lib/mesh/meshFragment';
import { writeCarryFile, readCarryFile } from '../lib/mesh/meshCarry';
import { memoryLinkPair } from '../lib/mesh/meshSim';
import { runMeshEvals } from '../lib/mesh/meshEvals';
import { BundleStore } from '../lib/mesh/meshStore';
import { encodeSignal, decodeSignal } from '../lib/mesh/meshWebRtc';

const wallet = () => keyPairFromPhrase(generateRecoveryPhrase());

async function mesh(guests: 'drop' | 'routine' = 'routine') {
  const authority = wallet();
  const charter = await createCharter(authority.privateKey, { name: 'test', authorities: [authority.address], policy: { ...DEFAULT_MESH_POLICY, guests } });
  const meshId = await meshIdOf(charter);
  const member = async (role?: 'coordinator' | 'responder' | 'member') => {
    const w = wallet();
    const grant = role ? await grantMembership(authority.privateKey, { meshId, authority: authority.address, member: w.address, role }) : undefined;
    const identity = await provisionMeshDevice({ walletPrivateKey: w.privateKey, walletAddress: w.address, grant });
    return { w, identity };
  };
  return { authority, charter, meshId, member };
}

async function node(charter: MeshCharter, identity: MeshNodeIdentity, extra: Partial<Parameters<typeof MeshNode.create>[0]> = {}) {
  const got: Delivery[] = [];
  const n = await MeshNode.create({ charter, identity, channels: ['alerts'], onDeliver: (d) => got.push(d), ...extra });
  return { n, got };
}

const flush = async (...nodes: MeshNode[]) => { for (let i = 0; i < 6; i++) { await Promise.all(nodes.map((n) => n.settle())); await new Promise((r) => setTimeout(r, 0)); } };

describe('v15-13-00 mesh identity: charter, membership, revocation', () => {
  it('a charter verifies, its id is its hash, and a grant reads as granted only for its member and mesh', async () => {
    const { charter, meshId, member, authority } = await mesh();
    expect(await verifyCharter(charter)).toBe('valid');
    expect(await verifyCharter({ ...charter, name: 'forged' })).toBe('bad-signature');
    const { w, identity } = await member('responder');
    const ctx = { charter, meshId, revokedGrants: new Set<string>() };
    expect((await evaluateMembership(w.address, identity.credentials.grant, ctx)).state).toBe('granted');
    expect((await evaluateMembership(wallet().address, identity.credentials.grant, ctx)).state).toBe('wrong-member');
    expect((await evaluateMembership(w.address, identity.credentials.grant, { ...ctx, meshId: 'other' })).state).toBe('wrong-mesh');
    expect((await evaluateMembership(w.address, undefined, ctx)).state).toBe('guest');
    const stranger = wallet();
    const selfGrant = await grantMembership(stranger.privateKey, { meshId, authority: stranger.address, member: w.address, role: 'coordinator' });
    expect((await evaluateMembership(w.address, selfGrant, ctx)).state).toBe('not-authority');
    const rev = await revokeMembership(authority.privateKey, identity.credentials.grant!, authority.address, 'left the area');
    const gate = new MeshGate({ charter, meshId });
    expect(await gate.learnMembershipRevocation(rev)).toBe(true);
    expect(await gate.learnMembershipRevocation(rev)).toBe(false);
    expect((await evaluateMembership(w.address, identity.credentials.grant, { ...ctx, revokedGrants: gate.revokedGrants })).state).toBe('revoked');
  });
});

describe('v15-13-00 mesh gate', () => {
  it('admits a member within its role and refuses forgeries, impersonation, precedence above the role, replays and other meshes', async () => {
    const { charter, meshId, member } = await mesh();
    const coord = await member('coordinator');
    const m = await member('member');
    const gate = new MeshGate({ charter, meshId });
    const ok = await createBundle(m.identity, 1, { meshId, to: { channel: 'alerts' }, prec: 'priority', body: utf8('water at the school'), ttlMs: 3600_000 });
    expect((await gate.check(ok.bundle)).verdict).toBe('admitted');
    gate.markSeen(ok.id, ok.bundle.h.expires);
    expect((await gate.check({ ...ok.bundle, hops: 3 })).verdict).toBe('duplicate');

    const tooHigh = await createBundle(m.identity, 2, { meshId, to: { channel: 'alerts' }, prec: 'flash', body: utf8('x'), ttlMs: 3600_000 });
    expect((await gate.check(tooHigh.bundle)).verdict).toBe('precedence-denied');

    const raised = { ...ok.bundle, h: { ...ok.bundle.h, prec: 'flash' as const, seq: 99 } };
    expect((await gate.check(raised)).verdict).toBe('bad-signature');
    const fresh = await createBundle(m.identity, 3, { meshId, to: { channel: 'alerts' }, prec: 'routine', body: utf8('hello'), ttlMs: 3600_000 });
    expect((await gate.check({ ...fresh.bundle, body: fresh.bundle.body.slice(0, -2) + 'AA' })).verdict).toBe('body-mismatch');

    // An attacker signs with its own key but presents the coordinator's wallet and credentials.
    const attacker = await member('member');
    const fake = await createBundle({ walletAddress: coord.w.address, deviceKey: attacker.identity.deviceKey, credentials: coord.identity.credentials }, 1, { meshId, to: { channel: 'alerts' }, prec: 'flash', body: utf8('EVACUATE'), ttlMs: 3600_000 });
    expect((await gate.check(fake.bundle)).verdict).toBe('key-untrusted');

    const other = await mesh();
    const foreign = await createBundle(m.identity, 4, { meshId: other.meshId, to: { channel: 'alerts' }, prec: 'routine', body: utf8('x'), ttlMs: 3600_000 });
    expect((await gate.check(foreign.bundle)).verdict).toBe('wrong-mesh');
    const old = await createBundle(m.identity, 5, { meshId, to: { channel: 'alerts' }, prec: 'routine', body: utf8('x'), ttlMs: 1000 }, Date.now() - 10_000);
    expect((await gate.check(old.bundle)).verdict).toBe('expired');
  });

  it('guests are carried at ROUTINE only, may not broadcast, and are dropped when the charter says so', async () => {
    const open = await mesh('routine');
    const guest = await open.member();
    const gate = new MeshGate({ charter: open.charter, meshId: open.meshId });
    const someone = wallet().address;
    const dm = await createBundle(guest.identity, 1, { meshId: open.meshId, to: { wallet: someone }, prec: 'routine', body: utf8('I am at the bridge'), ttlMs: 3600_000, clear: true });
    expect((await gate.check(dm.bundle)).verdict).toBe('admitted-guest');
    const bc = await createBundle(guest.identity, 2, { meshId: open.meshId, to: { channel: 'alerts' }, prec: 'routine', body: utf8('x'), ttlMs: 3600_000 });
    expect((await gate.check(bc.bundle)).verdict).toBe('broadcast-denied');
    const closed = await mesh('drop');
    const g2 = await closed.member();
    const dm2 = await createBundle(g2.identity, 1, { meshId: closed.meshId, to: { wallet: someone }, prec: 'routine', body: utf8('x'), ttlMs: 3600_000, clear: true });
    expect((await new MeshGate({ charter: closed.charter, meshId: closed.meshId }).check(dm2.bundle)).verdict).toBe('not-member');
  });

  it('counts origination per minute of creation, so a backlog arriving at once is not throttled but a burst is', async () => {
    const { charter, meshId, member } = await mesh();
    const m = await member('member');
    const gate = new MeshGate({ charter, meshId });
    const t = Date.now();
    const verdicts: string[] = [];
    for (let i = 0; i < 25; i++) verdicts.push((await gate.check((await createBundle(m.identity, i, { meshId, to: { channel: 'c' }, prec: 'routine', body: utf8(`${i}`), ttlMs: 3600_000 }, t - 30 * 60_000 + i * 60_000)).bundle)).verdict);
    expect(verdicts.every((v) => v === 'admitted')).toBe(true);
    const burst: string[] = [];
    for (let i = 0; i < 25; i++) burst.push((await gate.check((await createBundle(m.identity, 100 + i, { meshId, to: { channel: 'c' }, prec: 'routine', body: utf8(`b${i}`), ttlMs: 3600_000 }, t)).bundle)).verdict);
    expect(burst.filter((v) => v === 'admitted')).toHaveLength(DEFAULT_MESH_POLICY.roles.member.perMinute);
    expect(burst.filter((v) => v === 'rate-limited')).toHaveLength(25 - DEFAULT_MESH_POLICY.roles.member.perMinute);
  });

  it('a store gives one source at most its role share, and higher precedence displaces lower', async () => {
    const { meshId, member } = await mesh();
    const m = await member('member'); const c = await member('coordinator');
    const store = new BundleStore(20_000);
    const put = async (who: typeof m, prec: 'routine' | 'flash', share: number, i: number) => { const b = await createBundle(who.identity, i, { meshId, to: { channel: 'c' }, prec, body: utf8('z'.repeat(600)), ttlMs: 3600_000 }); return store.put(b.id, b.bundle, share, Date.now()); };
    // Same precedence: the soonest-expiring bundle makes room (drop-oldest), the store never overflows.
    for (let i = 0; i < 20; i++) expect(await put(m, 'routine', 1, i)).toBe('stored');
    expect(store.evicted).toBeGreaterThan(0);
    expect(store.bytes).toBeLessThanOrEqual(store.capacityBytes);
    // FLASH displaces ROUTINE; once the store is all FLASH, ROUTINE finds no room.
    for (let i = 0; i < 20; i++) expect(await put(c, 'flash', 1, 100 + i)).toBe('stored');
    expect(await put(m, 'routine', 1, 50)).toBe('no-room');
    // Over its share, a source only churns its own bundles; others' stay.
    const s2 = new BundleStore(100_000);
    const other = await createBundle(c.identity, 1, { meshId, to: { channel: 'c' }, prec: 'routine', body: utf8('keep me'), ttlMs: 3600_000 });
    s2.put(other.id, other.bundle, 0.08, Date.now());
    for (let i = 0; i < 20; i++) { const b = await createBundle(m.identity, 200 + i, { meshId, to: { channel: 'c' }, prec: 'routine', body: utf8('z'.repeat(600)), ttlMs: 3600_000 + i }); s2.put(b.id, b.bundle, 0.08, Date.now()); }
    expect(s2.has(other.id)).toBe(true);
    expect(s2.bytes - s2.get(other.id)!.bytes).toBeLessThanOrEqual(8_000);
    const flashFromM = await createBundle(m.identity, 300, { meshId, to: { channel: 'c' }, prec: 'priority', body: utf8('z'.repeat(9000)), ttlMs: 3600_000 });
    expect(s2.put(flashFromM.id, flashFromM.bundle, 0.08, Date.now())).toBe('source-quota');
  });
});

describe('v15-13-00 mesh nodes over links', () => {
  it('carries a sealed message A → B → C across two separate contacts, delivers it only to C, and C’s receipt purges B’s copy', async () => {
    const { charter, member } = await mesh();
    const [a, b, c] = await Promise.all([member('member'), member('member'), member('member')]);
    const A = await node(charter, a.identity); const B = await node(charter, b.identity); const C = await node(charter, c.identity);
    A.n.contacts.set(c.w.address, c.identity.encryptionDeclaration!.publicKey);
    const sent = await A.n.send({ to: c.w.address, body: utf8('meet at the north gate, 18:00'), prec: 'priority' });
    expect(sent.result.verdict).toBe('admitted');
    const ab = memoryLinkPair(A.n, B.n); await ab.up(); await flush(A.n, B.n); ab.down();
    expect(B.n.store.has(sent.id)).toBe(true);
    expect(B.got).toHaveLength(0);
    const sealed = B.n.store.get(sent.id)!.bundle;
    await expect(openBody(sealed, { encryptionPrivateKey: b.identity.encryptionPrivateKey })).rejects.toThrow();
    const bc = memoryLinkPair(B.n, C.n); await bc.up(); await flush(B.n, C.n);
    expect(C.got.map((d) => new TextDecoder().decode(d.body))).toEqual(['meet at the north gate, 18:00']);
    expect(C.got[0].from).toBe(a.w.address);
    expect(C.got[0].hops).toBe(2);
    expect(B.n.store.has(sent.id)).toBe(false); // handed to its recipient, then the receipt arrived
    bc.down();
    // The receipt rides back to A on the next contact and purges A's copy.
    const ba = memoryLinkPair(B.n, A.n); await ba.up(); await flush(A.n, B.n);
    expect(A.n.store.has(sent.id)).toBe(false);
  });

  it('learns encryption keys from contact bundles, so a stranger can be written to without meeting first', async () => {
    const { charter, member } = await mesh();
    const [a, b] = await Promise.all([member('member'), member('member')]);
    const A = await node(charter, a.identity); const B = await node(charter, b.identity);
    await B.n.publishContact();
    const l = memoryLinkPair(A.n, B.n); await l.up(); await flush(A.n, B.n);
    expect(A.n.contacts.get(b.w.address)).toBe(b.identity.encryptionDeclaration!.publicKey);
    await A.n.send({ to: b.w.address, body: utf8('ok'), prec: 'routine' });
    await flush(A.n, B.n);
    expect(B.got.map((d) => new TextDecoder().decode(d.body))).toContain('ok');
  });

  it('a KeyZ revocation spreads as a bundle and the revoked device is refused from then on, in hellos and bundles', async () => {
    const { charter, meshId, member } = await mesh();
    const [coord, lost, other] = await Promise.all([member('coordinator'), member('member'), member('member')]);
    const C = await node(charter, coord.identity); const O = await node(charter, other.identity); const L = await node(charter, lost.identity);
    const rev = await revokeKeyDeclaration(lost.w.privateKey, lost.identity.credentials.decl as KeyDeclaration, 'phone taken at checkpoint');
    expect((await C.n.publishKeyRevocation(rev)).result.verdict).toBe('admitted');
    const co = memoryLinkPair(C.n, O.n); await co.up(); await flush(C.n, O.n);
    expect(O.n.gate.keyRevocations).toHaveLength(1);
    const late = await createBundle(lost.identity, 50, { meshId, to: { channel: 'alerts' }, prec: 'routine', body: utf8('all clear (fake)'), ttlMs: 3600_000 });
    expect((await O.n.gate.check(late.bundle)).verdict).toBe('key-revoked');
    const lo = memoryLinkPair(L.n, O.n); await lo.up(); await flush(L.n, O.n);
    expect(O.n.stats.helloRejected).toBe(1);
  });

  it('closes a link that keeps sending forgeries and shuns its key', async () => {
    const { charter, member } = await mesh();
    const [a, b] = await Promise.all([member('member'), member('member')]);
    const A = await node(charter, a.identity, { maxInvalidPerLink: 3 }); const B = await node(charter, b.identity);
    const l = memoryLinkPair(A.n, B.n); await l.up(); await flush(A.n, B.n);
    const real = await B.n.broadcast({ channel: 'alerts', body: utf8('real'), prec: 'priority' });
    const bundle = B.n.store.get(real.id)!.bundle;
    for (let i = 0; i < 3; i++) l.ba.send(await encodeJsonFrame('frame', { ...bundle, h: { ...bundle.h, seq: 1000 + i } } satisfies MeshBundle));
    await flush(A.n, B.n);
    expect(A.n.stats.linksClosedForAbuse).toBe(1);
    expect(A.n.peerCount).toBe(0);
  });
});

describe('v15-13-00 small radios and carried files', () => {
  it('fragments a frame to a BLE / LoRa MTU and reassembles it in any order; partials are bounded', () => {
    const frame = utf8('x'.repeat(2000));
    const parts = fragmentFrame(7, frame, 180);
    expect(parts.every((p) => p.byteLength <= 180)).toBe(true);
    const r = new Reassembler();
    const shuffled = [...parts].reverse();
    let out: Uint8Array | null = null;
    for (const p of shuffled) out = r.push(p) ?? out;
    expect(new TextDecoder().decode(out!)).toBe('x'.repeat(2000));
    const small = new Reassembler({ maxPartial: 2 });
    for (let id = 0; id < 5; id++) small.push(fragmentFrame(id, frame, 180)[0]);
    expect(small.dropped).toBe(3);
  });

  it('a carry file moves bundles by hand; each one passes the importing node’s gate', async () => {
    const { charter, meshId, member } = await mesh();
    const [a, b] = await Promise.all([member('responder'), member('member')]);
    const A = await node(charter, a.identity); const B = await node(charter, b.identity);
    await A.n.broadcast({ channel: 'alerts', body: utf8('clinic open 8–12'), prec: 'immediate' });
    const bundles = A.n.exportBundles();
    // A tampered copy ahead of the genuine one is refused; the genuine one is then admitted.
    bundles.unshift({ ...bundles[0], body: bundles[0].body.slice(0, -3) + 'AAA' });
    const file = await writeCarryFile(meshId, bundles);
    const { manifest, bundles: read } = await readCarryFile(file);
    expect(manifest.count).toBe(2);
    const verdicts = await B.n.importBundles(read);
    expect(verdicts).toEqual({ stored: 1, 'body-mismatch': 1 });
    expect(B.got.map((d) => new TextDecoder().decode(d.body))).toEqual(['clinic open 8–12']);
    const corrupt = file.slice(); corrupt[corrupt.length - 5] ^= 0xff;
    await expect(readCarryFile(corrupt)).rejects.toThrow();
  });

  it('WebRTC pairing codes round-trip an SDP and refuse what is not a code', () => {
    const sdp = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 'a=extmap:1 urn:x', 'a=candidate:1 1 udp 2122260223 192.168.43.12 54321 typ host', 'a=fingerprint:sha-256 AA:BB', ''].join('\r\n');
    const code = encodeSignal({ type: 'offer', sdp });
    expect(code.startsWith('CPZM1O')).toBe(true);
    const back = decodeSignal(code);
    expect(back.type).toBe('offer');
    expect(back.sdp).toContain('typ host');
    expect(back.sdp).not.toContain('extmap');
    expect(decodeSignal(encodeSignal({ type: 'answer', sdp })).type).toBe('answer');
    expect(() => decodeSignal('hello')).toThrow();
  });

  it('registers the mesh carriers in the transport namespace', () => {
    for (const id of ['mesh-dtn', 'ble-gatt', 'webrtc-datachannel', 'lora']) expect(resolveTransportType(id)?.mdmAddress).toContain(id);
    expect(resolveTransportType('ble')?.id).toBe('ble-gatt');
  });
});

describe('v15-13-00 mesh evals (quick scale)', () => {
  it('dense, hostile, captured-device and receipt-forgery scenarios meet their thresholds', async () => {
    const report = await runMeshEvals({ scale: 'quick', only: ['dense-connected', 'hostile-injection', 'captured-device', 'receipt-forgery'] });
    for (const o of report.outcomes) expect({ id: o.id, failed: o.checks.filter((c) => !c.pass) }).toEqual({ id: o.id, failed: [] });
    expect(report.outcomes).toHaveLength(4);
  }, 120_000);
});
