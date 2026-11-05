// @vitest-environment node
/**
 * COPE node crystallized. Node ID: v15-31-00-subcontracts-test.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * Subcontracts (a seller hands part of a contract's work to another party as a
 * child contract, linked by ConstituentIncluded into the parent's HD slot) and
 * evaluators (a named third party who may accept milestones).
 */
import { describe, expect, it } from 'vitest';
import { DEMO_YOU, demoHash, seedDemoMarket, type DemoRunner } from '../lib/marketplace/demo';
import * as M from '../lib/marketplace/model';
import { resolveMarket } from '../lib/marketplace/replay';
import { marketLedger } from '../lib/marketplace/ledger';
import { partyAddress, subcontractAddress } from '../lib/marketplace/MarketplacePaths';
import { NO_FEES, buildFeeSchedule } from '../lib/marketplace/fees';
import { prepareStageEscrows } from '../lib/marketplace/settlement';
import { evaluateSigningIntent } from '../lib/marketplace/signingApproval';

const START = '2026-11-01T12:00:00.000Z';
const usd = (amount: number) => ({ amount, currency: 'USD' as const });
const SELLER = 'prairie-creek';
const view = (r: DemoRunner, id: string) => r.state.contracts.find((c) => c.contractId === id)!;

/** You buy 1000 bu of corn (4,100 USD, one delivery milestone) from Prairie Creek. */
async function usdParent(evaluatorId?: string) {
  const r = await seedDemoMarket(START);
  const o = await M.buildOrder(r.state, r.as(DEMO_YOU), 'l-corn-ia', 1000, undefined, evaluatorId); r.apply(o.txs);
  return { r, parentId: o.contractId };
}

const trucking = (over: Partial<M.SubcontractInput> = {}): M.SubcontractInput => ({ subcontractorId: 'jones-custom', title: 'Grain trucking to the buyer', quantity: 100, pricePerUnit: usd(4.5), serves: 0, ...over });

describe('subcontracts', () => {
  it('the seller subcontracts within the parent: one batch writes the child terms and the ConstituentIncluded link, replayed both ways', async () => {
    const { r, parentId } = await usdParent();
    const sub = await M.buildSubcontract(r.state, r.as(SELLER), parentId, trucking());
    expect(sub.txs.map((t) => t.eventType)).toEqual(['OrderPlaced', 'ConstituentIncluded']);
    const link = sub.txs[1];
    expect(link.sourceAddress).toBe(partyAddress(SELLER));
    expect(link.targetAddress).toBe(subcontractAddress(parentId, sub.contractId));
    expect(link.payload).toEqual(expect.objectContaining({ contentClass: 'subcontract', parentContractId: parentId, contractId: sub.contractId }));
    r.apply(sub.txs);
    const parent = view(r, parentId); const child = view(r, sub.contractId);
    expect(parent.subcontracts).toEqual([sub.contractId]);
    expect(parent.parentContractId).toBeUndefined();
    expect(child.parentContractId).toBe(parentId);
    expect(child.subcontracts).toEqual([]);
    // The parent's seller is the child's buyer; same asset; every stage names the parent milestone it serves and is due by it.
    expect(child).toEqual(expect.objectContaining({ buyerId: SELLER, sellerId: 'jones-custom', source: { kind: 'subcontract' }, categoryId: parent.categoryId }));
    expect(child.total).toEqual(usd(450));
    expect(child.milestones.every((m) => m.servesMilestone === 0 && m.dueBy <= parent.milestones[0].dueBy)).toBe(true);
    // Fees are charged on each contract: the child formed with the schedule in force, like any contract.
    expect(child.fees?.sheetId).toBe(parent.fees?.sheetId);
    expect(parent.because).toContain('open subcontract work');
    // Funding waits for the parent milestone, so the child says so instead of asking its buyer to fund.
    expect(child.nextAction.by).toBeNull();
    expect(child.nextAction.action).toContain('after the parent milestone');
  });

  it('refuses more than the parent’s remaining unreleased value, another asset, a non-seller, and a stage due after the parent milestone', async () => {
    const { r, parentId } = await usdParent();
    r.apply((await M.buildSubcontract(r.state, r.as(SELLER), parentId, trucking())).txs);
    // 4,100 total − 450 open = 3,650 left.
    await expect(M.buildSubcontract(r.state, r.as(SELLER), parentId, trucking({ quantity: 1, pricePerUnit: usd(3650.01) }))).rejects.toThrow(/exceeds what is left of the parent: 3650/);
    expect((await M.buildSubcontract(r.state, r.as(SELLER), parentId, trucking({ quantity: 1, pricePerUnit: usd(3650) }))).txs).toHaveLength(2);
    await expect(M.buildSubcontract(r.state, r.as(SELLER), parentId, trucking({ pricePerUnit: { amount: 1, currency: 'XRP' } }))).rejects.toThrow(/paid in the parent's asset/);
    await expect(M.buildSubcontract(r.state, r.as(DEMO_YOU), parentId, trucking())).rejects.toThrow(/Only the parent contract’s seller/);
    await expect(M.buildSubcontract(r.state, r.as('jones-custom'), parentId, trucking({ subcontractorId: 'valley-processing' }))).rejects.toThrow(/Only the parent contract’s seller/);
    await expect(M.buildSubcontract(r.state, r.as(SELLER), parentId, trucking({ serves: 3 }))).rejects.toThrow(/no milestone 3/);
    const late = { label: 'Late', share: 1, dueBy: '2027-06-01', evidence: 'x', delivery: true, servesMilestone: 0 };
    await expect(M.buildSubcontract(r.state, r.as(SELLER), parentId, trucking({ serves: undefined, milestones: [late] }))).rejects.toThrow(/after the parent milestone/);
  });

  it('an agent seller needs a mandate covering marketplace.contract.subcontract and the child’s value', async () => {
    const r = await seedDemoMarket(START);
    const o = await M.buildOrder(r.state, r.as(DEMO_YOU), 'l-agentco-recon', 10); r.apply(o.txs); // 250 USD
    const job = { subcontractorId: 'prairie-relay-coop', title: 'Relay capacity for the reconciliation runs', quantity: 1, pricePerUnit: usd(50), serves: 0 };
    await expect(M.buildSubcontract(r.state, r.as('agentco'), o.contractId, job)).rejects.toThrow(/No mandate allows marketplace\.contract\.subcontract/);
    r.apply((await M.buildMandate(r.state, r.as('agentco'), 'agentco', { verbs: ['marketplace.contract.subcontract'], categories: ['agents'], maxPerContract: usd(100), maxPerDay: usd(300), approvalAbove: null, expiresAt: '2027-11-01T00:00:00.000Z' })).txs);
    await expect(M.buildSubcontract(r.state, r.as('agentco'), o.contractId, { ...job, pricePerUnit: usd(150) })).rejects.toThrow(/per-contract limit/);
    const ok = await M.buildSubcontract(r.state, r.as('agentco'), o.contractId, job);
    expect(ok.txs[0].payload).toEqual(expect.objectContaining({ agentPartyId: 'agentco' }));
  });

  it('a child stage is funded only after the parent milestone it serves was released', async () => {
    const { r, parentId } = await usdParent();
    const sub = await M.buildSubcontract(r.state, r.as(SELLER), parentId, trucking()); r.apply(sub.txs);
    await expect(M.buildFund(r.state, r.as(SELLER), sub.contractId, 450, { rail: 'demo' })).rejects.toThrow(/funded after the parent milestone/);
    // Parent: fund, evidence, accept, release.
    r.apply(await M.buildFund(r.state, r.as(DEMO_YOU), parentId, 4100, { rail: 'demo' }));
    r.apply(await M.buildEvidence(r.state, r.as(SELLER), parentId, 0, { kind: 'delivery-receipt', hash: demoHash('corn'), note: '' }));
    r.apply(await M.buildAffirm(r.state, r.as(DEMO_YOU), parentId, 0));
    await expect(M.buildFund(r.state, r.as(SELLER), sub.contractId, 450, { rail: 'demo' })).rejects.toThrow(/funded after the parent milestone/);
    r.apply(await M.buildRelease(r.state, r.as(DEMO_YOU), parentId, 0));
    expect(view(r, sub.contractId).nextAction.by).toBe('buyer');
    r.apply(await M.buildFund(r.state, r.as(SELLER), sub.contractId, 450, { rail: 'demo' }));
    expect(view(r, sub.contractId).escrow.balance).toBe(450);
  });

  it('the signing-approval service refuses a child escrow before the parent milestone is released', async () => {
    const r = await seedDemoMarket(START);
    r.apply(await buildFeeSchedule('op', r.as('op', 1).at, { marketplace: NO_FEES, securities: NO_FEES, recipients: [], note: 'fees off' }));
    const accts = { [DEMO_YOU]: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', 'north-star-grain': 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', 'prairie-creek': 'rGWrZyQqhTp9Xu7G5Pkayo7bXjH4k4QYpf' };
    for (const [id, acct] of Object.entries(accts)) { const p = r.state.parties.get(id)!; r.apply(await M.buildProfile(r.state, r.as(id, 1), { ...p, xrplAccount: acct })); }
    r.apply(await M.buildListing(r.state, r.as('north-star-grain'), { listingId: 'l-xrp', sellerId: 'north-star-grain', categoryId: 'crops/grains', kind: 'sale', title: 'Wheat for XRP', description: 'x', unit: 'bu', pricePerUnit: { amount: 2, currency: 'XRP' }, quantity: 100, region: 'MN', delivery: 'ship', leadDays: 10, attributes: {} }));
    const o = await M.buildOrder(r.state, r.as(DEMO_YOU), 'l-xrp', 50); r.apply(o.txs);
    const sub = await M.buildSubcontract(r.state, r.as('north-star-grain'), o.contractId, { subcontractorId: 'prairie-creek', title: 'Cleaning', quantity: 10, pricePerUnit: { amount: 2, currency: 'XRP' }, serves: 0 }); r.apply(sub.txs);
    const child = view(r, sub.contractId);
    expect(child.rail ?? null).toBe(view(r, o.contractId).rail ?? null);
    const now = r.now();
    const [leg] = await prepareStageEscrows(child, 0, accts['north-star-grain'], accts['prairie-creek'], 'CD'.repeat(32), now);
    const d = await evaluateSigningIntent(r.state, { network: 'testnet', contractId: sub.contractId, milestone: 0, tx: { ...leg.tx, Fee: '12', Sequence: 42, LastLedgerSequence: 1000 } }, now);
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reasons.map((x) => x.code)).toEqual(['parent-not-released']);
  });

  it('a link from anyone but the parent’s seller, or into another slot, is not replayed', async () => {
    const { r, parentId } = await usdParent();
    const sub = await M.buildSubcontract(r.state, r.as(SELLER), parentId, trucking());
    const forged = await marketLedger.create({ eventType: 'ConstituentIncluded', sourceAddress: partyAddress(DEMO_YOU), targetAddress: subcontractAddress(parentId, sub.contractId), payload: { contentClass: 'subcontract', parentContractId: parentId, contractId: sub.contractId } });
    const wrongSlot = await marketLedger.create({ eventType: 'ConstituentIncluded', sourceAddress: partyAddress(SELLER), targetAddress: `${subcontractAddress(parentId, sub.contractId)}x`, payload: { contentClass: 'subcontract', parentContractId: parentId, contractId: sub.contractId } });
    r.apply([sub.txs[0], forged, wrongSlot]);
    expect(view(r, parentId).subcontracts).toEqual([]);
    expect(view(r, sub.contractId).parentContractId).toBeUndefined();
    // Unlinked, the subcontract fails closed: nothing funds it.
    await expect(M.buildFund(r.state, r.as(SELLER), sub.contractId, 450, { rail: 'demo' })).rejects.toThrow(/no replayed link/);
  });

  it('existing contracts replay unchanged: no parent, no subcontracts', async () => {
    const r = await seedDemoMarket(START);
    expect(r.state.contracts.length).toBeGreaterThan(0);
    for (const c of r.state.contracts) { expect(c.subcontracts).toEqual([]); expect(c.parentContractId).toBeUndefined(); expect(c.evaluatorId).toBeUndefined(); }
    expect(resolveMarket(r.txs).contracts.map((c) => [c.contractId, c.state, c.because, c.nextAction])).toEqual(r.state.contracts.map((c) => [c.contractId, c.state, c.because, c.nextAction]));
  });
});

describe('evaluators', () => {
  it('a named evaluator affirms a milestone; the buyer still pays, and the affirmation can be disputed', async () => {
    const { r, parentId } = await usdParent('valley-processing');
    expect(view(r, parentId).evaluatorId).toBe('valley-processing');
    r.apply(await M.buildFund(r.state, r.as(DEMO_YOU), parentId, 4100, { rail: 'demo' }));
    r.apply(await M.buildEvidence(r.state, r.as(SELLER), parentId, 0, { kind: 'delivery-receipt', hash: demoHash('corn'), note: '' }));
    await expect(M.buildAffirm(r.state, r.as('jones-custom'), parentId, 0)).rejects.toThrow(/buyer or the contract’s evaluator/);
    const t = await M.buildAffirm(r.state, r.as('valley-processing'), parentId, 0);
    expect(t[0].payload).toEqual(expect.objectContaining({ by: 'valley-processing', role: 'evaluator' }));
    r.apply(t);
    expect(view(r, parentId).milestoneStates[0].state).toBe('affirmed');
    expect(view(r, parentId).because).toContain('Evaluator valley-processing accepted');
    await expect(M.buildRelease(r.state, r.as('valley-processing'), parentId, 0)).rejects.toThrow(/Only the buyer releases/);
    r.apply(await M.buildDispute(r.state, r.as(DEMO_YOU), parentId, 0, 'Moisture above contract'));
    expect(view(r, parentId).milestoneStates[0].state).toBe('disputed');
    expect(view(r, parentId).nextAction.by).toBe('operator');
  });

  it('the seller cannot be the evaluator; an agent evaluator needs a mandate for marketplace.milestone.affirm; a forged evaluator role is ignored', async () => {
    const r0 = await seedDemoMarket(START);
    await expect(M.buildOrder(r0.state, r0.as(DEMO_YOU), 'l-corn-ia', 10, undefined, SELLER)).rejects.toThrow(/seller cannot be the evaluator/);
    const { r, parentId } = await usdParent('agent-fieldops');
    r.apply(await M.buildEvidence(r.state, r.as(SELLER), parentId, 0, { kind: 'delivery-receipt', hash: demoHash('corn'), note: '' }));
    await expect(M.buildAffirm(r.state, r.as('agent-fieldops'), parentId, 0)).rejects.toThrow(/No mandate allows marketplace\.milestone\.affirm/);
    const forged = await marketLedger.create({ eventType: 'DeliveryApproved', sourceAddress: partyAddress('jones-custom'), targetAddress: partyAddress('jones-custom'), payload: { contractId: parentId, milestone: 0, by: 'agent-fieldops', role: 'evaluator' } });
    r.apply([forged]);
    expect(view(r, parentId).milestoneStates[0].state).toBe('evidenced');
    r.apply((await M.buildMandate(r.state, r.as('jones-custom'), 'agent-fieldops', { verbs: ['marketplace.milestone.affirm'], categories: [], maxPerContract: usd(1), maxPerDay: usd(1), approvalAbove: null, expiresAt: '2027-11-01T00:00:00.000Z' })).txs);
    r.apply(await M.buildAffirm(r.state, r.as('agent-fieldops'), parentId, 0));
    expect(view(r, parentId).milestoneStates[0].state).toBe('affirmed');
  });
});
