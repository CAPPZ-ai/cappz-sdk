import { describe, it, expect } from 'vitest';
import { generateRecoveryPhrase, keyPairFromPhrase } from '../lib/auth/wallet/session';
import { createCharter, grantMembership, meshIdOf } from '../lib/mesh/meshIdentity';
import { MeshNode, provisionMeshDevice, type Delivery } from '../lib/mesh/meshNode';
import { memoryLinkPair } from '../lib/mesh/meshSim';
import { ContactBook, VoiceAssembler, decodeChat, encodeChat, textMessage, splitVoice, sanitizeAlias, EVERYONE_CHANNEL } from '../lib/mesh/meshChat';

const wallet = () => keyPairFromPhrase(generateRecoveryPhrase());
const flush = async (...ns: MeshNode[]) => { for (let i = 0; i < 6; i++) { await Promise.all(ns.map((n) => n.settle())); await new Promise((r) => setTimeout(r, 0)); } };

async function people(n: number) {
  const auth = wallet();
  const charter = await createCharter(auth.privateKey, { name: 'chat', authorities: [auth.address] });
  const meshId = await meshIdOf(charter);
  return Promise.all(Array.from({ length: n }, async () => {
    const w = wallet();
    const grant = await grantMembership(auth.privateKey, { meshId, authority: auth.address, member: w.address, role: 'member' });
    const identity = await provisionMeshDevice({ walletPrivateKey: w.privateKey, walletAddress: w.address, grant });
    const book = new ContactBook();
    const got: Delivery[] = [];
    const node = await MeshNode.create({ charter, identity, channels: [EVERYONE_CHANNEL], isBlocked: (x) => book.isBlocked(x), onContact: (c) => book.learnAlias(c.wallet, c.alias), onDeliver: (d) => got.push(d) });
    return { w, node, book, got, identity };
  }));
}

describe('v15-13-00 mesh messaging', () => {
  it('reads plain text from older senders, round-trips text and voice parts, and reassembles a clip in any order', () => {
    expect(decodeChat(new TextEncoder().encode('hello'))).toEqual({ chat: 1, t: 'text', text: 'hello' });
    expect(decodeChat(textMessage('hi'))).toEqual({ chat: 1, t: 'text', text: 'hi' });
    const audio = crypto.getRandomValues(new Uint8Array(25_000));
    const parts = splitVoice(audio, 'audio/webm', 17_000);
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(encodeChat(p).byteLength).toBeLessThan(16 * 1024);
    const asm = new VoiceAssembler();
    const decoded = parts.map((p) => decodeChat(encodeChat(p)));
    expect(asm.push('w', decoded[2] as never)).toBeNull();
    expect(asm.push('w', decoded[0] as never)).toBeNull();
    const clip = asm.push('w', decoded[1] as never)!;
    expect(clip.audio).toEqual(audio);
    expect(clip.ms).toBe(17_000);
  });

  it('aliases are display text: sanitised, shown with the address, shared names flagged, lookups never guess', () => {
    expect(sanitizeAlias('  Sam\u202e  the\nmedic ')).toBe('Sam the medic');
    expect(sanitizeAlias('x'.repeat(50))).toHaveLength(32);
    const b = new ContactBook();
    const a = '02' + 'a'.repeat(64), c = '03' + 'c'.repeat(64);
    b.learnAlias(a, 'Sam'); b.learnAlias(c, 'sam');
    expect(b.display(a)).toMatch(/^Sam ⚠ \(02aaaa…aaaa\)$/);
    expect(b.find('@Sam')).toHaveLength(2);
    b.setNickname(c, 'Sam from the clinic');
    expect(b.find('sam from the clinic')).toEqual([c]);
    expect(b.display(c)).toBe('Sam from the clinic (03cccc…cccc)');
    expect(b.find('02aaaaaaaa', [a, c])).toEqual([a]);
    expect(b.find('nobody')).toEqual([]);
    const copy = ContactBook.from(JSON.parse(JSON.stringify(b.toJSON())));
    expect(copy.display(c)).toBe(b.display(c));
  });

  it('publishes an alias with the contact, reaches everyone, and a block hides and stops carrying that sender — revocations still apply', async () => {
    const [A, B, C] = await people(3);
    await A.node.publishContact('Ana');
    const ab = memoryLinkPair(A.node, B.node); await ab.up();
    const bc = memoryLinkPair(B.node, C.node); await bc.up();
    await flush(A.node, B.node, C.node);
    expect(B.book.aliasOf(A.w.address)).toBe('Ana');
    expect(C.book.aliasOf(A.w.address)).toBe('Ana');

    await A.node.broadcast({ channel: EVERYONE_CHANNEL, body: textMessage('water at the school'), prec: 'priority' });
    await flush(A.node, B.node, C.node);
    expect(C.got.map((d) => decodeChat(d.body))).toContainEqual({ chat: 1, t: 'text', text: 'water at the school' });

    // B blocks A: A's next message to everyone is neither shown by B nor carried through B to C.
    B.book.block(A.w.address);
    B.node.dropFrom(A.w.address);
    await A.node.broadcast({ channel: EVERYONE_CHANNEL, body: textMessage('spam spam spam'), prec: 'priority' });
    await flush(A.node, B.node, C.node);
    expect(B.got.map((d) => decodeChat(d.body))).not.toContainEqual({ chat: 1, t: 'text', text: 'spam spam spam' });
    expect(C.got.map((d) => decodeChat(d.body))).not.toContainEqual({ chat: 1, t: 'text', text: 'spam spam spam' });
    expect([...B.node.store.values()].some((e) => e.bundle.h.src === A.w.address && e.bundle.h.kind === 'msg')).toBe(false);
    // Unblocked again, later messages flow.
    B.book.unblock(A.w.address);
    await A.node.broadcast({ channel: EVERYONE_CHANNEL, body: textMessage('all clear'), prec: 'priority' });
    await flush(A.node, B.node, C.node);
    expect(C.got.map((d) => decodeChat(d.body))).toContainEqual({ chat: 1, t: 'text', text: 'all clear' });
  });
});
