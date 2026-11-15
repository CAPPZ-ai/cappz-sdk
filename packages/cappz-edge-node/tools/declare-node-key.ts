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
 *
 * 15.45.0 — ON THE LEDGER, NO SEED (--ledger): the payout account signs one XRPL
 * transaction in its own wallet (Xaman: scan a QR code, approve) that declares the node
 * key (agents/ledgerKeyz.ts). This tool builds it, hands it to Xaman, waits until it is
 * validated, and writes an anchor {"v":"xrpl","network","txHash"} into --out.
 *
 *   deno run --config deno.json --allow-read --allow-write --allow-env --allow-net --allow-run \
 *     packages/cappz-edge-node/tools/declare-node-key.ts --ledger \
 *     --env <node folder>/node.env --out <node folder>/data/key-declarations.json \
 *     --account rPayoutAddress [--network mainnet] [--days 90] [--purposes signing,hello] \
 *     [--xaman-env <node folder>/xaman.env] [--no-open] [--json]
 *   … --ledger --hash <tx hash>   register a declaration already submitted from any wallet
 *   … --ledger --revoke           sign a revocation the same way (the agents stop signing within 5 minutes)
 *   … --check                     state of every declaration in --out (reads the ledger for anchors)
 *
 * Xaman shows sign requests created with an app key: create a free app at apps.xumm.dev
 * once and put CAPPZ_XAMAN_API_KEY / CAPPZ_XAMAN_API_SECRET in xaman.env (or the
 * environment). They can only ask you to sign; they cannot sign or move funds. Without
 * them the tool prints the transaction JSON for any wallet that signs a JSON transaction
 * and waits for it on the ledger the same way.
 * Exit codes: 0 done, 1 error, 3 rejected or expired in the wallet, 4 timed out waiting.
 */
import { decodeSeed, deriveAddress, Wallet } from 'xrpl';
import { declareKey, declarationHash, evaluateKey, revokeKeyDeclaration, type KeyDeclaration, type KeyPurpose, type KeyRevocation } from '../../../src/lib/identity/keyDeclaration.ts';
import { fromHex } from '../../../src/lib/identity/canonical.ts';
import {
  anchorRef, checkAnchor, declarationMemo, isLedgerAnchor, keyzMemoOf, keyzTransaction, recentAccountTx, xrplRpc, XAMAN_NETWORK,
  type KeyzMemo, type LedgerAnchor,
} from '../agents/ledgerKeyz.ts';
import type { XrplNetwork } from '../../../src/lib/xrpl/ledgerCheck.ts';

const argv = [...Deno.args];
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv.splice(i, 1), true) : false; };
const opt = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const check = flag('check'); const revoke = flag('revoke'); const ledger = flag('ledger'); const noOpen = flag('no-open'); const asJson = flag('json');
const account = opt('account'); const network = (opt('network', 'mainnet')!) as XrplNetwork; const givenHash = opt('hash');
const xamanEnv = opt('xaman-env'); const waitMinutes = Number(opt('wait-minutes', '15'));
const envFile = opt('env'); const out = opt('out');
const purposes = (opt('purposes', 'signing')!).split(',').map((s) => s.trim()) as KeyPurpose[];
const days = Number(opt('days', '90'));
const expect = opt('expect');
const die = (m: string, code = 1): never => {
  if (asJson) console.log(JSON.stringify({ ok: false, error: m, exitCode: code }));
  console.error(`declare-node-key: ${m}`); Deno.exit(code);
};
/** Progress for people; with --json it goes to stderr and stdout carries one JSON result line. */
const say = (m: string) => (asJson ? console.error(m) : console.log(m));

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
const existing = await readList<KeyDeclaration | LedgerAnchor>(out!);
const revocations = await readList<KeyRevocation>(revPath);

async function report(decls: Array<KeyDeclaration | LedgerAnchor>): Promise<void> {
  const mine = (decls as KeyDeclaration[]).filter((d) => d.v === 2 && d.publicKey?.toLowerCase() === nodePub);
  const anchors = (decls as unknown[]).filter(isLedgerAnchor).filter((a) => !a.key || a.key === nodePub);
  const states: Array<Record<string, unknown>> = [];
  if (!mine.length && !anchors.length) say(`node key ${nodePub.slice(0, 16)}…: no declaration in ${out}`);
  for (const d of mine) {
    const t = await evaluateKey(d.walletAddress, nodePub, d.purpose, { declarations: [d], revocations });
    say(`${t.state.padEnd(10)} ${d.purpose.padEnd(8)} by ${addressOf(d.walletAddress)} until ${d.expiresAt}  (${t.because})`);
    states.push({ kind: 'wallet-signed', state: t.state, purpose: d.purpose, account: addressOf(d.walletAddress), until: d.expiresAt });
  }
  for (const a of anchors) {
    const t = await checkAnchor(a, nodePub, 'signing').catch((e) => ({ state: 'unreadable', because: `the XRP Ledger could not be read: ${(e as Error).message}` }) as const);
    say(`${t.state.padEnd(10)} signing  on ${a.network} ledger, tx ${a.txHash.slice(0, 16)}…  (${t.because})`);
    states.push({ kind: 'on-ledger', state: t.state, network: a.network, txHash: a.txHash, ref: anchorRef(a.network, a.txHash), because: t.because, ...('until' in t ? { account: t.account, until: t.until } : {}) });
  }
  if (asJson && check) console.log(JSON.stringify({ ok: true, nodeKey: nodePub, declarations: states }));
}
function addressOf(pub: string): string { try { return deriveAddress(pub.toUpperCase()); } catch { return `${pub.slice(0, 16)}…`; } }

if (check) { await report(existing); Deno.exit(0); }

// ─── On the ledger: the payout account signs in its own wallet (15.45.0) ─────

async function readEnvFile(path: string | undefined): Promise<Record<string, string>> {
  const vals: Record<string, string> = {};
  if (!path) return vals;
  try { for (const l of (await Deno.readTextFile(path)).split(/\r?\n/)) { const m = /^\s*([A-Z_]+)=(.*)$/.exec(l); if (m) vals[m[1]] = m[2].trim(); } }
  catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; }
  return vals;
}

function openInBrowser(url: string): boolean {
  if (noOpen) return false;
  try {
    const cmd = Deno.build.os === 'windows' ? ['cmd', '/c', 'start', '""', url] : Deno.build.os === 'darwin' ? ['open', url] : ['xdg-open', url];
    new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: 'null', stderr: 'null' }).spawn();
    return true;
  } catch { return false; }
}

/** Xaman's platform API (CAPPZ_XAMAN_API_BASE only for tests against a stand-in). */
const XAMAN_API = (Deno.env.get('CAPPZ_XAMAN_API_BASE') || 'https://xumm.app/api/v1/platform').replace(/\/+$/, '');
interface XamanAsk { uuid: string; signUrl: string; qrPng: string }
async function xamanAsk(creds: { key: string; secret: string }, txjson: Record<string, unknown>, instruction: string): Promise<XamanAsk> {
  const res = await fetch(`${XAMAN_API}/payload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': creds.key, 'x-api-secret': creds.secret },
    body: JSON.stringify({ txjson, options: { submit: true, expire: waitMinutes, force_network: XAMAN_NETWORK[network] }, custom_meta: { instruction } }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.uuid) die(`Xaman refused the sign request (${res.status} ${JSON.stringify(body?.error ?? body).slice(0, 200)}). Check CAPPZ_XAMAN_API_KEY / CAPPZ_XAMAN_API_SECRET (apps.xumm.dev → your app → API credentials).`);
  return { uuid: body.uuid, signUrl: body.next?.always, qrPng: body.refs?.qr_png };
}
/** Where the sign request stands (best effort: the ledger is what decides). Fields as the Xaman GET /payload/<uuid> schema documents them. */
async function xamanState(creds: { key: string; secret: string }, uuid: string): Promise<{ state: 'signed' | 'rejected' | 'expired' | 'open'; txid?: string; dispatched?: string }> {
  try {
    const r = await fetch(`${XAMAN_API}/payload/${uuid}`, { headers: { 'x-api-key': creds.key, 'x-api-secret': creds.secret } });
    const b = await r.json();
    if (b?.meta?.signed) return { state: 'signed', txid: b.response?.txid, dispatched: b.response?.dispatched_result };
    if (b?.meta?.resolved) return { state: 'rejected' };            // resolved, not signed: the person declined
    if (b?.meta?.expired || b?.meta?.cancelled) return { state: 'expired' }; // never acted on
  } catch { /* the ledger watch continues */ }
  return { state: 'open' };
}

/** Sign `memo` from `acct` in a wallet and wait until the ledger validates it; returns the transaction hash. */
async function signOnLedger(acct: string, memo: KeyzMemo, instruction: string): Promise<string> {
  const txjson = keyzTransaction(acct, memo);
  const file = await readEnvFile(xamanEnv);
  const xk = Deno.env.get('CAPPZ_XAMAN_API_KEY') || file.CAPPZ_XAMAN_API_KEY;
  const xs = Deno.env.get('CAPPZ_XAMAN_API_SECRET') || file.CAPPZ_XAMAN_API_SECRET;
  const creds = xk && xs ? { key: xk, secret: xs } : null;
  const since = Date.now();
  let ask: XamanAsk | null = null;
  if (creds) {
    ask = await xamanAsk(creds, txjson, instruction);
    const opened = openInBrowser(ask.qrPng);
    say('');
    say('  ┌─ Approve in Xaman ───────────────────────────────────────────────');
    say(`  │ ${opened ? 'A QR code opened in your browser.' : `Open this QR code: ${ask.qrPng}`}`);
    say('  │ 1. Open Xaman on your phone and tap Scan (or open the link below on the phone).');
    say(`  │ 2. Check the account is ${acct}, then slide to accept.`);
    say('  │ It changes nothing on your account; the network fee is about 0.00001 XRP.');
    say(`  │ Link: ${ask.signUrl}`);
    say('  └──────────────────────────────────────────────────────────────────');
  } else {
    say('');
    say('No Xaman app key found, so here is the transaction to sign in any wallet that signs a JSON transaction:');
    say(JSON.stringify(txjson, null, 2));
    say(`Account ${acct}, network ${network}. It changes nothing on the account; the fee is about 0.00001 XRP.`);
    say('To use Xaman instead (one time, ~3 minutes): create an app at https://apps.xumm.dev, then put');
    say(`  CAPPZ_XAMAN_API_KEY=…  and  CAPPZ_XAMAN_API_SECRET=…  in ${xamanEnv ?? 'xaman.env (pass --xaman-env)'} and run this again.`);
  }
  say(`Waiting for the ${network} ledger to validate it (up to ${waitMinutes} minutes; Ctrl+C to stop, then use --hash <tx hash> once it is in)…`);
  let round = 0;
  while (Date.now() - since < waitMinutes * 60_000) {
    await new Promise((r) => setTimeout(r, 4000));
    round++;
    const recent = await recentAccountTx(network, acct).catch(() => []);
    const hit = recent.find((t) => t.validated && t.type === 'AccountSet' && JSON.stringify(keyzMemoOf(t)) === JSON.stringify(memo));
    if (hit) {
      if (hit.result !== 'tesSUCCESS') die(`the transaction ${hit.hash} failed on the ledger (${hit.result}); nothing written`);
      say(`Validated: ${hit.hash} (ledger ${hit.ledgerIndex}).`);
      return hit.hash;
    }
    // Xaman asks integrators not to poll hard: its status every 3rd round (~12 s), the public ledger every round.
    if (ask && round % 3 === 0) {
      const st = await xamanState(creds!, ask.uuid);
      if (st.state === 'rejected') die('the request was declined in Xaman; nothing written', 3);
      if (st.state === 'expired') die('the request expired in Xaman before it was signed; run again', 3);
      if (st.state === 'signed' && st.dispatched && !/^(tesSUCCESS|terQUEUED)$/.test(st.dispatched)) die(`Xaman signed it but the ledger refused it (${st.dispatched}${st.txid ? `, ${st.txid}` : ''}); nothing written`);
      if (st.state === 'signed' && round % 15 === 0) say(`Signed in Xaman${st.txid ? ` (${st.txid})` : ''}; waiting for a validated ledger…`);
    }
  }
  return die(`not seen on the ${network} ledger within ${waitMinutes} minutes. If you signed it, run again with --hash <tx hash>.`, 4);
}

async function onLedger(): Promise<never> {
  if (!['mainnet', 'testnet', 'devnet'].includes(network)) die('--network is mainnet, testnet or devnet');
  const anchors = (existing as unknown[]).filter(isLedgerAnchor);
  const acct = account ?? anchors.find((a) => a.key === nodePub)?.account;
  if (!acct || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(acct)) die('--account rADDRESS is required: the XRPL account that vouches for the node (your payout account)');
  try { await xrplRpc(network, 'account_info', { account: acct, ledger_index: 'validated' }); }
  catch (e) { die((e as { code?: string }).code === 'actNotFound' ? `${acct} is not activated on ${network}; fund it first (or pick --network)` : `the XRP Ledger (${network}) could not be read: ${(e as Error).message}`); }

  if (revoke) {
    const hash = givenHash ?? await signOnLedger(acct!, { v: 1, op: 'revoke', key: nodePub }, `Revokes every CAPPZ KeyZ declaration of edge node key ${nodePub.slice(0, 16)}… by this account. Changes nothing else.`);
    say(`Revoked on the ledger in ${hash}. The agents stop signing with this declaration within 5 minutes; verifiers see the revocation now.`);
    if (asJson) console.log(JSON.stringify({ ok: true, action: 'revoke', network, account: acct, txHash: hash }));
    Deno.exit(0);
  }

  const memo = declarationMemo(nodePub, purposes, days);
  const hash = givenHash?.toUpperCase() ?? await signOnLedger(acct!, memo, `Declares CAPPZ edge node key ${nodePub.slice(0, 16)}… as speaking for this account (${purposes.join(', ')}) until ${memo.op === 'declare' ? memo.until.slice(0, 10) : ''}. Changes nothing on the account.`);
  const anchor: LedgerAnchor = { v: 'xrpl', network, txHash: hash, account: acct, key: nodePub };
  const t = await checkAnchor(anchor, nodePub, 'signing');
  if (t.state !== 'declared') return die(`transaction ${hash.slice(0, 16)}… does not declare this node key for signing: ${t.because}; nothing written`);
  if (t.account !== acct) die(`transaction ${hash.slice(0, 16)}… is from ${t.account}, not ${acct}; nothing written`);
  anchor.until = t.until;
  // Older anchors of this key by this account are superseded (wallet-signed declarations stay).
  const next = (existing as unknown[]).filter((d) => !(isLedgerAnchor(d) && d.account === acct && (!d.key || d.key === nodePub)));
  next.push(anchor);
  await writeAtomic(out!, next);
  say(`${acct} declared node key ${nodePub.slice(0, 16)}… on the ${network} ledger until ${t.until} → ${out}`);
  say('The paid agents pick it up within a minute (restart them if CAPPZ_NODE_KEY_DECLARATIONS was not set before).');
  if (asJson) console.log(JSON.stringify({ ok: true, action: 'declare', network, account: acct, txHash: hash, ref: anchorRef(network, hash), until: t.until, file: out }));
  Deno.exit(0);
}

// After the definitions above (their consts must be initialized before onLedger runs).
if (ledger) await onLedger();

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
  const targets = (existing as KeyDeclaration[]).filter((d) => d.v === 2 && d.publicKey.toLowerCase() === nodePub && d.walletAddress.toLowerCase() === walletAddress);
  if (!targets.length) die(`no declaration of ${nodePub.slice(0, 16)}… by ${wallet!.classicAddress} in ${out}`);
  const known = new Set(revocations.map((r) => r.declarationHash));
  for (const d of targets) if (!known.has(await declarationHash(d))) revocations.push(await revokeKeyDeclaration(walletPrivateKey, d, 'revoked by the operator (declare-node-key --revoke)'));
  await writeAtomic(revPath, revocations);
  console.log(`revoked ${targets.length} declaration(s) → ${revPath}. Nodes and agents pick it up within a minute; copy it wherever the declarations file is served.`);
  Deno.exit(0);
}

const next = (existing as KeyDeclaration[]).filter((d) => !(d.v === 2 && d.publicKey?.toLowerCase() === nodePub && d.walletAddress?.toLowerCase() === walletAddress && purposes.includes(d.purpose)));
for (const purpose of purposes) {
  const prev = (existing as KeyDeclaration[]).find((d) => d.v === 2 && d.publicKey?.toLowerCase() === nodePub && d.walletAddress?.toLowerCase() === walletAddress && d.purpose === purpose);
  next.push(await declareKey(walletPrivateKey, walletAddress, { publicKey: nodePub, algorithm: 'ed25519', purpose, ...(prev ? { supersedes: await declarationHash(prev) } : {}) }, days * 86_400_000));
}
walletPrivateKey.fill(0);
await writeAtomic(out!, next);
console.log(`${wallet!.classicAddress} declared node key ${nodePub.slice(0, 16)}… for ${purposes.join(', ')} for ${days} days → ${out}`);
await report(next);
