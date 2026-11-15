/**
 * COPE node crystallized.
 * Node ID: v15-44-00-declare-node-key
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * A wallet vouches for the node key (KeyZ), instead of a certificate authority.
 * Writes wallet-signed KeyDeclarations of the node's Ed25519 key into a
 * key-declarations.json (the node's evidence file, and CAPPZ_NODE_KEY_DECLARATIONS
 * for the paid agents). Buyers' verify.mjs then shows the wallet's XRPL address
 * behind every receipt — trust that does not depend on the HTTPS certificate or
 * the DNS name the result was fetched from.
 *
 *   deno run --config deno.json --allow-read --allow-write --allow-env \
 *     packages/cappz-edge-node/tools/declare-node-key.ts \
 *     --env <node folder>/node.env --out <node folder>/data/key-declarations.json \
 *     [--purposes signing,hello] [--days 90] [--expect rPayoutAddress]
 *   … declare-node-key.ts --check --env node.env --out key-declarations.json   (no seed; prints the state)
 *   … declare-node-key.ts --revoke --env node.env --out key-declarations.json  (signs revocations into key-revocations.json)
 *
 * The wallet: an XRPL family seed (s…) of a secp256k1 account — ideally the payout
 * account, so buyers see the address they paid. Typed at a hidden prompt (or
 * CAPPZ_WALLET_SEED for scripts); used in memory to sign and never written.
 * Only CAPPZ_NODE_PUB is read from node.env; the node's private key is not needed.
 * Files are replaced atomically (temp file + rename), which the node's evidence reader expects.
 */
import { decodeSeed, deriveAddress, Wallet } from 'xrpl';
import { declareKey, declarationHash, evaluateKey, revokeKeyDeclaration, type KeyDeclaration, type KeyPurpose, type KeyRevocation } from '../../../src/lib/identity/keyDeclaration.ts';
import { fromHex } from '../../../src/lib/identity/canonical.ts';

const argv = [...Deno.args];
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv.splice(i, 1), true) : false; };
const opt = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const check = flag('check'); const revoke = flag('revoke');
const envFile = opt('env'); const out = opt('out');
const purposes = (opt('purposes', 'signing')!).split(',').map((s) => s.trim()) as KeyPurpose[];
const days = Number(opt('days', '90'));
const expect = opt('expect');
const die = (m: string): never => { console.error(`declare-node-key: ${m}`); Deno.exit(1); };

if (!out) die('--out <path to key-declarations.json> is required');
if (purposes.some((p) => p !== 'signing' && p !== 'hello')) die('--purposes takes signing and/or hello');
if (!(days > 0 && days <= 90)) die('--days must be 1–90 (KeyZ declarations last at most 90 days; renew before they expire)');

let nodePub = Deno.env.get('CAPPZ_NODE_PUB') ?? '';
if (envFile) for (const l of (await Deno.readTextFile(envFile)).split(/\r?\n/)) { const m = /^\s*CAPPZ_NODE_PUB=(.*)$/.exec(l); if (m) nodePub = m[1].trim(); }
nodePub = nodePub.toLowerCase();
if (!/^[0-9a-f]{64}$/.test(nodePub)) die('no CAPPZ_NODE_PUB (64 hex) in --env or the environment');

const revPath = out!.replace(/[^\\/]*$/, 'key-revocations.json');
async function readList<T>(path: string): Promise<T[]> {
  try { const v = JSON.parse(await Deno.readTextFile(path)); return Array.isArray(v) ? v : []; } catch (e) { if (e instanceof Deno.errors.NotFound) return []; throw e; }
}
async function writeAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  await Deno.writeTextFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await Deno.rename(tmp, path);
}
const existing = await readList<KeyDeclaration>(out!);
const revocations = await readList<KeyRevocation>(revPath);

async function report(decls: KeyDeclaration[]): Promise<void> {
  const mine = decls.filter((d) => d.v === 2 && d.publicKey?.toLowerCase() === nodePub);
  if (!mine.length) { console.log(`node key ${nodePub.slice(0, 16)}…: no declaration in ${out}`); return; }
  for (const d of mine) {
    const t = await evaluateKey(d.walletAddress, nodePub, d.purpose, { declarations: [d], revocations });
    console.log(`${t.state.padEnd(10)} ${d.purpose.padEnd(8)} by ${addressOf(d.walletAddress)} until ${d.expiresAt}  (${t.because})`);
  }
}
function addressOf(pub: string): string { try { return deriveAddress(pub.toUpperCase()); } catch { return `${pub.slice(0, 16)}…`; } }

if (check) { await report(existing); Deno.exit(0); }

/** Hidden prompt: raw mode, no echo. */
async function hidden(question: string): Promise<string> {
  const env = Deno.env.get('CAPPZ_WALLET_SEED');
  if (env) return env.trim();
  if (!Deno.stdin.isTerminal()) die('no terminal for the hidden prompt; set CAPPZ_WALLET_SEED for scripted runs');
  await Deno.stdout.write(new TextEncoder().encode(question));
  Deno.stdin.setRaw(true);
  const buf = new Uint8Array(1); let s = '';
  try {
    while (true) {
      const n = await Deno.stdin.read(buf);
      if (n === null) break;
      const c = buf[0];
      if (c === 13 || c === 10) break;
      if (c === 3) { Deno.stdin.setRaw(false); die('cancelled'); }
      if (c === 127 || c === 8) { s = s.slice(0, -1); continue; }
      s += String.fromCharCode(c);
    }
  } finally { Deno.stdin.setRaw(false); await Deno.stdout.write(new TextEncoder().encode('\n')); }
  return s.trim();
}

let wallet: Wallet;
try {
  const seed = await hidden('XRPL family seed of the declaring wallet (s…, hidden): ');
  // xrpl 4.x's fromSeed defaults to Ed25519 even for a secp256k1 seed (another account): take the algorithm the seed encodes.
  wallet = Wallet.fromSeed(seed, { algorithm: (decodeSeed(seed).type === 'ed25519' ? 'ed25519' : 'ecdsa-secp256k1') as never });
} catch { die('not a valid XRPL family seed'); }
if (/^ed/i.test(wallet!.publicKey)) die(`${wallet!.classicAddress} is an Ed25519 XRPL account; KeyZ declarations are signed with secp256k1. Use a secp256k1 account (most family seeds) for the declaring wallet.`);
if (expect && wallet!.classicAddress !== expect) die(`the seed belongs to ${wallet!.classicAddress}, not ${expect}; nothing written`);
const walletAddress = wallet!.publicKey.toLowerCase();
const walletPrivateKey = fromHex(wallet!.privateKey.replace(/^00/, '').toLowerCase());

if (revoke) {
  const targets = existing.filter((d) => d.v === 2 && d.publicKey.toLowerCase() === nodePub && d.walletAddress.toLowerCase() === walletAddress);
  if (!targets.length) die(`no declaration of ${nodePub.slice(0, 16)}… by ${wallet!.classicAddress} in ${out}`);
  const known = new Set(revocations.map((r) => r.declarationHash));
  for (const d of targets) if (!known.has(await declarationHash(d))) revocations.push(await revokeKeyDeclaration(walletPrivateKey, d, 'revoked by the operator (declare-node-key --revoke)'));
  await writeAtomic(revPath, revocations);
  console.log(`revoked ${targets.length} declaration(s) → ${revPath}. Nodes and agents pick it up within a minute; copy it wherever the declarations file is served.`);
  Deno.exit(0);
}

const next: KeyDeclaration[] = existing.filter((d) => !(d.v === 2 && d.publicKey?.toLowerCase() === nodePub && d.walletAddress?.toLowerCase() === walletAddress && purposes.includes(d.purpose)));
for (const purpose of purposes) {
  const prev = existing.find((d) => d.v === 2 && d.publicKey?.toLowerCase() === nodePub && d.walletAddress?.toLowerCase() === walletAddress && d.purpose === purpose);
  next.push(await declareKey(walletPrivateKey, walletAddress, { publicKey: nodePub, algorithm: 'ed25519', purpose, ...(prev ? { supersedes: await declarationHash(prev) } : {}) }, days * 86_400_000));
}
walletPrivateKey.fill(0);
await writeAtomic(out!, next);
console.log(`${wallet!.classicAddress} declared node key ${nodePub.slice(0, 16)}… for ${purposes.join(', ')} for ${days} days → ${out}`);
await report(next);
