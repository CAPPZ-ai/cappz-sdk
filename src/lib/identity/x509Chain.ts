/**
 * COPE node crystallized.
 * Node ID: v15-16-00-x509-chain
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Certificate chains for hardware attestation (Apple, Android, TPM, FIDO):
 * a strict DER reader that also handles high tag numbers (Android key
 * attestation uses [702] and friends), certificate inspection with the
 * extensions attestation formats rely on, signature checks for the
 * algorithms those chains use (ECDSA P-256 / P-384 / P-521 with SHA-256/384/512,
 * RSA PKCS#1 v1.5, Ed25519), and path validation to pinned anchors.
 *
 * CAPPZ's own trust stays in wallet key declarations (x509.ts projects those);
 * this module only answers "did a vendor's hardware make this key".
 */
import { buf, sha256, toHex } from './canonical';

// ─── DER ────────────────────────────────────────────────────────────────

export interface DerNode { cls: number; constructed: boolean; tag: number; start: number; end: number; headerStart: number }

/** Read one TLV at `at`. Definite lengths only, minimal length encodings, never past `limit`. */
export function derRead(b: Uint8Array, at: number, limit = b.length): DerNode {
  const fail = (why: string): never => { throw new Error(`der: ${why}`); };
  if (at + 2 > limit) fail('truncated');
  const first = b[at];
  let p = at + 1;
  let tag = first & 0x1f;
  if (tag === 0x1f) {
    tag = 0;
    for (let i = 0; ; i++) {
      if (p >= limit || i > 3) fail('bad tag');
      const x = b[p++];
      tag = (tag << 7) | (x & 0x7f);
      if (!(x & 0x80)) break;
    }
  }
  if (p >= limit) fail('truncated');
  let len = b[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0) fail('indefinite length');
    if (n > 4 || p + n > limit) fail('bad length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++];
    if (len < 0x80 || (n > 1 && len < 1 << (8 * (n - 1)))) fail('non-minimal length');
  }
  if (p + len > limit) fail('truncated');
  return { cls: first >> 6, constructed: (first & 0x20) !== 0, tag, start: p, end: p + len, headerStart: at };
}

export function derChildren(b: Uint8Array, n: DerNode): DerNode[] {
  const out: DerNode[] = [];
  for (let p = n.start; p < n.end;) { const c = derRead(b, p, n.end); out.push(c); p = c.end; }
  return out;
}

export function oidText(b: Uint8Array): string {
  if (!b.length) throw new Error('der: empty OID');
  const parts = [Math.min(2, Math.floor(b[0] / 40)), b[0] - 40 * Math.min(2, Math.floor(b[0] / 40))];
  let v = 0;
  for (let i = 1; i < b.length; i++) { v = v * 128 + (b[i] & 0x7f); if (!(b[i] & 0x80)) { parts.push(v); v = 0; } }
  return parts.join('.');
}

const bytesOf = (b: Uint8Array, n: DerNode) => b.subarray(n.start, n.end);
const same = (a: Uint8Array, c: Uint8Array) => a.length === c.length && a.every((x, i) => x === c[i]);

// ─── Certificates ───────────────────────────────────────────────────────

export const OIDS = {
  ecPublicKey: '1.2.840.10045.2.1', rsaEncryption: '1.2.840.113549.1.1.1', ed25519: '1.3.101.112',
  p256: '1.2.840.10045.3.1.7', p384: '1.3.132.0.34', p521: '1.3.132.0.35',
  ecdsaSha256: '1.2.840.10045.4.3.2', ecdsaSha384: '1.2.840.10045.4.3.3', ecdsaSha512: '1.2.840.10045.4.3.4',
  rsaSha256: '1.2.840.113549.1.1.11', rsaSha384: '1.2.840.113549.1.1.12', rsaSha512: '1.2.840.113549.1.1.13',
  basicConstraints: '2.5.29.19', extKeyUsage: '2.5.29.37', subjectAltName: '2.5.29.17',
} as const;

export interface CertExtension { critical: boolean; value: Uint8Array }

export interface CertDetail {
  der: Uint8Array;
  sha256: string;
  version: number;
  serialHex: string;
  tbs: Uint8Array;
  signatureOid: string;
  signature: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  /** SubjectPublicKeyInfo DER, for WebCrypto import. */
  spki: Uint8Array;
  keyAlgorithmOid: string;
  /** Curve OID for EC keys. */
  keyParameterOid?: string;
  /** The BIT STRING contents of the key (EC point, RSA key DER, Ed25519 key). */
  publicKey: Uint8Array;
  extensions: Map<string, CertExtension>;
  /** basicConstraints cA, when the extension is present. */
  isCA?: boolean;
}

function parseTime(b: Uint8Array, n: DerNode): Date {
  const s = new TextDecoder().decode(bytesOf(b, n));
  const y = n.tag === 0x17 ? (Number(s.slice(0, 2)) < 50 ? 2000 : 1900) + Number(s.slice(0, 2)) : Number(s.slice(0, 4));
  const r = n.tag === 0x17 ? s.slice(2) : s.slice(4);
  const d = new Date(Date.UTC(y, Number(r.slice(0, 2)) - 1, Number(r.slice(2, 4)), Number(r.slice(4, 6)), Number(r.slice(6, 8)), Number(r.slice(8, 10))));
  if (Number.isNaN(d.getTime())) throw new Error('der: bad time');
  return d;
}

export async function inspectCertificate(der: Uint8Array): Promise<CertDetail> {
  const cert = derRead(der, 0);
  if (cert.end !== der.length) throw new Error('x509: trailing bytes');
  const [tbsN, sigAlgN, sigN] = derChildren(der, cert);
  if (!tbsN || !sigAlgN || !sigN || sigN.tag !== 0x03) throw new Error('x509: not a certificate');
  const parts = derChildren(der, tbsN);
  let i = 0;
  let version = 1;
  if (parts[0].cls === 2 && parts[0].tag === 0) {
    // [0] EXPLICIT Version: v1(0) .. v3(2)
    const v = derRead(der, parts[0].start, parts[0].end);
    version = v.end - v.start === 1 ? der[v.start] + 1 : 0;
    i = 1;
  }
  const serialN = parts[i], issuerN = parts[i + 2], validityN = parts[i + 3], subjectN = parts[i + 4], spkiN = parts[i + 5];
  const [nb, na] = derChildren(der, validityN);
  const [algSeq, keyBits] = derChildren(der, spkiN);
  const [algOidN, paramN] = derChildren(der, algSeq);
  const extensions = new Map<string, CertExtension>();
  let isCA: boolean | undefined;
  const extsWrap = parts.find((p) => p.cls === 2 && p.tag === 3);
  if (extsWrap) {
    for (const e of derChildren(der, derRead(der, extsWrap.start))) {
      const f = derChildren(der, e);
      const id = oidText(bytesOf(der, f[0]));
      const critical = f.length === 3 && f[1].tag === 0x01 && der[f[1].start] !== 0;
      const value = bytesOf(der, f[f.length - 1]).slice();
      if (extensions.has(id)) throw new Error('x509: duplicate extension');
      extensions.set(id, { critical, value });
      if (id === OIDS.basicConstraints) {
        const bc = derRead(value, 0);
        const first = derChildren(value, bc)[0];
        isCA = !!first && first.tag === 0x01 && value[first.start] !== 0;
      }
    }
  }
  const sigBits = bytesOf(der, sigN);
  return {
    der, sha256: toHex(await sha256(der)), version, serialHex: toHex(bytesOf(der, serialN)),
    tbs: der.slice(tbsN.headerStart, tbsN.end), signatureOid: oidText(bytesOf(der, derChildren(der, sigAlgN)[0])),
    signature: sigBits.slice(1), issuer: der.slice(issuerN.headerStart, issuerN.end), subject: der.slice(subjectN.headerStart, subjectN.end),
    notBefore: parseTime(der, nb), notAfter: parseTime(der, na),
    spki: der.slice(spkiN.headerStart, spkiN.end), keyAlgorithmOid: oidText(bytesOf(der, algOidN)),
    keyParameterOid: paramN && paramN.tag === 0x06 ? oidText(bytesOf(der, paramN)) : undefined,
    publicKey: bytesOf(der, keyBits).slice(1), extensions, isCA,
  };
}

/** Is a name empty (an empty SEQUENCE)? TPM AIK certificates must have an empty subject. */
export const emptyName = (name: Uint8Array) => name.length === 2 && name[0] === 0x30 && name[1] === 0;

// ─── Signatures ─────────────────────────────────────────────────────────

const CURVES: Record<string, { name: string; size: number }> = {
  [OIDS.p256]: { name: 'P-256', size: 32 }, [OIDS.p384]: { name: 'P-384', size: 48 }, [OIDS.p521]: { name: 'P-521', size: 66 },
};
const HASH_OF: Record<string, string> = {
  [OIDS.ecdsaSha256]: 'SHA-256', [OIDS.ecdsaSha384]: 'SHA-384', [OIDS.ecdsaSha512]: 'SHA-512',
  [OIDS.rsaSha256]: 'SHA-256', [OIDS.rsaSha384]: 'SHA-384', [OIDS.rsaSha512]: 'SHA-512',
};

/** DER ECDSA signature → r||s for a curve of `size` bytes (strict). */
export function ecdsaDerToRawSized(sig: Uint8Array, size: number): Uint8Array {
  const s = derRead(sig, 0);
  if (s.end !== sig.length || s.tag !== 0x10) throw new Error('der: bad ECDSA signature');
  const ints = derChildren(sig, s);
  if (ints.length !== 2 || ints.some((n) => n.tag !== 0x02)) throw new Error('der: bad ECDSA signature');
  const out = new Uint8Array(2 * size);
  ints.forEach((n, k) => {
    let v = bytesOf(sig, n);
    if (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new Error('der: ECDSA integer too long');
    out.set(v, k * size + size - v.length);
  });
  return out;
}

/**
 * Verify `signature` over `data` with the key in `spki` using hash `hash`
 * ('SHA-1' only for TPM statements that declare RS1). `scheme` follows the key.
 */
export async function verifyWithSpki(spki: Uint8Array, keyAlgorithmOid: string, keyParameterOid: string | undefined, hash: string, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  try {
    if (keyAlgorithmOid === OIDS.ecPublicKey) {
      const curve = CURVES[keyParameterOid ?? ''];
      if (!curve) return false;
      const key = await crypto.subtle.importKey('spki', buf(spki), { name: 'ECDSA', namedCurve: curve.name }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'ECDSA', hash }, key, buf(ecdsaDerToRawSized(signature, curve.size)), buf(data));
    }
    if (keyAlgorithmOid === OIDS.rsaEncryption) {
      const key = await crypto.subtle.importKey('spki', buf(spki), { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
      return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, buf(signature), buf(data));
    }
    if (keyAlgorithmOid === OIDS.ed25519) {
      const key = await crypto.subtle.importKey('spki', buf(spki), { name: 'Ed25519' }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'Ed25519' }, key, buf(signature), buf(data));
    }
  } catch { /* unsupported or malformed: not verified */ }
  return false;
}

/** Was `cert` signed by `issuer`'s key (names chained, algorithm allowed)? SHA-1 certificate signatures are refused. */
export async function verifyIssuedBy(cert: CertDetail, issuer: CertDetail): Promise<boolean> {
  if (!same(cert.issuer, issuer.subject)) return false;
  const hash = cert.signatureOid === OIDS.ed25519 ? 'none' : HASH_OF[cert.signatureOid];
  if (!hash) return false;
  return verifyWithSpki(issuer.spki, issuer.keyAlgorithmOid, issuer.keyParameterOid, hash, cert.signature, cert.tbs);
}

export interface ChainResult { ok: boolean; anchor?: string; because: string }

/**
 * Validate leaf → … → anchor. Every certificate must be within its validity
 * period at `now`; every issuer must be a CA; the top certificate must be an
 * anchor or be issued by one. Anchors are trusted as given (pinned by hash).
 */
export async function verifyChain(chain: readonly CertDetail[], anchors: readonly CertDetail[], now: Date): Promise<ChainResult> {
  if (!chain.length) return { ok: false, because: 'empty chain' };
  if (chain.length > 8) return { ok: false, because: 'chain too long' };
  for (const c of chain) if (now < c.notBefore || now > c.notAfter) return { ok: false, because: `certificate ${c.sha256.slice(0, 12)} outside its validity period` };
  for (let i = 0; i + 1 < chain.length; i++) {
    if (chain[i + 1].isCA !== true) return { ok: false, because: `certificate ${i + 1} is not a CA` };
    if (!(await verifyIssuedBy(chain[i], chain[i + 1]))) return { ok: false, because: `certificate ${i} is not signed by certificate ${i + 1}` };
  }
  // RFC 5280 §6.1.1(d): a trust anchor is a name and a public key, not one
  // certificate file. Vendors reissue roots for the same key (Google's RSA
  // attestation root exists as 2016–2026 and 2022–2042 certificates), so a
  // chain that ends at the same name and key ends at the anchor. The chain's
  // own certificates must still be valid at `now` (checked above).
  const top = chain[chain.length - 1];
  const pinned = anchors.find((a) => a.sha256 === top.sha256 || (same(a.subject, top.subject) && same(a.spki, top.spki)));
  if (pinned) return { ok: true, anchor: pinned.sha256, because: 'chain ends at a pinned root key' };
  for (const a of anchors) {
    if (await verifyIssuedBy(top, a)) return { ok: true, anchor: a.sha256, because: 'chain is issued by a pinned root key' };
  }
  return { ok: false, because: anchors.length ? 'chain does not end at a pinned root' : 'no roots to anchor to' };
}

export async function certificatesFromPem(pems: readonly string[]): Promise<CertDetail[]> {
  return Promise.all(pems.map((p) => {
    const b64 = p.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
    const bin = atob(b64);
    return inspectCertificate(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }));
}
