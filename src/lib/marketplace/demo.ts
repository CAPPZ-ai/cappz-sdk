/**
 * COPE node crystallized. Node ID: v14-19-00-marketplace-demo.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * Synthetic demo market and guided scenarios (fictional parties, labelled as
 * such). Everything is produced by the real builders against replayed state,
 * so the demo obeys exactly the rules a live market does; in demo mode the
 * TXs stay in the browser session and are never written to a wallet.
 */
import type { MarketTx, MarketTxLike } from './ledger';
import * as M from './model';
import { resolveMarket, type MarketState } from './replay';
import { defaultMilestones } from './rules';
import type { ListingContent, PartyProfile, SupplyOfferContent, SupplyRequestContent } from './types';
import { generateBoxKeyPair } from '../crypto/sealedBox';
import { buildPublishGraph, buildRegisterBoxKey } from './knowledge/access';
import type { PhytoBundle } from './knowledge/graph';
import tomatoBlight from './knowledge/examples/tomato-blight.bundle.json';
import { buildApproveOffering, buildAttestEligibility, buildDeclareOffering } from './securities';
import { resolveSettlementPolicy } from './settlement';
import { operatorAddress } from './MarketplacePaths';
import { buildFeeSchedule, type FeeSchedule } from './fees';

export const DEMO_YOU = 'you';
const usd = (amount: number) => ({ amount, currency: 'USD' as const });
const iso = (base: string, days: number) => new Date(Date.parse(base) + days * 86_400_000).toISOString();
const d10 = (base: string, days: number) => iso(base, days).slice(0, 10);
export const demoHash = (s: string) => Array.from(s.padEnd(64, '0').slice(0, 64), (ch) => (ch.charCodeAt(0) % 16).toString(16)).join('');

type P = Omit<PartyProfile, 'capabilities' | 'about'> & { cats: string[]; canPlantNew?: boolean; acres?: number; about?: string; equipment?: string[]; selfGoverned?: boolean };
const PARTIES: P[] = [
  { partyId: DEMO_YOU, kind: 'person', name: 'You (demo)', roles: ['buyer', 'seller'], region: 'IA', cats: [], xrplAccount: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe' },
  { partyId: 'prairie-creek', kind: 'organization', name: 'Prairie Creek Farms', roles: ['farmer', 'seller'], region: 'IA', cats: ['crops/grains', 'crops/specialty'], canPlantNew: true, acres: 640, xrplAccount: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh' },
  { partyId: 'blue-ridge-herbs', kind: 'organization', name: 'Blue Ridge Herb Co.', roles: ['farmer', 'seller', 'processor'], region: 'NC', cats: ['crops/specialty'], canPlantNew: true, acres: 40 },
  { partyId: 'cascade-flowers', kind: 'organization', name: 'Cascade Cut Flowers', roles: ['farmer', 'seller'], region: 'OR', cats: ['crops/specialty', 'crops/produce'], canPlantNew: true, acres: 25 },
  { partyId: 'hill-country-lavender', kind: 'organization', name: 'Hill Country Lavender', roles: ['farmer', 'seller', 'processor'], region: 'TX', cats: ['crops/specialty'], canPlantNew: true, acres: 18 },
  { partyId: 'north-star-grain', kind: 'organization', name: 'North Star Grain', roles: ['farmer', 'seller'], region: 'MN', cats: ['crops/grains', 'land'], canPlantNew: true, acres: 2200 },
  { partyId: 'heartland-equipment', kind: 'organization', name: 'Heartland Equipment', roles: ['equipment-dealer', 'seller'], region: 'IL', cats: ['equipment'], equipment: ['tractors', 'planters', 'combines'] },
  { partyId: 'jones-custom', kind: 'person', name: 'Jones Custom Harvesting', roles: ['service-provider'], region: 'NE', cats: ['services'], equipment: ['2 combines', 'grain cart'] },
  { partyId: 'greenleaf-inputs', kind: 'organization', name: 'Greenleaf Seed & Inputs', roles: ['supplier', 'seller'], region: 'IA', cats: ['inputs'] },
  { partyId: 'maison-aroma', kind: 'organization', name: 'Maison Arôma Perfumers', roles: ['buyer'], region: 'NY', cats: [] },
  { partyId: 'harvest-table', kind: 'organization', name: 'Harvest Table Restaurant Group', roles: ['buyer'], region: 'IL', cats: [] },
  { partyId: 'agent-petalbot', kind: 'agent', name: 'PetalBot Procurement (autonomous agent)', roles: ['buyer'], region: 'CA', cats: [], about: 'A non-human company that sources edible and cut flowers for subscription boxes.', selfGoverned: true },
  { partyId: 'agentco', kind: 'agent', name: 'AgentCo (a company with no employees)', roles: ['service-provider', 'seller'], region: 'IA', cats: ['agents'], about: 'Five AI agents — sales, operations, compliance, treasury — run daily fund reconciliation for banks, each from its own wallet copy. Watch it work at /replicator/agentco (synthetic demo party).', selfGoverned: true },
  { partyId: 'prairie-relay-coop', kind: 'organization', name: 'Prairie Co-op Relay', roles: ['service-provider'], region: 'IA', cats: ['relay'], about: 'A farm co-op that runs an edge node so members and their buyers can replicate through bank and corporate firewalls (synthetic demo party).' },
  { partyId: 'agent-fieldops', kind: 'agent', name: 'FieldOps Autonomous Custom Hire', roles: ['service-provider'], region: 'KS', cats: ['services', 'equipment'], about: 'An agent-run fleet of autonomous sprayers and drones.' },
  { partyId: 'valley-processing', kind: 'organization', name: 'Valley Drying & Distilling', roles: ['service-provider', 'processor'], region: 'WI', cats: ['services'] },
  { partyId: 'phytograph-labs', kind: 'organization', name: 'PhytoGraph Labs', roles: ['seller', 'service-provider'], region: 'CA', cats: ['digital', 'services'], about: 'Curated plant-health knowledge graphs: symptoms, conditions, treatments, with provenance and confidence on every edge (synthetic demo party).' },
];
export const DEMO_GRAPH_LISTING = 'l-graph-tomato-blight';
export const DEMO_OFFERING = 'sec-prairie-lavender';

const L = (id: string, seller: string, categoryId: string, kind: ListingContent['kind'], title: string, unit: string, price: number, quantity: number, region: string, leadDays: number, attributes: Record<string, string> = {}): ListingContent => ({
  listingId: id, sellerId: seller, categoryId, kind, title, description: title, unit, pricePerUnit: usd(price), quantity, region, delivery: kind === 'service' ? 'on-site' : 'ship', leadDays, attributes,
});
const LISTINGS: ListingContent[] = [
  L('l-corn-ia', 'prairie-creek', 'crops/grains', 'sale', 'Yellow corn #2, 15% moisture', 'bu', 4.1, 20000, 'IA', 7),
  L('l-soy-ia', 'prairie-creek', 'crops/grains', 'sale', 'Food-grade soybeans', 'bu', 10.6, 6000, 'IA', 7),
  L('l-wheat-mn', 'north-star-grain', 'crops/grains', 'sale', 'Hard red spring wheat', 'bu', 6.2, 15000, 'MN', 10),
  L('l-barley-mn', 'north-star-grain', 'crops/grains', 'production-contract', 'Malting barley — contract 2027 crop', 'bu', 5.4, 30000, 'MN', 300),
  L('l-basil-nc', 'blue-ridge-herbs', 'crops/specialty', 'sale', 'Fresh holy basil (tulsi), weekly', 'lb', 9.5, 400, 'NC', 3, { variety: 'Ocimum tenuiflorum' }),
  L('l-chamomile-nc', 'blue-ridge-herbs', 'crops/specialty', 'sale', 'Dried German chamomile flowers', 'lb', 18, 300, 'NC', 5),
  L('l-dahlia-or', 'cascade-flowers', 'crops/specialty', 'sale', 'Heirloom dahlias, mixed', 'stems', 1.6, 5000, 'OR', 2),
  L('l-peony-or', 'cascade-flowers', 'crops/specialty', 'production-contract', 'Peonies — grow to order', 'stems', 2.4, 8000, 'OR', 240),
  L('l-lav-tx', 'hill-country-lavender', 'crops/specialty', 'sale', 'Dried lavender buds (Grosso)', 'lb', 22, 150, 'TX', 5, { variety: 'Lavandula × intermedia Grosso' }),
  L('l-lavoil-tx', 'hill-country-lavender', 'crops/specialty', 'sale', 'Lavender essential oil', 'kg', 180, 12, 'TX', 5),
  L('l-tomato-or', 'cascade-flowers', 'crops/produce', 'sale', 'Heirloom tomatoes', 'cases', 32, 200, 'OR', 2),
  L('l-tractor-il', 'heartland-equipment', 'equipment', 'sale', 'Used 100 hp utility tractor (2016, 2,400 h)', 'each', 48000, 2, 'IL', 14, { make: 'utility 100 hp', year: '2016', hours: '2400' }),
  L('l-planter-rent-il', 'heartland-equipment', 'equipment', 'rent', '16-row planter rental', 'day', 650, 30, 'IL', 3),
  L('l-transplanter-il', 'heartland-equipment', 'equipment', 'rent', 'Plug transplanter (herbs, flowers) rental', 'day', 220, 20, 'IL', 5),
  L('l-dryer-wi', 'valley-processing', 'services', 'service', 'Low-heat herb & flower drying', 'lb', 1.2, 20000, 'WI', 7),
  L('l-distill-wi', 'valley-processing', 'services', 'service', 'Steam distillation (essential oils)', 'job', 900, 25, 'WI', 10),
  L('l-harvest-ne', 'jones-custom', 'services', 'service', 'Custom combining — corn & soybeans', 'acre', 38, 4000, 'NE', 14),
  L('l-trucking-ne', 'jones-custom', 'services', 'service', 'Grain trucking', 'mile', 4.5, 10000, 'NE', 3),
  L('l-drone-ks', 'agent-fieldops', 'services', 'service', 'Autonomous drone spraying', 'acre', 14, 20000, 'KS', 5),
  L('l-plugs-ia', 'greenleaf-inputs', 'inputs', 'sale', 'Lavender plugs (Grosso), 72-cell trays', 'tray', 64, 400, 'IA', 10),
  L('l-seedcorn-ia', 'greenleaf-inputs', 'inputs', 'sale', 'Seed corn, 80k bag', 'bag', 285, 600, 'IA', 7),
  L('l-compost-ia', 'greenleaf-inputs', 'inputs', 'sale', 'OMRI-listed compost', 'ton', 48, 800, 'IA', 5),
  L('l-agentco-recon', 'agentco', 'agents', 'service', 'Daily fund NAV reconciliation — break report, notarized, by five AI agents', 'job', 25, 5000, 'IA', 1, { runtime: 'AgentCo node (own edge node)', payment: 'per job, milestone on delivery' }),
  L('l-relay-ia', 'prairie-relay-coop', 'relay', 'service', 'Relay node for copies behind firewalls (WebTransport, WebSocket, HTTPS)', 'month', 6, 200, 'IA', 1, { endpoint: 'https://relay.prairie-coop.example/cpz1', carriers: 'WebTransport, WebSocket, HTTPS stream, long-poll', ask: '0 CAPPZ per MB for members' }),
  L('l-bins-mn', 'north-star-grain', 'land', 'rent', 'On-farm bin space', 'bu-month', 0.05, 200000, 'MN', 1),
  L('l-lease-mn', 'north-star-grain', 'land', 'rent', 'Cropland lease, 160 ac', 'acre-year', 245, 160, 'MN', 30),
];

const R = (id: string, buyer: string, categoryId: string, title: string, quantity: number, unit: string, maxPrice: number | null, region: string, neededInDays: number, now: string, extra: Partial<SupplyRequestContent> = {}): SupplyRequestContent => ({
  requestId: id, buyerId: buyer, categoryId, title, description: title, quantity, unit, maxPricePerUnit: maxPrice === null ? null : usd(maxPrice), neededBy: d10(now, neededInDays), region,
  deliveryRadiusMiles: null, allowNewPlanting: false, contractType: 'spot', attributes: {}, ...extra,
});

export interface DemoMarket { txs: MarketTxLike[]; state: MarketState }

/** Apply builders in order, replaying state between steps (the demo is small, so full replay is fine). */
export class DemoRunner {
  txs: MarketTxLike[] = [];
  state: MarketState = resolveMarket([]);
  private clock: number;
  /** Demo box private keys, in session memory only (live keys are sealed in each person's wallet). */
  readonly boxKeys = new Map<string, JsonWebKey>();
  constructor(start: string) { this.clock = Date.parse(start); }
  async registerBoxKey(partyId: string) { const pair = await generateBoxKeyPair(); this.boxKeys.set(partyId, pair.privateKey); this.apply(await buildRegisterBoxKey(this.state, this.as(partyId, 1), pair.publicKey, { encryption: 'demo-session-memory' })); }
  /** Advance demo time and return an Actor for a party. */
  as(partyId: string, advanceMinutes = 5, coSignedBy?: string): M.Actor { this.clock += advanceMinutes * 60_000; return { partyId, at: new Date(this.clock).toISOString(), ...(coSignedBy ? { coSignedBy } : {}) }; }
  now() { return new Date(this.clock).toISOString(); }
  apply(txs: MarketTx[]) { const at = new Date(this.clock).toISOString(); for (const t of txs) this.txs.push({ ...t, timestamp: at }); this.state = resolveMarket(this.txs); return txs; }
}

export const DEMO_FEE_SCHEDULE: Omit<FeeSchedule, 'sheetId'> = {
  marketplace: { percent: { enabled: true, bps: 100 }, flat: { enabled: false, amounts: {} }, perRecord: { enabled: true, amounts: { USD: 0.01, XRP: 0.00001 } } },
  securities: { percent: { enabled: true, bps: 100 }, flat: { enabled: false, amounts: {} }, perRecord: { enabled: false, amounts: {} } },
  recipients: [{ account: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', label: 'Demo treasury', bps: 7_000 }, { account: 'rrrrrrrrrrrrrrrrrrrrBZbvji', label: 'Demo operator', bps: 3_000 }],
  note: 'Demo assumption: 1% of value plus 1¢ (0.00001 XRP) per ledger record for deals, 1% for placements. Not CAPPZ prices; an administrator publishes the real schedule.',
};

export async function seedDemoMarket(start: string): Promise<DemoRunner> {
  const run = new DemoRunner(start);
  for (const p of PARTIES) {
    const principal = p.kind === 'agent' ? (p.selfGoverned ? { governanceAddress: `m/44'/144'/0'/cappz/operational/marketplace/parties/${p.partyId}/governance` } : { partyId: 'jones-custom' }) : undefined;
    const profile: PartyProfile = { partyId: p.partyId, kind: p.kind, name: p.name, roles: p.roles, region: p.region, about: p.about ?? `${p.name} (synthetic demo party).`, capabilities: { categories: p.cats, canPlantNew: !!p.canPlantNew, ...(p.acres ? { acres: p.acres } : {}), ...(p.equipment ? { equipment: p.equipment } : {}) }, ...(principal ? { principal } : {}), ...(p.kind === 'agent' ? { runtime: 'demo agent runtime' } : {}), ...(p.xrplAccount ? { xrplAccount: p.xrplAccount } : {}) };
    run.apply(await M.buildProfile(run.state, run.as(p.partyId, 1), profile));
  }
  // Demo fee schedule — labelled assumptions, not CAPPZ prices — so every demo deal shows the buyer's price, the
  // seller's fees and net. Recipients are the XRPL "account zero/one" placeholders: nothing is ever paid to them in demo.
  run.apply(await buildFeeSchedule(operatorAddress('demo-admin'), run.as('demo-admin', 1).at, { ...DEMO_FEE_SCHEDULE }));
  // The non-human company governs itself; the agent fleet answers to its human owner.
  run.apply((await M.buildMandate(run.state, run.as('agent-petalbot'), 'agent-petalbot', { verbs: ['marketplace.request.post', 'marketplace.offer.award', 'marketplace.escrow.fund', 'marketplace.order.place'], categories: ['crops/specialty'], maxPerContract: usd(8000), maxPerDay: usd(20000), approvalAbove: usd(5000), expiresAt: iso(start, 365) })).txs);
  run.apply((await M.buildMandate(run.state, run.as('agentco'), 'agentco', { verbs: ['marketplace.listing.publish', 'marketplace.offer.submit'], categories: ['agents'], maxPerContract: usd(25000), maxPerDay: usd(50000), approvalAbove: usd(10000), expiresAt: iso(start, 365) })).txs);
  run.apply((await M.buildMandate(run.state, run.as('jones-custom'), 'agent-fieldops', { verbs: ['marketplace.listing.publish', 'marketplace.offer.submit'], categories: ['services', 'equipment'], maxPerContract: usd(50000), maxPerDay: usd(100000), approvalAbove: null, expiresAt: iso(start, 365) })).txs);
  for (const l of LISTINGS) run.apply(await M.buildListing(run.state, run.as(l.sellerId, 2), l));
  await run.registerBoxKey('phytograph-labs'); await run.registerBoxKey(DEMO_YOU);
  run.apply(await buildPublishGraph(run.state, run.as('phytograph-labs', 2), { listingId: DEMO_GRAPH_LISTING, sellerId: 'phytograph-labs', kind: 'sale', title: 'Tomato early-blight knowledge graph (license)', description: 'Symptoms, conditions, causes and treatments for early blight in tomato, with confidence and provenance on every edge. Search it, walk it, and run a diagnosis from what you see in the field — all in your browser after purchase.', pricePerUnit: usd(49), quantity: 1000, region: 'CA', delivery: 'ship', leadDays: 1, attributes: { crops: 'tomato', topics: 'early blight, alternaria, chlorosis, fungicide, sanitation' } }, tomatoBlight as unknown as PhytoBundle));
  // A security offering (testnet rehearsal) with you verified as an accredited investor, so the securities path can be tried.
  const op = operatorAddress('demo-compliance');
  run.apply(await buildDeclareOffering(run.state, run.as('prairie-creek', 5), { offeringId: DEMO_OFFERING, issuerId: 'prairie-creek', exemption: 'reg-d-506c', name: 'Prairie Creek lavender expansion — profit units', description: 'Each unit receives a share of 20% of net lavender profit for five years. Synthetic demo offering; nothing of value is offered.', units: 500, pricePerUnit: usd(100), minUnits: 5, lockupDays: 365, documents: [{ kind: 'offering memorandum', hash: demoHash('ppm') }, { kind: 'subscription agreement', hash: demoHash('sub-agreement') }], issuerAccount: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh' }));
  run.apply(await buildApproveOffering(run.state, op, run.as(DEMO_YOU, 60).at, DEMO_OFFERING, resolveSettlementPolicy(run.txs), 'Demo review: documents present; testnet rehearsal.'));
  run.apply(await buildAttestEligibility(run.state, op, null, run.as(DEMO_YOU, 5).at, { partyId: DEMO_YOU, status: 'accredited-verified', method: 'third-party-letter', evidenceHash: demoHash('cpa-letter'), expiresAt: iso(run.now(), 90) }));
  const now = run.now();
  const requests: SupplyRequestContent[] = [
    R('r-saffron', 'maison-aroma', 'crops/specialty', 'Saffron threads, ISO 3632 grade I', 2, 'kg', 9000, 'NY', 300, now, { allowNewPlanting: true, contractType: 'production-contract', attributes: { variety: 'Crocus sativus', form: 'dried threads' } }),
    R('r-rose', 'maison-aroma', 'crops/specialty', 'Damask rose petals for absolute', 1200, 'lb', 14, 'NY', 260, now, { allowNewPlanting: true, contractType: 'production-contract' }),
    R('r-tulsi', 'harvest-table', 'crops/specialty', 'Fresh holy basil, weekly for 12 weeks', 60, 'lb', 11, 'IL', 30, now, { recurring: { every: 'week', count: 12 } }),
    R('r-edible', 'agent-petalbot', 'crops/specialty', 'Edible flower mix (violas, nasturtium, borage)', 3000, 'stems', 0.9, 'CA', 120, now, { allowNewPlanting: true, contractType: 'production-contract' }),
    R('r-microgreens', 'harvest-table', 'crops/produce', 'Microgreens, chef mix', 40, 'cases', 45, 'IL', 21, now),
    R('r-hops', 'harvest-table', 'crops/specialty', 'Cascade hops, whole cone', 500, 'lb', 12, 'IL', 280, now, { allowNewPlanting: true, contractType: 'production-contract' }),
    R('r-sorghum', 'maison-aroma', 'crops/grains', 'Sweet sorghum syrup base', 2000, 'lb', 2.2, 'NY', 200, now, { allowNewPlanting: true, contractType: 'production-contract' }),
    R('r-transplant-svc', 'prairie-creek', 'services', 'Transplanting crew for 10 ac lavender', 10, 'acre', 400, 'IA', 40, now),
    R('r-flower-dryer', 'hill-country-lavender', 'equipment', 'Small flower dryer (used OK)', 1, 'each', 12000, 'TX', 60, now),
    R('r-pepper-ne', 'harvest-table', 'crops/produce', 'Shishito peppers', 80, 'cases', 38, 'IL', 90, now, { allowNewPlanting: true }),
  ];
  for (const r of requests) run.apply(await M.buildRequest(run.state, run.as(r.buyerId, 3), r));
  // A couple of bids, an award and a finished deal, so reputation and contracts are visible.
  const offer = (o: Omit<SupplyOfferContent, 'milestones' | 'message'> & { milestones?: SupplyOfferContent['milestones']; message?: string }, kind: 'spot' | 'production-contract'): SupplyOfferContent => ({ message: '', ...o, milestones: o.milestones ?? defaultMilestones(kind, now.slice(0, 10), o.deliveryDate, o.plan.plantingDate) });
  run.apply((await M.buildOffer(run.state, run.as('blue-ridge-herbs', 30), offer({ offerId: 'o-tulsi-br', requestId: 'r-tulsi', sellerId: 'blue-ridge-herbs', pricePerUnit: usd(10.2), quantity: 60, deliveryDate: d10(now, 21), plan: { newPlanting: false, notes: 'From existing beds; weekly cut.' } }, 'spot'))).txs);
  const tulsi = await M.buildAward(run.state, run.as('harvest-table', 60), 'r-tulsi', 'o-tulsi-br'); run.apply(tulsi.txs);
  run.apply(await M.buildFund(run.state, run.as('harvest-table', 10), tulsi.contractId, 612, { rail: 'demo' }));
  run.apply(await M.buildEvidence(run.state, run.as('blue-ridge-herbs', 60 * 24 * 7), tulsi.contractId, 0, { kind: 'delivery-receipt', hash: demoHash('tulsi-delivery-1'), note: 'Delivered to kitchen, signed receipt' }));
  run.apply(await M.buildAffirm(run.state, run.as('harvest-table', 60), tulsi.contractId, 0));
  run.apply(await M.buildRelease(run.state, run.as('harvest-table', 5), tulsi.contractId, 0));
  run.apply(await M.buildReview(run.state, run.as('harvest-table', 5), tulsi.contractId, 5, 'Fragrant, on time.'));
  run.apply(await M.buildReview(run.state, run.as('blue-ridge-herbs', 5), tulsi.contractId, 5, 'Clear specs, paid promptly.'));
  run.apply((await M.buildOffer(run.state, run.as('cascade-flowers', 40), offer({ offerId: 'o-edible-cf', requestId: 'r-edible', sellerId: 'cascade-flowers', pricePerUnit: usd(0.85), quantity: 3000, deliveryDate: d10(now, 110), plan: { newPlanting: true, plantingDate: d10(now, 14), acres: 0.5, notes: 'New bed of violas, nasturtium and borage.' } }, 'production-contract'))).txs);
  // A receipt token for stored grain.
  run.apply((await M.buildTokenize(run.state, run.as('north-star-grain', 20), { tokenId: 'tok-wheat-mn-1', assetKind: 'warehouse-receipt', categoryId: 'crops/grains', name: 'NSG wheat receipt, bin 4', description: 'Hard red spring wheat stored in bin 4, graded #1.', redeemsFor: { quantity: 1000, unit: 'bu' }, supply: 12, backing: { custodian: 'North Star Grain (bin 4)', region: 'MN', evidence: [{ kind: 'inspection', hash: demoHash('bin4-grade-cert'), note: 'Grade certificate' }] }, answers: { redeemableForSpecificAsset: true, profitFromOthersEfforts: false, fractionalEnterpriseOwnership: false }, issuerAccount: 'rDemoNorthStarGrainTestnetXXXXXX' })).txs);
  return run;
}

/** The guided “a crop that doesn't exist yet” scenario: a perfumer asks for lavender in Iowa; farmers bid, one by planting a new field. */
export interface DemoStep { title: string; explain: string; run: (r: DemoRunner) => Promise<void> }
export const LAVENDER_REQUEST_ID = 'r-lavender-ia';

/** One stage, start to finish, inside its 30-day hold: the buyer funds it, the farmer shows evidence, the buyer accepts and releases. */
async function completeStage(r: DemoRunner, contractId: string, m: number, kind: 'document' | 'photo' | 'delivery-receipt', note: string): Promise<void> {
  const c = r.state.contracts.find((x) => x.contractId === contractId)!;
  const prev = m === 0 ? c.formedAt.slice(0, 10) : c.milestones[m - 1].dueBy;
  const days = Math.min(25, Math.max(1, Math.round((Date.parse(c.milestones[m].dueBy) - Date.parse(prev)) / 86_400_000)));
  r.apply(await M.buildFund(r.state, r.as('maison-aroma', 30), contractId, M.currentStage(c)!.need, { rail: 'demo' }));
  r.apply(await M.buildEvidence(r.state, r.as('prairie-creek', 60 * 24 * days), contractId, m, { kind, hash: demoHash(`lav-${m}-${note}`), note }));
  r.apply(await M.buildAffirm(r.state, r.as('maison-aroma', 60), contractId, m));
  r.apply(await M.buildRelease(r.state, r.as('maison-aroma', 5), contractId, m));
}

export function lavenderScenario(): DemoStep[] {
  let contractId = '';
  const start = (r: DemoRunner) => r.now().slice(0, 10);
  return [
    { title: 'Post a request for a crop nobody grows here yet', explain: 'Maison Arôma needs 400 lb of dried Grosso lavender grown in the Midwest within 9 months. Nobody lists it, so they post a request and allow new plantings under a production contract.', run: async (r) => { r.apply(await M.buildRequest(r.state, r.as('maison-aroma'), R(LAVENDER_REQUEST_ID, 'maison-aroma', 'crops/specialty', 'Dried lavender buds, Grosso, grown in the Midwest', 400, 'lb', 26, 'IA', 270, r.now(), { allowNewPlanting: true, contractType: 'production-contract', deliveryRadiusMiles: 900, attributes: { variety: 'Lavandula × intermedia Grosso', form: 'dried buds', certification: 'none' } }))); } },
    { title: 'Farmers bid — including a new planting', explain: 'Matching invites farmers who can plant new crops. Prairie Creek bids to plant 1 acre in 3 weeks with a 4-step production schedule; Hill Country offers stock from Texas.', run: async (r) => {
      const now = r.now();
      r.apply((await M.buildOffer(r.state, r.as('prairie-creek', 60), { offerId: 'o-lav-pc', requestId: LAVENDER_REQUEST_ID, sellerId: 'prairie-creek', pricePerUnit: usd(24), quantity: 400, deliveryDate: d10(now, 250), plan: { newPlanting: true, plantingDate: d10(now, 21), acres: 1, expectedYieldPerUnitArea: 500, notes: 'Plugs from Greenleaf; drip irrigation; dry at Valley Drying.' }, milestones: defaultMilestones('production-contract', now.slice(0, 10), d10(now, 250), d10(now, 21)), message: 'Happy to grow this for you.' })).txs);
      r.apply((await M.buildOffer(r.state, r.as('hill-country-lavender', 30), { offerId: 'o-lav-hc', requestId: LAVENDER_REQUEST_ID, sellerId: 'hill-country-lavender', pricePerUnit: usd(25.5), quantity: 150, deliveryDate: d10(now, 10), plan: { newPlanting: false, notes: 'From this season’s stock.' }, milestones: defaultMilestones('spot', now.slice(0, 10), d10(now, 10)), message: '' })).txs);
    } },
    { title: 'Award the new planting', explain: 'The buyer compares price, delivery date, distance and reputation, and awards Prairie Creek. A contract forms with escrow stages of under 30 days: commitment, planting, the growing season in monthly stages, delivery.', run: async (r) => { const a = await M.buildAward(r.state, r.as('maison-aroma', 120), LAVENDER_REQUEST_ID, 'o-lav-pc'); contractId = a.contractId; r.apply(a.txs); } },
    { title: 'Fund and pay the commitment stage', explain: 'Holds are limited to a 30-day billing cycle, so the contract runs in stages of under 30 days. The buyer funds only the first stage; the farmer shows the plug purchase receipt; the buyer accepts and releases it so the farmer can buy inputs. Each next stage is configured and funded when the previous one completes.', run: async (r) => {
      await completeStage(r, contractId, 0, 'document', 'Invoice: 40 trays Grosso plugs');
    } },
    { title: 'Planting and the growing season, stage by stage', explain: 'Geo-tagged photos (by hash — the files stay with the farmer) release each stage as the crop grows; every stage is funded, shown and released within its 30-day hold.', run: async (r) => {
      const c = r.state.contracts.find((x) => x.contractId === contractId)!;
      for (let m = 1; m < c.milestones.length - 1; m++) await completeStage(r, contractId, m, 'photo', `Progress: ${c.milestones[m].label}`);
    } },
    { title: 'Harvest, delivery, release and reviews', explain: 'The dried lavender ships with a delivery receipt; the buyer funds the final stage, inspects and accepts, the last payment releases, and both sides review. The two-leg settlement is ready to prepare for XRPL testnet.', run: async (r) => {
      const c = r.state.contracts.find((x) => x.contractId === contractId)!;
      await completeStage(r, contractId, c.milestones.length - 1, 'delivery-receipt', '400 lb dried buds, moisture 9%');
      r.apply(await M.buildReview(r.state, r.as('maison-aroma', 5), contractId, 5, 'Beautiful first crop.'));
      r.apply(await M.buildReview(r.state, r.as('prairie-creek', 5), contractId, 5, 'Fair contract; paid at every step.'));
    } },
  ];
}
