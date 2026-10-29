/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-chat
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Messaging on the mesh: text and voice messages, names people choose for
 * themselves, a channel that reaches everyone, and a personal block list.
 *
 * Identity is the wallet; a name is display text. Each person publishes an
 * alias with their contact (signed by their declared device key, so nobody
 * can publish a name for someone else), but aliases are not unique: two
 * people may both call themselves "Sam". So a name is always shown with the
 * start of the wallet address, a shared alias is flagged, and each user may
 * set their own nickname for anyone (it wins over the alias, on their device
 * only). Lookups by name that match more than one person are reported as
 * ambiguous, never guessed.
 *
 * Voice messages are recorded clips (Opus / AAC at ~12 kbit/s), store-and-
 * forward like text, split into parts that fit the charter's body limit and
 * reassembled on arrival. Live calls need a live path, which a delay-tolerant
 * mesh does not promise; two phones linked directly could add one later.
 *
 * Blocking is personal: the node neither shows nor carries a blocked wallet's
 * messages (direct or to everyone), and drops what it already carried from
 * it. Revocations, receipts and contacts from that wallet still apply — a
 * block must never switch off security. Mesh-wide removal is a membership
 * revocation by an authority, not a block.
 */

import { canonicalJson, toBase64Url, fromBase64Url, utf8 } from '../identity/canonical.ts';

/** The channel every node reads: messages to everyone. Precedence marks what is important. */
export const EVERYONE_CHANNEL = 'alerts';
export const GENERAL_CHANNEL = 'general';
export const MAX_ALIAS_CHARS = 32;
/** Raw audio bytes per voice part: with base64 and JSON it stays under the default 16 KiB body. */
export const VOICE_PART_BYTES = 10_000;
export const MAX_VOICE_MS = 60_000;

export type ChatPayload =
  | { chat: 1; t: 'text'; text: string }
  | { chat: 1; t: 'voice'; clip: string; i: number; n: number; mime: string; ms: number; data: string };

export const encodeChat = (p: ChatPayload): Uint8Array => utf8(canonicalJson(p));

/** Any body to a chat payload: plain text from older senders reads as text. */
export function decodeChat(bytes: Uint8Array): ChatPayload {
  const s = new TextDecoder().decode(bytes);
  try {
    const p = JSON.parse(s) as ChatPayload;
    if (p && p.chat === 1 && (p.t === 'text' ? typeof p.text === 'string'
      : p.t === 'voice' && typeof p.clip === 'string' && Number.isInteger(p.i) && Number.isInteger(p.n) && p.n > 0 && p.n <= 64 && p.i >= 0 && p.i < p.n && typeof p.data === 'string')) return p;
  } catch { /* plain text */ }
  return { chat: 1, t: 'text', text: s };
}

export const textMessage = (text: string): Uint8Array => encodeChat({ chat: 1, t: 'text', text });

export type VoicePart = Extract<ChatPayload, { t: 'voice' }>;

export function splitVoice(audio: Uint8Array, mime: string, ms: number, partBytes = VOICE_PART_BYTES): VoicePart[] {
  const clip = toBase64Url(crypto.getRandomValues(new Uint8Array(9)));
  const n = Math.max(1, Math.ceil(audio.byteLength / partBytes));
  if (n > 64) throw new Error('voice message too long');
  return Array.from({ length: n }, (_, i) => ({ chat: 1 as const, t: 'voice' as const, clip, i, n, mime, ms, data: toBase64Url(audio.subarray(i * partBytes, (i + 1) * partBytes)) }));
}

export interface VoiceClip { clip: string; from: string; mime: string; ms: number; audio: Uint8Array }

/** Collects voice parts per (sender, clip); returns the clip once every part is in. Bounded; stale clips expire. */
export class VoiceAssembler {
  private readonly parts = new Map<string, { from: string; mime: string; ms: number; n: number; got: Map<number, Uint8Array>; at: number }>();
  constructor(private readonly o: { maxClips?: number; timeoutMs?: number; now?: () => number } = {}) {}

  push(from: string, p: VoicePart): VoiceClip | null {
    const now = (this.o.now ?? Date.now)();
    for (const [k, v] of this.parts) if (now - v.at > (this.o.timeoutMs ?? 24 * 3600_000)) this.parts.delete(k);
    const key = `${from}|${p.clip}`;
    let c = this.parts.get(key);
    if (!c) {
      if (this.parts.size >= (this.o.maxClips ?? 200)) this.parts.delete(this.parts.keys().next().value!);
      c = { from, mime: p.mime, ms: p.ms, n: p.n, got: new Map(), at: now };
      this.parts.set(key, c);
    }
    if (p.n !== c.n) return null;
    c.got.set(p.i, fromBase64Url(p.data));
    if (c.got.size < c.n) return null;
    this.parts.delete(key);
    const chunks = Array.from({ length: c.n }, (_, i) => c!.got.get(i)!);
    const audio = new Uint8Array(chunks.reduce((s, x) => s + x.byteLength, 0));
    let o = 0;
    for (const x of chunks) { audio.set(x, o); o += x.byteLength; }
    return { clip: p.clip, from, mime: c.mime, ms: c.ms, audio };
  }
}

/** Names are display text: no control or direction-override characters (they can make one name look like another), bounded length. */
export function sanitizeAlias(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined;
  const clean = s.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/ +/g, ' ').trim();
  return clean ? [...clean].slice(0, MAX_ALIAS_CHARS).join('') : undefined;
}

export const shortAddress = (wallet: string) => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;

export interface ContactBookData { aliases: Record<string, string>; nicknames: Record<string, string>; blocked: string[] }

export class ContactBook {
  private readonly aliases = new Map<string, string>();
  private readonly nicknames = new Map<string, string>();
  private readonly blockedSet = new Set<string>();
  /** Called whenever the book changes, so the caller can persist it. */
  onChange?: () => void;

  static from(d: Partial<ContactBookData> | null | undefined): ContactBook {
    const b = new ContactBook();
    for (const [w, a] of Object.entries(d?.aliases ?? {})) { const s = sanitizeAlias(a); if (s) b.aliases.set(w, s); }
    for (const [w, a] of Object.entries(d?.nicknames ?? {})) { const s = sanitizeAlias(a); if (s) b.nicknames.set(w, s); }
    for (const w of d?.blocked ?? []) b.blockedSet.add(w);
    return b;
  }

  toJSON(): ContactBookData {
    return { aliases: Object.fromEntries(this.aliases), nicknames: Object.fromEntries(this.nicknames), blocked: [...this.blockedSet] };
  }

  /** An alias the wallet published itself (from a verified contact bundle). */
  learnAlias(wallet: string, alias: unknown): void {
    const s = sanitizeAlias(alias);
    if (!s || this.aliases.get(wallet) === s) return;
    this.aliases.set(wallet, s); this.onChange?.();
  }

  setNickname(wallet: string, nickname: string | null): void {
    const s = nickname === null ? undefined : sanitizeAlias(nickname);
    if (s) this.nicknames.set(wallet, s); else this.nicknames.delete(wallet);
    this.onChange?.();
  }

  aliasOf(wallet: string): string | undefined { return this.aliases.get(wallet); }
  nicknameOf(wallet: string): string | undefined { return this.nicknames.get(wallet); }

  /** Wallets that published this alias (case-insensitive). More than one = shared name. */
  sharing(alias: string): string[] {
    const a = alias.toLowerCase();
    return [...this.aliases.entries()].filter(([, x]) => x.toLowerCase() === a).map(([w]) => w);
  }

  /** "Sam (02ab12…cd34)"; a shared alias is marked; your nickname wins. */
  display(wallet: string): string {
    const nick = this.nicknames.get(wallet);
    if (nick) return `${nick} (${shortAddress(wallet)})`;
    const alias = this.aliases.get(wallet);
    if (!alias) return shortAddress(wallet);
    return `${alias}${this.sharing(alias).length > 1 ? ' ⚠' : ''} (${shortAddress(wallet)})`;
  }

  /** Resolve "@name", a nickname, an alias or an address prefix (≥ 8 chars). Several matches = ambiguous. */
  find(query: string, known: Iterable<string> = []): string[] {
    const q = query.replace(/^@/, '').trim();
    if (!q) return [];
    if (/^[0-9a-f]{66}$/i.test(q)) return [q.toLowerCase()];
    const ql = q.toLowerCase();
    const byNick = [...this.nicknames.entries()].filter(([, n]) => n.toLowerCase() === ql).map(([w]) => w);
    if (byNick.length) return byNick;
    const byAlias = this.sharing(q);
    if (byAlias.length) return byAlias;
    if (/^[0-9a-f]{8,}$/i.test(q)) {
      const all = new Set([...this.aliases.keys(), ...this.nicknames.keys(), ...known]);
      return [...all].filter((w) => w.toLowerCase().startsWith(ql));
    }
    return [];
  }

  block(wallet: string): void { this.blockedSet.add(wallet); this.onChange?.(); }
  unblock(wallet: string): void { this.blockedSet.delete(wallet); this.onChange?.(); }
  isBlocked(wallet: string): boolean { return this.blockedSet.has(wallet); }
  get blocked(): string[] { return [...this.blockedSet]; }
  /** Everyone with a known name. */
  get known(): string[] { return [...new Set([...this.aliases.keys(), ...this.nicknames.keys()])]; }
}
