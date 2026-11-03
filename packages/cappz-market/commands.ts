/**
 * COPE node crystallized. Node ID: v15-25-00-cappz-market-commands.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * The cappz-market commands — one table, served as a CLI and as MCP tools.
 * Every write runs the marketplace's own builders (the same rules as the web
 * app, including mandates for agent parties) and is published to the shared
 * log as the signed-in account. Money moves only from the wallet on this
 * computer, on the network the marketplace declares, after a balance check;
 * on mainnet a command that moves money also needs `yes`.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { XrplNetwork } from '../../src/lib/xrpl/ledgerCheck';
import { fetchLedgerTx } from '../../src/lib/xrpl/ledgerCheck';
import { openWith, sealTo, type SealedBox } from '../../src/lib/crypto/sealedBox';
import * as M from '../../src/lib/marketplace/model';
import { CATEGORIES, REGIONS, categoryOf, rootCategoryOf } from '../../src/lib/marketplace/catalog';
import { milestoneAmounts, defaultMilestones } from '../../src/lib/marketplace/rules';
import { searchMarket } from '../../src/lib/marketplace/search';
import { matchDemand } from '../../src/lib/marketplace/matching';
import { newEscrowSecret, prepareEscrowFinish, prepareStageEscrows } from '../../src/lib/marketplace/settlement';
import { seedSigner, signAndSubmit, signAndSubmitAll } from '../../src/lib/marketplace/ledgerSigning';
import { xrpNeededForStage } from '../../src/lib/marketplace/onRamp';
import { AGENT_OPERATIONS, executeAgentOperation, type AgentOperation } from '../../src/lib/marketplace/agentApi';
import type { MarketplaceVerb } from '../../src/lib/marketplace/marketplaceVerbs';
import type { ContractView, Currency, ListingContent, PartyKind, PartyProfile, PartyRole, SupplyOfferContent, SupplyRequestContent } from '../../src/lib/marketplace/types';
import type { ListingView, MarketState, RequestView } from '../../src/lib/marketplace/replay';
import { ToolError, boxKey, getDiscovery, homeDir, loadMarket, marketUrl, newWallet, recallSecret, rememberSecret, requireWallet, resetDemo, session, signIn, wallet, walletStatus, type GlobalOptions, type Market } from './context';

export type ParamType = 'string' | 'number' | 'boolean' | 'json';
export interface Param { name: string; type: ParamType; description: string; required?: boolean; positional?: boolean }
export interface Command {
  name: string;
  summary: string;
  params: Param[];
  /** Moves money: on mainnet it needs `yes`. */
  money?: boolean;
  run(args: Record<string, unknown>, o: GlobalOptions): Promise<Record<string, unknown>>;
}

// ─── Small helpers ────────────────────────────────────────────────

const str = (a: Record<string, unknown>, k: string, fallback?: string): string => {
  const v = a[k];
  if (v === undefined || v === null || v === '') { if (fallback !== undefined) return fallback; throw new ToolError(`Missing ${k}.`); }
  return String(v);
};
const num = (a: Record<string, unknown>, k: string, fallback?: number): number => {
  const v = a[k];
  if (v === undefined || v === null || v === '') { if (fallback !== undefined) return fallback; throw new ToolError(`Missing ${k}.`); }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ToolError(`${k} must be a number, got “${String(v)}”.`);
  return n;
};
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
const money = (amount: number, currency: Currency) => ({ amount, currency });
const currencyOf = (a: Record<string, unknown>): Currency => { const c = str(a, 'currency', 'XRP').toUpperCase(); if (c !== 'XRP' && c !== 'USD') throw new ToolError('currency is XRP or USD.'); return c; };
const date = (s: string) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ToolError(`Dates are YYYY-MM-DD, got “${s}”.`); return s; };
const inDays = (from: string, d: number) => new Date(Date.parse(from) + d * 86_400_000).toISOString().slice(0, 10);
const price = (m: { amount: number; currency: string }, unit: string) => `${m.amount} ${m.currency}/${unit}`;
/** SHA-256 of raw bytes, hex — what deliverables and paid-agent results are checked against. */
const sha256Bytes = async (b: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource)), (x) => x.toString(16).padStart(2, '0')).join('');

function checkCategory(id: string): string {
  if (!categoryOf(id)) throw new ToolError(`Unknown category “${id}”.`, `Use one of: ${CATEGORIES.map((c) => c.id).join(', ')}.`);
  return id;
}
function checkRegion(r: string): string {
  const up = r.toUpperCase();
  if (!REGIONS[up]) throw new ToolError(`Unknown region “${r}”. Regions are two-letter US state codes (no street addresses go on the public log).`);
  return up;
}

const listingCard = (s: MarketState, l: ListingView) => ({ id: l.listingId, title: l.title, kind: l.kind, category: l.categoryId, price: price(l.pricePerUnit, l.unit), available: l.remaining, unit: l.unit, region: l.region, readyInDays: l.leadDays, seller: l.sellerId, sellerName: s.parties.get(l.sellerId)?.name ?? null, ...(l.attributes?.endpoint ? { endpoint: l.attributes.endpoint, hire: `cappz-market hire ${l.attributes.endpoint} --input "…" --max ${l.pricePerUnit.amount}` } : {}) });
const requestCard = (s: MarketState, r: RequestView) => ({ id: r.requestId, title: r.title, category: r.categoryId, quantity: r.quantity, unit: r.unit, maxPrice: r.maxPricePerUnit ? price(r.maxPricePerUnit, r.unit) : 'open', neededBy: r.neededBy, region: r.region, open: r.open, bids: r.offers.filter((o) => !o.withdrawn).length, buyer: r.buyerId, buyerName: s.parties.get(r.buyerId)?.name ?? null });

function dealCard(c: ContractView, me: string | null) {
  const amounts = milestoneAmounts(c.total.amount, c.milestones);
  const role = c.buyerId === me ? 'buyer' : c.sellerId === me ? 'seller' : 'observer';
  return {
    id: c.contractId, title: c.title, role, total: `${c.total.amount} ${c.total.currency}`, state: c.state,
    waitingOnYou: (c.nextAction.by === 'buyer' && role === 'buyer') || (c.nextAction.by === 'seller' && role === 'seller'),
    nextAction: c.nextAction,
    settlement: c.total.currency === 'XRP' ? 'XRP escrow on the ledger' : 'USD',
    escrow: c.escrow,
    stages: c.milestones.map((m, i) => ({ index: i, label: m.label, amount: amounts[i], dueBy: m.dueBy, evidence: m.evidence, state: c.milestoneStates[i]?.state, onLedger: c.ledgerEscrows.some((e) => e.milestone === i) })),
    openDisputes: c.disputes.filter((d) => !d.resolved).length,
  };
}

function contractOf(mk: Market, id: string): ContractView {
  const c = mk.state.contracts.find((x) => x.contractId === id);
  if (!c) throw new ToolError(`No contract ${id}.`, 'List yours with: cappz-market deals');
  return c;
}

/** The network the wallet must sign on: the marketplace's declared settlement network. */
async function signingWallet(mk: Market) {
  const w = await requireWallet();
  const net = mk.policy.network as XrplNetwork;
  const st = await walletStatus(w.classicAddress, net);
  if (!st.activated) throw new ToolError(`Your wallet ${w.classicAddress} is not activated on XRPL ${net}.`, net === 'mainnet' ? `Send it at least ${st.reserveBaseXrp} XRP (the account reserve) plus what you want to spend.` : 'Run: cappz-market wallet --fund (free test XRP).');
  return { w, net, st };
}

function guardMainnet(cmd: Command, mk: Market, o: GlobalOptions) {
  if (cmd.money && mk.mode === 'live' && mk.policy.network === 'mainnet' && !o.yes) throw new ToolError(`${cmd.name} moves real XRP on mainnet.`, 'Confirm with the person you act for, then repeat with --yes.');
}

async function commitAndReport(mk: Market, txs: Parameters<Market['commit']>[0], extra: Record<string, unknown> = {}) {
  await mk.commit(txs);
  return { ok: true, market: mk.mode, recorded: txs.map((t) => t.eventType), ...extra };
}

// ─── Commands ─────────────────────────────────────────────────────

export const COMMANDS: Command[] = [
  {
    name: 'setup',
    summary: 'Check everything needed to trade and say what to do next: wallet, reserve, sign-in, profile, mandate. Safe to run any time.',
    params: [],
    async run(_a, o) {
      const steps: Array<{ step: string; ok: boolean; detail: string; next?: string }> = [];
      const mk = await loadMarket(o).catch((e) => { throw e; });
      const net = mk.policy.network as XrplNetwork;
      steps.push({ step: 'market', ok: true, detail: `${mk.mode === 'demo' ? 'practice market (local, nothing is published)' : `live market at ${marketUrl()}`}; settlement on XRPL ${net}` });
      const w = await wallet();
      if (!w) steps.push({ step: 'wallet', ok: false, detail: 'no XRPL wallet', next: net === 'mainnet' ? 'cappz-market wallet --new, then fund it from an exchange (or set XRPL_SEED)' : 'cappz-market wallet --new (funded with free test XRP)' });
      else if (mk.mode === 'demo') steps.push({ step: 'wallet', ok: true, detail: `${w.wallet.classicAddress} (not used by the practice market)` });
      else {
        const st = await walletStatus(w.wallet.classicAddress, net);
        steps.push({ step: 'wallet', ok: st.activated && st.spendableXrp > 0, detail: st.activated ? `${st.address}: ${st.balanceXrp} XRP, ${st.spendableXrp} spendable (reserve ${st.reserveBaseXrp} + ${st.ownedObjects} × ${st.reserveOwnerXrp} XRP)` : `${st.address} is not activated on ${net}`, next: st.activated ? undefined : net === 'mainnet' ? `send it at least ${st.reserveBaseXrp} XRP` : 'cappz-market wallet --fund' });
      }
      if (mk.mode === 'live') {
        const s = await session(false);
        steps.push({ step: 'sign-in', ok: !!s, detail: s ? `signed in as ${s.email}` : 'not signed in (reading works; trading needs an account)', next: s ? undefined : 'cappz-market login --email … --password … (--signup the first time)' });
      }
      const me = mk.partyId ? mk.state.parties.get(mk.partyId) : null;
      steps.push({ step: 'profile', ok: !!me, detail: me ? `${me.name} (${me.kind}, party ${me.partyId})` : `no profile for party ${mk.partyId ?? '(sign in first)'}`, next: me ? undefined : 'cappz-market profile --name "…" --kind agent --principal <your web party id>' });
      if (me?.kind === 'agent') {
        const ms = mk.state.mandates.filter((m) => m.agentPartyId === me.partyId && Date.parse(m.limits.expiresAt) > Date.parse(mk.now()));
        const d = await getDiscovery().catch(() => null);
        steps.push({ step: 'mandate', ok: ms.length > 0, detail: ms.length ? ms.map((m) => `${m.limits.verbs.map((v) => v.replace('marketplace.', '')).join(', ')} ≤ ${m.limits.maxPerContract.amount} ${m.limits.maxPerContract.currency}/contract until ${m.limits.expiresAt.slice(0, 10)}`).join('; ') : 'no active mandate — an agent party cannot list, bid, buy or pay', next: ms.length ? undefined : `ask the person you act for to grant one at ${d?.agentsPage ?? `${marketUrl()}/marketplace?tab=agents`} (agent party id ${me.partyId})` });
      }
      const next = steps.find((x) => !x.ok)?.next ?? 'Ready. Try: cappz-market find "what you need"';
      return { ready: steps.every((x) => x.ok), steps, next };
    },
  },
  {
    name: 'wallet',
    summary: 'Show your XRPL wallet: address, balance, reserve and what is spendable. --new creates one (testnet: funded free); --fund tops up a testnet wallet from the faucet.',
    params: [
      { name: 'new', type: 'boolean', description: 'Create a wallet (kept in CAPPZ_HOME, file mode 0600). Never overwrites.' },
      { name: 'fund', type: 'boolean', description: 'Testnet/devnet only: ask the public faucet for test XRP.' },
      { name: 'network', type: 'string', description: 'testnet (default for --new), devnet or mainnet.' },
    ],
    async run(a, o) {
      const mk = o.demo ? null : await loadMarket(o).catch(() => null);
      const net = (a.network as XrplNetwork) ?? (mk?.policy.network as XrplNetwork) ?? 'testnet';
      if (a.new) { const r = await newWallet(net); return { created: r.address, network: net, funded: r.funded, keptIn: homeDir(), next: r.funded || net !== 'mainnet' ? 'cappz-market setup' : `Send at least the reserve (see cappz-market wallet) to ${r.address} from an exchange or another wallet.` }; }
      const w = await requireWallet();
      if (a.fund) {
        if (net === 'mainnet') throw new ToolError('There is no faucet on mainnet.', 'Buy XRP on an exchange and send it to your address.');
        const { Client } = await import('xrpl'); const { XRPL_ENDPOINTS } = await import('../../src/lib/xrpl/ledgerCheck');
        const c = new Client(XRPL_ENDPOINTS[net]); await c.connect();
        try { await c.fundWallet(w); } finally { await c.disconnect().catch(() => {}); }
      }
      const st = await walletStatus(w.classicAddress, net);
      return { ...st, note: 'Reserves are network settings read from the ledger now. Each open escrow, offer or trust line adds one owner reserve until it closes; it is returned then.' };
    },
  },
  {
    name: 'login',
    summary: 'Sign in to the CAPPZ marketplace (needed to publish). --signup creates the account. Reading the market needs no sign-in.',
    params: [
      { name: 'email', type: 'string', description: 'Account email (or CAPPZ_EMAIL).' },
      { name: 'password', type: 'string', description: 'Account password (or CAPPZ_PASSWORD).' },
      { name: 'signup', type: 'boolean', description: 'Create the account first.' },
    ],
    async run(a) {
      const email = str(a, 'email', process.env.CAPPZ_EMAIL ?? ''); const password = str(a, 'password', process.env.CAPPZ_PASSWORD ?? '');
      if (!email || !password) throw new ToolError('Give --email and --password (or set CAPPZ_EMAIL and CAPPZ_PASSWORD).');
      const r = await signIn(email, password, !!a.signup);
      return r.confirmed ? { signedIn: r.email, next: 'cappz-market setup' } : { created: r.email, signedIn: false, next: 'Confirm the email CAPPZ sent, then run cappz-market login again (without --signup).' };
    },
  },
  {
    name: 'profile',
    summary: 'Create or update your marketplace profile. Agents use --kind agent with --principal (the party id of the person or company they act for).',
    params: [
      { name: 'name', type: 'string', description: 'Public name.', required: true },
      { name: 'kind', type: 'string', description: 'agent (default), person or organization.' },
      { name: 'principal', type: 'string', description: 'Agents: the party id you act for (shown on their web profile).' },
      { name: 'governance', type: 'string', description: 'Non-human companies: governance address instead of a principal.' },
      { name: 'region', type: 'string', description: 'Two-letter US state code (default TX). No street addresses.' },
      { name: 'about', type: 'string', description: 'What you offer or need.' },
      { name: 'categories', type: 'string', description: 'Comma-separated category ids you supply.' },
      { name: 'roles', type: 'string', description: 'Comma-separated: buyer, seller, service-provider, supplier… (default buyer,seller).' },
      { name: 'runtime', type: 'string', description: 'Agents: model/runtime you run on, shown for transparency.' },
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true);
      const partyId = mk.partyId!;
      const kind = (str(a, 'kind', 'agent') as PartyKind);
      if (!['agent', 'person', 'organization'].includes(kind)) throw new ToolError('kind is agent, person or organization.');
      const prior = mk.state.parties.get(partyId);
      const w = await wallet();
      const box = await boxKey();
      const principal = a.principal ? { partyId: String(a.principal) } : a.governance ? { governanceAddress: String(a.governance) } : prior?.principal;
      const profile: PartyProfile = {
        partyId, kind, name: str(a, 'name'), roles: (list(a.roles).length ? list(a.roles) : prior?.roles ?? ['buyer', 'seller']) as PartyRole[],
        region: checkRegion(str(a, 'region', prior?.region ?? 'TX')), about: str(a, 'about', prior?.about ?? ''),
        capabilities: { categories: list(a.categories).map(checkCategory).length ? list(a.categories) : prior?.capabilities.categories ?? [], canPlantNew: prior?.capabilities.canPlantNew ?? false },
        ...(principal ? { principal } : {}), ...(w ? { xrplAccount: w.wallet.classicAddress } : prior?.xrplAccount ? { xrplAccount: prior.xrplAccount } : {}),
        encryptionKey: box.publicKey, ...(a.runtime ? { runtime: String(a.runtime) } : prior?.runtime ? { runtime: prior.runtime } : {}),
      };
      const txs = await M.buildProfile(mk.state, mk.actor(), profile);
      return commitAndReport(mk, txs, { partyId, xrplAccount: profile.xrplAccount ?? null, next: kind === 'agent' ? `Ask your principal to grant a mandate to ${partyId} at ${marketUrl()}/marketplace?tab=agents, then run cappz-market setup.` : 'cappz-market find "…"' });
    },
  },
  {
    name: 'find',
    summary: 'Search what is for sale (default) or wanted (--wanted). Ranked, typo-tolerant; filter by category and region.',
    params: [
      { name: 'text', type: 'string', description: 'What to look for, in plain words.', positional: true },
      { name: 'wanted', type: 'boolean', description: 'Search open requests (what buyers want) instead of listings.' },
      { name: 'category', type: 'string', description: 'Category id (e.g. agents, services, digital, goods, crops).' },
      { name: 'region', type: 'string', description: 'Two-letter state code.' },
      { name: 'limit', type: 'number', description: 'Max results (default 20).' },
    ],
    async run(a, o) {
      const mk = await loadMarket(o);
      const s = mk.state; const lim = num(a, 'limit', 20);
      const text = a.text ? String(a.text) : '';
      const root = a.category ? checkCategory(String(a.category)) : null;
      const region = a.region ? checkRegion(String(a.region)) : null;
      const inCat = (id: string) => !root || id === root || id.startsWith(`${root}/`) || rootCategoryOf(id) === root;
      if (a.wanted) {
        const order = text ? searchMarket(s, text, { kinds: ['request'] }).map((h) => h.id) : null;
        const rs = s.requests.filter((r) => r.open && inCat(r.categoryId) && (!region || r.region === region) && (!order || order.includes(r.requestId))).sort((x, y) => (order ? order.indexOf(x.requestId) - order.indexOf(y.requestId) : 0));
        const mine = mk.partyId && s.parties.get(mk.partyId) ? matchDemand(s, s.parties.get(mk.partyId)!, s.listings, mk.now()).slice(0, 5).map((m) => ({ id: m.id, title: m.title, why: m.reasons })) : [];
        return { wanted: rs.slice(0, lim).map((r) => requestCard(s, r)), total: rs.length, youCouldFill: mine, next: rs.length ? 'cappz-market bid <request id> --price … --quantity … --by YYYY-MM-DD' : 'Nothing open matches. Offer it anyway: cappz-market sell …' };
      }
      const order = text ? searchMarket(s, text, { kinds: ['listing'] }).map((h) => h.id) : null;
      const ls = s.listings.filter((l) => l.open && l.remaining > 0 && inCat(l.categoryId) && (!region || l.region === region) && (!order || order.includes(l.listingId))).sort((x, y) => (order ? order.indexOf(x.listingId) - order.indexOf(y.listingId) : 0));
      return { forSale: ls.slice(0, lim).map((l) => listingCard(s, l)), total: ls.length, next: ls.length ? 'cappz-market buy <listing id> --quantity …' : 'Nothing listed matches. Ask for it: cappz-market ask --title "…" --category … --quantity … --unit … --by YYYY-MM-DD' };
    },
  },
  {
    name: 'show',
    summary: 'Show one listing, request (with its bids), contract, party or token by id.',
    params: [{ name: 'id', type: 'string', description: 'Any id from find or deals.', required: true, positional: true }],
    async run(a, o) {
      const mk = await loadMarket(o); const s = mk.state; const id = str(a, 'id');
      const l = s.listings.find((x) => x.listingId === id); if (l) return { listing: { ...listingCard(s, l), description: l.description, delivery: l.delivery, paymentSchedule: l.milestones ?? 'category default', attributes: l.attributes, knowledge: l.knowledge ?? null, open: l.open } };
      const r = s.requests.find((x) => x.requestId === id); if (r) return { request: { ...requestCard(s, r), description: r.description, contractType: r.contractType, recurring: r.recurring ?? null, bids: r.offers.filter((x) => !x.withdrawn).map((x) => ({ id: x.offerId, seller: x.sellerId, sellerName: s.parties.get(x.sellerId)?.name ?? null, price: price(x.pricePerUnit, r.unit), quantity: x.quantity, delivers: x.deliveryDate, stages: x.milestones.length, awarded: x.awardedQuantity })) } };
      const c = s.contracts.find((x) => x.contractId === id); if (c) return { deal: dealCard(c, mk.partyId) };
      const p = s.parties.get(id); if (p) return { party: { ...p, encryptionKey: p.encryptionKey ? 'present' : null, reputation: s.reputation.get(id) ?? null } };
      const t = s.tokens.find((x) => x.content.tokenId === id); if (t) return { token: { ...t.content, balances: t.balances, redeemed: t.redeemed } };
      throw new ToolError(`Nothing with id ${id}.`, 'Ids come from find, deals or show.');
    },
  },
  {
    name: 'deals',
    summary: 'Your contracts, the ones waiting on you first, each with its stages, escrow and next action.',
    params: [],
    async run(_a, o) {
      const mk = await loadMarket(o);
      if (!mk.partyId) throw new ToolError('Sign in to see your deals.', 'cappz-market login');
      const mine = mk.state.contracts.filter((c) => c.buyerId === mk.partyId || c.sellerId === mk.partyId).map((c) => dealCard(c, mk.partyId));
      mine.sort((x, y) => Number(y.waitingOnYou) - Number(x.waitingOnYou));
      return { deals: mine, waitingOnYou: mine.filter((d) => d.waitingOnYou).length, next: mine.find((d) => d.waitingOnYou)?.nextAction.action ?? (mine.length ? 'Nothing waits on you.' : 'No deals yet: buy, or win a bid.') };
    },
  },
  {
    name: 'sell',
    summary: 'List something for sale, rent or as a service (agent work included). Buyers pay into escrow; you are paid stage by stage.',
    params: [
      { name: 'title', type: 'string', description: 'What it is.', required: true },
      { name: 'category', type: 'string', description: 'Category id (agents, services, digital, goods, equipment, land, relay, crops, inputs…).', required: true },
      { name: 'price', type: 'number', description: 'Price per unit.', required: true },
      { name: 'unit', type: 'string', description: 'Unit (job, hour, each, lb…). Default: the category’s first unit.' },
      { name: 'quantity', type: 'number', description: 'How many units are available (default 1).' },
      { name: 'currency', type: 'string', description: 'XRP (default; escrowed on the ledger) or USD (paid in the web app).' },
      { name: 'kind', type: 'string', description: 'sale, rent, service or production-contract (default: the category’s first).' },
      { name: 'description', type: 'string', description: 'Details buyers need.' },
      { name: 'delivery', type: 'string', description: 'online, ship, pickup or on-site (default online for agents/digital, else ship).' },
      { name: 'leadDays', type: 'number', description: 'Days from order to delivery (default 7).' },
      { name: 'region', type: 'string', description: 'State code (default your profile’s).' },
      { name: 'endpoint', type: 'string', description: 'Paid agents: the https address buyers (and cappz-market hire) call.' },
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true); const me = mk.state.parties.get(mk.partyId!);
      if (!me) throw new ToolError('Create your profile first.', 'cappz-market profile --name "…"');
      const cat = categoryOf(checkCategory(str(a, 'category')))!;
      if (a.endpoint && !/^https:\/\//.test(String(a.endpoint))) throw new ToolError('endpoint must be an https address buyers can reach (e.g. your tunnel URL).');
      const kind = str(a, 'kind', cat.kinds[0]) as ListingContent['kind'];
      if (!cat.kinds.includes(kind)) throw new ToolError(`${cat.label} takes kind ${cat.kinds.join(' or ')}.`);
      const root = rootCategoryOf(cat.id);
      const listing: ListingContent = {
        listingId: M.newId('l'), sellerId: me.partyId, categoryId: cat.id, kind, title: str(a, 'title'), description: str(a, 'description', str(a, 'title')),
        unit: str(a, 'unit', cat.units[0]), pricePerUnit: money(num(a, 'price'), currencyOf(a)), quantity: num(a, 'quantity', 1),
        region: checkRegion(str(a, 'region', me.region)), delivery: str(a, 'delivery', root === 'agents' || root === 'digital' || root === 'relay' ? 'online' : 'ship') as ListingContent['delivery'],
        leadDays: num(a, 'leadDays', 7), attributes: a.endpoint ? { endpoint: String(a.endpoint) } : {},
      };
      const txs = await M.buildListing(mk.state, mk.actor(), listing);
      return commitAndReport(mk, txs, { listingId: listing.listingId, next: 'Buyers order with: cappz-market buy ' + listing.listingId + ' — watch with cappz-market deals' });
    },
  },
  {
    name: 'ask',
    summary: 'Ask for something (even if nobody offers it yet). Suppliers bid; you award the bid you want.',
    params: [
      { name: 'title', type: 'string', description: 'What you need.', required: true },
      { name: 'category', type: 'string', description: 'Category id.', required: true },
      { name: 'quantity', type: 'number', description: 'How many units.', required: true },
      { name: 'unit', type: 'string', description: 'Unit (default: the category’s first).' },
      { name: 'by', type: 'string', description: 'Needed by, YYYY-MM-DD (default 30 days from now).' },
      { name: 'maxPrice', type: 'number', description: 'Highest price per unit you accept (omit for open price).' },
      { name: 'currency', type: 'string', description: 'XRP (default) or USD.' },
      { name: 'description', type: 'string', description: 'Specs, quality, format.' },
      { name: 'region', type: 'string', description: 'State code (default your profile’s).' },
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true); const me = mk.state.parties.get(mk.partyId!);
      if (!me) throw new ToolError('Create your profile first.', 'cappz-market profile --name "…"');
      const cat = categoryOf(checkCategory(str(a, 'category')))!;
      const req: SupplyRequestContent = {
        requestId: M.newId('rq'), buyerId: me.partyId, categoryId: cat.id, title: str(a, 'title'), description: str(a, 'description', str(a, 'title')),
        quantity: num(a, 'quantity'), unit: str(a, 'unit', cat.units[0]), maxPricePerUnit: a.maxPrice !== undefined ? money(num(a, 'maxPrice'), currencyOf(a)) : null,
        neededBy: date(str(a, 'by', inDays(mk.now(), 30))), region: checkRegion(str(a, 'region', me.region)), deliveryRadiusMiles: null,
        allowNewPlanting: rootCategoryOf(cat.id) === 'crops', contractType: 'spot', attributes: {},
      };
      const txs = await M.buildRequest(mk.state, mk.actor(), req);
      return commitAndReport(mk, txs, { requestId: req.requestId, next: `Bids arrive on it: cappz-market show ${req.requestId}, then cappz-market award ${req.requestId} <bid id>` });
    },
  },
  {
    name: 'bid',
    summary: 'Bid to fill an open request at your price and date.',
    params: [
      { name: 'request', type: 'string', description: 'Request id.', required: true, positional: true },
      { name: 'price', type: 'number', description: 'Your price per unit (in the request’s currency, default XRP).', required: true },
      { name: 'quantity', type: 'number', description: 'Units you supply (default: all still needed).' },
      { name: 'by', type: 'string', description: 'Delivery date YYYY-MM-DD (default: the request’s date).' },
      { name: 'message', type: 'string', description: 'A note to the buyer.' },
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true);
      const r = mk.state.requests.find((x) => x.requestId === str(a, 'request')) ?? (() => { throw new ToolError('No such request.', 'cappz-market find --wanted'); })();
      const currency = r.maxPricePerUnit?.currency ?? currencyOf(a);
      const by = date(str(a, 'by', r.neededBy));
      const offer: SupplyOfferContent = { offerId: M.newId('of'), requestId: r.requestId, sellerId: mk.partyId!, pricePerUnit: money(num(a, 'price'), currency), quantity: num(a, 'quantity', r.quantity - r.awardedQuantity), deliveryDate: by, plan: { newPlanting: false, notes: '' }, milestones: defaultMilestones('spot', mk.now().slice(0, 10), by), message: str(a, 'message', '') };
      const out = await M.buildOffer(mk.state, mk.actor(), offer);
      return commitAndReport(mk, out.txs, { bidId: offer.offerId, warnings: out.warnings, next: 'If the buyer awards it, a contract appears in cappz-market deals.' });
    },
  },
  {
    name: 'award',
    summary: 'Award a bid on your request (all or part). This forms a contract with a staged payment schedule.',
    params: [
      { name: 'request', type: 'string', description: 'Your request id.', required: true, positional: true },
      { name: 'bid', type: 'string', description: 'The bid (offer) id.', required: true, positional: true },
      { name: 'quantity', type: 'number', description: 'Award part of the bid.' },
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true);
      const r = await M.buildAward(mk.state, mk.actor(), str(a, 'request'), str(a, 'bid'), a.quantity === undefined ? undefined : num(a, 'quantity'));
      return commitAndReport(mk, r.txs, { contractId: r.contractId, next: `cappz-market fund ${r.contractId}` });
    },
  },
  {
    name: 'buy',
    summary: 'Buy from a listing. This forms a contract; then fund its first stage.',
    params: [
      { name: 'listing', type: 'string', description: 'Listing id.', required: true, positional: true },
      { name: 'quantity', type: 'number', description: 'Units (default 1).' },
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true);
      const r = await M.buildOrder(mk.state, mk.actor(), str(a, 'listing'), num(a, 'quantity', 1));
      return commitAndReport(mk, r.txs, { contractId: r.contractId, next: `cappz-market fund ${r.contractId}` });
    },
  },
  {
    name: 'fund',
    summary: 'Buyer: pay the current stage into escrow. XRP: one ledger escrow per payee, locked by a secret only you hold, returned to you after 30 days if never released.',
    money: true,
    params: [
      { name: 'contract', type: 'string', description: 'Contract id.', required: true, positional: true },
      { name: 'reference', type: 'string', description: 'USD deals only: the payment reference (USD is otherwise paid in the web app).' },
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true); guardMainnet(this, mk, o);
      const c = contractOf(mk, str(a, 'contract'));
      if (c.buyerId !== mk.partyId) throw new ToolError('Only the buyer funds a contract.');
      const stage = M.currentStage(c) ?? (() => { throw new ToolError('Every stage is paid.'); })();
      if (mk.mode === 'demo') return commitAndReport(mk, await M.buildFund(mk.state, mk.actor(), c.contractId, stage.need, { rail: 'demo' }), { stage: c.milestones[stage.index].label, amount: stage.need, next: 'The seller delivers evidence next; then cappz-market release ' + c.contractId });
      if (c.total.currency === 'USD') {
        if (!a.reference) throw new ToolError('USD stages are paid by card or bank in the web app.', `Open ${marketUrl()}/marketplace?tab=deals, or record a payment you already made with --reference.`);
        return commitAndReport(mk, await M.buildFund(mk.state, mk.actor(), c.contractId, stage.need, { rail: 'usd-reference', reference: str(a, 'reference') }), { note: 'Recorded by reference: not verifiable on a ledger.' });
      }
      if (c.ledgerEscrows.some((e) => e.milestone === stage.index)) throw new ToolError(`“${c.milestones[stage.index].label}” is already escrowed.`, 'Wait for the seller’s evidence, then release.');
      const buyer = mk.state.parties.get(c.buyerId)?.xrplAccount; const seller = mk.state.parties.get(c.sellerId)?.xrplAccount;
      if (!seller) throw new ToolError('The seller has no XRPL account on their profile yet.', 'Ask them to add one; then fund.');
      const { w, net, st } = await signingWallet(mk);
      if (buyer !== w.classicAddress) throw new ToolError(`Your profile’s XRPL account is ${buyer ?? 'missing'}, but this wallet is ${w.classicAddress}.`, 'Run cappz-market profile --name "…" to put this wallet on your profile.');
      const secret = newEscrowSecret();
      const legs = await prepareStageEscrows(c, stage.index, buyer, seller, secret, mk.now());
      const need = xrpNeededForStage(stage.amount, legs.length);
      if (st.spendableXrp < need) throw new ToolError(`This stage needs about ${need} XRP spendable (${stage.amount} XRP + ${legs.length} × ${st.reserveOwnerXrp} XRP reserve while the escrows are open + network fees); you have ${st.spendableXrp}.`, net === 'mainnet' ? `Send XRP to ${w.classicAddress}.` : 'cappz-market wallet --fund');
      await rememberSecret(c.contractId, stage.index, secret);
      const box = await boxKey();
      const sealedSecret = (await sealTo(box.publicKey, { contractId: c.contractId, milestone: stage.index, secret })) as unknown as Record<string, unknown>;
      const signed: string[] = [];
      try {
        const lts = await signAndSubmitAll(seedSigner(w.seed!), legs.map((l) => l.tx), net, (_n, lt) => signed.push(lt.hash));
        const checks = legs.map((p, i) => ({ milestone: p.milestone, condition: p.condition, sealedSecret, lt: lts[i] }));
        const txs = await M.buildFundOnLedger(mk.state, mk.actor(), c.contractId, mk.policy, checks);
        return commitAndReport(mk, txs, { stage: c.milestones[stage.index].label, escrowed: `${stage.amount} XRP`, ledgerTxs: lts.map((x) => x.hash), returnsToYouAfter: '30 days if not released', next: 'The seller delivers evidence; then: cappz-market release ' + c.contractId });
      } catch (e) {
        throw new ToolError(`${(e as Error).message}${signed.length ? ` Escrows already on the ledger: ${signed.join(', ')}.` : ''}`, signed.length ? `Record them with: cappz-market call marketplace.escrow.fund --input '{"contractId":"${c.contractId}","escrows":[…]}' (secret kept in ${homeDir()}).` : undefined);
      }
    },
  },
  {
    name: 'deliver',
    summary: 'Seller: submit evidence for the current stage. The file stays with you; only its SHA-256 goes on the public log.',
    params: [
      { name: 'contract', type: 'string', description: 'Contract id.', required: true, positional: true },
      { name: 'file', type: 'string', description: 'The deliverable or proof (hashed locally).' },
      { name: 'hash', type: 'string', description: 'Or its SHA-256 hex, if you hashed it yourself.' },
      { name: 'kind', type: 'string', description: 'document (default), delivery-receipt, photo, inspection or sensor.' },
      { name: 'note', type: 'string', description: 'What the buyer should check.' },
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true);
      const c = contractOf(mk, str(a, 'contract'));
      const stage = M.currentStage(c) ?? (() => { throw new ToolError('Every stage is paid.'); })();
      const hash = a.file ? await sha256Bytes(new Uint8Array(await readFile(resolve(String(a.file))))) : str(a, 'hash');
      const txs = await M.buildEvidence(mk.state, mk.actor(), c.contractId, stage.index, { kind: str(a, 'kind', 'document') as never, hash, note: str(a, 'note', '') });
      return commitAndReport(mk, txs, { stage: c.milestones[stage.index].label, sha256: hash, next: 'Send the buyer the file through your own channel; they check its SHA-256 and release.' });
    },
  },
  {
    name: 'release',
    summary: 'Buyer: accept the current stage’s evidence and pay it out of escrow (XRP: reveals the stage secret on the ledger).',
    money: true,
    params: [{ name: 'contract', type: 'string', description: 'Contract id.', required: true, positional: true }],
    async run(a, o) {
      let mk = await loadMarket(o, true); guardMainnet(this, mk, o);
      let c = contractOf(mk, str(a, 'contract'));
      const stage = M.currentStage(c) ?? (() => { throw new ToolError('Every stage is paid.'); })();
      const done: string[] = [];
      if (c.milestoneStates[stage.index].state === 'evidenced') { const t = await M.buildAffirm(mk.state, mk.actor(), c.contractId, stage.index); await mk.commit(t); done.push(...t.map((x) => x.eventType)); mk = await loadMarket(o, true); c = contractOf(mk, c.contractId); }
      if (c.milestoneStates[stage.index].state !== 'affirmed') throw new ToolError(`“${c.milestones[stage.index].label}” has no evidence to accept yet (state ${c.milestoneStates[stage.index].state}).`, 'Wait for the seller: cappz-market deals');
      const e = c.ledgerEscrows.find((x) => x.milestone === stage.index);
      if (!e) return commitAndReport(mk, await M.buildRelease(mk.state, mk.actor(), c.contractId, stage.index), { accepted: done, stage: c.milestones[stage.index].label, next: stage.index + 1 < c.milestones.length ? `Fund the next stage: cappz-market fund ${c.contractId}` : `Done. Review the seller: cappz-market review ${c.contractId} --rating 5 --text "…"` });
      const box = await boxKey();
      const secret = (await recallSecret(c.contractId, stage.index)) ?? (e.sealedSecret ? (await openWith<{ secret: string }>(box.privateKey, e.sealedSecret as unknown as SealedBox).catch(() => null))?.secret : null);
      if (!secret) throw new ToolError('The escrow secret for this stage is not on this computer.', 'Release it where it was funded (the web app or the computer that ran fund).');
      const { w, net } = await signingWallet(mk);
      const finishes = [e.sequence, ...e.feeEscrows.map((f) => f.sequence)].map((q) => prepareEscrowFinish(w.classicAddress, w.classicAddress, q, e.condition, secret));
      const lts = await signAndSubmitAll(seedSigner(w.seed!), finishes, net);
      const txs = await M.buildSettleOnLedger(mk.state, mk.actor(), c.contractId, stage.index, lts[0], mk.policy, lts.slice(1));
      return commitAndReport(mk, txs, { accepted: done, stage: c.milestones[stage.index].label, ledgerTxs: lts.map((x) => x.hash), next: M.currentStage(contractOf(mk, c.contractId)) ? `Fund the next stage: cappz-market fund ${c.contractId}` : `Done. Review the seller: cappz-market review ${c.contractId} --rating 5 --text "…"` });
    },
  },
  {
    name: 'dispute',
    summary: 'Buyer or seller: raise a dispute on a contract; a marketplace operator decides release, refund or split.',
    params: [
      { name: 'contract', type: 'string', description: 'Contract id.', required: true, positional: true },
      { name: 'reason', type: 'string', description: 'What went wrong.', required: true },
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true); const c = contractOf(mk, str(a, 'contract'));
      const stage = M.currentStage(c);
      return commitAndReport(mk, await M.buildDispute(mk.state, mk.actor(), c.contractId, stage?.index ?? null, str(a, 'reason')), { next: 'An operator reviews it; watch cappz-market deals.' });
    },
  },
  {
    name: 'review',
    summary: 'Rate the other side of a finished contract (1–5). Reputation is computed from finished contracts, never typed in.',
    params: [
      { name: 'contract', type: 'string', description: 'Contract id.', required: true, positional: true },
      { name: 'rating', type: 'number', description: '1 to 5.', required: true },
      { name: 'text', type: 'string', description: 'A short review.' },
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true); const c = contractOf(mk, str(a, 'contract'));
      return commitAndReport(mk, await M.buildReview(mk.state, mk.actor(), c.contractId, num(a, 'rating'), str(a, 'text', '')));
    },
  },
  {
    name: 'hire',
    summary: 'Hire a CAPPZ paid agent at its URL: open a job, pay each stage from your wallet, collect each result and check its SHA-256.',
    money: true,
    params: [
      { name: 'url', type: 'string', description: 'The agent’s address (from its listing), e.g. https://agent.example.com.', required: true, positional: true },
      { name: 'input', type: 'string', description: 'The work you want done (text or JSON). Not needed with --job.' },
      { name: 'job', type: 'string', description: 'Resume this job (from an earlier hire) instead of opening a new one.' },
      { name: 'max', type: 'number', description: 'Most you will pay in total for this job (required; in the agent’s currency).', required: true },
      { name: 'out', type: 'string', description: 'Folder for results (default ./cappz-results).' },
      { name: 'timeout', type: 'number', description: 'Minutes to wait for the whole job (default 15).' },
    ],
    async run(a, o) {
      const base = str(a, 'url').replace(/\/$/, ''); const max = num(a, 'max'); const out = resolve(str(a, 'out', 'cappz-results'));
      const http = async (path: string, init?: RequestInit) => { const r = await fetch(base + path, init); return { status: r.status, headers: r.headers, body: r.headers.get('content-type')?.includes('json') ? await r.json() : new Uint8Array(await r.arrayBuffer()) }; };
      const card = (await http('/agent')).body as { name: string; price: string; currency: string; network: XrplNetwork; stages: unknown[] };
      if (card.currency !== 'XRP' && card.currency !== 'CAPPZ') throw new ToolError(`Unexpected currency ${card.currency}.`);
      if (Number(card.price) > max) throw new ToolError(`${card.name} costs ${card.price} ${card.currency} per job; your max is ${max}.`, 'Raise --max if the person you act for agrees.');
      if (card.network === 'mainnet' && !o.yes) throw new ToolError(`${card.name} is paid in real ${card.currency} on mainnet.`, 'Confirm with the person you act for, then repeat with --yes.');
      const w = await requireWallet();
      if (!a.job && (a.input === undefined || a.input === '')) throw new ToolError('Give --input (the work), or --job to resume one.');
      const jobId = a.job ? String(a.job) : ((await http('/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: (() => { try { return JSON.parse(String(a.input)); } catch { return String(a.input); } })() }) })).body as { job: { jobId: string } }).job.jobId; let spent = 0; const results: Array<{ stage: number; file: string; sha256: string; verified: boolean }> = []; const paid: string[] = [];
      await mkdir(out, { recursive: true });
      const deadline = Date.now() + num(a, 'timeout', 15) * 60_000;
      for (;;) {
        const v = (await http(`/jobs/${jobId}`)).body as { job: { state: string; stages: Array<{ index: number; state: string; result: { hash: string } | null }> }; pay: { stage: number; amount: string; network: XrplNetwork; preparedTx: Record<string, unknown> } | null };
        for (const s of v.job.stages) {
          if (s.state !== 'released' || !s.result || results.some((r) => r.stage === s.index)) continue;
          const r = await http(`/jobs/${jobId}/stages/${s.index}/result`);
          const bytes = r.body as Uint8Array; const got = await sha256Bytes(bytes);
          const file = join(out, `${jobId}-stage-${s.index}`); await writeFile(file, bytes);
          results.push({ stage: s.index, file, sha256: got, verified: got === s.result.hash });
        }
        if (v.job.state === 'completed') return { job: jobId, agent: card.name, paid: `${spent} ${card.currency}`, payments: paid, results, allVerified: results.every((r) => r.verified) };
        if (v.job.state === 'failed') throw new ToolError(`The agent’s work failed on job ${jobId}.`, `Ask it to retry: POST ${base}/jobs/${jobId}/retry`);
        if (v.pay) {
          const amount = Number(v.pay.amount);
          if (spent + amount > max + 1e-9) throw new ToolError(`Stage ${v.pay.stage} asks ${amount}; paying it would pass your max of ${max} (spent ${spent}).`);
          const st = await walletStatus(w.classicAddress, v.pay.network);
          if (card.currency === 'XRP' && st.spendableXrp < amount + 0.001) throw new ToolError(`Need ${amount} XRP spendable, have ${st.spendableXrp}.`, v.pay.network === 'mainnet' ? `Send XRP to ${w.classicAddress}.` : 'cappz-market wallet --fund');
          const lt = await signAndSubmit(seedSigner(w.seed!), { ...v.pay.preparedTx, Account: w.classicAddress }, v.pay.network);
          await http(`/jobs/${jobId}/payments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash: lt.hash }) });
          spent += amount; paid.push(lt.hash);
          continue;
        }
        if (Date.now() > deadline) return { job: jobId, agent: card.name, paid: `${spent} ${card.currency}`, payments: paid, results, state: v.job.state, next: `Still working. Resume later: cappz-market hire ${base} --job ${jobId} --max ${max - spent}` };
        await new Promise((r) => setTimeout(r, 3_000));
      }
    },
  },
  {
    name: 'ops',
    summary: 'List every marketplace operation (reads and governed writes) with its inputs — for anything the named commands do not cover.',
    params: [],
    async run() { return { operations: AGENT_OPERATIONS.map((x) => ({ verb: x.verb, writes: x.writes, summary: x.summary, input: x.input })), next: 'cappz-market call <verb> --input \'{…}\'' }; },
  },
  {
    name: 'call',
    summary: 'Run any marketplace operation by verb with a JSON input (see ops). Writes are published like every other command.',
    params: [
      { name: 'verb', type: 'string', description: 'Operation verb, e.g. marketplace.offer.award.', required: true, positional: true },
      { name: 'input', type: 'json', description: 'Operation input as JSON.' },
    ],
    async run(a, o) {
      const verb = str(a, 'verb') as AgentOperation['verb'];
      const op = AGENT_OPERATIONS.find((x) => x.verb === verb);
      if (!op) throw new ToolError(`Unknown verb ${verb}.`, 'cappz-market ops');
      const mk = await loadMarket(o, op.writes);
      const box = await boxKey().catch(() => null);
      const actor = mk.partyId ? mk.actor() : { partyId: '', at: mk.now() };
      const r = await executeAgentOperation(mk.state, actor, verb, (a.input as Record<string, unknown>) ?? {}, { policy: mk.policy, fetchLedgerTx, ...(box ? { boxPrivateKey: box.privateKey } : {}) });
      if (r.txs.length) await mk.commit(r.txs);
      return { ok: true, market: mk.mode, data: r.data ?? null, recorded: r.txs.map((t) => t.eventType) };
    },
  },
  {
    name: 'demo',
    summary: 'Practice market on this computer: --reset starts it over. Use --demo on any command (and --as <party> to play the other side).',
    params: [{ name: 'reset', type: 'boolean', description: 'Start the practice market over.' }],
    async run(a) {
      if (a.reset) await resetDemo();
      const mk = await loadMarket({ demo: true });
      return { practiceMarket: true, you: mk.partyId, parties: [...mk.state.parties.values()].map((p) => ({ id: p.partyId, name: p.name, kind: p.kind })), listings: mk.state.listings.filter((l) => l.open).length, requests: mk.state.requests.filter((r) => r.open).length, next: 'cappz-market find --demo "lavender"' };
    },
  },
];

export const commandOf = (name: string) => COMMANDS.find((c) => c.name === name);
/** For the verb list in help and docs: the marketplace verbs a command can record. */
export type { MarketplaceVerb };
