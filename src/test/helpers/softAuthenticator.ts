/**
 * A software WebAuthn authenticator for tests: real P-256 keys (WebCrypto),
 * real authenticator data, client data, DER signatures and CBOR attestation
 * objects, and the PRF extension computed as the spec defines it
 * (HMAC-SHA-256 over SHA-256("WebAuthn PRF" || 0x00 || input)). Knobs let a
 * test drop user verification, change the origin, or pick the attestation.
 */
import { createHmac, createHash, randomBytes } from 'node:crypto';
import type { WebAuthnPort } from '../../lib/identity/webauthn';

type Cbor = number | string | Uint8Array | boolean | null | Cbor[] | Map<Cbor, Cbor>;

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
export function encodeCbor(v: Cbor): Uint8Array {
  const out: number[] = [];
  const enc = (x: Cbor) => {
    if (typeof x === 'number') { if (x >= 0) out.push(...head(0, x)); else out.push(...head(1, -1 - x)); }
    else if (typeof x === 'string') { const b = Buffer.from(x, 'utf8'); out.push(...head(3, b.length), ...b); }
    else if (x instanceof Uint8Array) { out.push(...head(2, x.length), ...x); }
    else if (x === true) out.push(0xf5); else if (x === false) out.push(0xf4); else if (x === null) out.push(0xf6);
    else if (Array.isArray(x)) { out.push(...head(4, x.length)); x.forEach(enc); }
    else { out.push(...head(5, x.size)); for (const [k, val] of x) { enc(k); enc(val); } }
  };
  enc(v);
  return Uint8Array.from(out);
}

const sha = (b: Uint8Array | string) => new Uint8Array(createHash('sha256').update(b).digest());
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const ab = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const bytesOf = (s: BufferSource): Uint8Array => s instanceof ArrayBuffer ? new Uint8Array(s) : new Uint8Array(s.buffer, s.byteOffset, s.byteLength);

function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (v: Uint8Array) => { let i = 0; while (i < v.length - 1 && v[i] === 0) i++; let t = v.subarray(i); if (t[0] & 0x80) t = Uint8Array.from([0, ...t]); return [0x02, t.length, ...t]; };
  const body = [...int(raw.subarray(0, 32)), ...int(raw.subarray(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

export interface SoftCredential { id: Uint8Array; rpId: string; keys: CryptoKeyPair; publicKeyHex: string; prfSecret: Uint8Array; signCount: number }

export interface SoftAuthenticatorOptions {
  origin?: string;
  userVerified?: boolean;
  /** 'none' (default) or 'packed' self attestation. */
  attestation?: 'none' | 'packed-self';
  /** Answer the PRF extension (default true). */
  prf?: boolean;
}

export class SoftAuthenticator implements WebAuthnPort {
  readonly credentials: SoftCredential[] = [];
  constructor(public opts: SoftAuthenticatorOptions = {}) {}

  private flags(extra = 0): number { return 0x01 | (this.opts.userVerified === false ? 0 : 0x04) | extra; }
  private origin(rpId: string): string { return this.opts.origin ?? `https://${rpId}`; }
  private prfOut(c: SoftCredential, input?: BufferSource): ArrayBuffer | undefined {
    if (!input || this.opts.prf === false) return undefined;
    const salt = sha(Buffer.concat([Buffer.from('WebAuthn PRF'), Buffer.from([0]), Buffer.from(bytesOf(input))]));
    return ab(new Uint8Array(createHmac('sha256', c.prfSecret).update(salt).digest()));
  }

  async create(o: PublicKeyCredentialCreationOptions): Promise<PublicKeyCredential> {
    const rpId = o.rp.id!;
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const point = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    const c: SoftCredential = { id: new Uint8Array(randomBytes(16)), rpId, keys, publicKeyHex: Buffer.from(point).toString('hex'), prfSecret: new Uint8Array(randomBytes(32)), signCount: 0 };
    this.credentials.push(c);
    const cose = new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, point.slice(1, 33)], [-3, point.slice(33)]]);
    const attested = Uint8Array.from([...new Uint8Array(16), c.id.length >> 8, c.id.length & 0xff, ...c.id, ...encodeCbor(cose)]);
    const authData = Uint8Array.from([...sha(rpId), this.flags(0x40), 0, 0, 0, 0, ...attested]);
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.create', challenge: b64url(bytesOf(o.challenge)), origin: this.origin(rpId), crossOrigin: false }));
    let attStmt = new Map<Cbor, Cbor>();
    let fmt = 'none';
    if (this.opts.attestation === 'packed-self') {
      fmt = 'packed';
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Uint8Array.from([...authData, ...sha(clientDataJSON)])));
      attStmt = new Map<Cbor, Cbor>([['alg', -7], ['sig', rawToDer(sig)]]);
    }
    const attestationObject = encodeCbor(new Map<Cbor, Cbor>([['fmt', fmt], ['attStmt', attStmt], ['authData', authData]]));
    const prfReq = (o.extensions as { prf?: { eval?: { first: BufferSource } } } | undefined)?.prf;
    return {
      id: b64url(c.id), rawId: ab(c.id), type: 'public-key', authenticatorAttachment: 'platform',
      response: { clientDataJSON: ab(clientDataJSON), attestationObject: ab(attestationObject), getPublicKey: () => null, getAuthenticatorData: () => ab(authData), getTransports: () => ['internal'], getPublicKeyAlgorithm: () => -7 },
      getClientExtensionResults: () => (prfReq ? { prf: { enabled: this.opts.prf !== false, ...(prfReq.eval ? { results: { first: this.prfOut(c, prfReq.eval.first) } } : {}) } } : {}),
    } as unknown as PublicKeyCredential;
  }

  async get(o: PublicKeyCredentialRequestOptions): Promise<PublicKeyCredential> {
    const allowed = o.allowCredentials?.map((a) => Buffer.from(bytesOf(a.id)).toString('hex'));
    const c = this.credentials.find((x) => x.rpId === o.rpId && (!allowed || allowed.includes(Buffer.from(x.id).toString('hex'))));
    if (!c) throw Object.assign(new Error('no credential'), { name: 'NotAllowedError' });
    c.signCount++;
    const n = c.signCount;
    const authData = Uint8Array.from([...sha(c.rpId), this.flags(), (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: b64url(bytesOf(o.challenge)), origin: this.origin(c.rpId), crossOrigin: false }));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, c.keys.privateKey, Uint8Array.from([...authData, ...sha(clientDataJSON)])));
    const prfReq = (o.extensions as { prf?: { eval?: { first: BufferSource }; evalByCredential?: Record<string, { first: BufferSource }> } } | undefined)?.prf;
    const prfEval = prfReq?.evalByCredential?.[b64url(c.id)] ?? prfReq?.eval;
    const first = this.prfOut(c, prfEval?.first);
    return {
      id: b64url(c.id), rawId: ab(c.id), type: 'public-key',
      response: { authenticatorData: ab(authData), clientDataJSON: ab(clientDataJSON), signature: ab(rawToDer(raw)), userHandle: null },
      getClientExtensionResults: () => (prfReq ? { prf: first ? { results: { first } } : {} } : {}),
    } as unknown as PublicKeyCredential;
  }
}
