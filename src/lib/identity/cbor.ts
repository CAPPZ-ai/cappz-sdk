/**
 * COPE node crystallized.
 * Node ID: v15-16-00-cbor
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * A strict CBOR (RFC 8949) decoder for what WebAuthn sends: COSE keys,
 * attestation objects and authenticator extension maps. It reads unsigned and
 * negative integers, byte and text strings, arrays, maps, booleans and null,
 * and refuses everything else — indefinite lengths, tags, floats, undefined —
 * along with duplicate map keys, non-shortest length encodings, nesting deeper
 * than 16 and items that run past the input. Attacker-supplied bytes either
 * decode to plain values or throw.
 *
 * Map keys are kept in a Map, since COSE uses integer keys.
 */

export type CborValue = number | bigint | string | Uint8Array | boolean | null | CborValue[] | Map<CborValue, CborValue>;

const MAX_DEPTH = 16;
const MAX_ITEMS = 1 << 16;

class Reader {
  at = 0;
  constructor(readonly b: Uint8Array) {}
  need(n: number): void { if (n < 0 || this.at + n > this.b.length) throw new Error('cbor: truncated'); }
  byte(): number { this.need(1); return this.b[this.at++]; }
  bytes(n: number): Uint8Array { this.need(n); const out = this.b.slice(this.at, this.at + n); this.at += n; return out; }
}

function readArgument(r: Reader, info: number): number | bigint {
  if (info < 24) return info;
  let v: number | bigint;
  if (info === 24) { v = r.byte(); if (v < 24) throw new Error('cbor: non-shortest integer'); return v; }
  if (info === 25) { const x = r.bytes(2); v = (x[0] << 8) | x[1]; if (v < 0x100) throw new Error('cbor: non-shortest integer'); return v; }
  if (info === 26) { const x = r.bytes(4); v = ((x[0] << 24) >>> 0) + (x[1] << 16) + (x[2] << 8) + x[3]; if (v < 0x10000) throw new Error('cbor: non-shortest integer'); return v; }
  if (info === 27) {
    const x = r.bytes(8);
    let big = 0n;
    for (const byte of x) big = (big << 8n) | BigInt(byte);
    if (big < 0x100000000n) throw new Error('cbor: non-shortest integer');
    return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
  }
  throw new Error(info === 31 ? 'cbor: indefinite lengths are not accepted' : 'cbor: reserved additional information');
}

function length(v: number | bigint): number {
  if (typeof v === 'bigint' || v > MAX_ITEMS * 1024) throw new Error('cbor: length too large');
  return v;
}

const keyId = (k: CborValue): string => {
  if (k instanceof Uint8Array) return `b:${Array.from(k).join(',')}`;
  if (typeof k === 'object' && k !== null) throw new Error('cbor: map keys must be integers, strings or bytes');
  return `${typeof k}:${String(k)}`;
};

function item(r: Reader, depth: number): CborValue {
  if (depth > MAX_DEPTH) throw new Error('cbor: nested too deeply');
  const head = r.byte();
  const major = head >> 5;
  const info = head & 0x1f;
  switch (major) {
    case 0: return readArgument(r, info);
    case 1: {
      const v = readArgument(r, info);
      return typeof v === 'bigint' ? -1n - v : -1 - v;
    }
    case 2: return r.bytes(length(readArgument(r, info)));
    case 3: return new TextDecoder('utf-8', { fatal: true }).decode(r.bytes(length(readArgument(r, info))));
    case 4: {
      const n = length(readArgument(r, info));
      if (n > MAX_ITEMS) throw new Error('cbor: array too large');
      const out: CborValue[] = [];
      for (let i = 0; i < n; i++) out.push(item(r, depth + 1));
      return out;
    }
    case 5: {
      const n = length(readArgument(r, info));
      if (n > MAX_ITEMS) throw new Error('cbor: map too large');
      const out = new Map<CborValue, CborValue>();
      const seen = new Set<string>();
      for (let i = 0; i < n; i++) {
        const k = item(r, depth + 1);
        const id = keyId(k);
        if (seen.has(id)) throw new Error('cbor: duplicate map key');
        seen.add(id);
        out.set(k, item(r, depth + 1));
      }
      return out;
    }
    case 6: throw new Error('cbor: tags are not accepted');
    default:
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new Error('cbor: unsupported simple value or float');
  }
}

/** Decode one CBOR item that fills `bytes` exactly. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const r = new Reader(bytes);
  const v = item(r, 0);
  if (r.at !== bytes.length) throw new Error('cbor: trailing bytes');
  return v;
}

/** Decode one CBOR item from the start of `bytes`; returns it and how many bytes it used. */
export function decodeCborPrefix(bytes: Uint8Array): { value: CborValue; used: number } {
  const r = new Reader(bytes);
  const value = item(r, 0);
  return { value, used: r.at };
}

/** Map lookup that tolerates the number/bigint split for small integer keys. */
export function cborGet(m: CborValue | undefined, key: number | string): CborValue | undefined {
  return m instanceof Map ? m.get(key) : undefined;
}
