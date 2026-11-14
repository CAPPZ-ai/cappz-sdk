#!/usr/bin/env node
// Verifies CAPPZ signed records offline. No dependencies; Node 20+ or Deno.
//   node verify.mjs <file.json> [expected signer public key hex]
//   deno run --allow-read {{BASE}}/verify.mjs <file.json> [key]
// Accepts a signed record, a timestamp result {receipt}, or a webhook bundle {bundle, records}.
// How a record is signed: txHash = sha256(canonical JSON of the record without
// txHash/signature/signerPublicKey, keys sorted); signature = Ed25519(txHash as UTF-8 text).
const args = typeof Deno !== 'undefined' ? Deno.args : process.argv.slice(2);
const readText = typeof Deno !== 'undefined' ? (p) => Deno.readTextFile(p) : async (p) => (await import('node:fs/promises')).readFile(p, 'utf8');
const exit = (c) => (typeof Deno !== 'undefined' ? Deno.exit(c) : process.exit(c));

const canonical = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
const enc = (s) => new TextEncoder().encode(s);
const hex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const sha256 = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function verify(tx) {
  const { txHash, signature, signerPublicKey, ...unsigned } = tx;
  if ((await sha256(canonical(unsigned))) !== txHash) return false;
  const key = await crypto.subtle.importKey('raw', hex(signerPublicKey), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, hex(signature), enc(txHash));
}

if (!args[0]) { console.log('usage: node verify.mjs <file.json> [expected signer public key hex]'); exit(2); }
const doc = JSON.parse(await readText(args[0]));
const expected = args[1]?.toLowerCase();
const records = Array.isArray(doc.records) ? doc.records : [];
const main = doc.receipt ?? doc.bundle ?? doc;
const checks = [];
const check = (label, ok) => { checks.push(ok); console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`); };

check(`${main.eventType} signature (txHash ${String(main.txHash).slice(0, 16)}…)`, await verify(main));
if (expected) check(`signed by expected key ${expected.slice(0, 16)}…`, main.signerPublicKey?.toLowerCase() === expected);
else console.log(`     signer ${main.signerPublicKey}  (pass it as the 2nd argument to require it)`);
if (main.payload?.network) console.log(`     network ${main.payload.network}${main.payload.network === 'mainnet' ? '' : '  (TEST record: no value as proof)'}`);
if (main.payload?.sha256) console.log(`     hash ${main.payload.sha256} at ${main.timestamp}${main.payload.note ? `  note: ${main.payload.note}` : ''}`);
if (doc.bundle) {
  check(`bundle covers ${records.length} records (count ${main.payload.count})`, main.payload.count === records.length);
  check('recordsSha256 matches the records', main.payload.recordsSha256 === (await sha256(JSON.stringify(records))));
  let bad = 0;
  for (const r of records) if (!(await verify(r)) || r.signerPublicKey !== main.signerPublicKey) bad++;
  check(`every record signed by the same key (${records.length - bad}/${records.length})`, bad === 0);
  console.log(`     period ${main.payload.periodStart} → ${main.payload.periodEnd}`);
}
console.log(checks.every(Boolean) ? 'VALID' : 'INVALID');
exit(checks.every(Boolean) ? 0 : 1);
