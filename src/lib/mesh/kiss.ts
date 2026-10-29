/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-kiss
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * KISS framing (the TNC serial protocol) for packet radios on a serial port,
 * and the RNode extensions that configure a LoRa RNode (the open firmware used
 * by Reticulum; it runs on common ESP32 / SX127x / SX126x boards such as
 * LilyGO T-Beam and Heltec). With these, a LoRa board plugged into a laptop,
 * a Raspberry Pi or an Android phone (USB-OTG) becomes a PacketRadio for
 * meshRadio.ts.
 *
 *   C0 <command> <data, with C0 → DB DC and DB → DB DD> C0
 *
 * Command 0x00 is data on port 0 for any KISS TNC. The RNode commands below
 * set frequency, bandwidth, power, spreading factor and coding rate and turn
 * the radio on; a plain KISS TNC ignores them.
 *
 * Legal: licence-free LoRa (EU 863–870 MHz, US 902–928 MHz) allows encrypted
 * traffic within power and airtime limits. Amateur radio bands generally
 * forbid encryption: sealed direct messages must not be sent over a KISS TNC
 * on amateur frequencies.
 *
 * Status: framing and RNode command encoding are unit-tested and the whole
 * path ran over a virtual serial pair; not yet against RNode hardware.
 */

export const FEND = 0xc0, FESC = 0xdb, TFEND = 0xdc, TFESC = 0xdd;

export const RNODE = {
  DATA: 0x00,
  FREQUENCY: 0x01,
  BANDWIDTH: 0x02,
  TXPOWER: 0x03,
  SF: 0x04,
  CR: 0x05,
  RADIO_STATE: 0x06,
  DETECT: 0x08,
  DETECT_REQ: 0x73,
  DETECT_RESP: 0x46,
  RADIO_STATE_ON: 0x01,
  RADIO_STATE_OFF: 0x00,
} as const;

export function kissEncode(command: number, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out: number[] = [FEND, command & 0xff];
  for (const b of data) {
    if (b === FEND) out.push(FESC, TFEND);
    else if (b === FESC) out.push(FESC, TFESC);
    else out.push(b);
  }
  out.push(FEND);
  return Uint8Array.from(out);
}

/** Incremental decoder: feed serial bytes in any chunking, get whole frames. Bounded. */
export class KissDecoder {
  private buf: number[] = [];
  private inFrame = false;
  private esc = false;
  dropped = 0;
  constructor(private readonly maxFrame = 1024) {}

  push(bytes: Uint8Array): Array<{ command: number; data: Uint8Array }> {
    const out: Array<{ command: number; data: Uint8Array }> = [];
    for (const b of bytes) {
      if (b === FEND) {
        if (this.inFrame && this.buf.length) out.push({ command: this.buf[0], data: Uint8Array.from(this.buf.slice(1)) });
        this.buf = []; this.inFrame = true; this.esc = false;
        continue;
      }
      if (!this.inFrame) continue;
      if (this.esc) { this.buf.push(b === TFEND ? FEND : b === TFESC ? FESC : b); this.esc = false; }
      else if (b === FESC) this.esc = true;
      else this.buf.push(b);
      if (this.buf.length > this.maxFrame) { this.buf = []; this.inFrame = false; this.dropped++; }
    }
    return out;
  }
}

export interface RNodeConfig {
  /** Hz, e.g. 868_100_000 or 915_000_000. */
  frequency: number;
  /** Hz: 125000, 250000, 500000 … */
  bandwidth: number;
  /** dBm. */
  txPower: number;
  sf: number;
  /** 5–8 meaning 4/5 … 4/8 (RNode convention). */
  cr: number;
}

const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };

/** The frames that configure an RNode and switch its radio on, in order. */
export function rnodeConfigFrames(c: RNodeConfig): Uint8Array[] {
  return [
    kissEncode(RNODE.FREQUENCY, u32(c.frequency)),
    kissEncode(RNODE.BANDWIDTH, u32(c.bandwidth)),
    kissEncode(RNODE.TXPOWER, Uint8Array.of(c.txPower & 0xff)),
    kissEncode(RNODE.SF, Uint8Array.of(c.sf)),
    kissEncode(RNODE.CR, Uint8Array.of(c.cr)),
    kissEncode(RNODE.RADIO_STATE, Uint8Array.of(RNODE.RADIO_STATE_ON)),
  ];
}

export const rnodeDetectFrame = () => kissEncode(RNODE.DETECT, Uint8Array.of(RNODE.DETECT_REQ));

/** Region presets: frequency and duty cycle a node must respect (check your country's rules). */
export const LORA_REGIONS = {
  eu868: { frequency: 869_525_000, bandwidth: 125_000, dutyCycle: 0.1, note: 'EU 869.4–869.65 MHz sub-band: 10% duty cycle, 500 mW ERP' },
  eu868_1pct: { frequency: 868_100_000, bandwidth: 125_000, dutyCycle: 0.01, note: 'EU 868.0–868.6 MHz: 1% duty cycle, 25 mW ERP' },
  us915: { frequency: 915_000_000, bandwidth: 500_000, dutyCycle: 1, note: 'US 902–928 MHz: no duty cycle for ≥500 kHz digital modulation; 1 W conducted' },
} as const;
