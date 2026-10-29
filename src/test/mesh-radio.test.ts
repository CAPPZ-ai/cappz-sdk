import { describe, it, expect } from 'vitest';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import { utf8 } from '../lib/identity/canonical';
import { createCharter, grantMembership, meshIdOf } from '../lib/mesh/meshIdentity';
import { MeshNode, provisionMeshDevice, type Delivery } from '../lib/mesh/meshNode';
import { RadioMedium, AirtimeBudget, loraTimeOnAirMs, loraBitRate, type PacketRadio } from '../lib/mesh/meshRadio';
import { kissEncode, KissDecoder, rnodeConfigFrames, RNODE, FEND, FESC } from '../lib/mesh/kiss';
import { attachNativeBridge, type NativeHost, type NativeIn, type NativeOut } from '../lib/mesh/meshNative';

const wallet = () => keyPairFromPhrase(generateRecoveryPhrase());
const until = async (f: () => boolean, ms = 20_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

async function nodes(n: number) {
  const auth = wallet();
  const charter = await createCharter(auth.privateKey, { name: 'radio', authorities: [auth.address] });
  const meshId = await meshIdOf(charter);
  const out: Array<{ node: MeshNode; got: Delivery[]; address: string; encKey: string }> = [];
  for (let i = 0; i < n; i++) {
    const w = wallet();
    const grant = await grantMembership(auth.privateKey, { meshId, authority: auth.address, member: w.address, role: 'member' });
    const identity = await provisionMeshDevice({ walletPrivateKey: w.privateKey, walletAddress: w.address, grant });
    const got: Delivery[] = [];
    out.push({ node: await MeshNode.create({ charter, identity, channels: ['alerts'], onDeliver: (d) => got.push(d) }), got, address: w.address, encKey: identity.encryptionDeclaration!.publicKey });
  }
  return out;
}

describe('v15-13-00 LoRa airtime and duty cycle', () => {
  it('matches the Semtech time-on-air formula', () => {
    // 64-byte payload, SF7, 125 kHz, CR 4/5, 8-symbol preamble, explicit header, CRC: 118.0 ms (Semtech calculator).
    expect(loraTimeOnAirMs(64, { sf: 7, bandwidth: 125_000, cr: 1 })).toBeCloseTo(118.0, 0);
    expect(loraTimeOnAirMs(255, { sf: 12, bandwidth: 125_000, cr: 1 })).toBeGreaterThan(9000); // SF12 uses low-data-rate optimisation
    expect(loraBitRate({ sf: 7, bandwidth: 125_000, cr: 1 })).toBeCloseTo(5468.75, 1);
  });

  it('an airtime budget never lets a radio exceed its duty cycle', () => {
    let t = 0;
    const b = new AirtimeBudget(0.01, 3600_000, () => t);
    expect(b.waitFor(36_000)).toBe(0);
    b.spend(36_000);
    expect(b.waitFor(100)).toBe(10_000); // 100 ms of air needs 10 s at 1%
    t += 10_000;
    expect(b.waitFor(100)).toBe(0);
    expect(new AirtimeBudget(1).waitFor(1e9)).toBe(0);
  });
});

describe('v15-13-00 KISS framing and RNode configuration', () => {
  it('escapes FEND/FESC, decodes across any chunking, and bounds frames', () => {
    const data = Uint8Array.of(1, FEND, 2, FESC, 3);
    const enc = kissEncode(RNODE.DATA, data);
    expect([...enc]).toEqual([0xc0, 0x00, 1, 0xdb, 0xdc, 2, 0xdb, 0xdd, 3, 0xc0]);
    const d = new KissDecoder();
    const frames = [...enc, ...kissEncode(RNODE.SF, Uint8Array.of(9))].flatMap((b) => d.push(Uint8Array.of(b)));
    expect(frames).toEqual([{ command: 0, data }, { command: RNODE.SF, data: Uint8Array.of(9) }]);
    const small = new KissDecoder(4);
    expect(small.push(kissEncode(0, new Uint8Array(10)))).toEqual([]);
    expect(small.dropped).toBe(1);
  });

  it('encodes RNode settings big-endian, ending with radio on', () => {
    const f = rnodeConfigFrames({ frequency: 868_100_000, bandwidth: 125_000, txPower: 14, sf: 9, cr: 5 });
    const d = new KissDecoder();
    const decoded = f.flatMap((x) => d.push(x));
    expect(decoded.map((x) => x.command)).toEqual([RNODE.FREQUENCY, RNODE.BANDWIDTH, RNODE.TXPOWER, RNODE.SF, RNODE.CR, RNODE.RADIO_STATE]);
    expect(new DataView(decoded[0].data.buffer).getUint32(0)).toBe(868_100_000);
    expect(decoded[5].data[0]).toBe(RNODE.RADIO_STATE_ON);
  });
});

describe('v15-13-00 mesh over a shared radio channel', () => {
  it('A reaches C only through B on a LoRa-sized channel; a sealed message arrives', async () => {
    const [A, B, C] = await nodes(3);
    // Range: A–B and B–C hear each other; A and C do not.
    const hears: Record<number, number[]> = { 0: [1], 1: [0, 2], 2: [1] };
    const listeners: Array<(p: Uint8Array) => void> = [];
    let packets = 0;
    const radio = (i: number): PacketRadio => ({
      mtu: 255, carrier: 'lora',
      send: (p) => { packets++; for (const j of hears[i]) setTimeout(() => listeners[j]?.(p.slice()), 1); },
      onPacket: (cb) => { listeners[i] = cb; },
      airtimeMs: (n) => loraTimeOnAirMs(n, { sf: 7, bandwidth: 125_000, cr: 1 }),
    });
    const media = [A, B, C].map((x, i) => new RadioMedium(x.node, radio(i), { dutyCycle: 1 }));
    for (const m of media) await m.start();
    A.node.contacts.set(C.address, C.encKey);
    const sent = await A.node.send({ to: C.address, body: utf8('ford is passable'), prec: 'priority' });
    expect(sent.result.verdict).toBe('admitted');
    expect(await until(() => C.got.some((d) => new TextDecoder().decode(d.body) === 'ford is passable'))).toBe(true);
    expect(C.got[0].hops).toBe(2);
    expect(media[1].stats.neighbours).toBe(2);
    expect(media[0].stats.neighbours).toBe(1);
    const air = media.reduce((n, m) => n + m.stats.airtimeMs, 0);
    expect(air).toBeGreaterThan(0);
    for (const m of media) m.stop();
    expect(packets).toBeGreaterThan(10);
  }, 30_000);
});

describe('v15-13-00 native shell bridge', () => {
  it('two web nodes linked through fake native shells exchange a message; peers still pass the signed hello', async () => {
    const [A, B] = await nodes(2);
    const listeners: Record<string, (m: NativeIn) => void> = {};
    const host = (me: string, other: string): NativeHost => ({
      listen: (cb) => { listeners[me] = cb; },
      post: (m: NativeOut) => {
        if (m.t === 'start') setTimeout(() => listeners[me]?.({ t: 'up', peer: other, carrier: 'multipeer' }), 5);
        if (m.t === 'send') setTimeout(() => listeners[other]?.({ t: 'data', peer: me, b64: m.b64 }), 1);
      },
    });
    attachNativeBridge(A.node, host('A', 'B'));
    attachNativeBridge(B.node, host('B', 'A'));
    expect(await until(() => A.node.peerCount === 1 && B.node.peerCount === 1)).toBe(true);
    await A.node.broadcast({ channel: 'alerts', body: utf8('generator at the depot'), prec: 'priority' });
    expect(await until(() => B.got.some((d) => d.channel === 'alerts'))).toBe(true);
    listeners.A({ t: 'down', peer: 'B' });
    expect(A.node.peerCount).toBe(0);
  }, 30_000);
});
