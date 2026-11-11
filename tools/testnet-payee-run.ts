/**
 * Real XRPL testnet run of the payee confirmation (v15-38-00), for development.
 *
 *   npx vite-node tools/testnet-payee-run.ts [-- --out <file>]
 *
 * Everything on the ledger is real (testnet): wallets from the faucet, endorsement AccountSets, a prior payment, and
 * both fee stages paid by the built `cappz-market confirm-payee` to the treasury addresses of the check service's
 * testnet configuration. The check service is the real worker code (packages/cappz-check-worker/worker.ts), served on
 * localhost with an in-memory job store; the marketplace log it reads is a local mirror stand-in holding this run's
 * party entries in the real row format (publishing to the shared CAPPZ testnet market needs a signed-in account, so
 * nothing is written there).
 *
 * Wallets are kept for reuse in ~/.cappz/dev/testnet-wallets.json (mode 600, outside the repo; override with
 * CAPPZ_DEV_WALLETS). Testnet is reset from time to time: a wallet the ledger no longer knows is replaced with a new
 * faucet-funded one. The treasury is never created or changed here.
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, chmod, mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Client, Wallet } from 'xrpl';
import { ed25519 } from '@noble/curves/ed25519';
import worker, { type Env } from '../packages/cappz-check-worker/worker';
import { XRPL_ENDPOINTS } from '../src/lib/xrpl/ledgerCheck';
import { xrplRpc, XrplRpcError } from '../src/lib/xrpl/xrplRpc';
import { seedSigner, signAndSubmit } from '../src/lib/marketplace/ledgerSigning';
import { marketLedger, type MarketTx } from '../src/lib/marketplace/ledger';
import { partyAddress } from '../src/lib/marketplace/MarketplacePaths';
import { marketPartition, publishToPublicLog, attributePublicLog, pullPublicLog, type PublicLogPort } from '../src/lib/marketplace/publicLog';
import { resolveMarket } from '../src/lib/marketplace/replay';
import { buildPayeeAnchor, buildPayeeInstructions, newInstructionsId, prepareEndorsement, runPayeeConfirmation, verifyPayeeReport, type PayeeInstructionsContent, type SignedPayeeReport } from '../src/lib/marketplace/payeeConfirmation';

const NET = 'testnet' as const;
/** The check service's testnet treasury (wrangler.toml PAY_TO_TESTNET / AGENT_PAY_TO_TESTNET). Read, never written. */
const TREASURY_TESTNET = 'rnQ3gydd9kTdx6gHKzhNHSKHSq6whzdiMe';
const WALLETS = process.env.CAPPZ_DEV_WALLETS ?? join(homedir(), '.cappz', 'dev', 'testnet-wallets.json');
const ROLES = ['payee', 'receiving', 'payer', 'fraud'] as const;
type Role = typeof ROLES[number];
interface WalletFile { network: 'testnet'; note: string; signingSeed: string; wallets: Partial<Record<Role, { address: string; seed: string; createdAt: string }>> }
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const log = (...a: unknown[]) => console.error('·', ...a);

async function activated(address: string): Promise<boolean> {
  try { await xrplRpc(NET, 'account_info', { account: address, ledger_index: 'validated' }); return true; }
  catch (e) { if (e instanceof XrplRpcError && e.code === 'actNotFound') return false; throw e; }
}

/** Load the dev wallets; replace any the ledger no longer knows (testnet reset) with a faucet-funded one. */
async function devWallets(): Promise<{ file: WalletFile; created: Role[] }> {
  let file: WalletFile;
  try { file = JSON.parse(await readFile(WALLETS, 'utf8')) as WalletFile; }
  catch { file = { network: 'testnet', note: 'CAPPZ development wallets on XRPL testnet (tools/testnet-payee-run.ts). Testnet only; replaced automatically after a testnet reset.', signingSeed: hex(crypto.getRandomValues(new Uint8Array(32))), wallets: {} }; }
  const created: Role[] = [];
  const client = new Client(XRPL_ENDPOINTS[NET]);
  try {
    for (const role of ROLES) {
      const w = file.wallets[role];
      if (w && await activated(w.address)) continue;
      if (!client.isConnected()) await client.connect();
      log(`${role}: ${w ? `${w.address} is gone (testnet reset?) — ` : ''}creating a faucet-funded wallet`);
      const { wallet } = await client.fundWallet();
      file.wallets[role] = { address: wallet.classicAddress, seed: wallet.seed!, createdAt: new Date().toISOString() };
      created.push(role);
    }
  } finally { await client.disconnect().catch(() => {}); }
  await mkdir(dirname(WALLETS), { recursive: true });
  await writeFile(WALLETS, JSON.stringify(file, null, 2));
  await chmod(WALLETS, 0o600);
  return { file, created };
}

/** The D1 subset d1JobStore uses, in memory. */
function memoryD1() {
  const events: Array<{ seq: number; network: string; job_id: string; type: string; tx_hash: string | null; body: string }> = [];
  const results = new Map<string, Uint8Array>();
  return {
    prepare(sql: string) {
      let v: unknown[] = [];
      const stmt = {
        bind: (...b: unknown[]) => { v = b; return stmt; },
        async run() {
          if (sql.startsWith('INSERT INTO events')) events.push({ seq: events.length + 1, network: v[0] as string, job_id: v[1] as string, type: v[2] as string, tx_hash: v[3] as string | null, body: v[4] as string });
          else if (sql.startsWith('INSERT OR REPLACE INTO results')) results.set(`${v[0]}|${v[1]}|${v[2]}`, v[3] as Uint8Array);
          return {};
        },
        async all<T>() { return { results: events.filter((e) => e.network === v[0] && (v.length < 2 || e.job_id === v[1])).map((e) => ({ body: e.body })) as T[] }; },
        async first<T>() {
          if (sql.includes("type = 'StagePaid'")) return (events.some((e) => e.network === v[0] && e.type === 'StagePaid' && e.tx_hash === v[1]) ? { x: 1 } : null) as T | null;
          const r = results.get(`${v[0]}|${v[1]}|${v[2]}`); return (r ? { bytes: r } : null) as T | null;
        },
      };
      return stmt;
    },
  };
}

async function main() {
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
  const treasuryOk = await activated(TREASURY_TESTNET);
  if (!treasuryOk) throw new Error(`The testnet treasury ${TREASURY_TESTNET} is not activated (testnet reset?). Activate it first; this tool never creates it.`);
  const { file, created } = await devWallets();
  const W = Object.fromEntries(ROLES.map((r) => [r, file.wallets[r]!])) as unknown as Record<Role, { address: string; seed: string }>;
  log('wallets', Object.fromEntries(ROLES.map((r) => [r, W[r].address])), created.length ? `(new: ${created.join(', ')})` : '(reused)');

  // ── The market log (local stand-in for the mirror, real row format and attribution) ──
  const rows: Array<{ metadata: unknown; created_at: string }> = [];
  const collect = (author: string): PublicLogPort => ({ insert: async (r) => { rows.push(...r.map((x) => ({ metadata: x.metadata, created_at: new Date().toISOString() }))); return { error: null }; }, select: async () => ({ data: rows, error: null }) });
  const publish = async (party: string, txs: MarketTx[]) => { await publishToPublicLog(collect(party), txs, `author-${party}`, party, marketPartition(NET)); await new Promise((r) => setTimeout(r, 5)); };
  const state = async () => { const txs = attributePublicLog(await pullPublicLog(collect(''), null)).accepted; return { txs, state: resolveMarket(txs) }; };
  const profileTx = async (partyId: string, name: string, xrplAccount: string) => marketLedger.create({ eventType: 'ContentCreated', sourceAddress: partyAddress(partyId), targetAddress: partyAddress(partyId), payload: { contentClass: 'party', profile: { partyId, name, kind: 'organization', roles: ['seller', 'buyer'], region: 'NJ', about: 'testnet run', capabilities: { categories: [], canPlantNew: false }, xrplAccount } } });
  const run = Date.now().toString(36);
  const SELLER = `p-seller-${run}`; const FRAUD = `p-fraud-${run}`; const TOWN = `p-town-${run}`;
  await publish(SELLER, [await profileTx(SELLER, 'Main Street Land LLC', W.payee.address)]);
  await publish(FRAUD, [await profileTx(FRAUD, 'Main Street Land, LLC', W.fraud.address)]);
  await publish(TOWN, [await profileTx(TOWN, 'Township of Example', W.payer.address)]);

  const sign = (role: Role, tx: Record<string, unknown>) => signAndSubmit(seedSigner(W[role].seed), tx, NET);
  const declare = async (party: string, role: Role, instrument: PayeeInstructionsContent['instrument'], extra: Partial<PayeeInstructionsContent> = {}, alsoFrom?: Role) => {
    const content: PayeeInstructionsContent = { instructionsId: newInstructionsId(), partyId: party, network: NET, instrument, validFrom: new Date(Date.now() - 60_000).toISOString(), validUntil: null, purpose: 'Testnet run: land purchase', ...extra };
    const { txs, hash } = await buildPayeeInstructions((await state()).state, party, content);
    await publish(party, txs);
    const anchors: string[] = [];
    for (const r of [role, ...(alsoFrom ? [alsoFrom] : [])]) {
      const lt = await sign(r, prepareEndorsement(W[r].address, content.instructionsId, hash));
      if (lt.result !== 'tesSUCCESS') throw new Error(`Endorsement from ${r} failed: ${lt.result}`);
      await publish(party, await buildPayeeAnchor(party, content.instructionsId, lt.hash));
      anchors.push(lt.hash);
      log(`endorsed ${content.instructionsId} from ${r} ${W[r].address}: ${lt.hash} (${lt.closeTime})`);
    }
    return { content, hash, anchors };
  };

  // Old instructions (tag 1), which the town paid once; new instructions (tag 2) replacing them, endorsed by the payee's
  // wallet AND signed from the receiving address (control); the fraudster's own declaration of its wallet.
  const old = await declare(SELLER, 'payee', { kind: 'xrpl', address: W.receiving.address, destinationTag: 1 });
  const prior = await sign('payer', { TransactionType: 'Payment', Account: W.payer.address, Destination: W.receiving.address, DestinationTag: 1, Amount: '1000000' });
  log(`prior payment to the old instructions: ${prior.hash} ${prior.result}`);
  const neu = await declare(SELLER, 'payee', { kind: 'xrpl', address: W.receiving.address, destinationTag: 2 }, { supersedes: [old.content.instructionsId] }, 'receiving');
  const fraud = await declare(FRAUD, 'fraud', { kind: 'xrpl', address: W.fraud.address });

  // ── Rules against the real ledger, now and as of 73 hours after the endorsements (the cooling period) ──
  const m = await state();
  const later = new Date(Date.now() + 73 * 3_600_000).toISOString();
  const check = async (label: string, address: string, tag: number | undefined, now?: string) => {
    const r = await runPayeeConfirmation({ network: NET, payee: SELLER, instrument: { kind: 'xrpl', address, ...(tag !== undefined ? { destinationTag: tag } : {}) }, payer: W.payer.address, amount: 5 }, m.state, m.txs, now);
    return { label, asOf: now ?? 'now', verdict: r.verdict, binding: r.binding.state, control: r.binding.control, inForceFrom: r.binding.inForceFrom, reasons: r.reasons.map((x) => `${x.level}:${x.code}`), anchors: r.ledger.anchors.map((a) => ({ tx: a.txHash, account: a.account, validated: a.validated, closeTime: a.closeTime })) };
  };
  const rules = [
    await check('new instructions, right after endorsement', W.receiving.address, 2),
    await check('new instructions, after the cooling period', W.receiving.address, 2, later),
    await check('old (replaced) instructions', W.receiving.address, 1, later),
    await check('fraudster\'s address claimed for the seller', W.fraud.address, undefined, later),
    await check('right address, undeclared tag', W.receiving.address, 3, later),
  ];

  // ── End to end: the real worker on localhost, the built CLI paying both stages on testnet ──
  const env: Env = { DB: memoryD1() as never, CHECK_SIGNING_SEED: file.signingSeed, MIRROR_URL: '', MIRROR_KEY: 'local', PAY_TO_MAINNET: 'rUqPbiwe2Z5rj2AewokbFHCGQPtwjtzjHM', PAY_TO_TESTNET: TREASURY_TESTNET, AGENT_PAY_TO_MAINNET: 'rhszv2Ghe8NbqPDmmdJvJ4Cq2E3hjfYnYh', AGENT_PAY_TO_TESTNET: TREASURY_TESTNET, PRICE_XRP: '0.01', PRICE_PAYEE_XRP: '0.1', PRICE_PAYEE_PLATFORM_XRP: '0.01' };
  const publicKey = hex(ed25519.getPublicKey(Uint8Array.from(file.signingSeed.match(/../g)!.map((x) => parseInt(x, 16)))));
  const server = createServer(async (req, res) => {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${req.url}`;
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const send = (status: number, body: string | Uint8Array, headers: Record<string, string> = { 'content-type': 'application/json' }) => { res.writeHead(status, headers); res.end(body); };
    if (req.url!.startsWith('/.well-known/cappz-market.json')) return send(200, JSON.stringify({ name: 'local', services: { payeeConfirmation: { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, path: 'payee', publicKey, priceXrp: 0.11, networks: ['testnet'] } } }));
    if (req.url!.startsWith('/rest/v1/chainlet_blocks')) return send(200, JSON.stringify(rows));
    const r = await worker.fetch(new Request(url, { method: req.method, headers: req.headers as Record<string, string>, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }), env, { waitUntil: () => {} });
    send(r.status, new Uint8Array(await r.arrayBuffer()), Object.fromEntries(r.headers.entries()));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  env.MIRROR_URL = base;
  const before = Number((await xrplRpc<{ account_data: { Balance: string } }>(NET, 'account_info', { account: TREASURY_TESTNET, ledger_index: 'validated' })).account_data.Balance);
  const home = await mkdtemp(join(tmpdir(), 'cappz-payee-run-'));
  const cli = async (...args: string[]) => {
    const r = await promisify(execFile)('node', ['packages/cappz-market/dist/cappz-market.mjs', ...args], { env: { ...process.env, CAPPZ_MARKET_URL: base, CAPPZ_HOME: home, XRPL_SEED: W.payer.seed }, timeout: 300_000 }).catch((e) => ({ stdout: e.stdout as string, stderr: e.stderr as string }));
    try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout, stderr: r.stderr }; }
  };
  log('cappz-market confirm-payee (pays 0.01 + 0.1 XRP on testnet)…');
  const e2e = await cli('confirm-payee', SELLER, '--address', W.receiving.address, '--tag', '2', '--amount', '5');
  const unknown = await cli('confirm-payee', 'p-nobody-here', '--address', W.receiving.address);
  server.close();
  const after = Number((await xrplRpc<{ account_data: { Balance: string } }>(NET, 'account_info', { account: TREASURY_TESTNET, ledger_index: 'validated' })).account_data.Balance);
  const signed = e2e.report ? JSON.parse(await readFile(e2e.report, 'utf8')) as SignedPayeeReport : null;

  const summary = {
    network: NET, at: new Date().toISOString(), wallets: Object.fromEntries(ROLES.map((r) => [r, W[r].address])), walletsFile: WALLETS, createdThisRun: created,
    parties: { seller: SELLER, fraud: FRAUD, town: TOWN },
    ledger: { oldEndorsement: old.anchors, priorPayment: prior.hash, newEndorsements: neu.anchors, fraudEndorsement: fraud.anchors },
    rules,
    endToEnd: { verdict: e2e.verdict, binding: e2e.binding?.state, inForceFrom: e2e.binding?.inForceFrom, reasons: e2e.reasons?.map((x: { level: string; code: string }) => `${x.level}:${x.code}`), signedByCappz: e2e.signedByCappz, hashMatched: e2e.hashMatched, paid: e2e.paid, signatureRecheck: signed ? verifyPayeeReport(signed, publicKey) : null, error: e2e.error ?? e2e.raw ?? null },
    unknownPayee: { verdict: unknown.verdict, reasons: unknown.reasons, paid: unknown.paid },
    treasuryTestnet: { address: TREASURY_TESTNET, receivedDrops: after - before },
  };
  const text = JSON.stringify(summary, null, 2);
  if (out) await writeFile(out, text);
  console.log(text);
}

main().catch((e) => { console.error(e); process.exit(1); });
