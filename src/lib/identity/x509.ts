/**
 * COPE node crystallized.
 * Node ID: v15-09-00-x509-projection
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * X.509 is a projection of a wallet key declaration, never the source of
 * trust. A certificate here is self-signed by the key it carries; its SAN
 * names the wallet (did:key) and the declaration or delegation that binds the
 * key (cappz:keydecl:<sha256>). A verifier trusts the certificate exactly as
 * far as evaluateKey() trusts its public key for purpose 'tls' — so mTLS,
 * QUIC, WebTransport and enterprise clients get the CAPPZ trust states, and
 * revocation is the wallet's replayed revocation record, not a CRL.
 *
 * Public browser HTTPS is out of scope by design: browsers trust only public
 * CA roots, so nginx/Caddy keeps a public-CA certificate for visitors.
 * WebTransport serverCertificateHashes accepts only ECDSA P-256 certificates
 * valid ≤ 14 days, hence P-256 and the 13-day delegation window.
 *
 * Minimal DER writer and reader (RFC 5280 subset): no dependency, WebCrypto
 * only, runs in browsers, Deno and Node.
 */

import { buf, fromHex, sha256, toHex, utf8 } from './canonical.ts';

// ─── DER writer ───────────────────────────────────────────────────

const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

function len(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}
const tlv = (tag: number, content: Uint8Array) => cat(Uint8Array.of(tag), len(content.length), content);
const seq = (...items: Uint8Array[]) => tlv(0x30, cat(...items));
const set = (...items: Uint8Array[]) => tlv(0x31, cat(...items));
const explicit = (n: number, inner: Uint8Array) => tlv(0xa0 + n, inner);
const octets = (b: Uint8Array) => tlv(0x04, b);
const bits = (b: Uint8Array, unused = 0) => tlv(0x03, cat(Uint8Array.of(unused), b));
const bool = (v: boolean) => tlv(0x01, Uint8Array.of(v ? 0xff : 0));

function int(b: Uint8Array): Uint8Array {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0 && !(b[i + 1] & 0x80)) i++;
  const v = b.subarray(i);
  return tlv(0x02, v[0] & 0x80 ? cat(Uint8Array.of(0), v) : v);
}

function oid(dotted: string): Uint8Array {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (let n of rest) {
    const stack = [n & 0x7f];
    while ((n >>= 7) > 0) stack.unshift(0x80 | (n & 0x7f));
    out.push(...stack);
  }
  return tlv(0x06, Uint8Array.from(out));
}

function time(d: Date): Uint8Array {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const body = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  const y = d.getUTCFullYear();
  return y < 2050 ? tlv(0x17, utf8(`${p(y % 100)}${body}`)) : tlv(0x18, utf8(`${p(y, 4)}${body}`));
}

const OID = {
  ed25519: '1.3.101.112',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  clientAuth: '1.3.6.1.5.5.7.3.2',
} as const;

const name = (cn: string, org?: string) => seq(
  ...(org ? [set(seq(oid(OID.organization), tlv(0x0c, utf8(org))))] : []),
  set(seq(oid(OID.commonName), tlv(0x0c, utf8(cn)))),
);

const ext = (id: string, critical: boolean, value: Uint8Array) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

function ipBytes(ip: string): Uint8Array | null {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return Uint8Array.from(ip.split('.').map(Number));
  if (!ip.includes(':')) return null;
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : []; const t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return null;
  return Uint8Array.from(groups.flatMap((g) => { const n = parseInt(g || '0', 16); return [n >> 8, n & 0xff]; }));
}

/** ECDSA signatures from WebCrypto are r||s; X.509 wants SEQUENCE { r INTEGER, s INTEGER }. */
function ecdsaRawToDer(raw: Uint8Array): Uint8Array {
  const h = raw.length / 2;
  return seq(int(raw.subarray(0, h)), int(raw.subarray(h)));
}

function ecdsaDerToRaw(der: Uint8Array, size = 32): Uint8Array {
  const s = read(der, 0); const r = read(der, s.start); const t = read(der, r.end);
  const pad = (b: Uint8Array) => { const v = b[0] === 0 ? b.subarray(1) : b; const out = new Uint8Array(size); out.set(v, size - v.length); return out; };
  return cat(pad(der.subarray(r.start, r.end)), pad(der.subarray(t.start, t.end)));
}

export type CertKeyAlgorithm = 'ed25519' | 'p256';

export interface CertificateRequest {
  /** The key the certificate carries and is self-signed with (WebCrypto CryptoKeyPair). */
  keyPair: CryptoKeyPair;
  algorithm: CertKeyAlgorithm;
  commonName: string;
  organization?: string;
  dnsNames?: string[];
  ipAddresses?: string[];
  /** e.g. did:key:… of the wallet, cappz:keydecl:<sha256> of the declaration or delegation. */
  uris?: string[];
  notBefore?: Date;
  notAfter: Date;
  serial?: Uint8Array;
  /**
   * v15-11-00: sign with an issuer instead of self-signing — used to build a
   * conventional CA chain as the X.509 baseline the trust comparison measures
   * against (trustComparison.ts). CAPPZ projections stay self-signed.
   */
  issuer?: { keyPair: CryptoKeyPair; algorithm: CertKeyAlgorithm; commonName: string; organization?: string };
  /** This certificate is a CA (basicConstraints cA, keyCertSign + cRLSign). */
  ca?: boolean;
}

export interface IssuedCertificate { der: Uint8Array; pem: string; sha256: string; keyPem?: string }

export async function issueSelfSignedCertificate(req: CertificateRequest): Promise<IssuedCertificate> {
  const signer = req.issuer ?? { keyPair: req.keyPair, algorithm: req.algorithm, commonName: req.commonName, organization: req.organization };
  const sigAlg = seq(oid(signer.algorithm === 'ed25519' ? OID.ed25519 : OID.ecdsaSha256));
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', req.keyPair.publicKey));
  const serial = req.serial ?? crypto.getRandomValues(new Uint8Array(16));
  serial[0] &= 0x7f;
  const san = [
    ...(req.dnsNames ?? []).map((d) => tlv(0x82, utf8(d))),
    ...(req.ipAddresses ?? []).map(ipBytes).filter((b): b is Uint8Array => Boolean(b)).map((b) => tlv(0x87, b)),
    ...(req.uris ?? []).map((u) => tlv(0x86, utf8(u))),
  ];
  const extensions = req.ca
    ? [ext(OID.basicConstraints, true, seq(bool(true))), ext(OID.keyUsage, true, bits(Uint8Array.of(0x06), 1))] // keyCertSign + cRLSign
    : [
      ext(OID.basicConstraints, true, seq()),
      ext(OID.keyUsage, true, bits(Uint8Array.of(0x80), 7)), // digitalSignature
      ext(OID.extKeyUsage, false, seq(oid(OID.serverAuth), oid(OID.clientAuth))),
      ...(san.length ? [ext(OID.subjectAltName, false, seq(...san))] : []),
    ];
  const subject = name(req.commonName, req.organization);
  const issuerName = name(signer.commonName, signer.organization);
  const tbs = seq(
    explicit(0, int(Uint8Array.of(2))), int(serial), sigAlg, issuerName,
    seq(time(req.notBefore ?? new Date(Date.now() - 60_000)), time(req.notAfter)),
    subject, spki, explicit(3, seq(...extensions)),
  );
  const params = signer.algorithm === 'ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' };
  let sig: Uint8Array = new Uint8Array(await crypto.subtle.sign(params, signer.keyPair.privateKey, buf(tbs)));
  if (signer.algorithm === 'p256') sig = ecdsaRawToDer(sig);
  const der = seq(tbs, sigAlg, bits(sig));
  let keyPem: string | undefined;
  if (req.keyPair.privateKey.extractable) keyPem = toPem('PRIVATE KEY', new Uint8Array(await crypto.subtle.exportKey('pkcs8', req.keyPair.privateKey)));
  return { der, pem: toPem('CERTIFICATE', der), sha256: toHex(await sha256(der)), keyPem };
}

/** v15-11-00: an issued (not self-signed) certificate, for the X.509 baseline chain. */
export const issueCertificate = issueSelfSignedCertificate;

export function toPem(label: string, der: Uint8Array): string {
  let s = '';
  for (const b of der) s += String.fromCharCode(b);
  return `-----BEGIN ${label}-----\n${btoa(s).replace(/.{64}/g, '$&\n').replace(/\n$/, '')}\n-----END ${label}-----\n`;
}

export function fromPem(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ─── DER reader ───────────────────────────────────────────────────

interface Node { tag: number; start: number; end: number; headerStart: number }

function read(b: Uint8Array, at: number): Node {
  if (at + 2 > b.length) throw new Error('truncated DER');
  const tag = b[at];
  let l = b[at + 1]; let p = at + 2;
  if (l & 0x80) {
    // Length of length: at most 4 bytes, all present (a crafted certificate must not shift past 32 bits or read past the end).
    const n = l & 0x7f;
    if (n === 0 || n > 4 || p + n > b.length) throw new Error('bad DER length');
    l = 0; for (let i = 0; i < n; i++) l = l * 256 + b[p++];
  }
  if (p + l > b.length) throw new Error('truncated DER');
  return { tag, start: p, end: p + l, headerStart: at };
}

function children(b: Uint8Array, n: Node): Node[] {
  const out: Node[] = [];
  for (let p = n.start; p < n.end;) { const c = read(b, p); out.push(c); p = c.end; }
  return out;
}

function oidText(b: Uint8Array): string {
  const parts = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) { v = (v << 7) | (b[i] & 0x7f); if (!(b[i] & 0x80)) { parts.push(v); v = 0; } }
  return parts.join('.');
}

function parseTime(b: Uint8Array, tag: number): Date {
  const s = new TextDecoder().decode(b);
  const y = tag === 0x17 ? (Number(s.slice(0, 2)) < 50 ? 2000 : 1900) + Number(s.slice(0, 2)) : Number(s.slice(0, 4));
  const r = tag === 0x17 ? s.slice(2) : s.slice(4);
  return new Date(Date.UTC(y, Number(r.slice(0, 2)) - 1, Number(r.slice(2, 4)), Number(r.slice(4, 6)), Number(r.slice(6, 8)), Number(r.slice(8, 10))));
}

export interface ParsedCertificate {
  der: Uint8Array;
  sha256: string;
  algorithm: CertKeyAlgorithm | 'unsupported';
  /** Raw public key hex (32 bytes Ed25519, SEC1 point for P-256). */
  publicKeyHex: string;
  spki: Uint8Array;
  commonName?: string;
  notBefore: Date;
  notAfter: Date;
  dnsNames: string[];
  uris: string[];
  tbs: Uint8Array;
  signature: Uint8Array;
  selfIssued: boolean;
  /** Serial number, hex (v15-11-00: CRL lookups in the X.509 baseline). */
  serialHex: string;
  issuerCommonName?: string;
}

export async function parseCertificate(pemOrDer: string | Uint8Array): Promise<ParsedCertificate> {
  const der = typeof pemOrDer === 'string' ? fromPem(pemOrDer) : pemOrDer;
  const cert = read(der, 0);
  const [tbsN, sigAlgN, sigN] = children(der, cert);
  const tbsParts = children(der, tbsN);
  const off = tbsParts[0].tag === 0xa0 ? 1 : 0;
  const serialN = tbsParts[off]; const issuerN = tbsParts[off + 2]; const validityN = tbsParts[off + 3]; const subjectN = tbsParts[off + 4]; const spkiN = tbsParts[off + 5];
  const extsN = tbsParts.find((p) => p.tag === 0xa3);
  const sigOid = oidText(der.subarray(children(der, sigAlgN)[0].start, children(der, sigAlgN)[0].end));
  const algorithm = sigOid === OID.ed25519 ? 'ed25519' : sigOid === OID.ecdsaSha256 ? 'p256' : 'unsupported';
  const [algN, keyBits] = children(der, spkiN);
  void algN;
  const publicKey = der.subarray(keyBits.start + 1, keyBits.end);
  const [nb, na] = children(der, validityN);
  const cnOf = (n: Node) => { let cn: string | undefined; for (const rdn of children(der, n)) for (const atv of children(der, rdn)) { const [t, v] = children(der, atv); if (oidText(der.subarray(t.start, t.end)) === OID.commonName) cn = new TextDecoder().decode(der.subarray(v.start, v.end)); } return cn; };
  const commonName = cnOf(subjectN); const issuerCommonName = cnOf(issuerN);
  const dnsNames: string[] = []; const uris: string[] = [];
  if (extsN) for (const e of children(der, children(der, extsN)[0])) {
    const parts = children(der, e);
    if (oidText(der.subarray(parts[0].start, parts[0].end)) !== OID.subjectAltName) continue;
    const value = parts[parts.length - 1];
    const sanSeq = read(der, value.start);
    for (const g of children(der, sanSeq)) {
      const text = new TextDecoder().decode(der.subarray(g.start, g.end));
      if (g.tag === 0x82) dnsNames.push(text);
      if (g.tag === 0x86) uris.push(text);
    }
  }
  const sigBytes = der.subarray(sigN.start + 1, sigN.end);
  const same = (a: Node, b: Node) => toHex(der.subarray(a.start, a.end)) === toHex(der.subarray(b.start, b.end));
  return {
    der, sha256: toHex(await sha256(der)), algorithm, publicKeyHex: toHex(publicKey), spki: der.slice(spkiN.headerStart, spkiN.end),
    commonName, notBefore: parseTime(der.subarray(nb.start, nb.end), nb.tag), notAfter: parseTime(der.subarray(na.start, na.end), na.tag),
    dnsNames, uris, tbs: der.slice(tbsN.headerStart, tbsN.end), signature: sigBytes.slice(), selfIssued: same(issuerN, subjectN),
    serialHex: toHex(der.subarray(serialN.start, serialN.end)).replace(/^00/, ''), issuerCommonName,
  };
}

/** Is the certificate signed by this issuer key (SPKI DER)? Used by the X.509 baseline chain walk. */
export async function verifySignedBy(c: ParsedCertificate, issuerSpki: Uint8Array, issuerAlgorithm: CertKeyAlgorithm): Promise<boolean> {
  try {
    if (issuerAlgorithm === 'ed25519') {
      const k = await crypto.subtle.importKey('spki', buf(issuerSpki), { name: 'Ed25519' }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'Ed25519' }, k, buf(c.signature), buf(c.tbs));
    }
    const k = await crypto.subtle.importKey('spki', buf(issuerSpki), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, buf(ecdsaDerToRaw(c.signature)), buf(c.tbs));
  } catch {
    return false;
  }
}

/** Does the certificate's own key sign it? (Self-signed projection check; trust comes from evaluateKey.) */
export async function verifySelfSignature(c: ParsedCertificate): Promise<boolean> {
  if (c.algorithm === 'unsupported' || !c.selfIssued) return false;
  try {
    if (c.algorithm === 'ed25519') {
      const k = await crypto.subtle.importKey('raw', buf(fromHex(c.publicKeyHex)), { name: 'Ed25519' }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'Ed25519' }, k, buf(c.signature), buf(c.tbs));
    }
    const k = await crypto.subtle.importKey('spki', buf(c.spki), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, buf(ecdsaDerToRaw(c.signature)), buf(c.tbs));
  } catch {
    return false;
  }
}

export const KEYDECL_URI_PREFIX = 'cappz:keydecl:';

/** The declaration/delegation hashes a certificate names in its SAN. */
export function certificateBindings(c: ParsedCertificate): { walletDid?: string; declarationHashes: string[] } {
  return {
    walletDid: c.uris.find((u) => u.startsWith('did:key:')),
    declarationHashes: c.uris.filter((u) => u.startsWith(KEYDECL_URI_PREFIX)).map((u) => u.slice(KEYDECL_URI_PREFIX.length)),
  };
}
