/**
 * COPE node crystallized. Node ID: v15-25-00-cappz-market-commands.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * The cappz-market commands — one table, served as a CLI and as MCP tools.
 * Every write runs the marketplace's own builders (the same rules as the web
 * app, including mandates for agent parties) and is published to the shared
 * log as the signed-in account. Money moves only from the wallet on this
 * computer, on the network the caller chooses (one market per network), after a balance check;
 * on mainnet a command that moves money also needs `yes`.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { XrplNetwork } from '../../src/lib/xrpl/ledgerCheck';
import { isValidClassicAddress } from 'xrpl';
import { fetchLedgerTx } from '../../src/lib/xrpl/ledgerCheck';
import { openWith, sealTo, type SealedBox } from '../../src/lib/crypto/sealedBox';
import * as M from '../../src/lib/marketplace/model';
import { CATEGORIES, REGIONS, categoryOf, rootCategoryOf } from '../../src/lib/marketplace/catalog';
import { milestoneAmounts, defaultMilestones, subcontractGate } from '../../src/lib/marketplace/rules';
import { searchMarket } from '../../src/lib/marketplace/search';
import { matchDemand } from '../../src/lib/marketplace/matching';
import { channelCapDrops, channelIdOf, payChannelNode, prepareChannelClaim, prepareChannelClose, prepareChannelCreate, prepareChannelFeePayments, signChannelClaim, unitPriceDrops, verifyChannelClaim } from '../../src/lib/marketplace/settlement';
import { contractRail, newEscrowSecret, prepareEscrowFinish, prepareStageEscrows, prepareStagePayments, stagePaymentLegs } from '../../src/lib/marketplace/settlement';
import { assetLabel, assetsOn, currencyOf as assetCodeOf, formatMoney, fromMinor, PAYMENT_ASSETS, tokenSpecFor } from '../../src/lib/marketplace/paymentAssets';
import { fundingNeed, fundingSummary, prepareTrustSet } from '../../src/lib/marketplace/walletFunding';
import { liveSigningDeps, seedSigner, signAndSubmit, signAndSubmitAll, type SigningDeps } from '../../src/lib/marketplace/ledgerSigning';
import { approvalHook, coSignTx, verifyCoSignature, type CoSignature, type CoSignTerms } from '../../src/lib/marketplace/signingApproval';
import { milestoneEscrowLegs } from '../../src/lib/marketplace/settlement';
import { Wallet } from 'xrpl';
import { xrpNeededForStage } from '../../src/lib/marketplace/walletFunding';
import { AGENT_OPERATIONS, executeAgentOperation, type AgentOperation } from '../../src/lib/marketplace/agentApi';
import { readTrustLine, verifyCheck, type SignedCheck } from '../../src/lib/marketplace/counterpartyCheck';
import type { MarketplaceVerb } from '../../src/lib/marketplace/marketplaceVerbs';
import type { ContractView, Currency, ListingContent, PartyKind, PartyProfile, PartyRole, SupplyOfferContent, SupplyRequestContent } from '../../src/lib/marketplace/types';
import type { ListingView, MarketState, RequestView } from '../../src/lib/marketplace/replay';
import { ToolError, agentKey, agentSigningKey, boxKey, ensureAgentKey, getDiscovery, homeDir, loadMarket, marketNetwork, marketUrl, newWallet, partyIdForAccount, recallSecret, rememberSecret, requireWallet, resetDemo, session, signIn, wallet, walletStatus, type GlobalOptions, type Market } from './context';
import { agentRequestHook, signAgentRequest, type RequestSignHook } from '../../src/lib/marketplace/agentRequestAuth';
import { acceptanceProblems, type AcceptanceSpec } from '../../src/lib/marketplace/acceptance';
import { milestonePlanPresets } from '../../src/lib/marketplace/rules';
import { verdictSha256, verdictSupportsAcceptance, verifyVerdict, type SignedVerdict } from '../../src/lib/marketplace/stageEvaluation';
import { amendListing, sellerListings } from '../../src/lib/marketplace/sellerListings';

/**
 * RFC 9421 request signing with this party's declared key, when its profile declares the key kept on this computer
 * (the same Signature-Input / Signature / Content-Digest headers card networks' agent protocols and Web Bot Auth use).
 * Absent: requests go unsigned, as before, and the service reports them as not-signed.
 */
async function requestHookFor(mk: Market): Promise<RequestSignHook | undefined> {
  const me = mk.partyId ? mk.state.parties.get(mk.partyId) : undefined;
  const k = await agentSigningKey(mk.partyId, me?.keyDeclaration);
  return k ? agentRequestHook(k) : undefined;
}


/**
 * Signing deps that ask the marketplace's approval service to approve each exact escrow transaction before it is
 * signed, and verify the signed approval against the published key and those bytes. Fails closed: no approval, no
 * signature. Networks the service does not cover (devnet) sign without one, and say so.
 */
async function approvedSigning(net: string, contractId: string, milestone: number, approvals: string[], coSignature?: CoSignature, signRequest?: RequestSignHook): Promise<SigningDeps> {
  const d = await getDiscovery(); const svc = d.services?.counterpartyCheck;
  if (!svc?.url || !svc.publicKey) {
    if (net === 'mainnet') throw new ToolError(`${marketUrl()} publishes no signing-approval service, so mainnet escrow is not signed.`);
    approvals.push(`none (no approval service published for ${net})`); return liveSigningDeps;
  }
  if (!svc.networks.includes(net)) { approvals.push(`none (the approval service covers ${svc.networks.join(' and ')}, not ${net})`); return liveSigningDeps; }
  const hook = approvalHook({ serviceUrl: svc.url, publicKey: svc.publicKey, network: net as XrplNetwork, contractId, milestone, coSignature, signRequest, onApproved: (a) => approvals.push(a.approval.requestAuth ? `${a.approval.txHash} (request ${a.approval.requestAuth.state})` : a.approval.txHash) });
  return { ...liveSigningDeps, approve: async (prepared) => { try { await hook(prepared); } catch (e) { throw new ToolError((e as Error).message, 'Check the deal with: cappz-market show ' + contractId); } } };
}

/** The grantor party whose profile account made this (service-verified) co-signature. */
function coSignerOf(mk: Market, c: ContractView, cs: CoSignature): string | undefined {
  const grantors = mk.state.mandates.filter((m) => m.agentPartyId === c.buyerId).map((m) => m.grantedBy);
  return grantors.find((g) => { const acct = mk.state.parties.get(g)?.xrplAccount; return !!acct && verifyCoSignature(cs, acct, new Date().toISOString()).length === 0; });
}

/** Read a co-signature given as JSON or as a file path. */
async function readCoSignature(v: unknown): Promise<CoSignature | undefined> {
  if (v === undefined) return undefined;
  const text = String(v).trim().startsWith('{') ? String(v) : await readFile(resolve(String(v)), 'utf8');
  try { const cs = JSON.parse(text) as CoSignature; if (!cs.terms || !cs.txBlob) throw new Error('shape'); return cs; } catch { throw new ToolError('--co-signature must be the JSON (or a file of it) that cappz-market cosign printed.'); }
}

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
/** Any payment asset by code, id or alias (XRP, CAPPZ, USD-tokenZ/1 — RLUSD —, USD). */
const currencyOf = (a: Record<string, unknown>): Currency => { const c = assetCodeOf(str(a, 'currency', 'XRP')); if (!c) throw new ToolError(`currency is one of ${PAYMENT_ASSETS.map((x) => `${x.code}${x.label !== x.code ? ` (${x.label})` : ''}`).join(', ')}.`); return c; };
const date = (s: string) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ToolError(`Dates are YYYY-MM-DD, got “${s}”.`); return s; };
const inDays = (from: string, d: number) => new Date(Date.parse(from) + d * 86_400_000).toISOString().slice(0, 10);
const price = (m: { amount: number; currency: string }, unit: string) => `${m.amount} ${m.currency}/${unit}`;
/** --acceptance: inline JSON or a file of it; checked before anything is published. */
async function acceptanceArg(a: Record<string, unknown>): Promise<AcceptanceSpec | undefined> {
  if (a.acceptance === undefined || a.acceptance === '') return undefined;
  const raw = typeof a.acceptance === 'object' ? a.acceptance : (() => { const t = String(a.acceptance).trim(); return t.startsWith('{') ? t : null; })();
  let spec: unknown;
  try { spec = typeof raw === 'object' && raw !== null ? raw : JSON.parse(raw ?? await readFile(String(a.acceptance), 'utf8')); } catch { throw new ToolError('--acceptance is JSON ({"version": 1, "criteria": […]}) or a file of it.'); }
  const p = acceptanceProblems(spec);
  if (p.length) throw new ToolError(`Acceptance criteria rejected: ${p.join(' ')}`, 'Format: skills/evaluating-cappz-deliverables/reference/acceptance-criteria.md');
  return spec as AcceptanceSpec;
}
const ACCEPTANCE_PARAM: Param = { name: 'acceptance', type: 'string', description: 'Acceptance criteria for the delivered result (JSON or a file): what an evaluator checks. Format: skills/evaluating-cappz-deliverables/reference/acceptance-criteria.md' };
/** SHA-256 of raw bytes, hex — what deliverables and paid-agent results are checked against. */
const sha256Bytes = async (b: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource)), (x) => x.toString(16).padStart(2, '0')).join('');

function checkCategory(id: string): string {
  if (!categoryOf(id)) throw new ToolError(`Unknown category “${id}”.`, `Use one of: ${CATEGORIES.map((c) => c.id).join(', ')}.`);
  return id;
}
function checkAddress(addr: string): string {
  if (!isValidClassicAddress(addr)) throw new ToolError(`${addr} is not a valid XRPL classic address.`);
  return addr;
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
  const role = c.buyerId === me ? 'buyer' : c.sellerId === me ? 'seller' : c.evaluatorId && c.evaluatorId === me ? 'evaluator' : 'observer';
  return {
    id: c.contractId, title: c.title, role, total: `${c.total.amount} ${c.total.currency}`, state: c.state,
    waitingOnYou: (c.nextAction.by === 'buyer' && role === 'buyer') || (c.nextAction.by === 'seller' && role === 'seller'),
    nextAction: c.nextAction,
    settlement: contractRail(c) === 'ledger-channel' ? 'XRP payment channel on the ledger (metered)' : c.total.currency === 'XRP' ? 'XRP escrow on the ledger' : contractRail(c) === 'ledger-staged' ? `${assetLabel(c.total.currency)} paid on the ledger per stage` : 'USD',
    ...(c.channel ? { channel: c.channel } : {}),
    escrow: c.escrow,
    stages: c.milestones.map((m, i) => ({ index: i, label: m.label, amount: amounts[i], dueBy: m.dueBy, evidence: m.evidence, state: c.milestoneStates[i]?.state, onLedger: c.ledgerEscrows.some((e) => e.milestone === i) })),
    openDisputes: c.disputes.filter((d) => !d.resolved).length,
    ...(c.evaluatorId ? { evaluator: c.evaluatorId } : {}),
    ...(c.parentContractId ? { parentContract: c.parentContractId } : {}),
    ...(c.subcontracts.length ? { subcontracts: c.subcontracts } : {}),
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
      steps.push({ step: 'market', ok: true, detail: mk.mode === 'demo' ? 'practice market (local, nothing is published, no real money)' : `${net} market at ${marketUrl()}${net === 'mainnet' ? ' — real XRP' : ' — test XRP, no value'} (choose with --network devnet|testnet|mainnet)` });
      const w = await wallet();
      if (!w) steps.push({ step: 'wallet', ok: false, detail: 'no XRPL wallet — bring your own funded wallet (XRPL_SEED) or create one here', next: net === 'mainnet' ? `cappz-market wallet --new, then: ${fundingNeed({ network: net, currency: 'XRP', amount: 0, accountExists: false }).steps.join(' ')}` : 'cappz-market wallet --new (funded with free test XRP)' });
      else if (mk.mode === 'demo') steps.push({ step: 'wallet', ok: true, detail: `${w.wallet.classicAddress} (not used by the practice market)` });
      else {
        const st = await walletStatus(w.wallet.classicAddress, net);
        steps.push({ step: 'wallet', ok: st.activated && st.spendableXrp > 0, detail: st.activated ? `${st.address}: ${st.balanceXrp} XRP, ${st.spendableXrp} spendable (reserve ${st.reserveBaseXrp} + ${st.ownedObjects} × ${st.reserveOwnerXrp} XRP)` : `${st.address} is not activated on ${net}`, next: st.activated ? undefined : net === 'mainnet' ? fundingNeed({ network: net, currency: 'XRP', amount: 0, accountExists: false }).steps.join(' ') : 'cappz-market wallet --fund' });
      }
      if (mk.mode === 'live') {
        const s = await session(false);
        steps.push({ step: 'sign-in', ok: !!s, detail: s ? `signed in as ${s.email}` : 'not signed in (reading works; trading needs an account)', next: s ? undefined : 'cappz-market login --email … --password … (--signup the first time)' });
      }
      const me = mk.partyId ? mk.state.parties.get(mk.partyId) : null;
      steps.push({ step: 'profile', ok: !!me, detail: me ? `${me.name} (${me.kind}, party ${me.partyId})` : `no profile for party ${mk.partyId ?? '(sign in first)'}`, next: me ? undefined : 'cappz-market profile --name "…" --kind agent --principal <party id of the person or company you act for> (or --kind organization if you act for yourself)' });
      if (me?.kind === 'agent') {
        const ms = mk.state.mandates.filter((m) => m.agentPartyId === me.partyId && Date.parse(m.limits.expiresAt) > Date.parse(mk.now()));
        const d = await getDiscovery().catch(() => null);
        steps.push({ step: 'mandate', ok: ms.length > 0, detail: ms.length ? ms.map((m) => `${m.limits.verbs.map((v) => v.replace('marketplace.', '')).join(', ')} ≤ ${m.limits.maxPerContract.amount} ${m.limits.maxPerContract.currency}/contract until ${m.limits.expiresAt.slice(0, 10)}`).join('; ') : 'no active mandate — an agent party cannot list, bid, buy or pay', next: ms.length ? undefined : `ask the person you act for to grant one at ${d?.agentsPage ?? `${marketUrl()}/marketplace?tab=agents`} (agent party id ${me.partyId})` });
      }
      const next = steps.find((x) => !x.ok)?.next ?? (mk.mode === 'demo' ? 'Practised? Validate on testnet next: cappz-market setup --network testnet' : net === 'mainnet' ? 'Ready on mainnet (real XRP). Try: cappz-market find "what you need" --network mainnet' : `Ready on ${net}. Validate your whole flow here, then go live: cappz-market setup --network mainnet`);
      return { ready: steps.every((x) => x.ok), steps, next };
    },
  },
  {
    name: 'wallet',
    summary: 'Show your XRPL wallet on the chosen network: address, balance, reserve and what is spendable. --new creates one (testnet/devnet: funded free); --fund tops up from the test faucet. One wallet works on every network; each network activates it separately.',
    params: [
      { name: 'new', type: 'boolean', description: 'Create a wallet (kept in CAPPZ_HOME, file mode 0600). Never overwrites.' },
      { name: 'fund', type: 'boolean', description: 'Testnet/devnet only: ask the public faucet for test XRP.' },
    ],
    async run(a, o) {
      const net = marketNetwork(o) as XrplNetwork;
      if (a.new) { const r = await newWallet(net); return { created: r.address, network: net, funded: r.funded, keptIn: homeDir(), next: r.funded || net !== 'mainnet' ? 'cappz-market setup' : `Send at least the reserve (see cappz-market wallet) to ${r.address} from an exchange or another wallet.` }; }
      const w = await requireWallet();
      if (a.fund) {
        if (net === 'mainnet') throw new ToolError('There is no faucet on mainnet.', 'Buy XRP on an exchange and send it to your address.');
        const { Client } = await import('xrpl'); const { XRPL_ENDPOINTS } = await import('../../src/lib/xrpl/ledgerCheck');
        const c = new Client(XRPL_ENDPOINTS[net]); await c.connect();
        try { await c.fundWallet(w); } finally { await c.disconnect().catch(() => {}); }
      }
      const st = await walletStatus(w.classicAddress, net);
      return { ...st, assetsOnThisNetwork: assetsOn(net).map((x) => x.label), fundIt: fundingNeed({ network: net, currency: 'XRP', amount: 0, accountExists: st.activated }).steps, tokens: 'CAPPZ and RLUSD (USD-tokenZ) need a trust line to their issuer first; cappz-market check <your address> shows what is missing.', note: 'Reserves are network settings read from the ledger now. Each open escrow, offer or trust line adds one owner reserve until it closes; it is returned then.' };
    },
  },
  {
    name: 'trust',
    summary: 'Let this wallet hold an issued payment asset: set the trust line to CAPPZ or RLUSD (USD-tokenZ/1), to the issuer in the CAPPZ payment-asset registry. Needed before anyone can pay you (or you can hold) that token. Locks one owner reserve (0.2 XRP) per line; skipped when the line exists.',
    money: true,
    params: [
      { name: 'currency', type: 'string', description: 'CAPPZ or USD-tokenZ/1 (RLUSD); comma-separated for both (default CAPPZ,USD-tokenZ/1).', positional: true },
    ],
    async run(a, o) {
      const net = marketNetwork(o) as XrplNetwork;
      const codes = list(a.currency ?? 'CAPPZ,USD-tokenZ/1').map((c) => assetCodeOf(c) ?? (() => { throw new ToolError(`${c} is not a payment asset.`, 'Use CAPPZ or USD-tokenZ/1 (RLUSD).'); })());
      const w = await requireWallet();
      const st = await walletStatus(w.classicAddress, net);
      if (!st.activated) throw new ToolError(`Your wallet ${w.classicAddress} is not activated on XRPL ${net}.`, net === 'mainnet' ? fundingNeed({ network: net, currency: 'XRP', amount: 0, accountExists: false }).steps.join(' ') : 'Run: cappz-market wallet --fund');
      const results: Array<Record<string, unknown>> = []; const todo: Array<{ code: Currency; tx: Record<string, unknown> }> = [];
      for (const code of codes) {
        let tx: Record<string, unknown>;
        try { tx = prepareTrustSet(w.classicAddress, code, net); } catch (e) { results.push({ asset: assetLabel(code), state: 'unavailable', reason: (e as Error).message }); continue; }
        const lim = tx.LimitAmount as { currency: string; issuer: string };
        const line = await readTrustLine(net, w.classicAddress, lim.issuer, lim.currency);
        if (line.error) throw new ToolError(`Could not read your ${assetLabel(code)} trust line: ${line.error}`);
        if (line.present) results.push({ asset: assetLabel(code), state: 'already-set', issuer: lim.issuer, balance: line.balance });
        else todo.push({ code, tx });
      }
      if (todo.length) {
        if (net === 'mainnet' && !o.yes) throw new ToolError(`Setting ${todo.map((t) => assetLabel(t.code)).join(' and ')} trust line(s) on mainnet locks ${todo.length} × ${st.reserveOwnerXrp} XRP of your reserve.`, 'Confirm with the person you act for, then repeat with --yes.');
        if (st.spendableXrp < todo.length * st.reserveOwnerXrp + 0.001) throw new ToolError(`Each trust line locks ${st.reserveOwnerXrp} XRP; you have ${st.spendableXrp} XRP spendable.`, fundingSummary(fundingNeed({ network: net, currency: 'XRP', amount: todo.length * st.reserveOwnerXrp, accountExists: true })));
        for (const t of todo) {
          const lt = await signAndSubmit(seedSigner(w.seed!), t.tx, net);
          const lim = t.tx.LimitAmount as { issuer: string };
          results.push({ asset: assetLabel(t.code), state: lt.result === 'tesSUCCESS' ? 'set' : 'failed', result: lt.result, issuer: lim.issuer, tx: lt.hash });
        }
      }
      return { wallet: w.classicAddress, network: net, lines: results, next: 'Others can now pay you in these tokens. To hold some, get them into this wallet (on mainnet: withdraw from an exchange on the XRP Ledger network). Check any time: cappz-market check <your address> --currency USD-tokenZ/1' };
    },
  },
  {
    name: 'login',
    summary: 'Sign in to the CAPPZ marketplace (needed to publish). --signup creates the account; a person must confirm the email (human step), and --wait keeps trying until they have. Reading the market needs no sign-in.',
    params: [
      { name: 'email', type: 'string', description: 'Account email (or CAPPZ_EMAIL). Use an inbox the person you act for reads.' },
      { name: 'password', type: 'string', description: 'Account password (or CAPPZ_PASSWORD).' },
      { name: 'signup', type: 'boolean', description: 'Create the account first.' },
      { name: 'wait', type: 'number', description: 'Minutes to keep retrying until the email is confirmed (e.g. 15). Tell the person first.' },
    ],
    async run(a) {
      const email = str(a, 'email', process.env.CAPPZ_EMAIL ?? ''); const password = str(a, 'password', process.env.CAPPZ_PASSWORD ?? '');
      if (!email || !password) throw new ToolError('Give --email and --password (or set CAPPZ_EMAIL and CAPPZ_PASSWORD).');
      const humanStep = { humanAction: `Ask the person you act for to open the email CAPPZ sent to ${email} and click the confirmation link. This is a human step by design: do not try to confirm it yourself.`, next: `After telling them: cappz-market login --wait 15` };
      if (a.signup) { const r = await signIn(email, password, true); if (r.confirmed) return { signedIn: r.email, next: 'cappz-market setup' }; return { created: r.email, signedIn: false, ...humanStep }; }
      const deadline = Date.now() + num(a, 'wait', 0) * 60_000;
      for (;;) {
        try { const r = await signIn(email, password); return { signedIn: r.email, next: 'cappz-market setup' }; }
        catch (e) {
          if (!/not confirmed/i.test((e as Error).message)) throw e;
          if (Date.now() > deadline) return { signedIn: false, waitingFor: 'email confirmation', ...humanStep };
          await new Promise((r) => setTimeout(r, 10_000));
        }
      }
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
      { name: 'xrplAccount', type: 'string', description: 'Public XRPL address you are paid at, if not this tool\'s wallet (e.g. a treasury or cold wallet). Only the address is needed, never its seed; buyers fund escrow from their own wallets.' },
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
      // Agents declare a request-signing key (KeyZ): kept here, declared on the profile, renewed before it expires.
      const ak = kind === 'agent' && mk.mode === 'live' ? await ensureAgentKey() : null;
      const profile: PartyProfile = {
        partyId, kind, name: str(a, 'name'), roles: (list(a.roles).length ? list(a.roles) : prior?.roles ?? ['buyer', 'seller']) as PartyRole[],
        region: checkRegion(str(a, 'region', prior?.region ?? 'TX')), about: str(a, 'about', prior?.about ?? ''),
        capabilities: { categories: list(a.categories).map(checkCategory).length ? list(a.categories) : prior?.capabilities.categories ?? [], canPlantNew: prior?.capabilities.canPlantNew ?? false },
        ...(principal ? { principal } : {}), ...(a.xrplAccount ? { xrplAccount: checkAddress(String(a.xrplAccount)) } : w ? { xrplAccount: w.wallet.classicAddress } : prior?.xrplAccount ? { xrplAccount: prior.xrplAccount } : {}),
        encryptionKey: box.publicKey, ...(a.runtime ? { runtime: String(a.runtime) } : prior?.runtime ? { runtime: prior.runtime } : {}),
        ...(ak ? { keyDeclaration: ak.declaration } : prior?.keyDeclaration ? { keyDeclaration: prior.keyDeclaration } : {}),
        ...(prior?.keyRevocations ? { keyRevocations: prior.keyRevocations } : {}), ...(prior?.principalCredential ? { principalCredential: prior.principalCredential } : {}),
      };
      const txs = await M.buildProfile(mk.state, mk.actor(), profile);
      return commitAndReport(mk, txs, { partyId, xrplAccount: profile.xrplAccount ?? null, signingKey: profile.keyDeclaration ? { keyId: profile.keyDeclaration.publicKey, declaredBy: profile.keyDeclaration.walletAddress, expiresAt: profile.keyDeclaration.expiresAt } : null, next: kind === 'agent' ? `Ask your principal to grant a mandate to ${partyId} at ${marketUrl()}/marketplace?tab=agents, then run cappz-market setup.` : 'cappz-market find "…"' });
    },
  },
  {
    name: 'cosign',
    summary: 'Mandate grantor (a person): co-sign one stage of your agent’s deal that is above its approval threshold. Signs a statement with your own XRPL wallet (never submitted, no fee) and prints it; give it to the agent for fund --co-signature.',
    params: [
      { name: 'contract', type: 'string', description: 'Contract id.', required: true, positional: true },
      { name: 'milestone', type: 'number', description: 'Stage index (default: the stage to fund now).' },
      { name: 'hours', type: 'number', description: 'How long the co-signature is valid (default 24).' },
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true);
      const c = contractOf(mk, str(a, 'contract'));
      const action: 'fund' | 'pay' | 'channel' = contractRail(c) === 'ledger-staged' ? 'pay' : contractRail(c) === 'ledger-channel' ? 'channel' : 'fund';
      const buyer = mk.state.parties.get(c.buyerId);
      if (buyer?.kind !== 'agent') throw new ToolError('Only an agent buyer’s stages need a co-signature.');
      const grantors = new Set(mk.state.mandates.filter((m) => m.agentPartyId === buyer.partyId).map((m) => m.grantedBy));
      if (!mk.partyId || !grantors.has(mk.partyId)) throw new ToolError(`Only a party that granted ${buyer.name} a mandate can co-sign (${[...grantors].join(', ') || 'none'}).`);
      const me = mk.state.parties.get(mk.partyId)!;
      const w = await requireWallet();
      if (me.xrplAccount !== w.classicAddress) throw new ToolError(`Your profile’s XRPL account is ${me.xrplAccount ?? 'missing'}, but this wallet is ${w.classicAddress}.`, 'The co-signature must come from the account on your profile: cappz-market profile --xrpl-account …');
      if (!w.seed) throw new ToolError('This wallet has no seed on this computer, so it cannot sign.');
      const milestone = a.milestone === undefined ? (M.currentStage(c)?.index ?? 0) : num(a, 'milestone');
      const seller = mk.state.parties.get(c.sellerId)?.xrplAccount;
      if (!seller) throw new ToolError('The seller has no XRPL account on their profile yet.');
      const amountDrops = action === 'channel' ? channelCapDrops(c).toString() : (action === 'pay' ? stagePaymentLegs(c, milestone, seller).map((l) => l.units) : milestoneEscrowLegs(c, milestone, seller).map((l) => l.drops)).reduce((s, u) => s + BigInt(u), 0n).toString();
      const terms: CoSignTerms = { network: mk.policy.network as XrplNetwork, contractId: c.contractId, milestone, action, amountDrops, expiresAt: new Date(Date.now() + num(a, 'hours', 24) * 3_600_000).toISOString() };
      const signed = Wallet.fromSeed(w.seed).sign(coSignTx(w.classicAddress, terms) as never);
      const cs: CoSignature = { terms, txBlob: signed.tx_blob };
      const problems = verifyCoSignature(cs, w.classicAddress, new Date().toISOString());
      if (problems.length) throw new ToolError(`Could not make a valid co-signature: ${problems.join(' ')}`);
      return { coSigned: `${c.title} — stage ${milestone} (${c.milestones[milestone]?.label ?? ''}): ${formatMoney(fromMinor(Number(amountDrops), c.total.currency), c.total.currency)} on ${terms.network}`, validUntil: terms.expiresAt, coSignature: cs, next: `Give the agent the coSignature JSON: cappz-market ${action === 'pay' ? 'release' : 'fund'} ${c.contractId} --co-signature '<json>' (or a file). Nothing was submitted to the ledger.` };
    },
  },
  {
    name: 'mandate',
    summary: 'Principal (a person or organization running this tool): grant your agent a mandate — what it may do, in which categories, up to how much — or revoke one. Agents cannot grant themselves anything.',
    params: [
      { name: 'agent', type: 'string', description: 'The agent’s party id (it prints it in setup).', positional: true },
      { name: 'actions', type: 'string', description: 'buy, sell or both (default buy), or comma-separated verbs (see ops).' },
      { name: 'categories', type: 'string', description: 'Comma-separated category ids (default: any).' },
      { name: 'maxContract', type: 'number', description: 'Most per contract (default 100).' },
      { name: 'maxDay', type: 'number', description: 'Most per day (default 3 × max-contract).' },
      { name: 'askAbove', type: 'number', description: 'Above this value the agent needs your co-signature.' },
      { name: 'currency', type: 'string', description: 'XRP (default), CAPPZ, USD-tokenZ/1 (RLUSD) or USD: the mandate covers deals in this asset only (grant one per asset).' },
      { name: 'days', type: 'number', description: 'Valid for this many days (default 30).' },
      { name: 'revoke', type: 'string', description: 'Revoke this mandate id instead (see setup or show <agent>).' },
      { name: 'bindKey', type: 'boolean', description: 'Bind the mandate to the agent’s declared signing key: its approval requests must then be signed by that key.' },
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true);
      const me = mk.state.parties.get(mk.partyId!);
      if (!me) throw new ToolError('Create your profile first.', 'cappz-market profile --name "…" --kind organization');
      if (me.kind === 'agent') throw new ToolError('An agent cannot grant mandates; its principal does.', `Ask your principal to run this, or to grant it at ${marketUrl()}/marketplace?tab=agents`);
      if (a.revoke) return commitAndReport(mk, await M.buildRevokeMandate(mk.state, mk.actor(), str(a, 'revoke')), { revoked: str(a, 'revoke') });
      const agentId = str(a, 'agent');
      const agent = mk.state.parties.get(agentId);
      if (!agent || agent.kind !== 'agent') throw new ToolError(`No agent party ${agentId} on the ${mk.network} market.`, 'The agent runs cappz-market profile --kind agent first (on this network).');
      const BUY = ['marketplace.order.place', 'marketplace.request.post', 'marketplace.offer.award', 'marketplace.escrow.fund', 'marketplace.milestone.affirm', 'marketplace.escrow.release', 'marketplace.stage.pay', 'marketplace.channel.open', 'marketplace.channel.close'];
      const SELL = ['marketplace.listing.publish', 'marketplace.offer.submit', 'marketplace.milestone.evidence', 'marketplace.channel.settle', 'marketplace.channel.close'];
      const act = str(a, 'actions', 'buy');
      const verbs = act === 'buy' ? BUY : act === 'sell' ? SELL : act === 'both' ? [...BUY, ...SELL] : list(act);
      const currency = currencyOf(a); const per = num(a, 'maxContract', 100);
      const limits = { verbs, categories: list(a.categories).map(checkCategory), maxPerContract: money(per, currency), maxPerDay: money(num(a, 'maxDay', per * 3), currency), approvalAbove: a.askAbove !== undefined ? money(num(a, 'askAbove'), currency) : null, expiresAt: new Date(Date.parse(mk.now()) + num(a, 'days', 30) * 86_400_000).toISOString() };
      if (a.bindKey && !agent.keyDeclaration) throw new ToolError(`${agent.name} declares no signing key yet.`, 'The agent runs cappz-market profile (it declares one), then grant again with --bind-key.');
      const boundKey = a.bindKey ? agent.keyDeclaration!.publicKey : undefined;
      const r = await M.buildMandate(mk.state, mk.actor(), agentId, limits, boundKey ? { boundKey } : {});
      return commitAndReport(mk, r.txs, { mandateId: r.mandateId, agent: agentId, limits, boundKey: boundKey ?? null, next: `The agent can act now on ${mk.network}: it runs cappz-market setup${mk.network === 'testnet' ? '' : ` --network ${mk.network}`}` });
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
      const mine = mk.state.contracts.filter((c) => c.buyerId === mk.partyId || c.sellerId === mk.partyId || (!!c.evaluatorId && c.evaluatorId === mk.partyId)).map((c) => dealCard(c, mk.partyId));
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
      { name: 'currency', type: 'string', description: 'XRP (default; escrowed per stage), CAPPZ or USD-tokenZ/1 (RLUSD; paid on the ledger per accepted stage), or USD (card or bank in the web app).' },
      { name: 'kind', type: 'string', description: 'sale, rent, service or production-contract (default: the category’s first).' },
      { name: 'description', type: 'string', description: 'Details buyers need.' },
      { name: 'delivery', type: 'string', description: 'online, ship, pickup or on-site (default online for agents/digital, else ship).' },
      { name: 'leadDays', type: 'number', description: 'Days from order to delivery (default 7).' },
      { name: 'region', type: 'string', description: 'State code (default your profile’s).' },
      { name: 'endpoint', type: 'string', description: 'Paid agents: the https address buyers (and cappz-market hire) call.' },
      { name: 'metered', type: 'boolean', description: 'XRP only: sell metered use (unit = query, MB, call…; price per unit). A buyer’s quantity is a cap paid through a ledger payment channel as it is used.' },
      ACCEPTANCE_PARAM,
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
        ...(a.metered ? { metered: true } : {}),
      };
      const acceptance = await acceptanceArg(a);
      if (acceptance) {
        if (a.metered) throw new ToolError('A metered listing has no stages to accept; drop --acceptance or --metered.');
        // Pay on delivery, with the criteria on the delivery milestone (copied into every order's terms).
        listing.milestones = milestonePlanPresets(listing.leadDays)['on-delivery'].plan.map((m) => ({ ...m, acceptance }));
      }
      const txs = await M.buildListing(mk.state, mk.actor(), listing);
      return commitAndReport(mk, txs, { listingId: listing.listingId, next: 'Buyers order with: cappz-market buy ' + listing.listingId + ' — watch with cappz-market deals' });
    },
  },
  {
    name: 'listings',
    summary: 'Seller: your listings (open first) with what is left, the orders formed from each, acceptance criteria, and the commands to change them.',
    params: [{ name: 'all', type: 'boolean', description: 'Include closed listings.' }],
    async run(a, o) {
      const mk = await loadMarket(o, true);
      if (!mk.partyId) throw new ToolError('Sign in first.', 'cappz-market login');
      const rows = sellerListings(mk.state, mk.partyId).filter((r) => a.all || r.state !== 'closed');
      return {
        listings: rows.map((r) => ({ ...listingCard(mk.state, r.listing), state: r.state, ...(r.closed ? { closed: r.closed } : {}), orders: r.orders, contracts: r.contractIds.slice(0, 5), acceptance: r.acceptance ? r.acceptance.criteria.map((c) => c.id) : null,
          ...(r.state === 'closed' ? {} : { change: `cappz-market update ${r.listing.listingId} --price … --available …`, close: `cappz-market withdraw ${r.listing.listingId}` }) })),
        next: rows.length ? 'Change one: cappz-market update <listing> [--price --available --title --description --leadDays --endpoint --acceptance]' : 'No listings yet: cappz-market sell (or cappz-market draft "…" to word one).',
      };
    },
  },
  {
    name: 'update',
    summary: 'Seller: change one of your listings — price, what is available, title, description, lead time, endpoint or acceptance criteria. Applies to orders placed after it; formed contracts keep their terms.',
    params: [
      { name: 'listing', type: 'string', description: 'Your listing id (cappz-market listings).', required: true, positional: true },
      { name: 'price', type: 'number', description: 'New price per unit (same asset).' },
      { name: 'available', type: 'number', description: 'Units left to sell from now (0 pauses orders; withdraw closes the listing).' },
      { name: 'title', type: 'string', description: 'New title.' },
      { name: 'description', type: 'string', description: 'New description.' },
      { name: 'leadDays', type: 'number', description: 'Days from order to delivery.' },
      { name: 'endpoint', type: 'string', description: 'Paid agents: new https endpoint ("none" removes it).' },
      { ...ACCEPTANCE_PARAM, description: 'New acceptance criteria for future orders (JSON or a file; "none" removes them).' },
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true);
      const l = mk.state.listings.find((x) => x.listingId === str(a, 'listing'));
      if (!l) throw new ToolError('No such listing on this market.', 'cappz-market listings --all');
      if (l.sellerId !== mk.partyId) throw new ToolError('That listing is not yours.');
      const removeAcceptance = a.acceptance === 'none';
      const changes = {
        ...(a.title !== undefined ? { title: str(a, 'title') } : {}), ...(a.description !== undefined ? { description: str(a, 'description') } : {}),
        ...(a.price !== undefined ? { price: num(a, 'price') } : {}), ...(a.available !== undefined ? { available: num(a, 'available') } : {}),
        ...(a.leadDays !== undefined ? { leadDays: num(a, 'leadDays') } : {}), ...(a.endpoint !== undefined ? { endpoint: str(a, 'endpoint') === 'none' ? null : str(a, 'endpoint') } : {}),
        ...(removeAcceptance ? { acceptance: null } : a.acceptance !== undefined ? { acceptance: (await acceptanceArg(a))! } : {}),
      };
      if (!Object.keys(changes).length) throw new ToolError('Nothing to change.', `cappz-market update ${l.listingId} --price … (see --help)`);
      let next; try { next = amendListing(l, changes); } catch (e) { throw new ToolError((e as Error).message); }
      return commitAndReport(mk, await M.buildListing(mk.state, mk.actor(), next), { listingId: l.listingId, changed: Object.keys(changes), next: 'Applies to new orders. See it: cappz-market listings' });
    },
  },
  {
    name: 'withdraw',
    summary: 'Seller: close one of your listings so nobody can order from it (contracts already formed are unaffected).',
    params: [{ name: 'listing', type: 'string', description: 'Your listing id.', required: true, positional: true }],
    async run(a, o) {
      const mk = await loadMarket(o, true);
      const l = mk.state.listings.find((x) => x.listingId === str(a, 'listing'));
      if (!l) throw new ToolError('No such listing on this market.', 'cappz-market find --category …');
      if (!l.open) return { listingId: l.listingId, open: false, next: 'Already closed.' };
      return commitAndReport(mk, await M.buildWithdrawListing(mk.state, mk.actor(), l.listingId), { listingId: l.listingId, open: false, next: 'Closed. Re-list any time with cappz-market sell.' });
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
      { name: 'currency', type: 'string', description: 'XRP (default), CAPPZ, USD-tokenZ/1 (RLUSD) or USD.' },
      { name: 'description', type: 'string', description: 'Specs, quality, format.' },
      { name: 'region', type: 'string', description: 'State code (default your profile’s).' },
      ACCEPTANCE_PARAM,
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
      const acceptance = await acceptanceArg(a); if (acceptance) req.acceptance = acceptance;
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
      { ...ACCEPTANCE_PARAM, description: 'Acceptance criteria for your delivery (default: the request’s own, when it states them).' },
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true);
      const r = mk.state.requests.find((x) => x.requestId === str(a, 'request')) ?? (() => { throw new ToolError('No such request.', 'cappz-market find --wanted'); })();
      const currency = r.maxPricePerUnit?.currency ?? currencyOf(a);
      const by = date(str(a, 'by', r.neededBy));
      const offer: SupplyOfferContent = { offerId: M.newId('of'), requestId: r.requestId, sellerId: mk.partyId!, pricePerUnit: money(num(a, 'price'), currency), quantity: num(a, 'quantity', r.quantity - r.awardedQuantity), deliveryDate: by, plan: { newPlanting: false, notes: '' }, milestones: defaultMilestones('spot', mk.now().slice(0, 10), by), message: str(a, 'message', '') };
      const acceptance = (await acceptanceArg(a)) ?? r.acceptance;
      if (acceptance) offer.milestones = offer.milestones.map((m) => (m.delivery ? { ...m, acceptance } : m));
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
      { name: 'evaluator', type: 'string', description: 'A third party (never the seller) who may accept milestones besides you; you still pay.' },
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true);
      const r = await M.buildAward(mk.state, mk.actor(), str(a, 'request'), str(a, 'bid'), a.quantity === undefined ? undefined : num(a, 'quantity'), a.evaluator ? str(a, 'evaluator') : undefined);
      return commitAndReport(mk, r.txs, { contractId: r.contractId, next: `cappz-market fund ${r.contractId}` });
    },
  },
  {
    name: 'buy',
    summary: 'Buy from a listing. This forms a contract; then fund its first stage.',
    params: [
      { name: 'listing', type: 'string', description: 'Listing id.', required: true, positional: true },
      { name: 'quantity', type: 'number', description: 'Units (default 1).' },
      { name: 'evaluator', type: 'string', description: 'A third party (never the seller) who may accept milestones besides you; you still pay.' },
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true);
      const r = await M.buildOrder(mk.state, mk.actor(), str(a, 'listing'), num(a, 'quantity', 1), undefined, a.evaluator ? str(a, 'evaluator') : undefined);
      return commitAndReport(mk, r.txs, { contractId: r.contractId, next: `cappz-market fund ${r.contractId}` });
    },
  },
  {
    name: 'subcontract',
    summary: 'Seller: hand part of a contract’s work to another party as a child contract. Same asset and rail, within the parent’s unreleased value; you are its buyer and fund each stage only after the parent milestone it serves is released to you. Fees apply to the child like any contract.',
    params: [
      { name: 'parent', type: 'string', description: 'The contract you sell on.', required: true, positional: true },
      { name: 'to', type: 'string', description: 'The subcontractor’s party id.', required: true },
      { name: 'title', type: 'string', description: 'What the subcontractor delivers.', required: true },
      { name: 'price', type: 'number', description: 'Price per unit, in the parent’s asset.', required: true },
      { name: 'quantity', type: 'number', description: 'Units (default 1).' },
      { name: 'unit', type: 'string', description: 'Unit (default: the parent’s).' },
      { name: 'serves', type: 'number', description: 'The parent milestone index this work serves; the child stage is due with it.', required: true },
      { name: 'evaluator', type: 'string', description: 'A third party (never the subcontractor) who may accept the child’s milestones besides you.' },
      ACCEPTANCE_PARAM,
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true);
      const parent = contractOf(mk, str(a, 'parent'));
      const r = await M.buildSubcontract(mk.state, mk.actor(), parent.contractId, { subcontractorId: str(a, 'to'), title: str(a, 'title'), quantity: num(a, 'quantity', 1), pricePerUnit: money(num(a, 'price'), parent.total.currency), serves: num(a, 'serves'), ...(a.unit ? { unit: str(a, 'unit') } : {}), ...(a.evaluator ? { evaluatorId: str(a, 'evaluator') } : {}), ...(await acceptanceArg(a).then((x) => (x ? { acceptance: x } : {}))) });
      return commitAndReport(mk, r.txs, { contractId: r.contractId, parent: parent.contractId, next: `When the parent milestone ${num(a, 'serves')} is released to you: cappz-market fund ${r.contractId}` });
    },
  },
  {
    name: 'fund',
    summary: 'Buyer: pay the current stage into escrow. XRP: one ledger escrow per payee, locked by a secret only you hold, returned to you after 30 days if never released.',
    money: true,
    params: [
      { name: 'contract', type: 'string', description: 'Contract id.', required: true, positional: true },
      { name: 'reference', type: 'string', description: 'USD deals only: the payment reference (USD is otherwise paid in the web app).' },
      { name: 'co-signature', type: 'string', description: 'Agents above their mandate threshold: the co-signature (JSON or file) the mandate grantor made with cappz-market cosign.' },
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true); guardMainnet(this, mk, o);
      const c = contractOf(mk, str(a, 'contract'));
      if (c.buyerId !== mk.partyId) throw new ToolError('Only the buyer funds a contract.');
      const coSignature = await readCoSignature(a['co-signature']);
      const stage = M.currentStage(c) ?? (() => { throw new ToolError('Every stage is paid.'); })();
      const gate = subcontractGate(mk.state.contracts, c, stage.index);
      if (gate) throw new ToolError(gate, c.parentContractId ? `Check the parent: cappz-market show ${c.parentContractId}` : undefined);
      if (mk.mode === 'demo') return commitAndReport(mk, await M.buildFund(mk.state, mk.actor(), c.contractId, stage.need, { rail: 'demo' }), { stage: c.milestones[stage.index].label, amount: stage.need, next: 'The seller delivers evidence next; then cappz-market release ' + c.contractId });
      if (c.total.currency === 'USD') {
        if (!a.reference) throw new ToolError('USD stages are paid by card or bank in the web app.', `Open ${marketUrl()}/marketplace?tab=deals, or record a payment you already made with --reference.`);
        return commitAndReport(mk, await M.buildFund(mk.state, mk.actor(), c.contractId, stage.need, { rail: 'usd-reference', reference: str(a, 'reference') }), { note: 'Recorded by reference: not verifiable on a ledger.' });
      }
      if (contractRail(c) === 'ledger-channel') {
        // Metered: open one payment channel for the cap. Claims are signed with this wallet's own key (its public key is the channel's), so nothing new is kept.
        if (c.channel) throw new ToolError(`The channel is already open (${c.channel.channelId}).`, `Sign claims as you use the service: cappz-market claim ${c.contractId} --units N`);
        const buyer = mk.state.parties.get(c.buyerId)?.xrplAccount; const seller = mk.state.parties.get(c.sellerId)?.xrplAccount;
        if (!seller) throw new ToolError('The seller has no XRPL account on their profile yet.', 'Ask them to add one; then fund.');
        const { w, net, st } = await signingWallet(mk);
        if (buyer !== w.classicAddress) throw new ToolError(`Your profile’s XRPL account is ${buyer ?? 'missing'}, but this wallet is ${w.classicAddress}.`, 'Run cappz-market profile --name "…" to put this wallet on your profile.');
        const need = xrpNeededForStage(c.total.amount, 1);
        if (st.spendableXrp < need) throw new ToolError(`The channel needs about ${need} XRP spendable (the ${c.total.amount} XRP cap + one owner reserve while it is open + network fees); you have ${st.spendableXrp}.`, fundingSummary(fundingNeed({ network: net, currency: 'XRP', amount: Math.max(0, Math.round((need - st.spendableXrp) * 1e6) / 1e6), accountExists: st.activated })));
        const create = prepareChannelCreate(c, buyer, seller, w.publicKey, mk.now());
        const approvals: string[] = [];
        const lt = await signAndSubmit(seedSigner(w.seed!), create, net, await approvedSigning(net, c.contractId, 0, approvals, coSignature, await requestHookFor(mk)));
        try {
          const txs = await M.buildOpenChannel(mk.state, mk.actor(coSignature ? coSignerOf(mk, c, coSignature) : undefined), c.contractId, mk.policy, lt);
          return commitAndReport(mk, txs, { channel: channelIdOf(lt), cap: `${c.quantity} ${c.unit} (${formatMoney(c.total.amount, 'XRP')})`, ledgerTx: lt.hash, approvedIntents: approvals, returnsToYouAfter: 'the channel expires within 30 days; anything unredeemed comes back', next: `As you use the service: cappz-market claim ${c.contractId} --units <total used so far>, and give the seller the claim it prints.` });
        } catch (e) { throw new ToolError(`${(e as Error).message} The channel is on the ledger: ${lt.hash}.`, `Record it with: cappz-market call marketplace.channel.open --input '{"contractId":"${c.contractId}","txHash":"${lt.hash}"}'`); }
      }
      if (contractRail(c) === 'ledger-staged') throw new ToolError(`${assetLabel(c.total.currency)} deals hold nothing: each stage is paid on the ledger when you accept it.`, `Wait for the seller's evidence, then: cappz-market release ${c.contractId}`);
      if (c.ledgerEscrows.some((e) => e.milestone === stage.index)) throw new ToolError(`“${c.milestones[stage.index].label}” is already escrowed.`, 'Wait for the seller’s evidence, then release.');
      const buyer = mk.state.parties.get(c.buyerId)?.xrplAccount; const seller = mk.state.parties.get(c.sellerId)?.xrplAccount;
      if (!seller) throw new ToolError('The seller has no XRPL account on their profile yet.', 'Ask them to add one; then fund.');
      const { w, net, st } = await signingWallet(mk);
      if (buyer !== w.classicAddress) throw new ToolError(`Your profile’s XRPL account is ${buyer ?? 'missing'}, but this wallet is ${w.classicAddress}.`, 'Run cappz-market profile --name "…" to put this wallet on your profile.');
      const secret = newEscrowSecret();
      const legs = await prepareStageEscrows(c, stage.index, buyer, seller, secret, mk.now());
      const need = xrpNeededForStage(stage.amount, legs.length);
      if (st.spendableXrp < need) throw new ToolError(`This stage needs about ${need} XRP spendable (${stage.amount} XRP + ${legs.length} × ${st.reserveOwnerXrp} XRP reserve while the escrows are open + network fees); you have ${st.spendableXrp}.`, fundingSummary(fundingNeed({ network: net, currency: 'XRP', amount: Math.max(0, Math.round((need - st.spendableXrp) * 1e6) / 1e6), accountExists: st.activated })));
      await rememberSecret(c.contractId, stage.index, secret);
      const box = await boxKey();
      const sealedSecret = (await sealTo(box.publicKey, { contractId: c.contractId, milestone: stage.index, secret })) as unknown as Record<string, unknown>;
      const signed: string[] = []; const approvals: string[] = [];
      const deps = await approvedSigning(net, c.contractId, stage.index, approvals, coSignature, await requestHookFor(mk));
      try {
        const lts = await signAndSubmitAll(seedSigner(w.seed!), legs.map((l) => l.tx), net, (_n, lt) => signed.push(lt.hash), deps);
        const checks = legs.map((p, i) => ({ milestone: p.milestone, condition: p.condition, sealedSecret, lt: lts[i] }));
        // The approval service verified the grantor's signature; the log records who co-signed.
        const txs = await M.buildFundOnLedger(mk.state, mk.actor(coSignature ? coSignerOf(mk, c, coSignature) : undefined), c.contractId, mk.policy, checks);
        return commitAndReport(mk, txs, { stage: c.milestones[stage.index].label, escrowed: `${stage.amount} XRP`, ledgerTxs: lts.map((x) => x.hash), approvedIntents: approvals, returnsToYouAfter: '30 days if not released', next: 'The seller delivers evidence; then: cappz-market release ' + c.contractId });
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
    name: 'accept',
    summary: 'Buyer or the contract’s evaluator: accept the current stage’s evidence without paying it (the buyer then releases or pays). An agent evaluator needs a mandate covering marketplace.milestone.affirm.',
    params: [{ name: 'contract', type: 'string', description: 'Contract id.', required: true, positional: true },
      { name: 'verdict', type: 'string', description: 'A signed verdict file from cappz-market evaluate: the acceptance cites it (required to be a pass on the contract’s agreed criteria for the current evidence).' }],
    async run(a, o) {
      const mk = await loadMarket(o, true);
      const c = contractOf(mk, str(a, 'contract'));
      const stage = M.currentStage(c) ?? (() => { throw new ToolError('Every stage is paid.'); })();
      let basis: M.AffirmBasis | undefined;
      if (a.verdict) {
        const svc = (await getDiscovery()).services?.stageEvaluator;
        if (!svc) throw new ToolError(`${marketUrl()} does not publish a stage evaluator key to check the verdict against.`);
        const signed = JSON.parse(await readFile(str(a, 'verdict'), 'utf8')) as SignedVerdict;
        const ok = verdictSupportsAcceptance(mk.state, signed, svc.publicKey);
        if (!ok.ok) throw new ToolError(`Not accepting on this verdict: ${ok.because}`);
        if (signed.verdict.contractId !== c.contractId || signed.verdict.milestone !== stage.index) throw new ToolError('The verdict is for another contract or stage.');
        basis = { verdictSha256: verdictSha256(signed), verdictAddress: signed.verdict.address, verdict: 'pass' };
      }
      return commitAndReport(mk, await M.buildAffirm(mk.state, mk.actor(), c.contractId, stage.index, basis), { stage: c.milestones[stage.index].label, ...(basis ? { onVerdict: basis.verdictSha256 } : {}), next: `The buyer pays it: cappz-market release ${c.contractId}` });
    },
  },
  {
    name: 'release',
    summary: 'Buyer: accept the current stage’s evidence and pay it — out of escrow for XRP (reveals the stage secret on the ledger), directly on the ledger for CAPPZ and RLUSD (USD-tokenZ) deals.',
    money: true,
    params: [{ name: 'contract', type: 'string', description: 'Contract id.', required: true, positional: true },
      { name: 'co-signature', type: 'string', description: 'Agents paying a token stage above their mandate threshold: the grantor’s co-signature (cappz-market cosign <contract>).' }],
    async run(a, o) {
      let mk = await loadMarket(o, true); guardMainnet(this, mk, o);
      let c = contractOf(mk, str(a, 'contract'));
      const stage = M.currentStage(c) ?? (() => { throw new ToolError('Every stage is paid.'); })();
      const done: string[] = [];
      if (c.milestoneStates[stage.index].state === 'evidenced') { const t = await M.buildAffirm(mk.state, mk.actor(), c.contractId, stage.index); await mk.commit(t); done.push(...t.map((x) => x.eventType)); mk = await loadMarket(o, true); c = contractOf(mk, c.contractId); }
      if (c.milestoneStates[stage.index].state !== 'affirmed') throw new ToolError(`“${c.milestones[stage.index].label}” has no evidence to accept yet (state ${c.milestoneStates[stage.index].state}).`, 'Wait for the seller: cappz-market deals');
      if (contractRail(c) === 'ledger-staged') {
        const gate = subcontractGate(mk.state.contracts, c, stage.index);
        if (gate) throw new ToolError(gate, c.parentContractId ? `Check the parent: cappz-market show ${c.parentContractId}` : undefined);
        // Issued tokens (CAPPZ, USD-tokenZ): pay the accepted stage directly — seller net and each fee leg — each approved, then checked on the ledger.
        const buyer = mk.state.parties.get(c.buyerId)?.xrplAccount; const seller = mk.state.parties.get(c.sellerId)?.xrplAccount;
        if (!seller) throw new ToolError('The seller has no XRPL account on their profile yet.', 'Ask them to add one; then release.');
        const { w, net } = await signingWallet(mk);
        if (buyer !== w.classicAddress) throw new ToolError(`Your profile’s XRPL account is ${buyer ?? 'missing'}, but this wallet is ${w.classicAddress}.`, 'Run cappz-market profile --name "…" to put this wallet on your profile.');
        const legs = prepareStagePayments(c, stage.index, buyer, seller, net);
        const coSignature = await readCoSignature(a['co-signature']);
        const approvals: string[] = []; const paid: string[] = [];
        try {
          const lts = await signAndSubmitAll(seedSigner(w.seed!), legs.map((l) => l.tx), net, (_n, lt) => paid.push(lt.hash), await approvedSigning(net, c.contractId, stage.index, approvals, coSignature, await requestHookFor(mk)));
          const txs = await M.buildPayStageOnLedger(mk.state, mk.actor(coSignature ? coSignerOf(mk, c, coSignature) : undefined), c.contractId, stage.index, mk.policy, lts);
          return commitAndReport(mk, txs, { accepted: done, stage: c.milestones[stage.index].label, paid: formatMoney(stage.amount, c.total.currency), ledgerTxs: lts.map((x) => x.hash), approvedIntents: approvals, next: stage.index + 1 < c.milestones.length ? `The seller delivers the next stage; then: cappz-market release ${c.contractId}` : `Done. Review the seller: cappz-market review ${c.contractId} --rating 5 --text "…"` });
        } catch (err) {
          const need = fundingNeed({ network: net, currency: c.total.currency, amount: stage.amount, accountExists: true });
          throw new ToolError(`${(err as Error).message}${paid.length ? ` Payments already on the ledger: ${paid.join(', ')}.` : ''}`, paid.length ? `Record them with: cappz-market call marketplace.stage.pay --input '{"contractId":"${c.contractId}","milestone":${stage.index},"txHashes":[${paid.map((h) => `"${h}"`).join(',')}]}'` : `If the wallet lacks ${assetLabel(c.total.currency)}: ${fundingSummary(need)}`);
        }
      }
      const e = c.ledgerEscrows.find((x) => x.milestone === stage.index);
      if (!e) return commitAndReport(mk, await M.buildRelease(mk.state, mk.actor(), c.contractId, stage.index), { accepted: done, stage: c.milestones[stage.index].label, next: stage.index + 1 < c.milestones.length ? `Fund the next stage: cappz-market fund ${c.contractId}` : `Done. Review the seller: cappz-market review ${c.contractId} --rating 5 --text "…"` });
      const box = await boxKey();
      const secret = (await recallSecret(c.contractId, stage.index)) ?? (e.sealedSecret ? (await openWith<{ secret: string }>(box.privateKey, e.sealedSecret as unknown as SealedBox).catch(() => null))?.secret : null);
      if (!secret) throw new ToolError('The escrow secret for this stage is not on this computer.', 'Release it where it was funded (the web app or the computer that ran fund).');
      const { w, net } = await signingWallet(mk);
      const finishes = [e.sequence, ...e.feeEscrows.map((f) => f.sequence)].map((q) => prepareEscrowFinish(w.classicAddress, w.classicAddress, q, e.condition, secret));
      const approvals: string[] = [];
      const lts = await signAndSubmitAll(seedSigner(w.seed!), finishes, net, undefined, await approvedSigning(net, c.contractId, stage.index, approvals, undefined, await requestHookFor(mk)));
      const txs = await M.buildSettleOnLedger(mk.state, mk.actor(), c.contractId, stage.index, lts[0], mk.policy, lts.slice(1));
      return commitAndReport(mk, txs, { accepted: done, stage: c.milestones[stage.index].label, ledgerTxs: lts.map((x) => x.hash), approvedIntents: approvals, next: stage.index + 1 < c.milestones.length ? `Fund the next stage: cappz-market fund ${c.contractId}` : `Done. Review the seller: cappz-market review ${c.contractId} --rating 5 --text "…"` });
    },
  },
  {
    name: 'claim',
    summary: 'Buyer of a metered deal: sign a payment-channel claim for the units used so far (the total, not the increase) with your wallet key, off the ledger and free. Give the printed claim to the seller; they redeem it with cappz-market redeem.',
    params: [
      { name: 'contract', type: 'string', description: 'Contract id.', required: true, positional: true },
      { name: 'units', type: 'number', description: 'Total units used so far (up to the cap).', required: true },
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true);
      const c = contractOf(mk, str(a, 'contract'));
      if (c.buyerId !== mk.partyId) throw new ToolError('Only the buyer signs claims.');
      const ch = c.channel; if (!ch || ch.closed) throw new ToolError(ch ? 'The channel is closed.' : 'The channel is not open yet.', `Open it with: cappz-market fund ${c.contractId}`);
      const units = num(a, 'units');
      if (!(units > 0) || units > c.quantity) throw new ToolError(`Units are the total used so far: more than 0, at most the cap of ${c.quantity} ${c.unit}.`);
      const drops = BigInt(Math.round(units * Number(unitPriceDrops(c))));
      if (drops > BigInt(ch.capDrops)) throw new ToolError(`That is above the channel cap (${ch.capDrops} drops).`);
      if (drops <= BigInt(ch.releasedDrops)) throw new ToolError(`The seller already redeemed ${ch.unitsUsed} ${c.unit}; a claim is for the total used, so it must be more than that.`);
      const w = await requireWallet();
      if (w.publicKey.toUpperCase() !== ch.publicKey.toUpperCase()) throw new ToolError('This wallet’s key is not the channel’s claim key.', 'Sign claims on the computer (wallet) that opened the channel.');
      const signature = signChannelClaim(ch.channelId, drops, w.privateKey);
      if (!verifyChannelClaim(ch.channelId, drops, signature, ch.publicKey)) throw new ToolError('The claim did not verify against the channel key.');
      return { claim: { contractId: c.contractId, channelId: ch.channelId, balanceDrops: drops.toString(), units, signature, publicKey: ch.publicKey }, worth: formatMoney(Number(drops) / 1e6, 'XRP'), next: 'Give the claim JSON to the seller (any channel you both use). Nothing was submitted; later claims replace earlier ones.' };
    },
  },
  {
    name: 'redeem',
    summary: 'Seller of a metered deal: redeem the buyer’s latest claim on the ledger (PaymentChannelClaim), pay the fee on the increase from your account (a channel pays only you), and record both. --close also closes the channel, returning the unused rest to the buyer.',
    money: true,
    params: [
      { name: 'contract', type: 'string', description: 'Contract id.', required: true, positional: true },
      { name: 'claim', type: 'string', description: 'The claim JSON (or a file of it) the buyer printed with cappz-market claim.', required: true },
      { name: 'close', type: 'boolean', description: 'Close the channel in the same transaction.' },
    ],
    async run(a, o) {
      const mk = await loadMarket(o, true); guardMainnet(this, mk, o);
      const c = contractOf(mk, str(a, 'contract'));
      if (c.sellerId !== mk.partyId) throw new ToolError('Only the seller redeems claims.');
      const ch = c.channel; if (!ch || ch.closed) throw new ToolError(ch ? 'The channel is closed.' : 'The buyer has not opened the channel yet.');
      let claim: { channelId?: string; balanceDrops?: string; signature?: string };
      try { const v = a.claim; const text = typeof v === 'string' ? (v.trim().startsWith('{') ? v : await readFile(resolve(v), 'utf8')) : JSON.stringify(v); const j = JSON.parse(text) as { claim?: typeof claim } & typeof claim; claim = j.claim ?? j; }
      catch { throw new ToolError('--claim must be the JSON (or a file of it) that cappz-market claim printed.'); }
      if (!claim?.signature || !claim.balanceDrops || String(claim.channelId ?? '').toUpperCase() !== ch.channelId.toUpperCase()) throw new ToolError('--claim must be the JSON cappz-market claim printed for this contract’s channel.');
      const balance = BigInt(claim.balanceDrops);
      if (!verifyChannelClaim(ch.channelId, balance, claim.signature, ch.publicKey)) throw new ToolError('The claim signature is not the buyer’s claim for that amount on this channel.');
      if (balance <= BigInt(ch.releasedDrops)) throw new ToolError(`Nothing new: ${ch.releasedDrops} drops are already redeemed.`);
      const { w, net } = await signingWallet(mk);
      const seller = mk.state.parties.get(c.sellerId)?.xrplAccount;
      if (seller !== w.classicAddress) throw new ToolError(`Your profile’s XRPL account is ${seller ?? 'missing'}, but this wallet is ${w.classicAddress}.`);
      const approvals: string[] = [];
      const claimLt = await signAndSubmit(seedSigner(w.seed!), prepareChannelClaim(w.classicAddress, ch.channelId, balance, claim.signature, ch.publicKey, !!a.close), net, await approvedSigning(net, c.contractId, 0, approvals, undefined, await requestHookFor(mk)));
      // The fee legs are plain Payments from the seller to the collection account or DARC recipients (not counterparty money), checked on the ledger when recorded.
      const fees = prepareChannelFeePayments(c, w.classicAddress, BigInt(ch.releasedDrops), balance, net);
      const paid: string[] = [];
      try {
        const feeLts = await signAndSubmitAll(seedSigner(w.seed!), fees.map((f) => f.tx), net, (_n, lt) => paid.push(lt.hash));
        const txs = await M.buildChannelSettle(mk.state, mk.actor(), c.contractId, mk.policy, claimLt, feeLts);
        await mk.commit(txs);
        const recorded = txs.map((t) => t.eventType);
        if (a.close) { const m2 = await loadMarket(o, true); const ct = await M.buildCloseChannel(m2.state, m2.actor(), c.contractId, m2.policy, claimLt); await m2.commit(ct); recorded.push(...ct.map((t) => t.eventType)); }
        return { ok: true, market: mk.mode, recorded, redeemed: formatMoney(Number(balance - BigInt(ch.releasedDrops)) / 1e6, 'XRP'), feeLegs: fees.map((f) => `${f.units} drops → ${f.label}`), ledgerTxs: [claimLt.hash, ...feeLts.map((x) => x.hash)], approvedIntents: approvals, next: a.close ? `Done. Review the buyer: cappz-market review ${c.contractId} --rating 5 --text "…"` : `Redeem later claims the same way; close when done: cappz-market close ${c.contractId}` };
      } catch (e) {
        throw new ToolError(`${(e as Error).message} Redeemed on the ledger: ${claimLt.hash}${paid.length ? `; fee payments: ${paid.join(', ')}` : ''}.`, `Pay any missing fee leg, then record: cappz-market call marketplace.channel.settle --input '{"contractId":"${c.contractId}","txHash":"${claimLt.hash}","feeTxHashes":[${paid.map((h) => `"${h}"`).join(',')}]}'`);
      }
    },
  },
  {
    name: 'close',
    summary: 'Either party of a metered deal: close the payment channel on the ledger and record it; the unused rest returns to the buyer. The seller’s close is immediate; the buyer’s takes effect after the settle delay (or at once after the channel expires) — run it again then.',
    money: true,
    params: [{ name: 'contract', type: 'string', description: 'Contract id.', required: true, positional: true }],
    async run(a, o) {
      const mk = await loadMarket(o, true); guardMainnet(this, mk, o);
      const c = contractOf(mk, str(a, 'contract'));
      if (mk.partyId !== c.buyerId && mk.partyId !== c.sellerId) throw new ToolError('Only the buyer or seller closes the channel.');
      const ch = c.channel; if (!ch || ch.closed) throw new ToolError(ch ? 'The channel is already closed.' : 'The channel is not open.');
      const { w, net } = await signingWallet(mk);
      const approvals: string[] = [];
      const lt = await signAndSubmit(seedSigner(w.seed!), prepareChannelClose(w.classicAddress, ch.channelId), net, await approvedSigning(net, c.contractId, 0, approvals, undefined, await requestHookFor(mk)));
      if (payChannelNode(lt, ch.channelId)?.kind !== 'DeletedNode') return { ok: true, closing: true, ledgerTx: lt.hash, approvedIntents: approvals, note: `The ledger scheduled the close: the seller has the settle delay (${ch.settleDelay ?? '?'} s) to redeem the last claim.`, next: `Run cappz-market close ${c.contractId} again after that, or record a later close with: cappz-market call marketplace.channel.close --input '{"contractId":"${c.contractId}","txHash":"<hash>"}'` };
      return commitAndReport(mk, await M.buildCloseChannel(mk.state, mk.actor(), c.contractId, mk.policy, lt), { ledgerTx: lt.hash, approvedIntents: approvals, next: `Review the other side: cappz-market review ${c.contractId} --rating 5 --text "…"` });
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
    name: 'check',
    summary: 'Before you pay or fund escrow: CAPPZ checks the other side (can the address receive, how old is it, its marketplace record and mandate, can you afford it) and returns ok / warn / stop with reasons, signed. Costs 0.01 XRP from your wallet.',
    money: true,
    params: [
      { name: 'target', type: 'string', description: 'The XRPL address (r…) you will pay, or a marketplace party id (p-…).', required: true, positional: true },
      { name: 'amount', type: 'number', description: 'What you intend to send (in XRP, or in --currency): also checks you can afford it with escrow reserves.' },
      { name: 'legs', type: 'number', description: 'Escrow legs the payment will use (default 1).' },
      { name: 'currency', type: 'string', description: 'CAPPZ or USD-tokenZ/1 (RLUSD): also checks both trust lines, the issuer\'s freeze and authorization settings, and whether the token can be escrowed.' },
    ],
    async run(a, o) {
      const d = await getDiscovery(); const svc = d.services?.counterpartyCheck;
      if (!svc) throw new ToolError(`${marketUrl()} does not offer a counterparty check.`);
      const net = marketNetwork(o);
      if (!svc.networks.includes(net)) throw new ToolError(`The counterparty check runs on ${svc.networks.join(' and ')}, not ${net}.`);
      const w = await requireWallet(); const target = str(a, 'target');
      const cur = a.currency !== undefined ? currencyOf(a) : 'XRP';
      const input = { ...(target.startsWith('r') ? { address: target } : { party: target }), payer: w.classicAddress, ...(a.amount !== undefined ? (cur === 'XRP' ? { amountXrp: num(a, 'amount') } : { currency: cur, amount: num(a, 'amount') }) : cur !== 'XRP' ? { currency: cur } : {}), ...(a.legs !== undefined ? { escrowLegs: num(a, 'legs') } : {}) };
      const out = join(homeDir(), 'checks');
      const r = await commandOf('hire')!.run({ url: `${svc.url}/${net}`, input: JSON.stringify(input), max: svc.priceXrp, out, timeout: 3 }, o) as { results?: Array<{ file: string; verified: boolean }>; payments?: string[]; paid?: string; next?: string };
      const file = r.results?.[0]?.file;
      if (!file) return { checked: false, ...r };
      const signed = JSON.parse(await readFile(file, 'utf8')) as SignedCheck;
      const signatureOk = verifyCheck(signed, svc.publicKey);
      const rep = signed.report;
      return {
        verdict: rep.verdict, reasons: rep.reasons, subject: rep.subject, network: rep.network,
        signedByCappz: signatureOk, hashMatched: r.results?.[0]?.verified ?? false, paid: r.paid, report: file,
        next: !signatureOk ? 'Do not rely on this report: its signature does not match the published CAPPZ key.' : rep.verdict === 'stop' ? 'Do not pay: fix or ask about the stop reasons first.' : rep.verdict === 'warn' ? 'Paying is possible; weigh the warnings (or ask the person you act for).' : 'OK to proceed.',
      };
    },
  },
  {
    name: 'evaluate',
    summary: 'Before you accept or pay a stage: CAPPZ checks the delivered file against the milestone’s agreed acceptance criteria and returns a signed pass / fail / needs-human verdict. The file goes to the evaluator only (not the public log) and is not kept. Costs 0.05 XRP from your wallet. The contract’s named evaluator can accept on a pass with --accept.',
    money: true,
    params: [
      { name: 'contract', type: 'string', description: 'Contract id.', required: true, positional: true },
      { name: 'file', type: 'string', description: 'The delivered file (its SHA-256 must be the seller’s published evidence).', required: true },
      { name: 'milestone', type: 'number', description: 'Stage index (default: the stage with new evidence).' },
      { ...ACCEPTANCE_PARAM, description: 'Only when the contract has no agreed criteria for the stage: your own (the verdict says they came from you).' },
      { name: 'accept', type: 'boolean', description: 'You are the contract’s named evaluator: on a pass with the agreed criteria, accept the stage citing the verdict (the buyer still pays).' },
    ],
    async run(a, o) {
      const svc = (await getDiscovery()).services?.stageEvaluator;
      if (!svc) throw new ToolError(`${marketUrl()} does not offer a stage evaluator.`);
      const net = marketNetwork(o);
      if (!svc.networks.includes(net)) throw new ToolError(`The stage evaluator runs on ${svc.networks.join(' and ')}, not ${net}.`);
      const bytes = new Uint8Array(await readFile(str(a, 'file')));
      const acceptance = await acceptanceArg(a);
      const base = `${svc.url}/${net}/${svc.path}`;
      const body = JSON.stringify({ input: { contractId: str(a, 'contract'), ...(a.milestone !== undefined ? { milestone: num(a, 'milestone') } : {}), ...(acceptance ? { acceptance } : {}) }, file: Buffer.from(bytes).toString('base64') });
      const res = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      const opened = await res.json().catch(() => ({})) as { job?: { jobId: string }; error?: string; notes?: string[] };
      if (!res.ok || !opened.job) throw new ToolError(`The evaluator refused: ${opened.error ?? res.status}. Nothing was charged.`);
      const r = await commandOf('hire')!.run({ url: base, job: opened.job.jobId, max: svc.priceXrp, out: join(homeDir(), 'verdicts'), timeout: 3 }, o) as { results?: Array<{ file: string; verified: boolean }>; paid?: string; next?: string };
      const file = r.results?.[0]?.file;
      if (!file) return { evaluated: false, ...r };
      const signed = JSON.parse(await readFile(file, 'utf8')) as SignedVerdict;
      const signedByCappz = verifyVerdict(signed, svc.publicKey);
      const v = signed.verdict;
      const out: Record<string, unknown> = { verdict: v.verdict.state, reasons: v.verdict.reasons, criteria: v.criteria.source, results: v.results.map((x) => ({ id: x.id, state: x.state, judgedBy: x.judgedBy, detail: x.detail })), evidenceMatched: v.evidence.matched, signedByCappz, hashMatched: r.results?.[0]?.verified ?? false, paid: r.paid, verdictFile: file, notes: opened.notes ?? [] };
      if (!signedByCappz) return { ...out, next: 'Do not rely on this verdict: its signature does not match the published CAPPZ key.' };
      if (a.accept) {
        if (v.verdict.state !== 'pass') return { ...out, accepted: false, next: v.verdict.state === 'fail' ? 'Not accepted. Tell the seller what failed, or the buyer may dispute.' : 'Not accepted: a person must check the open criteria.' };
        return { ...out, ...(await commandOf('accept')!.run({ contract: v.contractId, verdict: file }, o) as Record<string, unknown>) };
      }
      return { ...out, next: v.verdict.state === 'pass' ? `Criteria met. Buyer: cappz-market release ${v.contractId} (or the named evaluator: cappz-market accept ${v.contractId} --verdict ${file})` : v.verdict.state === 'fail' ? 'Criteria not met: ask the seller to fix and deliver again, or dispute.' : 'A person must check the open criteria before accepting.' };
    },
  },
  {
    name: 'draft',
    summary: 'Describe what you sell or need in your own words; CAPPZ returns a checked draft and the exact sell or ask command to run (nothing is published). Costs 0.02 XRP from your wallet.',
    money: true,
    params: [
      { name: 'text', type: 'string', description: 'What you sell or need, in plain words (price, quantity and dates only if you know them).', required: true, positional: true },
      { name: 'wanted', type: 'boolean', description: 'Draft a request (ask) instead of a listing (sell).' },
      { name: 'region', type: 'string', description: 'Your two-letter state code, if not in the text.' },
    ],
    async run(a, o) {
      const svc = (await getDiscovery()).services?.listingDrafter;
      if (!svc) throw new ToolError(`${marketUrl()} does not offer a listing drafter.`);
      const net = marketNetwork(o);
      if (!svc.networks.includes(net)) throw new ToolError(`The listing drafter runs on ${svc.networks.join(' and ')}, not ${net}.`);
      const input = { text: str(a, 'text'), ...(a.wanted ? { intent: 'ask' } : {}), ...(a.region ? { region: checkRegion(str(a, 'region')) } : {}) };
      const r = await commandOf('hire')!.run({ url: `${svc.url}/${net}/${svc.path}`, input: JSON.stringify(input), max: svc.priceXrp, out: join(homeDir(), 'drafts'), timeout: 3 }, o) as { results?: Array<{ file: string; verified: boolean }>; paid?: string };
      const file = r.results?.[0]?.file;
      if (!file) return { drafted: false, ...r };
      const d = JSON.parse(await readFile(file, 'utf8')) as { draft: unknown; missing: string[]; questions: string[]; notes: string[]; command: string; argv: string[]; ready: boolean; model: string };
      return { draft: d.draft, ready: d.ready, missing: d.missing, questions: d.questions, notes: d.notes, command: d.command, paid: r.paid, hashMatched: r.results?.[0]?.verified ?? false, next: d.ready ? `Review it, then run: ${d.command}` : `Fill in ${d.missing.join(', ')} and run the command.` };
    },
  },
  {
    name: 'scout',
    summary: 'For a contract you sell on: which parts to subcontract, who on the market could do them (with reputation), and a ready subcontract command for each. Nothing is formed. Costs 0.05 XRP from your wallet.',
    money: true,
    params: [
      { name: 'contract', type: 'string', description: 'The contract you sell on.', required: true, positional: true },
      { name: 'budget', type: 'number', description: 'Most of what is left to subcontract, as a fraction (default 0.5).' },
      { name: 'need', type: 'string', description: 'What you want help with, in a sentence.' },
    ],
    async run(a, o) {
      const svc = (await getDiscovery()).services?.subcontractScout;
      if (!svc) throw new ToolError(`${marketUrl()} does not offer a subcontract scout.`);
      const net = marketNetwork(o);
      if (!svc.networks.includes(net)) throw new ToolError(`The subcontract scout runs on ${svc.networks.join(' and ')}, not ${net}.`);
      const input = { contractId: str(a, 'contract'), ...(a.budget !== undefined ? { budgetShare: num(a, 'budget') } : {}), ...(a.need ? { need: str(a, 'need') } : {}) };
      const r = await commandOf('hire')!.run({ url: `${svc.url}/${net}/${svc.path}`, input: JSON.stringify(input), max: svc.priceXrp, out: join(homeDir(), 'scouts'), timeout: 3 }, o) as { results?: Array<{ file: string; verified: boolean }>; paid?: string };
      const file = r.results?.[0]?.file;
      if (!file) return { scouted: false, ...r };
      const rep = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      return { ...rep, paid: r.paid, hashMatched: r.results?.[0]?.verified ?? false, report: file, next: 'Check a candidate (cappz-market check <party>), then run its subcontract command.' };
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
      // Sign each call with this party's declared key when there is one (the agent may check it against the market's profile).
      const ak = await agentKey(); const s = ak ? await session(false).catch(() => null) : null;
      const signer = ak && s ? { partyId: await partyIdForAccount(s.userId), declaration: ak.declaration, secretKeyHex: ak.secretKey } : null;
      const http = async (path: string, init?: RequestInit, raw = false) => {
        const signed = signer ? await signAgentRequest({ method: init?.method ?? 'GET', url: base + path, body: typeof init?.body === 'string' ? init.body : undefined }, signer) : {};
        const r = await fetch(base + path, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...signed } }); return { status: r.status, headers: r.headers, body: !raw && r.headers.get('content-type')?.includes('json') ? await r.json() : new Uint8Array(await r.arrayBuffer()) }; };
      const card = (await http('/agent')).body as { name: string; price: string; currency: string; issuer?: string | null; network: XrplNetwork; stages: unknown[] };
      const cardAsset = assetCodeOf(card.currency);
      if (!cardAsset || cardAsset === 'USD') throw new ToolError(`Unexpected currency ${card.currency}: paid agents are paid in XRP, CAPPZ or USD-tokenZ/1 (RLUSD) on the ledger.`);
      // An issued token must come from the issuer this market knows for it on that network — never from one the agent names.
      const knownToken = cardAsset === 'XRP' ? null : tokenSpecFor(cardAsset, card.network);
      if (knownToken && card.issuer && card.issuer !== knownToken.issuer) throw new ToolError(`${card.name} asks for ${assetLabel(cardAsset)} from issuer ${card.issuer}, not the known issuer ${knownToken.issuer}. Not paying.`);
      if (Number(card.price) > max) throw new ToolError(`${card.name} costs ${card.price} ${card.currency} per job; your max is ${max}.`, 'Raise --max if the person you act for agrees.');
      if (card.network === 'mainnet' && !o.yes) throw new ToolError(`${card.name} is paid in real ${card.currency} on mainnet.`, 'Confirm with the person you act for, then repeat with --yes.');
      const w = await requireWallet();
      if (!a.job && (a.input === undefined || a.input === '')) throw new ToolError('Give --input (the work), or --job to resume one.');
      const jobId = a.job ? String(a.job) : ((await http('/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: (() => { try { return JSON.parse(String(a.input)); } catch { return String(a.input); } })() }) })).body as { job: { jobId: string } }).job.jobId; let spent = 0; const results: Array<{ stage: number; file: string; sha256: string; verified: boolean }> = []; const paid: string[] = []; const paidStage = new Map<number, { hash: string; at: number }>();
      await mkdir(out, { recursive: true });
      const deadline = Date.now() + num(a, 'timeout', 15) * 60_000;
      for (;;) {
        const v = (await http(`/jobs/${jobId}`)).body as { job: { state: string; stages: Array<{ index: number; state: string; result: { hash: string } | null }> }; pay: { stage: number; amount: string; network: XrplNetwork; preparedTx: Record<string, unknown> } | null };
        for (const s of v.job.stages) {
          if (s.state !== 'released' || !s.result || results.some((r) => r.stage === s.index)) continue;
          const r = await http(`/jobs/${jobId}/stages/${s.index}/result`, undefined, true); // results are bytes, hashed as delivered
          const bytes = r.body as Uint8Array; const got = await sha256Bytes(bytes);
          const file = join(out, `${jobId}-stage-${s.index}`); await writeFile(file, bytes);
          results.push({ stage: s.index, file, sha256: got, verified: got === s.result.hash });
        }
        if (v.job.state === 'completed') return { job: jobId, agent: card.name, paid: `${spent} ${card.currency}`, payments: paid, results, allVerified: results.every((r) => r.verified) };
        if (v.job.state === 'failed') throw new ToolError(`The agent’s work failed on job ${jobId}.`, `Ask it to retry: POST ${base}/jobs/${jobId}/retry`);
        if (v.pay && paidStage.has(v.pay.stage)) {
          // Already paid on the ledger: never pay twice. Report the same transaction until the agent records it.
          const p = paidStage.get(v.pay.stage)!;
          if (Date.now() - p.at > 120_000) throw new ToolError(`Stage ${v.pay.stage} is paid on the ledger (${p.hash}) but ${card.name} has not recorded it yet.`, `Do not pay again. Report it later: POST ${base}/jobs/${jobId}/payments {"txHash":"${p.hash}"}, then cappz-market hire ${base} --job ${jobId} --max ${max - spent}`);
          await http(`/jobs/${jobId}/payments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash: p.hash }) });
          await new Promise((r) => setTimeout(r, 5_000));
          continue;
        }
        if (v.pay) {
          const amount = Number(v.pay.amount);
          if (spent + amount > max + 1e-9) throw new ToolError(`Stage ${v.pay.stage} asks ${amount}; paying it would pass your max of ${max} (spent ${spent}).`);
          const st = await walletStatus(w.classicAddress, v.pay.network);
          if (card.currency === 'XRP' && st.spendableXrp < amount + 0.001) throw new ToolError(`Need ${amount} XRP spendable, have ${st.spendableXrp}.`, v.pay.network === 'mainnet' ? `Send XRP to ${w.classicAddress}.` : 'cappz-market wallet --fund');
          const ptx = v.pay.preparedTx;
          if (ptx.TransactionType !== 'Payment' || ['SendMax', 'Paths', 'DeliverMin'].some((k) => ptx[k] !== undefined) || (Number(ptx.Flags ?? 0) & 0x00020000)) throw new ToolError(`${card.name} prepared a payment with paths, SendMax or partial-payment flags. Not paying.`);
          const amt = ptx.Amount as string | { currency: string; issuer: string; value: string };
          if (knownToken ? (typeof amt !== 'object' || amt.issuer !== knownToken.issuer || amt.currency.toUpperCase() !== knownToken.hex.toUpperCase() || Number(amt.value) !== amount) : (typeof amt !== 'string' || Number(amt) !== Math.round(amount * 1e6))) throw new ToolError(`${card.name} prepared a payment that is not ${amount} ${assetLabel(cardAsset)}${knownToken ? ` from issuer ${knownToken.issuer}` : ''}. Not paying.`);
          const lt = await signAndSubmit(seedSigner(w.seed!), { ...ptx, Account: w.classicAddress }, v.pay.network);
          await http(`/jobs/${jobId}/payments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash: lt.hash }) });
          spent += amount; paid.push(lt.hash); paidStage.set(v.pay.stage, { hash: lt.hash, at: Date.now() });
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
