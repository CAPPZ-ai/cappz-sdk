#!/usr/bin/env node
// Verifies CAPPZ signed records offline. No dependencies; Node 20+ or Deno.
//   node verify.mjs <file.json> [expected signer] [--evidence key-declarations.json] [--offline]
//   deno run --allow-read --allow-net --allow-env {{BASE}}/verify.mjs <file.json> [expected signer] [--evidence key-declarations.json]
// Accepts a signed record, a timestamp result {receipt, declarations?}, a webhook bundle {bundle, records, declarations?},
// or a fair draw {draw, commitment, entries?} (15.47.0; --entries <list.txt|list.json> for a list sent only as a hash),
// or a vault report {report, decisions?, alerts?} (15.49.0: vault-check, and the vault guard's period report),
// or a key exposure report {report, details, vault?, plans} (16.2.0: key-exposure).
//   node verify.mjs --hash-entries list.txt   prints a list's entriesSha256 and count (one entry per line, trimmed, blanks dropped)
// expected signer: the node key (64 hex), the declaring wallet's public key (66 hex), or its XRPL address (r…).
// How a record is signed: txHash = sha256(canonical JSON of the record without
// txHash/signature/signerPublicKey, keys sorted); signature = Ed25519(txHash as UTF-8 text).
// 15.44.0 — who the signer is, without trusting a website's certificate: a record's payload.signerDeclaration
// names a KeyDeclaration in which a wallet (secp256k1) declares the node key for purpose "signing". This file
// checks that wallet signature itself and prints the wallet's XRPL address, so the anchor is the account you
// paid, not the HTTPS certificate (or DNS name) the result was downloaded through.
// 15.45.0 — or the wallet declared the node key ON THE XRP LEDGER: signerDeclaration is then "xrpl:<network>:<tx hash>",
// an AccountSet by that account with a cappz/keyz memo. This file reads that transaction and the account's later
// transactions (a revocation is another such memo) from public XRPL servers; --offline skips it (the signer stays unproven).
// Override a server with CAPPZ_XRPL_RPC_MAINNET / _TESTNET.
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

// ─── On-ledger declarations (keep in step with agents/ledgerKeyz.ts) ──────────
const RPC = { mainnet: ['https://xrplcluster.com/', 'https://s1.ripple.com:51234/'], testnet: ['https://s.altnet.rippletest.net:51234/'], devnet: ['https://s.devnet.rippletest.net:51234/'] };
const envGet = (k) => { try { return typeof Deno !== 'undefined' ? Deno.env.get(k) : process.env[k]; } catch { return undefined; } };
async function rpc(network, method, params) {
  const own = envGet(`CAPPZ_XRPL_RPC_${network.toUpperCase()}`);
  let last;
  for (const url of own ? [own] : RPC[network]) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [params] }), signal: AbortSignal.timeout(20_000) });
      const r = (await res.json()).result;
      if (r?.status === 'error') { if (r.error === 'txnNotFound') return null; throw Object.assign(new Error(r.error_message ?? r.error), { code: r.error }); }
      return r;
    } catch (e) { last = e; if (e.code) throw e; }
  }
  throw last ?? new Error('XRPL unreachable');
}
const utf8 = (h) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(hex(h)); } catch { return ''; } };
function ledgerEntry(e) {
  const t = e.tx_json ?? e.tx ?? e; const meta = e.meta ?? e.metaData ?? {};
  const date = t.date ?? e.date;
  return {
    hash: String(e.hash ?? t.hash ?? '').toUpperCase(), validated: e.validated === true, result: meta.TransactionResult ?? '', ledgerIndex: e.ledger_index ?? t.ledger_index ?? null,
    type: t.TransactionType, account: t.Account, closeTime: e.close_time_iso ?? (typeof date === 'number' ? new Date((date + 946684800) * 1000).toISOString() : null),
    memos: (t.Memos ?? []).map((m) => ({ type: utf8(m.Memo?.MemoType ?? ''), data: utf8(m.Memo?.MemoData ?? '') })),
  };
}
function keyzMemo(t) {
  for (const m of t.memos) {
    if (m.type !== 'cappz/keyz') continue;
    try {
      const v = JSON.parse(m.data);
      if (v?.v === 1 && v.op === 'declare' && /^[0-9a-f]{64}$/.test(v.key) && v.alg === 'ed25519' && Array.isArray(v.purposes) && typeof v.until === 'string') return v;
      if (v?.v === 1 && v.op === 'revoke' && (/^[0-9a-f]{64}$/i.test(v.tx ?? '') || /^[0-9a-f]{64}$/.test(v.key ?? ''))) return v;
    } catch { /* not ours */ }
  }
  return null;
}
const ledgerCache = new Map();
/** The declaration transaction and the account's validated transactions after it (oldest first), read once per reference. */
function ledgerFacts(network, txHash) {
  if (!ledgerCache.has(txHash)) ledgerCache.set(txHash, (async () => {
    const r = await rpc(network, 'tx', { transaction: txHash });
    if (!r) return { decl: null, later: [] };
    const decl = ledgerEntry(r);
    const later = []; let marker;
    if (decl.validated && decl.ledgerIndex !== null) do {
      const page = await rpc(network, 'account_tx', { account: decl.account, ledger_index_min: decl.ledgerIndex, ledger_index_max: -1, forward: true, limit: 200, ...(marker ? { marker } : {}) });
      for (const e of page?.transactions ?? []) if (e.validated !== false) later.push(ledgerEntry({ ...e, validated: true }));
      marker = page?.marker;
    } while (marker && later.length < 2000);
    return { decl, later };
  })());
  return ledgerCache.get(txHash);
}
const offline = args.includes('--offline'); if (offline) args.splice(args.indexOf('--offline'), 1);
async function ledgerDeclaredBy(tx, ref) {
  const m = /^xrpl:(mainnet|testnet|devnet):([0-9A-F]{64})$/i.exec(ref);
  if (!m) return { ok: false, why: `unreadable on-ledger reference ${ref}` };
  const [network, txHash] = [m[1].toLowerCase(), m[2].toUpperCase()];
  if (offline) return { ok: false, why: `declared on the XRP Ledger (${network} ${txHash.slice(0, 16)}…), not checked (--offline)` };
  let facts;
  try { facts = await ledgerFacts(network, txHash); } catch (e) { return { ok: false, why: `the XRP Ledger (${network}) could not be read: ${e.message}` }; }
  const { decl, later } = facts;
  if (!decl) return { ok: false, why: `declaration ${txHash.slice(0, 16)}… is not on ${network}` };
  if (!decl.validated || decl.result !== 'tesSUCCESS' || decl.type !== 'AccountSet') return { ok: false, why: `declaration ${txHash.slice(0, 16)}… is not a validated, successful AccountSet` };
  const d = keyzMemo(decl);
  if (!d || d.op !== 'declare') return { ok: false, why: 'the transaction carries no cappz/keyz declaration' };
  if (d.key !== String(tx.signerPublicKey).toLowerCase()) return { ok: false, why: 'the declaration names another key' };
  if (!d.purposes.includes('signing')) return { ok: false, why: 'the declaration is not for signing' };
  const from = Date.parse(decl.closeTime); const until = Date.parse(d.until);
  if (!(until - from <= 91 * 86_400_000)) return { ok: false, why: 'the declaration claims more than 90 days' };
  for (const t of later) {
    if (t.result !== 'tesSUCCESS' || t.account !== decl.account || t.hash === decl.hash) continue;
    const r = keyzMemo(t);
    if (r?.op === 'revoke' && (String(r.tx ?? '').toUpperCase() === decl.hash || r.key === d.key)) return { ok: false, revoked: true, why: `the account REVOKED this declaration in ${t.hash.slice(0, 16)}… (${t.closeTime})` };
  }
  const at = Date.parse(tx.timestamp);
  if (!(at >= from - 5 * 60_000 && at < until)) return { ok: false, why: `signed at ${tx.timestamp}, outside the declaration (${decl.closeTime} → ${d.until})` };
  return { ok: true, wallet: null, address: decl.account, expiresAt: d.until, hash: ref, onLedger: { network, txHash, ledgerIndex: decl.ledgerIndex, closeTime: decl.closeTime } };
}

const declHash = async (d) => { const { signature, ...rest } = d; return sha256(`${canonical({ ...rest, publicKey: String(rest.publicKey).toLowerCase() })}|${signature}`); };
/** The wallet behind a record's signer: checks the declaration its payload names. */
async function declaredBy(tx, declarations) {
  const want = tx.payload?.signerDeclaration;
  if (!want) return { ok: false, why: 'the record names no declaration (signer key undeclared)' };
  if (String(want).startsWith('xrpl:')) return ledgerDeclaredBy(tx, String(want));
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

// ─── Fair draw, rule cappz-draw/v1 (keep in step with agents/draw.ts) ─────────
const entriesFrom = (text, name) => {
  if (/\.json$/i.test(name) || /^\s*\[/.test(text)) { const v = JSON.parse(text); if (!Array.isArray(v) || v.some((e) => typeof e !== 'string')) throw new Error(`${name}: expected a JSON array of texts`); return v; }
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
};
const entriesHash = (entries) => sha256(JSON.stringify(entries));
async function drawPicks(seedHex, count, winners) {
  const seed = hex(seedHex); let counter = 0; let words = [];
  const nextWord = async () => {
    if (!words.length) {
      const block = new Uint8Array(seed.length + 4); block.set(seed); new DataView(block.buffer).setUint32(seed.length, counter++, false);
      const d = new DataView((await digest(block)).buffer); words = Array.from({ length: 8 }, (_, i) => d.getUint32(i * 4, false));
    }
    return words.shift();
  };
  const uniform = async (n) => { const limit = 2 ** 32 - (2 ** 32 % n); for (;;) { const w = await nextWord(); if (w < limit) return w % n; } };
  const swapped = new Map(); const at = (i) => swapped.get(i) ?? i; const picks = [];
  for (let i = 0; i < winners; i++) { const j = i + await uniform(count - i); const a = at(i), b = at(j); swapped.set(i, b); swapped.set(j, a); picks.push(b); }
  return picks;
}
async function ledgerHeader(network, index) {
  const r = await rpc(network, 'ledger', { ledger_index: index, transactions: false, expand: false });
  const l = r?.ledger;
  if (r?.validated !== true || !l) throw new Error(`ledger ${index} is not validated`);
  return { index: Number(l.ledger_index), hash: String(l.ledger_hash ?? l.hash).toUpperCase(), closeTime: l.close_time_iso ? new Date(l.close_time_iso).toISOString() : new Date((l.close_time + 946684800) * 1000).toISOString() };
}

const hashAt = args.indexOf('--hash-entries');
if (hashAt >= 0) {
  const f = args[hashAt + 1]; if (!f) { console.log('usage: node verify.mjs --hash-entries <list.txt | list.json>'); exit(2); }
  const entries = entriesFrom(await readText(f), f);
  console.log(JSON.stringify({ entriesSha256: await entriesHash(entries), count: entries.length }));
  exit(0);
}
const entriesAt = args.indexOf('--entries');
const entriesArg = entriesAt > 0 ? args.splice(entriesAt, 2)[1] : null;

if (!args[0]) { console.log('usage: node verify.mjs <file.json> [expected signer: node key hex | wallet public key hex | XRPL address r…] [--evidence key-declarations.json] [--offline]'); exit(2); }
const doc = JSON.parse(await readText(args[0]));
const records = Array.isArray(doc.records) ? doc.records : [];
// Declarations and revocations ride in the result; `--evidence <key-declarations.json>` adds a fresher copy (e.g. the node's).
const evidenceAt = args.indexOf('--evidence');
const evidence = evidenceAt > 0 ? JSON.parse(await readText(args.splice(evidenceAt, 2)[1])) : {};
const declarations = [doc, evidence].flatMap((x) => [...(Array.isArray(x.declarations) ? x.declarations : []), ...(x.declaration ? [x.declaration] : [])]);
const revocations = [doc, evidence].flatMap((x) => (Array.isArray(x.revocations) ? x.revocations : []));
const expected = args[1]?.trim();
const main = doc.receipt ?? doc.bundle ?? doc.draw ?? doc.report ?? doc;
const checks = [];
const check = (label, ok) => { checks.push(ok); console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`); };

check(`${main.eventType} signature (txHash ${String(main.txHash).slice(0, 16)}…)`, await verify(main));
const who = await declaredBy(main, declarations);
if (who.ok && who.onLedger) console.log(`     signer ${main.signerPublicKey}\n     declared ON THE XRP LEDGER (${who.onLedger.network}) by wallet ${who.address} until ${who.expiresAt}\n     declaration tx ${who.onLedger.txHash} (ledger ${who.onLedger.ledgerIndex}, ${who.onLedger.closeTime}); revocations checked on the ledger just now`);
else if (who.ok) console.log(`     signer ${main.signerPublicKey}\n     declared by wallet ${who.address} (${who.wallet.slice(0, 16)}…) until ${who.expiresAt}`);
else if (who.revoked) check(`signer ${main.signerPublicKey.slice(0, 16)}…: ${who.why}`, false);
else console.log(`     signer ${main.signerPublicKey}  (${who.why})`);
if (expected) {
  if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(expected)) check(`declared by expected wallet ${expected}`, who.ok && who.address === expected);
  else if (/^0[23][0-9a-f]{64}$/i.test(expected)) check(`declared by expected wallet key ${expected.slice(0, 16)}…`, who.ok && who.wallet === expected.toLowerCase()); // on-ledger declarations name an address: pass the r-address
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
    if (who.ok) { const w = await declaredBy(r, declarations); if (!w.ok || w.address !== who.address) undeclared++; }
  }
  check(`every record signed by the same key (${records.length - bad}/${records.length})`, bad === 0);
  if (who.ok) check(`every record's key declared by the same wallet (${records.length - undeclared}/${records.length})`, undeclared === 0);
  console.log(`     period ${main.payload.periodStart} → ${main.payload.periodEnd}`);
}
if (doc.report && main.eventType === 'KeyExposureChecked') {
  // 16.2.0 key-exposure: the signed report names each account's posture and the hash of its full detail report.
  const p = main.payload ?? {};
  const rows = Array.isArray(p.accounts) ? p.accounts : [];
  for (const a of rows) console.log(`     ${a.account}: ${a.posture} (master ${a.master}, regular key ${a.regularKey}${a.historyComplete ? '' : ', history incomplete'})`);
  const details = Array.isArray(doc.details) ? doc.details : [];
  const detailOk = async (d, want) => { if (!d || !want) return false; const { reportHash, ...body } = d; return reportHash === want && (await sha256(canonical(body))) === want; };
  let good = 0; for (let i = 0; i < rows.length; i++) if (await detailOk(details[i], rows[i].reportHash)) good++;
  check(`each account's detail report matches the signed hash (${good}/${rows.length})`, rows.length > 0 && good === rows.length);
  if (p.vault) check(`vault ${p.vault.account} detail matches the signed hash`, await detailOk(doc.vault, p.vault.reportHash));
  console.log(`     ledger signatures: ${p.ledgerSignatures}`);
} else if (doc.report) {
  const p = main.payload ?? {};
  console.log(`     ${main.eventType} for ${p.account}: ${p.state ?? p.setupAtEnd ?? ''}${p.reconciliation ? `  reconciliation ${p.reconciliation.clean ? 'clean' : 'NOT clean'}` : ''}`);
  const extra = [...(Array.isArray(doc.decisions) ? doc.decisions : []), ...(Array.isArray(doc.alerts) ? doc.alerts : [])];
  if (Array.isArray(doc.decisions) && p.decisionsSha256) check(`decisionsSha256 matches the ${doc.decisions.length} decisions`, p.decisionsSha256 === (await sha256(JSON.stringify(doc.decisions))));
  if (extra.length) {
    let bad = 0; let undeclared = 0;
    for (const r of extra) {
      if (!(await verify(r)) || r.signerPublicKey !== main.signerPublicKey) { bad++; continue; }
      if (who.ok) { const w = await declaredBy(r, declarations); if (!w.ok || w.address !== who.address) undeclared++; }
    }
    check(`every decision and alert signed by the same key (${extra.length - bad}/${extra.length})`, bad === 0);
    if (who.ok) check(`every decision's key declared by the same wallet (${extra.length - undeclared}/${extra.length})`, undeclared === 0);
  }
}
if (doc.draw) {
  const d = main.payload, c = doc.commitment, cp = c?.payload ?? {};
  check(`DrawCommitted signature (txHash ${String(c?.txHash).slice(0, 16)}…)`, !!c && (await verify(c)) && c.signerPublicKey === main.signerPublicKey);
  if (c && who.ok) { const w = await declaredBy(c, declarations); check(`commitment's key declared by the same wallet`, w.ok && w.address === who.address); }
  check('the draw names this commitment', d.commitment === c?.txHash);
  check('commitment and draw agree (list, count, winners, draw time, rule)', ['entriesSha256', 'count', 'winners', 'drawAt', 'rule'].every((k) => cp[k] === d[k]) && d.rule === 'cappz-draw/v1');
  check(`committed (${c?.timestamp}) before the draw time (${d.drawAt})`, Date.parse(c?.timestamp) < Date.parse(d.drawAt));
  check(`commitment followed ledger ${cp.afterLedger?.index}, closed before the draw time`, !!cp.afterLedger && Date.parse(cp.afterLedger.closeTime) < Date.parse(d.drawAt) && d.seedLedger.index > cp.afterLedger.index);
  let entries = Array.isArray(doc.entries) ? doc.entries : null;
  if (entriesArg) entries = entriesFrom(await readText(entriesArg), entriesArg);
  if (entries) {
    check(`the list (${entries.length} entries) matches entriesSha256 ${d.entriesSha256.slice(0, 16)}…`, (await entriesHash(entries)) === d.entriesSha256 && entries.length === d.count);
  } else console.log('     list not in this file: pass --entries <list.txt|list.json> to check the names behind the picks');
  const seed = await sha256(`cappz-draw/v1|${String(d.seedLedger.hash).toUpperCase()}|${d.entriesSha256}|${d.count}|${d.winners}`);
  check('seed follows from the seed ledger hash and the list', seed === d.seed);
  const picks = await drawPicks(seed, d.count, d.winners);
  check(`winners recomputed: ${picks.join(', ')}`, JSON.stringify(picks) === JSON.stringify(d.picks));
  if (entries && Array.isArray(d.picked)) check('picked entries match the list', JSON.stringify(picks.map((i) => entries[i])) === JSON.stringify(d.picked));
  if (offline) console.log(`     seed ledger ${d.seedLedger.index} NOT checked against the XRP Ledger (--offline)`);
  else {
    try {
      const net = d.network ?? 'mainnet';
      const [L, prev] = await Promise.all([ledgerHeader(net, d.seedLedger.index), ledgerHeader(net, d.seedLedger.index - 1)]);
      check(`seed ledger ${L.index} on ${net}: hash ${L.hash.slice(0, 16)}… matches`, L.hash === String(d.seedLedger.hash).toUpperCase());
      check(`seed ledger is the first closed at or after the draw time (${prev.closeTime} < ${d.drawAt} ≤ ${L.closeTime})`, Date.parse(prev.closeTime) < Date.parse(d.drawAt) && Date.parse(L.closeTime) >= Date.parse(d.drawAt));
    } catch (e) { check(`seed ledger could not be read from the XRP Ledger: ${e.message}`, false); }
  }
  console.log(`     draw "${d.label ?? ''}": ${d.count} entries, ${d.winners} winner(s) at ${d.drawAt}`);
  picks.forEach((i, n) => console.log(`     ${n + 1}. entry #${i}${entries ? `  ${entries[i]}` : ''}`));
}
if (who.ok && !who.onLedger) console.log(`     revocations checked: ${revocations.length} in this file${evidenceAt > 0 ? ' and --evidence' : ''} (fetch the node's key-declarations.json and pass --evidence for the latest)`);
console.log(checks.every(Boolean) ? 'VALID' : 'INVALID');
exit(checks.every(Boolean) ? 0 : 1);
