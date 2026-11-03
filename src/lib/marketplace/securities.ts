/**
 * COPE node crystallized. Node ID: v15-00-01-marketplace-securities.
 * Provenance: m/44'/144'/100'/principles/cope/v1
 *
 * A compliance path for tokens that ARE securities (profit from others'
 * efforts, fractional ownership) — the ones the receipt classifier blocks.
 * It is a framework, not legal advice: nothing here makes an offering lawful;
 * it makes the controls an exemption requires enforceable and auditable.
 *
 *   1. Eligibility is an attestation by a marketplace compliance operator
 *      (PermissionGranted contentClass 'investor-eligibility'), with method,
 *      evidence hash and expiry; revocable. Self-certification is refused.
 *   2. An issuer declares an offering under an exemption, with its offering
 *      documents by hash. It cannot take subscriptions until an operator
 *      approves it (SecurityOfferingApproved) — and real-value approval needs
 *      the mainnet settlement policy (with its recorded acknowledgement);
 *      on testnet an approval is a rehearsal and says so.
 *   3. Reg D 506(c): accredited investors only, verified; subscriptions and
 *      transfers check eligibility at the time. Reg CF: CAPPZ is not a funding
 *      portal, so the offering is a pointer to the registered portal and
 *      subscriptions are refused here.
 *   4. The token is an XRPL MPT with RequireAuth (issuer authorizes each
 *      holder), CanLock and CanClawback (court orders, lost keys), CanTransfer
 *      but not CanTrade (no open DEX trading). Transfers check the lock-up and
 *      the recipient's eligibility before the issuer authorizes them.
 *   5. Placement fees (v15-14-00): a subscription copies the securities fee
 *      terms in force; the issuer pays the fee, routed to the DARC recipients,
 *      before allocation — validated XRPL payments for XRP offerings, a
 *      recorded reference for USD — written in the same batch as the
 *      allocation, so no unit is allocated with its fee unpaid.
 */
import { marketLedger, type MarketTx, type MarketTxLike } from './ledger';
import { MARKETPLACE_POW_ROOT, partyAddress } from './MarketplacePaths';
import { MarketRuleError } from './rules';
import type { MarketState } from './replay';
import type { Actor } from './model';
import type { Money } from './types';
import type { SettlementPolicy } from './settlement';
import { buildMemo } from './MarketplaceMemoValidator';
import { checkFeePayment, feeTermsFor, placementFeeQuote, type FeeQuote, type FeeTerms } from './fees';
import type { LedgerTx } from '../xrpl/ledgerCheck';
import type { RoyaltyLeg } from '../skills/royaltyRouting';

const fail = (msg: string): never => { throw new MarketRuleError(msg); };
const tx = (eventType: MarketTx['eventType'], sourceAddress: string, targetAddress: string, payload: Record<string, unknown>) => marketLedger.create({ eventType, sourceAddress, targetAddress, payload });
export const securityAddress = (offeringId: string) => `${MARKETPLACE_POW_ROOT}/securities/${offeringId}`;
export const eligibilityAddress = (partyId: string) => `${partyAddress(partyId)}/eligibility`;

export type Exemption = 'reg-d-506c' | 'reg-cf';
export const EXEMPTIONS: Record<Exemption, { label: string; summary: string; requiresEligibility: boolean; subscribeHere: boolean; defaultLockupDays: number; maxRaise: number | null }> = {
  'reg-d-506c': { label: 'Regulation D, Rule 506(c)', summary: 'General solicitation allowed; every purchaser must be an accredited investor whose status the issuer has taken reasonable steps to verify. Form D within 15 days of first sale. Securities are restricted (Rule 144 holding period).', requiresEligibility: true, subscribeHere: true, defaultLockupDays: 365, maxRaise: null },
  'reg-cf': { label: 'Regulation Crowdfunding', summary: 'Offered only through an SEC-registered funding portal or broker-dealer, with Form C disclosures and per-investor limits; capped at $5M in 12 months. CAPPZ lists the offering and links to the portal — subscriptions happen there.', requiresEligibility: false, subscribeHere: false, defaultLockupDays: 365, maxRaise: 5_000_000 },
};

export interface EligibilityAttestation { partyId: string; status: 'accredited-verified'; method: 'third-party-letter' | 'income-review' | 'net-worth-review' | 'registered-professional'; evidenceHash: string; expiresAt: string; by: string; at: string }

export interface SecurityOffering {
  offeringId: string; issuerId: string; exemption: Exemption; name: string; description: string;
  units: number; pricePerUnit: Money; minUnits: number; lockupDays: number;
  /** Offering documents (PPM / Form C / subscription agreement) by sha256; the files stay with the issuer. */
  documents: Array<{ kind: string; hash: string }>;
  portalUrl?: string; issuerAccount: string;
}
export interface OfferingView extends SecurityOffering {
  declaredAt: string;
  approval: null | { by: string; at: string; network: SettlementPolicy['network']; rehearsal: boolean; note: string };
  subscriptions: SubscriptionView[];
  holdings: Record<string, Array<{ units: number; since: string }>>;
  issued: number;
}

export interface SubscriptionView {
  subscriptionId: string; investorId: string; units: number; at: string; allocated: boolean;
  amount: Money;
  /** Securities fee terms copied when the investor subscribed (null = no fee). The issuer pays. */
  fees: FeeTerms | null;
  feeCharged: null | { feeUnits: number; currency: Money['currency']; settlement: 'validated' | 'by-reference'; owed: RoyaltyLeg[]; collector: { account: string; label: string } | null; reference?: string };
}

/** The placement fee on a subscription, from the terms it carries. */
export const subscriptionFee = (s: Pick<SubscriptionView, 'fees' | 'amount'>): FeeQuote => placementFeeQuote(s.fees, s.amount);

/** One Payment per fee leg from the issuer's account, memo naming the subscription — for the issuer's own wallet to sign. */
export function prepareSecurityFeePayments(o: Pick<SecurityOffering, 'issuerAccount'>, s: Pick<SubscriptionView, 'subscriptionId' | 'fees' | 'amount'>): Array<Record<string, unknown>> {
  const q = subscriptionFee(s);
  if (q.currency !== 'XRP') return [];
  return q.payLegs.filter((l) => l.units > 0).map((l) => ({ TransactionType: 'Payment', Account: o.issuerAccount, Destination: l.account, Amount: String(l.units), Memos: [buildMemo({ class: 'monetary', contractId: s.subscriptionId, deliveryIndex: 0, currency: 'XRP' })] }));
}

const NOW_OK = (iso: string, at: string) => Date.parse(iso) > Date.parse(at);

/** Active eligibility for a party at a time (latest attestation wins; revocations remove it). */
export function eligibilityOf(state: MarketState, partyId: string, at: string): EligibilityAttestation | null {
  const e = state.eligibility.get(partyId);
  return e && NOW_OK(e.expiresAt, at) ? e : null;
}

/** MPT issuance for a security: RequireAuth | CanLock | CanClawback | CanTransfer — no CanTrade, no CanEscrow. */
export const MPT_SECURITY_FLAGS = 0x02 | 0x04 | 0x20 | 0x40;
export function prepareSecurityIssuance(o: SecurityOffering, network: SettlementPolicy['network']): Record<string, unknown> {
  const meta = JSON.stringify({ t: o.name.slice(0, 40), ex: o.exemption, id: o.offeringId, lock: o.lockupDays, docs: o.documents.map((d) => d.hash.slice(0, 16)) });
  return { TransactionType: 'MPTokenIssuanceCreate', Account: o.issuerAccount, AssetScale: 0, MaximumAmount: String(o.units), Flags: MPT_SECURITY_FLAGS, MPTokenMetadata: Array.from(new TextEncoder().encode(meta), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase(), _network: network };
}
/** Issuer authorizes a holder (RequireAuth): MPTokenAuthorize with Holder. */
export const prepareHolderAuthorization = (issuerAccount: string, holderAccount: string, issuanceId = '<MPTokenIssuanceID>') => ({ TransactionType: 'MPTokenAuthorize', Account: issuerAccount, Holder: holderAccount, MPTokenIssuanceID: issuanceId });

// ─── Builders ─────────────────────────────────────────────────────

/** Compliance operator attests a party's eligibility. The bus restricts the verb to operators; self-attestation is refused here too. */
export async function buildAttestEligibility(state: MarketState, operatorAddress: string, operatorPartyId: string | null, at: string, a: Omit<EligibilityAttestation, 'by' | 'at'>): Promise<MarketTx[]> {
  if (!state.parties.has(a.partyId)) fail('Unknown party.');
  if (operatorPartyId && operatorPartyId === a.partyId) fail('Investors cannot attest their own eligibility.');
  if (!/^[0-9a-f]{64}$/.test(a.evidenceHash)) fail('Reference the verification evidence by its sha256 hash; the documents stay with the verifier.');
  if (!NOW_OK(a.expiresAt, at)) fail('The attestation must expire in the future.');
  if (Date.parse(a.expiresAt) - Date.parse(at) > 366 * 86_400_000) fail('Re-verify at least yearly: expiry must be within a year.');
  return [await tx('PermissionGranted', operatorAddress, eligibilityAddress(a.partyId), { contentClass: 'investor-eligibility', attestation: { ...a, by: operatorAddress, at } })];
}
export async function buildRevokeEligibility(state: MarketState, operatorAddress: string, partyId: string, reason: string): Promise<MarketTx[]> {
  if (!state.eligibility.has(partyId)) fail('No active attestation.');
  return [await tx('PermissionRevoked', operatorAddress, eligibilityAddress(partyId), { contentClass: 'investor-eligibility', partyId, reason })];
}

export async function buildDeclareOffering(state: MarketState, actor: Actor, o: SecurityOffering): Promise<MarketTx[]> {
  const p = state.parties.get(actor.partyId) ?? fail('Set up your marketplace profile first.');
  if (o.issuerId !== actor.partyId) fail('You can only declare offerings as yourself.');
  if (p.kind === 'agent') fail('An agent cannot issue securities; its accountable principal must.');
  if (state.offerings.some((x) => x.offeringId === o.offeringId)) fail('Offering already declared.');
  const ex = EXEMPTIONS[o.exemption] ?? fail('Choose an exemption.');
  if (!o.name.trim() || !(o.units > 0 && Number.isInteger(o.units)) || !(o.pricePerUnit.amount > 0)) fail('Name, whole-number units and a price are required.');
  if (ex.maxRaise !== null && o.units * o.pricePerUnit.amount > ex.maxRaise) fail(`${ex.label} is capped at $${ex.maxRaise.toLocaleString('en-US')} in 12 months.`);
  if (!o.documents.length || o.documents.some((d) => !/^[0-9a-f]{64}$/.test(d.hash))) fail('Attach the offering documents by sha256 hash (offering memorandum or Form C, subscription agreement).');
  if (o.exemption === 'reg-cf' && !/^https:\/\//.test(o.portalUrl ?? '')) fail('Regulation Crowdfunding offerings must link to the registered funding portal (https).');
  if (o.lockupDays < ex.defaultLockupDays) fail(`${ex.label}: lock-up must be at least ${ex.defaultLockupDays} days.`);
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(o.issuerAccount)) fail('Give the issuer’s XRPL classic address.');
  return [await tx('SecurityOfferingDeclared', partyAddress(actor.partyId), securityAddress(o.offeringId), { offering: o })];
}

/** Operator approval after compliance review. On testnet it is a rehearsal; real-value approval needs the mainnet policy. */
export async function buildApproveOffering(state: MarketState, operatorAddress: string, at: string, offeringId: string, policy: SettlementPolicy, note: string): Promise<MarketTx[]> {
  const o = state.offerings.find((x) => x.offeringId === offeringId) ?? fail('Unknown offering.');
  if (o.approval) fail('Already approved.');
  if (!note.trim()) fail('Record the review: who reviewed the documents and on what basis.');
  const rehearsal = policy.network !== 'mainnet';
  return [await tx('SecurityOfferingApproved', operatorAddress, securityAddress(offeringId), { offeringId, by: operatorAddress, at, network: policy.network, rehearsal, note, preparedIssuance: prepareSecurityIssuance(o, policy.network) })];
}

export async function buildSubscribe(state: MarketState, actor: Actor, offeringId: string, units: number): Promise<MarketTx[]> {
  const o = state.offerings.find((x) => x.offeringId === offeringId) ?? fail('Unknown offering.');
  const ex = EXEMPTIONS[o.exemption];
  if (!ex.subscribeHere) fail(`Subscriptions for this offering happen on its funding portal: ${o.portalUrl}`);
  if (!o.approval) fail('This offering has not been approved by compliance yet.');
  const p = state.parties.get(actor.partyId) ?? fail('Set up your marketplace profile first.');
  if (p.partyId === o.issuerId) fail('The issuer cannot subscribe to its own offering.');
  if (ex.requiresEligibility && !eligibilityOf(state, actor.partyId, actor.at)) fail('Only verified accredited investors can subscribe (Rule 506(c)). Ask a compliance operator to verify you.');
  if (!(Number.isInteger(units) && units >= o.minUnits)) fail(`Subscribe for at least ${o.minUnits} whole units.`);
  const committed = o.subscriptions.reduce((s, x) => s + x.units, 0);
  if (committed + units > o.units) fail(`Only ${o.units - committed} units remain.`);
  if (!p.xrplAccount) fail('Add your XRPL account to your profile: the issuer authorizes it to hold the token.');
  const subscriptionId = `${offeringId}-s${o.subscriptions.length + 1}`;
  const amount = { amount: units * o.pricePerUnit.amount, currency: o.pricePerUnit.currency };
  const fees = feeTermsFor(state.fees, 'securities');
  const q = placementFeeQuote(fees, amount);
  if (q.netUnits < 0) fail('The placement fee would exceed this subscription; subscribe for more units.');
  return [await tx('SecuritySubscribed', partyAddress(actor.partyId), `${securityAddress(offeringId)}/subscriptions/${subscriptionId}`, { offeringId, subscriptionId, investorId: actor.partyId, units, amount, fees, eligibilityAt: actor.at })];
}

/**
 * Issuer allocates a subscription (after receiving payment off-platform or via escrow) and authorizes the holder.
 * Eligibility is re-checked now. When the subscription carries a fee, the issuer's fee payment is checked first and
 * recorded with the allocation: XRP — one validated Payment per DARC leg; USD — the payment reference.
 */
export async function buildAllocate(state: MarketState, actor: Actor, offeringId: string, subscriptionId: string, paymentReference: string, feeProof: { lts?: LedgerTx[]; reference?: string; policy?: SettlementPolicy } = {}): Promise<MarketTx[]> {
  const o = state.offerings.find((x) => x.offeringId === offeringId) ?? fail('Unknown offering.');
  if (o.issuerId !== actor.partyId) fail('Only the issuer allocates.');
  const s = o.subscriptions.find((x) => x.subscriptionId === subscriptionId) ?? fail('Unknown subscription.');
  if (s.allocated) fail('Already allocated.');
  if (EXEMPTIONS[o.exemption].requiresEligibility && !eligibilityOf(state, s.investorId, actor.at)) fail('The investor’s accreditation has expired or was revoked; it must be re-verified before allocation.');
  if (!paymentReference.trim()) fail('Record the payment reference.');
  const holder = state.parties.get(s.investorId)!;
  const out: MarketTx[] = [];
  const q = subscriptionFee(s);
  if (q.feeUnits > 0) {
    const target = `${securityAddress(offeringId)}/subscriptions/${subscriptionId}/fee`;
    const base = { offeringId, subscriptionId, sheetId: s.fees?.sheetId ?? '', currency: q.currency, grossUnits: q.grossUnits, feeUnits: q.feeUnits, netUnits: q.netUnits, lines: q.lines, owed: q.legs, collector: s.fees?.collector ?? null, payer: o.issuerId };
    if (q.currency === 'XRP') {
      const network = feeProof.policy?.network ?? fail('Fee payments are checked against the settlement network; it was not given.');
      const legs = q.payLegs.filter((l) => l.units > 0).map((leg) => {
        const lt = (feeProof.lts ?? []).find((x) => x.destination === leg.account) ?? fail(`Pay the ${leg.label} fee leg (${leg.units} drops to ${leg.account}) before allocating.`);
        const problems = checkFeePayment(lt, { network, from: o.issuerAccount, leg, reference: subscriptionId });
        if (problems.length) fail(`${leg.label} fee leg: ${problems.join(' ')}`);
        return { ...leg, txHash: lt.hash, ledgerIndex: lt.ledgerIndex, checkedAt: lt.checkedAt };
      });
      out.push(await tx('FeeCharged', partyAddress(actor.partyId), target, { ...base, legs, settlement: 'validated', network }));
    } else {
      const reference = feeProof.reference?.trim() || fail(`Record the reference of the ${q.currency} fee payment before allocating.`);
      out.push(await tx('FeeCharged', partyAddress(actor.partyId), target, { ...base, legs: q.legs, settlement: 'by-reference', reference }));
    }
  }
  return [...out, await tx('SecurityAllocated', partyAddress(actor.partyId), securityAddress(offeringId), { offeringId, subscriptionId, investorId: s.investorId, units: s.units, paymentReference, preparedAuthorization: prepareHolderAuthorization(o.issuerAccount, holder.xrplAccount ?? '') })];
}

/** Holder-to-holder transfer: lock-up elapsed for those units, recipient eligible, issuer authorization prepared. */
export async function buildSecurityTransfer(state: MarketState, actor: Actor, offeringId: string, to: string, units: number): Promise<MarketTx[]> {
  const o = state.offerings.find((x) => x.offeringId === offeringId) ?? fail('Unknown offering.');
  const lots = o.holdings[actor.partyId] ?? [];
  const free = lots.filter((l) => Date.parse(l.since) + o.lockupDays * 86_400_000 <= Date.parse(actor.at)).reduce((s, l) => s + l.units, 0);
  const held = lots.reduce((s, l) => s + l.units, 0);
  if (!(Number.isInteger(units) && units > 0)) fail('Transfer whole units.');
  if (units > held) fail('Not enough units.');
  if (units > free) fail(`Only ${free} of your ${held} units are past the ${o.lockupDays}-day lock-up.`);
  const recipient = state.parties.get(to) ?? fail('Unknown recipient.');
  if (EXEMPTIONS[o.exemption].requiresEligibility && !eligibilityOf(state, to, actor.at)) fail('The recipient is not a verified accredited investor.');
  const recipientAccount = recipient.xrplAccount ?? fail('The recipient has no XRPL account on their profile.');
  return [await tx('SecurityTransferred', partyAddress(actor.partyId), securityAddress(offeringId), { offeringId, from: actor.partyId, to, units, preparedAuthorization: prepareHolderAuthorization(o.issuerAccount, recipientAccount) })];
}

// ─── Replay (called from replay.ts) ───────────────────────────────

export function applySecurityEvent(t: MarketTxLike, offerings: Map<string, OfferingView>, eligibility: Map<string, EligibilityAttestation>): void {
  const v = t.payload as Record<string, unknown>;
  switch (t.eventType) {
    case 'PermissionGranted': if (v.contentClass === 'investor-eligibility') { const a = v.attestation as EligibilityAttestation; eligibility.set(a.partyId, a); } break;
    case 'PermissionRevoked': if (v.contentClass === 'investor-eligibility') eligibility.delete(String(v.partyId)); break;
    case 'SecurityOfferingDeclared': { const o = v.offering as SecurityOffering; offerings.set(o.offeringId, { ...o, declaredAt: t.timestamp, approval: null, subscriptions: [], holdings: {}, issued: 0 }); break; }
    case 'SecurityOfferingApproved': { const o = offerings.get(String(v.offeringId)); if (o) o.approval = { by: String(v.by), at: t.timestamp, network: v.network as SettlementPolicy['network'], rehearsal: v.rehearsal === true, note: String(v.note ?? '') }; break; }
    case 'SecuritySubscribed': offerings.get(String(v.offeringId))?.subscriptions.push({ subscriptionId: String(v.subscriptionId), investorId: String(v.investorId), units: Number(v.units), at: t.timestamp, allocated: false, amount: v.amount as Money, fees: (v.fees as FeeTerms | undefined) ?? null, feeCharged: null }); break;
    case 'FeeCharged': { const s = v.subscriptionId ? offerings.get(String(v.offeringId))?.subscriptions.find((x) => x.subscriptionId === v.subscriptionId) : undefined; if (s) s.feeCharged = { feeUnits: Number(v.feeUnits), currency: v.currency as Money['currency'], settlement: v.settlement as 'validated' | 'by-reference', owed: (v.owed as RoyaltyLeg[] | undefined) ?? [], collector: (v.collector as { account: string; label: string } | null | undefined) ?? null, ...(v.reference ? { reference: String(v.reference) } : {}) }; break; }
    case 'SecurityAllocated': { const o = offerings.get(String(v.offeringId)); const s = o?.subscriptions.find((x) => x.subscriptionId === v.subscriptionId); if (o && s) { s.allocated = true; (o.holdings[s.investorId] ??= []).push({ units: s.units, since: t.timestamp }); o.issued += s.units; } break; }
    case 'SecurityTransferred': {
      const o = offerings.get(String(v.offeringId)); if (!o) break;
      let left = Number(v.units); const lots = o.holdings[String(v.from)] ?? [];
      // Oldest lots move first (they are the ones past lock-up); the recipient's holding period starts now.
      for (const l of lots) { const take = Math.min(l.units, left); l.units -= take; left -= take; if (!left) break; }
      o.holdings[String(v.from)] = lots.filter((l) => l.units > 0);
      (o.holdings[String(v.to)] ??= []).push({ units: Number(v.units), since: t.timestamp });
      break;
    }
  }
}
