/**
 * COPE node crystallized.
 * Node ID: v15-09-00-identity-canonical
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Canonical JSON (keys sorted at every depth, no whitespace, undefined
 * dropped) and the byte helpers the identity modules share. Web-standard
 * APIs only, so the same code runs in browsers, the edge node (Deno) and tests.
 */

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function fromHex(h: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(h)) throw new Error('not hex');
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
}

export function toBase64Url(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export const utf8 = (s: string) => new TextEncoder().encode(s);

/** A fresh ArrayBuffer copy (WebCrypto rejects views over shared or offset buffers in some runtimes). */
export const buf = (b: Uint8Array): ArrayBuffer => { const c = new Uint8Array(b.byteLength); c.set(b); return c.buffer; };

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf(bytes)));
}

export async function sha256HexOf(text: string): Promise<string> {
  return toHex(await sha256(utf8(text)));
}
