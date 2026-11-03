/**
 * COPE node crystallized. Node ID: v15-25-00-cappz-market-context.
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * Everything the cappz-market tool keeps on this computer, and how it reaches
 * the shared market. Keys stay here: the XRPL seed, the box key and escrow
 * secrets live in CAPPZ_HOME (default ~/.cappz/market, files 0600) or come
 * from the environment; nothing secret is ever sent. The shared log's address
 * comes from the marketplace's discovery document
 * (<CAPPZ_MARKET_URL>/.well-known/cappz-market.json), so this tool carries no
 * backend of its own. --demo runs the same rules on a local practice market.
 */
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client, Wallet } from 'xrpl';
import { XRPL_ENDPOINTS, type XrplNetwork } from '../../src/lib/xrpl/ledgerCheck';
import { sha256Hex } from '../../src/lib/governance/PrinciplesChainlet';
import { generateBoxKeyPair } from '../../src/lib/crypto/sealedBox';
import { resolveMarket, type MarketState } from '../../src/lib/marketplace/replay';
import { DEMO_YOU, DemoRunner, seedDemoMarket } from '../../src/lib/marketplace/demo';
import { PUBLIC_LOG_PARTITION, attributePublicLog, authorHashOf, publishToPublicLog, pullPublicLog, type PublicLogPort } from '../../src/lib/marketplace/publicLog';
import { resolveSettlementPolicy, type SettlementPolicy } from '../../src/lib/marketplace/settlement';
import { MARKETPLACE_POW_ROOT } from '../../src/lib/marketplace/MarketplacePaths';
import type { MarketTx, MarketTxLike } from '../../src/lib/marketplace/ledger';
import type { Actor } from '../../src/lib/marketplace/model';

export class ToolError extends Error {
  constructor(message: string, readonly next?: string) { super(message); }
}

/** Global options every command accepts. */
export interface GlobalOptions { demo?: boolean; as?: string; yes?: boolean }

/** The marketplace's public discovery document. */
export interface Discovery {
  name: string;
  web: string;
  mirror: { url: string; publishableKey: string; table: string };
  publicLog: { partition: string };
  agentsPage: string;
  skills: string;
}

const HOME = () => process.env.CAPPZ_HOME ?? join(homedir(), '.cappz', 'market');
const MARKET_URL = () => (process.env.CAPPZ_MARKET_URL ?? 'https://cappz.ai').replace(/\/$/, '');

async function readJson<T>(name: string): Promise<T | null> {
  try { return JSON.parse(await readFile(join(HOME(), name), 'utf8')) as T; } catch { return null; }
}
async function writeJson(name: string, value: unknown, secret = false): Promise<void> {
  await mkdir(HOME(), { recursive: true });
  const p = join(HOME(), name);
  await writeFile(p, JSON.stringify(value, null, 2) + '\n', { mode: secret ? 0o600 : 0o644 });
  if (secret) await chmod(p, 0o600).catch(() => {});
}

// ─── Discovery and the shared log ─────────────────────────────────

let discovery: Discovery | null = null;
export async function getDiscovery(): Promise<Discovery> {
  if (discovery) return discovery;
  if (process.env.CAPPZ_MIRROR_URL && process.env.CAPPZ_MIRROR_KEY) {
    discovery = { name: 'custom', web: MARKET_URL(), mirror: { url: process.env.CAPPZ_MIRROR_URL, publishableKey: process.env.CAPPZ_MIRROR_KEY, table: 'chainlet_blocks' }, publicLog: { partition: PUBLIC_LOG_PARTITION }, agentsPage: `${MARKET_URL()}/marketplace?tab=agents`, skills: 'https://github.com/CAPPZ-ai/cappz-sdk/tree/main/skills' };
    return discovery;
  }
  const url = `${MARKET_URL()}/.well-known/cappz-market.json`;
  const res = await fetch(url).catch((e: Error) => { throw new ToolError(`Could not reach ${url}: ${e.message}`, 'Check your internet connection, or practise offline with --demo.'); });
  if (!res.ok) throw new ToolError(`${url} answered ${res.status}.`, 'Practise offline with --demo, or set CAPPZ_MIRROR_URL and CAPPZ_MIRROR_KEY.');
  discovery = (await res.json()) as Discovery;
  if (discovery.publicLog.partition !== PUBLIC_LOG_PARTITION) throw new ToolError(`The marketplace publishes partition ${discovery.publicLog.partition}; this tool expects ${PUBLIC_LOG_PARTITION}.`, 'Update cappz-market.');
  return discovery;
}

interface Session { accessToken: string; refreshToken: string; expiresAt: number; userId: string; email: string }

async function auth(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const d = await getDiscovery();
  const res = await fetch(`${d.mirror.url}/auth/v1/${path}`, { method: 'POST', headers: { apikey: d.mirror.publishableKey, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ToolError(`Sign-in failed: ${String(json.error_description ?? json.msg ?? json.message ?? res.status)}`);
  return json;
}

const toSession = (j: Record<string, unknown>): Session => {
  const user = j.user as { id: string; email: string };
  return { accessToken: String(j.access_token), refreshToken: String(j.refresh_token), expiresAt: Date.now() + Number(j.expires_in ?? 3600) * 1000, userId: user.id, email: user.email };
};

/** Sign in (or create the account with signup) with email + password; the session is kept in CAPPZ_HOME. */
export async function signIn(email: string, password: string, signup = false): Promise<{ email: string; confirmed: boolean }> {
  if (signup) {
    const j = await auth('signup', { email, password });
    if (!j.access_token) return { email, confirmed: false };
    await writeJson('session.json', toSession(j), true);
    return { email, confirmed: true };
  }
  await writeJson('session.json', toSession(await auth('token?grant_type=password', { email, password })), true);
  return { email, confirmed: true };
}

/** The current session, refreshed when close to expiry; signs in from CAPPZ_EMAIL / CAPPZ_PASSWORD when there is none. */
export async function session(required = true): Promise<Session | null> {
  let s = await readJson<Session>('session.json');
  if (!s && process.env.CAPPZ_EMAIL && process.env.CAPPZ_PASSWORD) { await signIn(process.env.CAPPZ_EMAIL, process.env.CAPPZ_PASSWORD); s = await readJson<Session>('session.json'); }
  if (s && s.expiresAt - Date.now() < 60_000) {
    try { s = toSession(await auth('token?grant_type=refresh_token', { refresh_token: s.refreshToken })); await writeJson('session.json', s, true); }
    catch { s = null; }
  }
  if (!s && required) throw new ToolError('Not signed in to the CAPPZ marketplace.', 'Run: cappz-market login --email you@example.com --password … (add --signup the first time), or set CAPPZ_EMAIL and CAPPZ_PASSWORD.');
  return s;
}

function mirrorPort(token: string | null): PublicLogPort {
  return {
    async insert(rows) {
      const d = await getDiscovery();
      const res = await fetch(`${d.mirror.url}/rest/v1/${d.mirror.table}`, { method: 'POST', headers: { apikey: d.mirror.publishableKey, authorization: `Bearer ${token ?? d.mirror.publishableKey}`, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify(rows) });
      return { error: res.ok ? null : { message: `${res.status} ${await res.text()}` } };
    },
    async select(since, limit) {
      const d = await getDiscovery();
      const q = new URLSearchParams({ select: 'metadata,created_at', query_hash: `eq.${d.publicLog.partition}`, chainlet_id: 'is.null', order: 'created_at.asc', limit: String(limit) });
      if (since) q.append('created_at', `gte.${since}`);
      const res = await fetch(`${d.mirror.url}/rest/v1/${d.mirror.table}?${q}`, { headers: { apikey: d.mirror.publishableKey, authorization: `Bearer ${token ?? d.mirror.publishableKey}` } });
      if (!res.ok) return { data: null, error: { message: `${res.status} ${await res.text()}` } };
      return { data: (await res.json()) as Array<{ metadata: unknown; created_at: string }>, error: null };
    },
  };
}

// ─── The market (live or demo) ────────────────────────────────────

export interface Market {
  mode: 'live' | 'demo';
  state: MarketState;
  txs: MarketTxLike[];
  policy: SettlementPolicy;
  /** This tool's party on the market (live: derived from your account; demo: --as, default "you"). */
  partyId: string | null;
  actor(coSignedBy?: string): Actor;
  /** Publish a command's TXs (live: shared log as your account; demo: local practice market). */
  commit(txs: MarketTx[], opts?: { operator?: boolean }): Promise<void>;
  now(): string;
  /** Shared-log entries set aside (written for a party by another account). */
  aside: number;
}

interface DemoFile { now: string; txs: MarketTxLike[]; boxKeys: Record<string, JsonWebKey> }

async function demoRunner(): Promise<DemoRunner> {
  const saved = await readJson<DemoFile>('demo.json');
  if (saved) {
    const r = new DemoRunner(saved.now);
    r.txs = saved.txs; r.state = resolveMarket(saved.txs);
    for (const [k, v] of Object.entries(saved.boxKeys ?? {})) r.boxKeys.set(k, v);
    return r;
  }
  const r = await seedDemoMarket(new Date().toISOString());
  await saveDemo(r);
  return r;
}
async function saveDemo(r: DemoRunner): Promise<void> { await writeJson('demo.json', { now: r.now(), txs: r.txs, boxKeys: Object.fromEntries(r.boxKeys) } satisfies DemoFile); }

/** Start the practice market over. */
export async function resetDemo(): Promise<void> { await saveDemo(await seedDemoMarket(new Date().toISOString())); }

/** Party id for an account: stable and pseudonymous (the account id never reaches the public log). */
export const partyIdForAccount = async (userId: string) => `p-${(await sha256Hex(`marketplace-agent-party|${userId}`)).slice(0, 16)}`;

export async function loadMarket(o: GlobalOptions, needSession = false): Promise<Market> {
  if (o.demo) {
    const r = await demoRunner();
    const partyId = o.as ?? DEMO_YOU;
    return {
      mode: 'demo', get state() { return r.state; }, get txs() { return r.txs; }, policy: resolveSettlementPolicy(r.txs), partyId,
      actor: (co) => r.as(partyId, 5, co),
      async commit(txs) { r.apply(txs); await saveDemo(r); },
      now: () => r.now(), aside: 0,
    } as Market;
  }
  const s = await session(needSession);
  const port = mirrorPort(s?.accessToken ?? null);
  const entries = await pullPublicLog(port, null);
  const attribution = attributePublicLog(entries);
  const txs = attribution.accepted;
  const state = resolveMarket(txs);
  const partyId = s ? await partyIdForAccount(s.userId) : null;
  return {
    mode: 'live', state, txs, policy: resolveSettlementPolicy(txs), partyId, aside: attribution.rejected.length,
    actor(co) {
      if (!partyId) throw new ToolError('Sign in to act on the live market.', 'Run: cappz-market login');
      return { partyId, at: new Date().toISOString(), ...(co ? { coSignedBy: co } : {}) };
    },
    async commit(batch, opts = {}) {
      const live = await session(true);
      const operator = opts.operator ?? batch.every((t) => t.sourceAddress.startsWith(`${MARKETPLACE_POW_ROOT}/operators/`));
      await publishToPublicLog(mirrorPort(live!.accessToken), batch, await authorHashOf(live!.userId), operator ? null : partyId);
      // Each party's own copy: kept on this computer, so the tool can show what it published even before the mirror answers.
      const own = (await readJson<MarketTxLike[]>('own-txs.json')) ?? [];
      await writeJson('own-txs.json', [...own, ...batch.map(({ txId, eventType, sourceAddress, targetAddress, payload, timestamp }) => ({ txId, eventType, sourceAddress, targetAddress, payload, timestamp }))]);
    },
    now: () => new Date().toISOString(),
  } as Market;
}

// ─── The XRPL wallet ──────────────────────────────────────────────

interface WalletFile { seed: string; address: string; network: XrplNetwork }

/** The wallet this tool signs with: XRPL_SEED, or the one kept in CAPPZ_HOME. Null when there is none yet. */
export async function wallet(): Promise<{ wallet: Wallet; network: XrplNetwork | null; source: 'env' | 'file' } | null> {
  if (process.env.XRPL_SEED) return { wallet: Wallet.fromSeed(process.env.XRPL_SEED), network: (process.env.XRPL_NETWORK as XrplNetwork) ?? null, source: 'env' };
  const f = await readJson<WalletFile>('wallet.json');
  return f ? { wallet: Wallet.fromSeed(f.seed), network: f.network, source: 'file' } : null;
}

export async function requireWallet(): Promise<Wallet> {
  const w = await wallet();
  if (!w) throw new ToolError('No XRPL wallet yet.', 'Run: cappz-market wallet --new (testnet: funded for free), or set XRPL_SEED to your own wallet seed.');
  return w.wallet;
}

/** Create a wallet; on testnet/devnet it is funded from the public faucet. Never overwrites an existing wallet. */
export async function newWallet(network: XrplNetwork): Promise<{ address: string; funded: boolean }> {
  if (await readJson<WalletFile>('wallet.json')) throw new ToolError('A wallet already exists in CAPPZ_HOME; this tool never overwrites one.', 'Use it (cappz-market wallet), or point CAPPZ_HOME at a new folder.');
  const w = Wallet.generate();
  await writeJson('wallet.json', { seed: w.seed!, address: w.classicAddress, network } satisfies WalletFile, true);
  if (network === 'mainnet') return { address: w.classicAddress, funded: false };
  const c = new Client(XRPL_ENDPOINTS[network]);
  await c.connect();
  try { await c.fundWallet(w); return { address: w.classicAddress, funded: true }; }
  catch { return { address: w.classicAddress, funded: false }; }
  finally { await c.disconnect().catch(() => {}); }
}

export interface WalletStatus {
  address: string; network: XrplNetwork; activated: boolean;
  balanceXrp: number; reserveBaseXrp: number; reserveOwnerXrp: number; ownedObjects: number;
  /** Balance minus the reserve currently locked: what can be sent or escrowed now. */
  spendableXrp: number;
}

/** Balance and reserves read from the ledger right now (reserves are network settings and change by validator vote). */
export async function walletStatus(address: string, network: XrplNetwork): Promise<WalletStatus> {
  const c = new Client(XRPL_ENDPOINTS[network]);
  await c.connect();
  try {
    const info = (await c.request({ command: 'server_info' })).result.info;
    const base = Number(info.validated_ledger?.reserve_base_xrp ?? 1); const inc = Number(info.validated_ledger?.reserve_inc_xrp ?? 0.2);
    try {
      const a = (await c.request({ command: 'account_info', account: address, ledger_index: 'validated' })).result.account_data;
      const bal = Number(a.Balance) / 1_000_000; const owned = Number(a.OwnerCount ?? 0);
      return { address, network, activated: true, balanceXrp: bal, reserveBaseXrp: base, reserveOwnerXrp: inc, ownedObjects: owned, spendableXrp: Math.max(0, Math.round((bal - base - owned * inc) * 1e6) / 1e6) };
    } catch {
      return { address, network, activated: false, balanceXrp: 0, reserveBaseXrp: base, reserveOwnerXrp: inc, ownedObjects: 0, spendableXrp: 0 };
    }
  } finally { await c.disconnect().catch(() => {}); }
}

// ─── Keys kept on this computer ───────────────────────────────────

/** This party's box key (P-256): the public half goes on the profile, the private half stays here. */
export async function boxKey(): Promise<{ publicKey: JsonWebKey; privateKey: JsonWebKey }> {
  const k = await readJson<{ publicKey: JsonWebKey; privateKey: JsonWebKey }>('box-key.json');
  if (k) return k;
  const pair = await generateBoxKeyPair();
  await writeJson('box-key.json', pair, true);
  return pair;
}

/** Escrow secrets by contract and stage, kept here as well as sealed on the funding TX (either one can release). */
export async function rememberSecret(contractId: string, milestone: number, secret: string): Promise<void> {
  const all = (await readJson<Record<string, string>>('escrow-secrets.json')) ?? {};
  all[`${contractId}:${milestone}`] = secret;
  await writeJson('escrow-secrets.json', all, true);
}
export async function recallSecret(contractId: string, milestone: number): Promise<string | null> {
  return ((await readJson<Record<string, string>>('escrow-secrets.json')) ?? {})[`${contractId}:${milestone}`] ?? null;
}

export const homeDir = HOME;
export const marketUrl = MARKET_URL;
