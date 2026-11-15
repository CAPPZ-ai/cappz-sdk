#!/usr/bin/env node
// Verifies CAPPZ signed records offline. No dependencies; Node 20+ or Deno.
//   node verify.mjs <file.json> [expected signer] [--evidence key-declarations.json]
//   deno run --allow-read {{BASE}}/verify.mjs <file.json> [expected signer] [--evidence key-declarations.json]
// Accepts a signed record, a timestamp result {receipt, declarations?}, or a webhook bundle {bundle, records, declarations?}.
// expected signer: the node key (64 hex), the declaring wallet's public key (66 hex), or its XRPL address (r…).
// How a record is signed: txHash = sha256(canonical JSON of the record without
// txHash/signature/signerPublicKey, keys sorted); signature = Ed25519(txHash as UTF-8 text).
// 15.44.0 — who the signer is, without trusting a website's certificate: a record's payload.signerDeclaration
// names a KeyDeclaration in which a wallet (secp256k1) declares the node key for purpose "signing". This file
// checks that wallet signature itself and prints the wallet's XRPL address, so the anchor is the account you
// paid, not the HTTPS certificate (or DNS name) the result was downloaded through.
const args = typeof Deno !== 'undefined' ? Deno.args : process.argv.slice(2);
const readText = typeof Deno !== 'undefined' ? (p) => Deno.readTextFile(p) : async (p) => (await import('node:fs/promises')).readFile(p, 'utf8');
const exit = (c) => (typeof Deno !== 'undefined' ? Deno.exit(c) : process.exit(c));

const canonical = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`
  : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
const enc = (s) => new TextEncoder().encode(s);
const hex = (h) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const digest = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
const sha256 = async (s) => toHex(await digest(enc(s)));

async function verify(tx) {
  const { txHash, signature, signerPublicKey, ...unsigned } = tx;
  if (!/^[0-9a-f]{64}$/i.test(signerPublicKey ?? '') || !/^[0-9a-f]{128}$/i.test(signature ?? '')) return false;
  if ((await sha256(canonical(unsigned))) !== txHash) return false;
  const key = await crypto.subtle.importKey('raw', hex(signerPublicKey), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, hex(signature), enc(txHash));
}

// ─── secp256k1 ECDSA verify (the wallet's signature over a KeyDeclaration) ────
// Verification only (public data, no secrets), so plain BigInt arithmetic is fine.
const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const mod = (a, m = P) => ((a % m) + m) % m;
const big = (b) => BigInt(`0x${toHex(b) || '0'}`);
function inv(a, m = P) { let [x, y, u, v] = [0n, 1n, m, mod(a, m)]; while (v) { const q = u / v; [x, y] = [y, x - q * y]; [u, v] = [v, u - q * v]; } return mod(x, m); }
function pow(b, e, m = P) { let r = 1n; b = mod(b, m); while (e) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
function add(a, b) {
  if (!a) return b; if (!b) return a;
  if (a[0] === b[0] && mod(a[1] + b[1]) === 0n) return null;
  const l = a[0] === b[0] ? mod(3n * a[0] * a[0] * inv(2n * a[1])) : mod((b[1] - a[1]) * inv(b[0] - a[0]));
  const x = mod(l * l - a[0] - b[0]);
  return [x, mod(l * (a[0] - x) - a[1])];
}
function mul(pt, k) { let r = null; while (k) { if (k & 1n) r = add(r, pt); pt = add(pt, pt); k >>= 1n; } return r; }
function decompress(h) {
  if (!/^0[23][0-9a-f]{64}$/i.test(h)) return null;
  const x = big(hex(h.slice(2)));
  if (x >= P) return null;
  let y = pow(mod(x * x * x + 7n), (P + 1n) / 4n);
  if (mod(y * y) !== mod(x * x * x + 7n)) return null;
  if ((y & 1n) !== BigInt(parseInt(h.slice(0, 2), 16) & 1)) y = P - y;
  return [x, y];
}
/** As @noble/secp256k1 v3 verify(sig, sha256(message), pub): ECDSA over sha256(sha256(message)), compact r‖s, low-S only. */
async function secpVerify(message, sigHex, pubHex) {
  const Q = decompress(pubHex);
  if (!Q || !/^[0-9a-f]{128}$/i.test(sigHex ?? '')) return false;
  const r = big(hex(sigHex.slice(0, 64))); const s = big(hex(sigHex.slice(64)));
  if (r < 1n || r >= N || s < 1n || s > N >> 1n) return false;
  const e = mod(big(await digest(await digest(enc(message)))), N);
  const w = inv(s, N);
  const X = add(mul(G, mod(e * w, N)), mul(Q, mod(r * w, N)));
  return !!X && mod(X[0], N) === r;
}

// ─── XRPL classic address of a secp256k1 public key ──────────────────────────
function ripemd160(msg) {
  const R = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8, 3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2, 4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13];
  const RR = [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2, 15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14, 12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11];
  const S = [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12, 11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12, 9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6];
  const SS = [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11, 9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8, 8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11];
  const K = [0, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e]; const KK = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0];
  const f = (j, x, y, z) => [x ^ y ^ z, (x & y) | (~x & z), (x | ~y) ^ z, (x & z) | (y & ~z), x ^ (y | ~z)][j];
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  const len = msg.length; const padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
  padded.set(msg); padded[len] = 0x80;
  const dv = new DataView(padded.buffer); dv.setUint32(padded.length - 8, (len * 8) >>> 0, true); dv.setUint32(padded.length - 4, Math.floor(len / 0x20000000), true);
  let h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  for (let o = 0; o < padded.length; o += 64) {
    const X = Array.from({ length: 16 }, (_, i) => dv.getUint32(o + i * 4, true));
    let [a, b, c, d, e] = h; let [aa, bb, cc, dd, ee] = h;
    for (let j = 0; j < 80; j++) {
      const rd = j >> 4;
      let t = (rotl((a + f(rd, b, c, d) + X[R[j]] + K[rd]) | 0, S[j]) + e) | 0;
      [a, e, d, c, b] = [e, d, rotl(c, 10), b, t];
      t = (rotl((aa + f(4 - rd, bb, cc, dd) + X[RR[j]] + KK[rd]) | 0, SS[j]) + ee) | 0;
      [aa, ee, dd, cc, bb] = [ee, dd, rotl(cc, 10), bb, t];
    }
    h = [(h[1] + c + dd) | 0, (h[2] + d + ee) | 0, (h[3] + e + aa) | 0, (h[4] + a + bb) | 0, (h[0] + b + cc) | 0];
  }
  const out = new Uint8Array(20); const ov = new DataView(out.buffer); h.forEach((w, i) => ov.setUint32(i * 4, w >>> 0, true));
  return out;
}
async function xrplAddress(pubHex) {
  const body = new Uint8Array(21); body.set(ripemd160(await digest(hex(pubHex))), 1);
  const check = (await digest(await digest(body))).slice(0, 4);
  const bytes = new Uint8Array([...body, ...check]);
  const A = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
  let n = big(bytes); let s = '';
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b) break; s = A[0] + s; }
  return s;
}

const declHash = async (d) => { const { signature, ...rest } = d; return sha256(`${canonical({ ...rest, publicKey: String(rest.publicKey).toLowerCase() })}|${signature}`); };
/** The wallet behind a record's signer: checks the declaration its payload names. */
async function declaredBy(tx, declarations) {
  const want = tx.payload?.signerDeclaration;
  if (!want) return { ok: false, why: 'the record names no declaration (signer key undeclared)' };
  let d = null;
  for (const x of declarations) if (x && (await declHash(x)) === want) d = x;
  if (!d) return { ok: false, why: `declaration ${String(want).slice(0, 16)}… is not in this file` };
  if (d.v !== 2 || d.algorithm !== 'ed25519' || d.purpose !== 'signing') return { ok: false, why: 'the declaration is not an ed25519 signing declaration' };
  if (String(d.publicKey).toLowerCase() !== String(tx.signerPublicKey).toLowerCase()) return { ok: false, why: 'the declaration names another key' };
  const at = Date.parse(tx.timestamp);
  if (!(at >= Date.parse(d.issuedAt) - 5 * 60_000 && at < Date.parse(d.expiresAt))) return { ok: false, why: `signed at ${tx.timestamp}, outside the declaration (${d.issuedAt} → ${d.expiresAt})` };
  const { signature, ...rest } = d;
  if (!(await secpVerify(canonical({ ...rest, publicKey: String(rest.publicKey).toLowerCase() }), signature, d.walletAddress))) return { ok: false, why: 'the wallet signature on the declaration is invalid' };
  // A wallet-signed revocation of this declaration withdraws it for every record, whenever signed: a leaked key can backdate.
  for (const r of revocations) {
    if (r?.v !== 1 || r.declarationHash !== want || String(r.walletAddress).toLowerCase() !== String(d.walletAddress).toLowerCase()) continue;
    const { signature: rs, ...rb } = r;
    if (await secpVerify(canonical({ ...rb, publicKey: String(rb.publicKey).toLowerCase() }), rs, r.walletAddress)) return { ok: false, revoked: true, why: `the wallet REVOKED this declaration at ${r.revokedAt} (${r.reason})` };
  }
  return { ok: true, wallet: String(d.walletAddress).toLowerCase(), address: await xrplAddress(d.walletAddress), expiresAt: d.expiresAt, hash: want };
}

if (!args[0]) { console.log('usage: node verify.mjs <file.json> [expected signer: node key hex | wallet public key hex | XRPL address r…]'); exit(2); }
const doc = JSON.parse(await readText(args[0]));
const records = Array.isArray(doc.records) ? doc.records : [];
// Declarations and revocations ride in the result; `--evidence <key-declarations.json>` adds a fresher copy (e.g. the node's).
const evidenceAt = args.indexOf('--evidence');
const evidence = evidenceAt > 0 ? JSON.parse(await readText(args.splice(evidenceAt, 2)[1])) : {};
const declarations = [doc, evidence].flatMap((x) => [...(Array.isArray(x.declarations) ? x.declarations : []), ...(x.declaration ? [x.declaration] : [])]);
const revocations = [doc, evidence].flatMap((x) => (Array.isArray(x.revocations) ? x.revocations : []));
const expected = args[1]?.trim();
const main = doc.receipt ?? doc.bundle ?? doc;
const checks = [];
const check = (label, ok) => { checks.push(ok); console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`); };

check(`${main.eventType} signature (txHash ${String(main.txHash).slice(0, 16)}…)`, await verify(main));
const who = await declaredBy(main, declarations);
if (who.ok) console.log(`     signer ${main.signerPublicKey}\n     declared by wallet ${who.address} (${who.wallet.slice(0, 16)}…) until ${who.expiresAt}`);
else if (who.revoked) check(`signer ${main.signerPublicKey.slice(0, 16)}…: ${who.why}`, false);
else console.log(`     signer ${main.signerPublicKey}  (${who.why})`);
if (expected) {
  if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(expected)) check(`declared by expected wallet ${expected}`, who.ok && who.address === expected);
  else if (/^0[23][0-9a-f]{64}$/i.test(expected)) check(`declared by expected wallet key ${expected.slice(0, 16)}…`, who.ok && who.wallet === expected.toLowerCase());
  else check(`signed by expected key ${expected.slice(0, 16)}…`, main.signerPublicKey?.toLowerCase() === expected.toLowerCase());
} else console.log('     pass the XRPL address you paid (r…) as the 2nd argument to require it');
if (main.payload?.network) console.log(`     network ${main.payload.network}${main.payload.network === 'mainnet' ? '' : '  (TEST record: no value as proof)'}`);
if (main.payload?.sha256) console.log(`     hash ${main.payload.sha256} at ${main.timestamp}${main.payload.note ? `  note: ${main.payload.note}` : ''}`);
if (doc.bundle) {
  check(`bundle covers ${records.length} records (count ${main.payload.count})`, main.payload.count === records.length);
  check('recordsSha256 matches the records', main.payload.recordsSha256 === (await sha256(JSON.stringify(records))));
  let bad = 0; let undeclared = 0;
  for (const r of records) {
    if (!(await verify(r)) || r.signerPublicKey !== main.signerPublicKey) { bad++; continue; }
    if (who.ok) { const w = await declaredBy(r, declarations); if (!w.ok || w.wallet !== who.wallet) undeclared++; }
  }
  check(`every record signed by the same key (${records.length - bad}/${records.length})`, bad === 0);
  if (who.ok) check(`every record's key declared by the same wallet (${records.length - undeclared}/${records.length})`, undeclared === 0);
  console.log(`     period ${main.payload.periodStart} → ${main.payload.periodEnd}`);
}
if (who.ok) console.log(`     revocations checked: ${revocations.length} in this file${evidenceAt > 0 ? ' and --evidence' : ''} (fetch the node's key-declarations.json and pass --evidence for the latest)`);
console.log(checks.every(Boolean) ? 'VALID' : 'INVALID');
exit(checks.every(Boolean) ? 0 : 1);
