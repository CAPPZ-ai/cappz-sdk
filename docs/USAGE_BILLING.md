# Usage billing and the subscription agent

For apps, services and agents sold through the CAPPZ marketplace and billed by use. Everything below is exported from `@cappz/sdk/paidAgent` and runs unchanged in the browser, Node 22+, Deno and the CAPPZ edge node. The code lives in `src/lib/treasury/funding/`.

CAPPZ takes care of identity, sign-in and security. The SDK supplies the billing rules. Your app supplies four small ports: storage, payment, notices and an exchange rate.

## Who is who

| Party | Role in billing |
|---|---|
| **User** | Pays from their *user app wallet* (UAW), one per app. |
| **App owner** | The ebb tenant. Publishes the app's plan and prices, and may sponsor its users from the app's POW treasury account. |
| **Content owners** | Talent. Paid per charge by the contract. |
| **Platform** | Paid per charge by the contract, plus the baseline fee per charged transaction. |

Each charge is split **only by the contract**, and every split line becomes a payable for the payer and a receivable for the payee. The tenant's receivables feed the royalty flywheel.

## 1. Describe the plan

```ts
import { quoteUsage, type AppUsagePlan } from '@cappz/sdk/paidAgent';

const plan: AppUsagePlan = {
  appRoot: "m/44'/144'/0'/cappz/apps/summarizer",
  tenant: 'rAppOwner…',
  contractId: 'contract-7',
  mode: 'subscription-overage',      // 'payg' | 'subscription' | 'subscription-overage' | 'sponsored'
  accepts: ['USD', 'XRP'],           // either or both
  prices: [{
    useCase: 'summaries', function: 'summarize', process: 'fees/fee-charging',
    unit: 'per-document', perUnit: { USD: 5, XRP: 80_000 }, validation: 'owner-set',
  }],
  subscription: { period: 'month', price: { USD: 900 }, included: { summarize: 200 } },
  baseFee: { amount: { USD: 1, XRP: 20_000 }, to: 'rPlatform…' },
};

quoteUsage(plan, 'summarize', 3, 'XRP', { events, rate });
// → { ok: true, chargedUnits, usage, baseFee, total, converted, validation }
```

- **Currencies.** Usage plans are priced in USD, XRP or both (`src/lib/treasury/funding/money.ts`). Marketplace deals and paid agents use the payment-asset registry instead (`src/lib/marketplace/paymentAssets.ts`: XRP, CAPPZ, USD-tokenZ/1 (RLUSD) or USD), where each asset is an equal option and nothing is converted.
- **Units.** Amounts are whole minor units: cents for USD, drops for XRP.
- **Conversion.** A price set in one currency is converted to the other only with a fresh `rate` (no older than 15 minutes). Without one, the quote is refused with `no-rate`; the SDK never guesses a rate.
- **Allowances.** Subscription allowances are counted from the `UsageRecorded` history in UTC periods. Plain `subscription` refuses usage beyond the allowance; `subscription-overage` charges for it.

### No price yet? Proposals, not prices

```ts
import { proposeDefaultPrices, applyOwnerDecisions, priceStatusLabel } from '@cappz/sdk/paidAgent';

const proposed = proposeDefaultPrices([{ useCase: 'summaries', function: 'summarize', process: 'fees/fee-charging', unit: 'per-document' }]);
priceStatusLabel(proposed[0]); // "Proposed default — not validated by the app owner. Not charged until …"
```

- **Not chargeable.** A proposed default is never charged: `quoteUsage` refuses it with `price-not-validated`.
- **Planning estimates.** Pass `estimate: true` to price a proposal for planning. The quote then reports `validation: 'proposed-default'`.
- **Becoming a price.** A proposal becomes a price when the owner records `PriceAcknowledged` or `PriceSet`; the newest decision wins (`applyOwnerDecisions`).

## 2. Keep wallets funded

```ts
import type { FundingRule } from '@cappz/sdk/paidAgent';

const rule: FundingRule = {
  ruleId: 'summarizer-usd', appRoot: plan.appRoot, appName: 'Summarizer', currency: 'USD',
  belowBalance: 500, belowRunwayHours: 48,   // either trigger
  target: 2000, minTopUp: 500,
  source: 'user-wallet',                      // or 'app-treasury' (sponsored)
  mode: 'confirm',                            // 'auto' | 'confirm' | 'command' | 'off'
  caps: { hour: 2000, day: 5000, week: 10000, month: 20000, overall: 100000 },
  autoApproveUpTo: 2000,
};
```

The four modes:

| Mode | What happens when the wallet runs low |
|---|---|
| `confirm` | A top-up is proposed. The person approves it with one click, such as a toast button. |
| `command` | A top-up is proposed. The person approves it by typing the command shown, for example `top up Summarizer $15.00`. |
| `auto` | The wallet is topped up within the caps, up to `autoApproveUpTo`. Larger amounts are proposed instead. |
| `off` | The person is warned only. |

Caps:
- **Windows.** A cap can be set overall and per UTC month, ISO week, day and hour. The tightest one wins, and it can shrink a top-up to a partial one.
- **What counts.** Only top-ups made under the rule count against its caps; money added by hand doesn't.
- **No caps, no auto.** A rule in `auto` mode with no cap only proposes.

## 3. Run the agent

```ts
import { createSubscriptionAgent } from '@cappz/sdk/paidAgent';

const agent = createSubscriptionAgent({
  store,                                   // read/append a wallet's FundingEvent TXs (one writer per wallet)
  fund: async ({ amount, currency }) => {  // the wallet or treasury that owns the money signs
    const txHash = await wallet.pay(/* … */);
    return { txHash };
  },
  notify: (n) => showToast(n),             // 'propose' | 'funded' | 'warn' | 'failed'
  rate: async () => latestSignedRate(),    // only needed for cross-currency prices
});

await agent.check(uaw, [rule]);                                  // propose / auto-fund / warn
await agent.approve(uaw, proposalId, 'user', [rule]);            // the toast's button
await agent.approveCommand(uaw, 'top up Summarizer $15.00', 'user', [rule]);
await agent.charge({ wallet: uaw, payer: 'rUser…', plan, split, fn: 'summarize', quantity: 1, currency: 'USD', chargeId });
await agent.planTasks(uaw, tasks, { USD: 300 });                 // critical first; record what is deferred
```

The agent holds no key. Without a `fund` port it never moves money, so every top-up stays a proposal.

`charge` returns:
- the quote, the contract's split lines and the AP/AR postings;
- or **402** when the wallet is short, with nothing recorded;
- or **409** when the plan and the contract disagree.

A repeated `chargeId` never charges twice.

### When money is short

`planWithinBudget` and `agent.planTasks` order the queued work:
- Critical tasks run first, and they may use the reserve.
- Normal and deferrable tasks run only from money above the reserve.
- Whatever doesn't fit is deferred with a reason and an exact shortfall, never dropped.

### XRP top-ups from the person's own wallet

An XRP top-up is paid by the person, not by the app. They pay from their own funded wallet: CAPPZ sells no XRP and links no purchase provider (on mainnet, the person withdraws XRP to their wallet from an exchange; on testnet, the faucet). For these, the app's `fund` port returns `{ awaitingPayment: await xrpTopUpRequest({ proposalId, network, payTo, drops }) }`. The request holds:
- the app's receiving address (`plan.xrpl.payTo`);
- a destination tag reproducible from the proposal id;
- the amount in drops;
- an unsigned `Payment` for the person's wallet to complete and sign.

Once they have paid:

```ts
await agent.settleXrpTopUp(uaw, proposalId, txHash, [rule], plan.xrpl!); // needs the `ledgerTx` port
```

How settling works:
- `checkXrpTopUp` reads the validated ledger. It checks the destination, the tag, and `delivered_amount` (never `Amount`).
- The money is credited as `AppFunded` with the ledger hash, and a ledger payment is credited only once.
- Only an approved proposal can be settled.
- An approved proposal that is still unpaid lapses at its expiry, so the rule can propose again.

### Rules and plans on the ledger

These live in `ledgerConfig.ts`, and the newest event wins.
- A person's top-up rules are `FundingRuleSet` / `FundingRuleRemoved` TXs at their account, so every device sees the same rules (`replayFundingRules`).
- An app owner's plan is `UsagePlanPublished` at the app's root. The owner's later `PriceAcknowledged` / `PriceSet` decisions apply on top of it (`resolvePublishedPlan`).
- `planFromPriceSheet` turns a published price sheet into an owner-set plan. Volume tiers are not carried over.

### Sponsored apps: the edge-node job

- **In-app agent:** `subscriptionWatchJob(agent, targets)` runs the in-app agent as an edge-node timer job.
- **Treasury accounts:** for the app owner's own accounts, such as the POW treasury hot wallet that sponsored usage draws on, use `treasuryWatchJob`. It reads the balance from the ledger (`balanceOf`), not from a replayed log. It tops up with `pay` only for automatic rules with caps; any other decision is logged for the owner.
- **The edge node binds it** when `CAPPZ_FUNDING_CONFIG` is set (`packages/cappz-edge-node/funding.ts`):

```json
{ "network": "testnet",
  "targets": [{ "wallet": "r…treasury hot wallet",
                "rules": [{ "ruleId": "hot-wallet", "appRoot": "…", "appName": "Treasury", "currency": "XRP",
                            "belowBalance": 50000000, "target": 200000000, "source": "app-treasury",
                            "mode": "auto", "caps": { "day": 300000000, "month": 2000000000 } }] }] }
```

- **Payments** are signed with `CAPPZ_FUNDING_SEED`: the owner's own funding account, on the owner's node.
- **Schedule** the job with a timer start event, `cappz:function="subscription-watch"`.

## 4. Splits come from the contract

```ts
import { splitCharge, postingsFor } from '@cappz/sdk/paidAgent';

const split = { contractId: 'contract-7', remainderTo: 'rAppOwner…', shares: [
  { party: 'rPlatform…', role: 'platform', bps: 1000 },
  { party: 'rAppOwner…', role: 'tenant',   bps: 6000 },
  { party: 'rWriter…',   role: 'talent',   bps: 3000 },
  { party: 'rEditor…',   role: 'talent',   bps: null },   // no share
] };
```

- **Null and zero shares.** A share of `null` or `0` gets nothing.
- **Unallocated shares.** If the shares add up to less than 100%, the contract must name `remainderTo`; otherwise the split is refused, never guessed.
- **Rounding.** Rounding is exact (largest remainder), so the lines always add up to the charge.
- **Baseline fee.** The plan's baseline fee is its own line, paid to `baseFee.to`.

## 5. Spend reports

- **`estimateRunway`** gives the spend per hour over the last seven days, and how many hours the balance lasts at that rate.
- **`projectedVsActual`** compares a projected spend for the current period with what was actually charged: the variance, and the variance as a percentage.

## 6. Platform adapter templates

`PLATFORM_ADAPTER_TEMPLATES` lists the endpoints an app depends on, per service: XRPL, notices and the scheduler. Each endpoint has a priority and a weight.

- **`endpointOrder`** orders them: lowest priority first, load shared by weight within a priority, and failing endpoints moved last with exponential back-off.
- **`withFailover`** tries each endpoint in that order until one succeeds.

Templates are plain data, with no hosting provider assumed. Notices and scheduling default to the device itself.

## Events

All state is replayed from these transactions; no balance or flag is stored. They are registered in the MDM `fees` category:

`AppFunded`, `FeeCharged`, `UsageRecorded`, `TopUpProposed`, `TopUpApproved`, `TopUpDeclined`, `RunwayLow`, `TaskDeferred`, `TaskResumed`, `PriceAcknowledged`, `PriceSet`, `FundingRuleSet`, `FundingRuleRemoved`, `UsagePlanPublished`.
