/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-radio
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * The mesh over a shared packet radio: LoRa (through a KISS modem, kiss.ts),
 * or any radio where one transmission reaches everyone in range and a packet
 * holds a few hundred bytes. The node speaks to one peer per link, so this
 * layer turns the shared channel into one virtual MeshLink per neighbour:
 *
 *   [0]     packet type: 1 announce · 2 fragment
 *   [1..4]  sender radio id (first 4 bytes of sha256(device key))
 *   [5..8]  destination radio id (0xffffffff: everyone)
 *   [9..]   a fragment (meshFragment.ts) of one CPZ1 frame
 *
 * A device announces itself now and then; a neighbour that hears an announce
 * or any packet opens a virtual link to it, and the node's hello follows over
 * that link and authenticates it like any carrier. A neighbour unheard for a
 * while is dropped. Radio ids are only addresses, never trust.
 *
 * Licence-free bands limit airtime (EU 868 MHz: 1% duty cycle in most
 * sub-bands; US 915 MHz: dwell-time rules). Every transmission is charged
 * against an airtime budget computed from the LoRa time-on-air formula, and
 * waits when the budget is spent, so a node never breaks the duty cycle it is
 * configured for. Queued bytes are bounded; the overflow is counted.
 */

import { sha256 } from '../identity/canonical.ts';
import { fragmentFrame, Reassembler, FRAGMENT_HEADER_BYTES } from './meshFragment.ts';
import type { MeshLink, MeshNode } from './meshNode.ts';

export const RADIO_HEADER_BYTES = 9;
const ANNOUNCE = 1, FRAGMENT = 2;
const BROADCAST = 0xffffffff;

export interface LoraParams {
  /** Spreading factor 7–12. */
  sf: number;
  /** Bandwidth in Hz (125000, 250000, 500000). */
  bandwidth: number;
  /** Coding rate 4/(4+cr), cr 1–4. */
  cr: number;
  preamble?: number;
  explicitHeader?: boolean;
  crc?: boolean;
}

/** Semtech SX127x/SX126x time on air for one packet of `bytes` payload, in ms. */
export function loraTimeOnAirMs(bytes: number, p: LoraParams): number {
  const tSym = (2 ** p.sf) / p.bandwidth * 1000;
  const de = tSym > 16 ? 1 : 0; // low data rate optimisation
  const ih = p.explicitHeader === false ? 1 : 0;
  const crc = p.crc === false ? 0 : 1;
  const preamble = ((p.preamble ?? 8) + 4.25) * tSym;
  const n = 8 + Math.max(Math.ceil((8 * bytes - 4 * p.sf + 28 + 16 * crc - 20 * ih) / (4 * (p.sf - 2 * de))) * (p.cr + 4), 0);
  return preamble + n * tSym;
}

/** LoRa bit rate in bit/s (useful for planning: SF7/125 kHz ≈ 5.5 kbit/s, SF12 ≈ 0.29 kbit/s). */
export const loraBitRate = (p: LoraParams) => p.sf * (p.bandwidth / 2 ** p.sf) * (4 / (4 + p.cr));

/** Airtime allowance: accrues at `dutyCycle` of elapsed time, up to one window's worth. */
export class AirtimeBudget {
  private credit: number;
  private at: number;
  spentMs = 0;
  constructor(private readonly dutyCycle: number, private readonly windowMs = 3600_000, private readonly now: () => number = Date.now) {
    this.credit = dutyCycle * windowMs; // a full window to start, as a fresh radio has used nothing
    this.at = now();
  }
  private refill(): void {
    const t = this.now();
    this.credit = Math.min(this.dutyCycle * this.windowMs, this.credit + (t - this.at) * this.dutyCycle);
    this.at = t;
  }
  /** ms to wait before `airMs` may be spent (0 = now). */
  waitFor(airMs: number): number {
    if (this.dutyCycle >= 1) return 0;
    this.refill();
    return this.credit >= airMs ? 0 : Math.ceil((airMs - this.credit) / this.dutyCycle);
  }
  spend(airMs: number): void { this.refill(); this.credit -= airMs; this.spentMs += airMs; }
}

/** A packet radio: one packet out to everyone in range; packets heard come back through `onPacket`. */
export interface PacketRadio {
  mtu: number;
  carrier: string;
  send(packet: Uint8Array): Promise<void> | void;
  onPacket(cb: (packet: Uint8Array) => void): void;
  /** Time on air of one packet, ms (0 = not metered). */
  airtimeMs?(bytes: number): number;
}

export interface RadioMediumOptions {
  /** 0.01 = 1% (EU 868 MHz sub-bands g/g1); 1 = unmetered. */
  dutyCycle?: number;
  announceEveryMs?: number;
  neighbourTimeoutMs?: number;
  /** Bytes queued for the air before new frames are dropped (counted). */
  maxQueueBytes?: number;
  now?: () => number;
  log?: (s: string) => void;
}

interface Neighbour { id: number; link: MeshLink; heard: number; reassembler: Reassembler }

export interface RadioStats { packetsOut: number; packetsIn: number; bytesOut: number; airtimeMs: number; queuedDropped: number; neighbours: number }

export class RadioMedium {
  readonly stats: RadioStats = { packetsOut: 0, packetsIn: 0, bytesOut: 0, airtimeMs: 0, queuedDropped: 0, neighbours: 0 };
  private myId = 0;
  private readonly neighbours = new Map<number, Neighbour>();
  private readonly queue: Uint8Array[] = [];
  private queued = 0;
  private sending = false;
  private nextFrag = 1;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly budget: AirtimeBudget;
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly node: MeshNode, private readonly radio: PacketRadio, private readonly o: RadioMediumOptions = {}) {
    if (radio.mtu < RADIO_HEADER_BYTES + FRAGMENT_HEADER_BYTES + 32) throw new Error('radio packet too small');
    this.now = o.now ?? Date.now;
    this.budget = new AirtimeBudget(o.dutyCycle ?? 1, 3600_000, this.now);
  }

  async start(): Promise<void> {
    this.myId = new DataView((await sha256(new TextEncoder().encode(this.node.identity.deviceKey.publicKeyHex.toLowerCase()))).buffer).getUint32(0);
    this.radio.onPacket((p) => this.onPacket(p));
    this.announce();
    this.timers.push(setInterval(() => this.announce(), this.o.announceEveryMs ?? 60_000));
    this.timers.push(setInterval(() => this.expire(), 15_000));
  }

  stop(): void {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    for (const n of this.neighbours.values()) this.node.linkDown(n.link.id);
    this.neighbours.clear();
  }

  get id(): number { return this.myId; }
  get airtimeSpentMs(): number { return this.budget.spentMs; }

  private header(type: number, dst: number, body: Uint8Array): Uint8Array {
    const p = new Uint8Array(RADIO_HEADER_BYTES + body.byteLength);
    const v = new DataView(p.buffer);
    p[0] = type; v.setUint32(1, this.myId); v.setUint32(5, dst >>> 0);
    p.set(body, RADIO_HEADER_BYTES);
    return p;
  }

  private announce(): void { this.enqueue([this.header(ANNOUNCE, BROADCAST, new Uint8Array(0))], true); }

  private enqueue(packets: Uint8Array[], control = false): void {
    const bytes = packets.reduce((n, p) => n + p.byteLength, 0);
    if (!control && this.queued + bytes > (this.o.maxQueueBytes ?? 64 * 1024)) { this.stats.queuedDropped += packets.length; return; }
    for (const p of packets) this.queue.push(p);
    this.queued += bytes;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length && !this.closed) {
        const p = this.queue[0];
        const air = this.radio.airtimeMs?.(p.byteLength) ?? 0;
        const wait = this.budget.waitFor(air);
        if (wait > 0) { await new Promise((r) => setTimeout(r, Math.min(wait, 60_000))); continue; }
        this.queue.shift(); this.queued -= p.byteLength;
        this.budget.spend(air);
        this.stats.packetsOut++; this.stats.bytesOut += p.byteLength; this.stats.airtimeMs += air;
        await this.radio.send(p);
      }
    } finally { this.sending = false; }
  }

  private neighbour(id: number): Neighbour {
    let n = this.neighbours.get(id);
    if (n) return n;
    const linkId = `${this.radio.carrier}:${id.toString(16).padStart(8, '0')}`;
    const link: MeshLink = {
      id: linkId,
      carrier: this.radio.carrier,
      send: (frame) => this.enqueue(fragmentFrame(this.nextFrag++ >>> 0, frame, this.radio.mtu - RADIO_HEADER_BYTES).map((f) => this.header(FRAGMENT, id, f))),
      close: () => { this.neighbours.delete(id); this.node.linkDown(linkId); },
    };
    n = { id, link, heard: this.now(), reassembler: new Reassembler({ now: this.now, timeoutMs: 10 * 60_000 }) };
    this.neighbours.set(id, n);
    this.stats.neighbours = this.neighbours.size;
    this.o.log?.(`radio neighbour ${linkId}`);
    void this.node.linkUp(link);
    return n;
  }

  private onPacket(p: Uint8Array): void {
    if (this.closed || p.byteLength < RADIO_HEADER_BYTES) return;
    const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const type = p[0], src = v.getUint32(1), dst = v.getUint32(5);
    if (src === this.myId) return;
    this.stats.packetsIn++;
    const n = this.neighbour(src);
    n.heard = this.now();
    if (type !== FRAGMENT || (dst !== this.myId && dst !== BROADCAST)) return;
    const frame = n.reassembler.push(p.subarray(RADIO_HEADER_BYTES));
    if (frame) void this.node.receive(n.link.id, frame);
  }

  private expire(): void {
    const t = this.now();
    for (const n of [...this.neighbours.values()]) if (t - n.heard > (this.o.neighbourTimeoutMs ?? 10 * 60_000)) {
      this.neighbours.delete(n.id);
      this.node.linkDown(n.link.id);
      this.o.log?.(`radio neighbour ${n.link.id} gone`);
    }
    this.stats.neighbours = this.neighbours.size;
  }
}
