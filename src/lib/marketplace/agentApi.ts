/**
 * COPE node crystallized. Node ID: v14-19-00-marketplace-agent-api.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * The marketplace as an API for autonomous agents and non-human companies
 * (NHCs). Every operation is a governed verb with a typed input schema; it
 * runs the same builders and rules as the UI, so an agent can do nothing a
 * person could not — and an agent party additionally needs an active
 * mandate (rules.checkMandate), with co-signature above its threshold.
 * Identity (agent party), governance (mandate) and settlement (escrow legs)
 * stay separate. The caller commits the returned TXs through the command bus.
 */
import type { MarketTx } from './ledger';
import type { MarketplaceVerb } from './marketplaceVerbs';
import * as M from './model';
import type { MarketState } from './replay';
import { matchDemand, matchSuppliers } from './matching';
import { searchMarket, type SearchKind } from './search';
import { runGlobalDiscovery, type ConceptWriter } from './globalDiscovery';
import { buildDeliverAccessKey, openPurchasedGraph, sellerContentKey } from './knowledge/access';
import { diagnose, indexGraph, searchGraph, walk } from './knowledge/query';
import { buildSecurityTransfer, buildSubscribe } from './securities';
import { PUBLIC_LOG_PARTITION } from './publicLog';
import { resolveSettlementPolicy, type SettlementPolicy } from './settlement';
import type { Lacuna } from '../lacuna/types';
import type { LedgerTx } from '../xrpl/ledgerCheck';

/** What the caller's runtime provides for operations that need more than replayed state. Keys never leave the caller's process. */
export interface AgentDeps { policy?: SettlementPolicy; lacuna?: Lacuna | null; research?: ConceptWriter | null; fetchLedgerTx?: (network: SettlementPolicy['network'], hash: string) => Promise<LedgerTx>; boxPrivateKey?: JsonWebKey }

type Field = { type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'; description: string; required?: boolean };
export interface AgentOperation { verb: MarketplaceVerb | 'marketplace.match.suppliers' | 'marketplace.match.demand' | 'marketplace.state.read' | 'marketplace.search' | 'marketplace.discovery.global' | 'marketplace.knowledge.query'; summary: string; input: Record<string, Field>; writes: boolean }

const s = (description: string, required = true): Field => ({ type: 'string', description, required });
const n = (description: string, required = true): Field => ({ type: 'number', description, required });
const o = (description: string, required = true): Field => ({ type: 'object', description, required });

export const AGENT_OPERATIONS: AgentOperation[] = [
  { verb: 'marketplace.state.read', summary: 'Read open listings, open requests, your contracts (each with the fee terms it formed with), token balances and the fee schedule in force.', input: {}, writes: false },
  { verb: 'marketplace.match.suppliers', summary: 'Rank suppliers (listings and capable parties) for a request, with reasons.', input: { requestId: s('Request id') }, writes: false },
  { verb: 'marketplace.match.demand', summary: 'Rank open requests your party could fill, with reasons.', input: {}, writes: false },
  { verb: 'marketplace.search', summary: 'Ranked search over listings, requests, parties and tokens (synonyms, typos, categories); each hit says which terms matched.', input: { query: s('What to look for'), kinds: { type: 'array', description: 'listing | request | party | token', required: false } }, writes: false },
  { verb: 'marketplace.discovery.global', summary: 'Global whitespace: existing offerings worldwide (from your research function, labelled agent-reported) plus CAPPZ listings (verified), voids found by lacuna. Needs deps.lacuna; deps.research optional.', input: { interests: s('The space to explore'), region: s('Region to emphasize', false) }, writes: false },
  { verb: 'marketplace.knowledge.query', summary: 'Open a purchased knowledge graph with your box key (deps.boxPrivateKey, used in your process only), verify its Merkle root, then search / walk / diagnose.', input: { contractId: s('Contract for the graph license'), symptoms: { type: 'array', description: 'Observed symptoms (diagnose)', required: false }, query: s('Search text', false), nodeId: s('Walk from this node', false), depth: n('Walk depth ≤ 3', false) }, writes: false },
  { verb: 'marketplace.party.profile', summary: 'Create or update your party profile (kind agent requires a principal or governance address).', input: { profile: o('PartyProfile') }, writes: true },
  { verb: 'marketplace.listing.publish', summary: 'Publish or amend a listing.', input: { listing: o('ListingContent') }, writes: true },
  { verb: 'marketplace.order.place', summary: 'Buy from a listing; forms a contract.', input: { listingId: s('Listing id'), quantity: n('Quantity in the listing unit') }, writes: true },
  { verb: 'marketplace.request.post', summary: 'Request supply, including crops that do not exist yet (allowNewPlanting).', input: { request: o('SupplyRequestContent') }, writes: true },
  { verb: 'marketplace.offer.submit', summary: 'Bid on a request (with a production plan for new plantings).', input: { offer: o('SupplyOfferContent') }, writes: true },
  { verb: 'marketplace.offer.award', summary: 'Award a bid (all or part).', input: { requestId: s('Request id'), offerId: s('Offer id'), quantity: n('Quantity to award', false) }, writes: true },
  { verb: 'marketplace.escrow.fund', summary: 'USD contracts: record a payment reference. XRP contracts: pass the validated EscrowCreate hashes (one per leg — the seller net and each fee recipient — all under the milestone condition, prepared with settlement.prepareMilestoneEscrows); they are read from the ledger (deps.fetchLedgerTx) and must match amount, accounts, condition and memo.', input: { contractId: s('Contract id'), amount: n('USD: amount to fund', false), reference: s('USD: payment reference', false), escrows: { type: 'array', description: 'XRP: [{ milestone, txHash, condition }]', required: false } }, writes: true },
  { verb: 'marketplace.escrow.ledger-settle', summary: 'Record a validated EscrowFinish (release) or EscrowCancel (refund) for an XRP milestone; every fee leg escrow must be finished (or cancelled) too.', input: { contractId: s('Contract id'), milestone: n('Milestone index'), txHash: s('EscrowFinish / EscrowCancel hash for the seller leg'), feeTxHashes: { type: 'array', description: 'EscrowFinish / EscrowCancel hashes for the fee legs', required: false } }, writes: true },
  { verb: 'marketplace.access.deliver', summary: 'Seller of a knowledge graph: seal its content key to the buyer (uses deps.boxPrivateKey locally).', input: { contractId: s('Contract id') }, writes: true },
  { verb: 'marketplace.milestone.evidence', summary: 'Submit milestone evidence by sha256 hash.', input: { contractId: s('Contract id'), milestone: n('Milestone index'), kind: s('photo | document | inspection | sensor | delivery-receipt'), hash: s('sha256 hex of the evidence file'), note: s('Note', false) }, writes: true },
  { verb: 'marketplace.milestone.affirm', summary: 'Accept a milestone or delivery.', input: { contractId: s('Contract id'), milestone: n('Milestone index') }, writes: true },
  { verb: 'marketplace.escrow.release', summary: 'Release escrow for an accepted milestone.', input: { contractId: s('Contract id'), milestone: n('Milestone index') }, writes: true },
  { verb: 'marketplace.token.transfer', summary: 'Transfer receipt tokens.', input: { tokenId: s('Token id'), to: s('Recipient party id'), amount: { type: 'integer', description: 'Whole tokens', required: true } }, writes: true },
  { verb: 'marketplace.security.subscribe', summary: 'Subscribe to an approved offering. Rule 506(c) requires your party (its principal) to be a verified accredited investor.', input: { offeringId: s('Offering id'), units: { type: 'integer', description: 'Whole units', required: true } }, writes: true },
  { verb: 'marketplace.security.transfer', summary: 'Transfer security units after lock-up to an eligible holder.', input: { offeringId: s('Offering id'), to: s('Recipient party id'), units: { type: 'integer', description: 'Whole units', required: true } }, writes: true },
];

export class AgentOperationError extends Error {}

/** Execute one operation as `actor`; reads return data, writes return the TXs to commit (nothing is written here). */
export async function executeAgentOperation(state: MarketState, actor: M.Actor, verb: AgentOperation['verb'], input: Record<string, unknown>, deps: AgentDeps = {}): Promise<{ data?: unknown; txs: MarketTx[] }> {
  const op = AGENT_OPERATIONS.find((x) => x.verb === verb);
  if (!op) throw new AgentOperationError(`Unknown or unsupported operation ${verb}.`);
  for (const [k, f] of Object.entries(op.input)) if (f.required && (input[k] === undefined || input[k] === null || input[k] === '')) throw new AgentOperationError(`${verb}: missing ${k} (${f.description}).`);
  const str = (k: string) => String(input[k]); const num = (k: string) => Number(input[k]);
  switch (verb) {
    case 'marketplace.state.read': return { data: {
      listings: state.listings.filter((l) => l.open), requests: state.requests.filter((r) => r.open),
      contracts: state.contracts.filter((c) => c.buyerId === actor.partyId || c.sellerId === actor.partyId),
      tokens: state.tokens.map((t) => ({ tokenId: t.content.tokenId, name: t.content.name, balance: t.balances[actor.partyId] ?? 0 })).filter((t) => t.balance > 0),
      mandates: state.mandates.filter((m) => m.agentPartyId === actor.partyId),
      fees: state.fees,
    }, txs: [] };
    case 'marketplace.match.suppliers': { const r = state.requests.find((x) => x.requestId === str('requestId')); if (!r) throw new AgentOperationError('Unknown request.'); return { data: matchSuppliers(state, r, actor.at), txs: [] }; }
    case 'marketplace.match.demand': { const p = state.parties.get(actor.partyId); if (!p) throw new AgentOperationError('Create a profile first.'); return { data: matchDemand(state, p, state.listings, actor.at), txs: [] }; }
    case 'marketplace.search': return { data: searchMarket(state, str('query'), Array.isArray(input.kinds) ? { kinds: input.kinds as SearchKind[] } : {}), txs: [] };
    case 'marketplace.discovery.global': return { data: await runGlobalDiscovery({ state, lacuna: deps.lacuna ?? null, interests: str('interests'), region: input.region ? str('region') : null, ranAt: actor.at, research: deps.research ?? null }), txs: [] };
    case 'marketplace.knowledge.query': {
      if (!deps.boxPrivateKey) throw new AgentOperationError('Provide deps.boxPrivateKey (your party’s box key) to open the graph.');
      const opened = await openPurchasedGraph(state, str('contractId'), deps.boxPrivateKey);
      const g = indexGraph(opened.bundle);
      return { data: { verified: opened.verified, problems: opened.problems, manifest: opened.manifest,
        ...(Array.isArray(input.symptoms) ? { diagnosis: diagnose(g, (input.symptoms as unknown[]).map(String)) } : {}),
        ...(input.query ? { hits: searchGraph(g, str('query')) } : {}),
        ...(input.nodeId ? { neighborhood: walk(g, str('nodeId'), input.depth === undefined ? 1 : num('depth')) } : {}) }, txs: [] };
    }
    case 'marketplace.escrow.ledger-settle': {
      if (!deps.fetchLedgerTx) throw new AgentOperationError('Provide deps.fetchLedgerTx to read the ledger.');
      const policy = deps.policy ?? resolveSettlementPolicy([]);
      const feeLts = await Promise.all(((input.feeTxHashes as unknown[] | undefined) ?? []).map((h) => deps.fetchLedgerTx!(policy.network, String(h))));
      return { txs: await M.buildSettleOnLedger(state, actor, str('contractId'), num('milestone'), await deps.fetchLedgerTx(policy.network, str('txHash')), policy, feeLts) };
    }
    case 'marketplace.access.deliver': {
      if (!deps.boxPrivateKey) throw new AgentOperationError('Provide deps.boxPrivateKey to open your graph key.');
      const c = state.contracts.find((x) => x.contractId === str('contractId'));
      if (!c || c.source.kind !== 'listing') throw new AgentOperationError('Unknown graph contract.');
      return { txs: await buildDeliverAccessKey(state, actor, c.contractId, await sellerContentKey(state, c.source.listingId, deps.boxPrivateKey)) };
    }
    case 'marketplace.security.subscribe': return { txs: await buildSubscribe(state, actor, str('offeringId'), num('units')) };
    case 'marketplace.security.transfer': return { txs: await buildSecurityTransfer(state, actor, str('offeringId'), str('to'), num('units')) };
    case 'marketplace.party.profile': return { txs: await M.buildProfile(state, actor, input.profile as never) };
    case 'marketplace.listing.publish': return { txs: await M.buildListing(state, actor, input.listing as never) };
    case 'marketplace.order.place': { const r = await M.buildOrder(state, actor, str('listingId'), num('quantity')); return { data: { contractId: r.contractId }, txs: r.txs }; }
    case 'marketplace.request.post': return { txs: await M.buildRequest(state, actor, input.request as never) };
    case 'marketplace.offer.submit': { const r = await M.buildOffer(state, actor, input.offer as never); return { data: { warnings: r.warnings }, txs: r.txs }; }
    case 'marketplace.offer.award': { const r = await M.buildAward(state, actor, str('requestId'), str('offerId'), input.quantity === undefined ? undefined : num('quantity')); return { data: { contractId: r.contractId }, txs: r.txs }; }
    case 'marketplace.escrow.fund': {
      if (Array.isArray(input.escrows)) {
        if (!deps.fetchLedgerTx) throw new AgentOperationError('Provide deps.fetchLedgerTx to read the ledger.');
        const policy = deps.policy ?? resolveSettlementPolicy([]);
        const checks = await Promise.all((input.escrows as Array<{ milestone: number; txHash: string; condition: string }>).map(async (e) => ({ milestone: Number(e.milestone), condition: String(e.condition), lt: await deps.fetchLedgerTx!(policy.network, String(e.txHash)) })));
        return { txs: await M.buildFundOnLedger(state, actor, str('contractId'), policy, checks) };
      }
      if (!input.reference || input.amount === undefined) throw new AgentOperationError('USD funding needs amount and reference; XRP funding needs escrows.');
      return { txs: await M.buildFund(state, actor, str('contractId'), num('amount'), { rail: 'usd-reference', reference: str('reference') }) };
    }
    case 'marketplace.milestone.evidence': return { txs: await M.buildEvidence(state, actor, str('contractId'), num('milestone'), { kind: str('kind') as never, hash: str('hash'), note: input.note ? str('note') : '' }) };
    case 'marketplace.milestone.affirm': return { txs: await M.buildAffirm(state, actor, str('contractId'), num('milestone')) };
    case 'marketplace.escrow.release': return { txs: await M.buildRelease(state, actor, str('contractId'), num('milestone')) };
    case 'marketplace.token.transfer': return { txs: await M.buildTokenTransfer(state, actor, str('tokenId'), str('to'), num('amount')) };
    default: throw new AgentOperationError(`${verb} is not exposed to agents in this release.`);
  }
}

/** Machine-readable description of the agent API (served to MCP/A2A clients and shown in the docs). */
export function agentApiManifest(policy?: SettlementPolicy) {
  return { name: 'cappz-marketplace', version: '1.2.0', sharedLog: `Writes return TXs; commit them by publishing to the shared public log (publicLog.publishToPublicLog: partition ${PUBLIC_LOG_PARTITION} on the hosted mirror, as a signed-in account, one insert per command; the mirror attributes the author and role-checks operator entries), then to your wallet. Read the market with publicLog.pullPublicLog + attributePublicLog.`, network: `xrpl-${policy?.network ?? 'testnet'}`, deps: 'Some operations need runtime dependencies (AgentDeps): lacuna, a research function, a ledger reader, your box key. They run in your process; keys are never sent.', governance: 'Agent parties act only within an active mandate (PermissionGranted at parties/{id}/mandates/{mandateId}); writes are governed verbs.', operations: AGENT_OPERATIONS };
}
