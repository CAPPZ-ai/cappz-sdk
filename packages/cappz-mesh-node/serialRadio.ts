/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-serial-radio
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * A LoRa board (RNode firmware) or any KISS TNC on a serial port, as a
 * PacketRadio for the mesh. No dependency: the port is set raw with `stty`
 * and opened as a file, which works on Linux, Raspberry Pi and macOS
 * (/dev/ttyUSB0, /dev/ttyACM0, /dev/cu.usbserial-…). Windows COM ports and
 * Android USB-OTG (termux-usb) need a different opener; not included.
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { KissDecoder, kissEncode, rnodeConfigFrames, rnodeDetectFrame, RNODE, type RNodeConfig } from '../../src/lib/mesh/kiss.ts';
import { loraTimeOnAirMs, type PacketRadio } from '../../src/lib/mesh/meshRadio.ts';

export interface SerialRadioOptions {
  device: string;
  baud?: number;
  /** RNode radio settings; omit for a plain KISS TNC that is configured on its own. */
  rnode?: RNodeConfig;
  /** LoRa packet payload limit (SX127x: 255). */
  mtu?: number;
  log?: (s: string) => void;
}

export async function openSerialRadio(o: SerialRadioOptions): Promise<PacketRadio & { close(): void; detected: boolean }> {
  const log = o.log ?? (() => {});
  const baud = String(o.baud ?? 115200);
  try {
    execFileSync('stty', process.platform === 'darwin' ? ['-f', o.device, baud, 'raw', '-echo'] : ['-F', o.device, baud, 'raw', '-echo', '-hupcl'], { stdio: 'ignore' });
  } catch { log(`stty on ${o.device} failed: continuing (a virtual port needs none)`); }
  const fd = fs.openSync(o.device, fs.constants.O_RDWR | fs.constants.O_NOCTTY);
  const decoder = new KissDecoder();
  const listeners: Array<(p: Uint8Array) => void> = [];
  let detected = false;
  const write = (b: Uint8Array) => new Promise<void>((resolve, reject) => fs.write(fd, b, (e) => (e ? reject(e) : resolve())));
  const stream = fs.createReadStream('', { fd, autoClose: false, highWaterMark: 1024 });
  stream.on('data', (chunk) => {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    for (const f of decoder.push(bytes)) {
      if (f.command === RNODE.DATA) for (const l of listeners) l(f.data);
      else if (f.command === RNODE.DETECT && f.data[0] === RNODE.DETECT_RESP) detected = true;
    }
  });
  stream.on('error', (e) => log(`serial: ${e.message}`));

  if (o.rnode) {
    await write(rnodeDetectFrame());
    await new Promise((r) => setTimeout(r, 600));
    log(detected ? 'RNode detected' : 'no RNode answer: sending configuration anyway (plain KISS TNCs ignore it)');
    for (const f of rnodeConfigFrames(o.rnode)) await write(f);
  }
  const lora = o.rnode ? { sf: o.rnode.sf, bandwidth: o.rnode.bandwidth, cr: o.rnode.cr - 4 } : null;
  return {
    mtu: o.mtu ?? 255,
    carrier: 'lora',
    get detected() { return detected; },
    send: (p) => write(kissEncode(RNODE.DATA, p)),
    onPacket: (cb) => { listeners.push(cb); },
    airtimeMs: lora ? (bytes) => loraTimeOnAirMs(bytes, lora) : undefined,
    close: () => { stream.destroy(); try { fs.closeSync(fd); } catch { /* closed */ } },
  };
}
