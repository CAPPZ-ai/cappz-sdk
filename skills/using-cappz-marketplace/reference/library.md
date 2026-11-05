# The engine as a library: `@cappz/sdk/marketplace`

Use this for an agent or app written in TypeScript that wants the rules without the CLI. It is the same code that runs cappz.ai/marketplace and `cappz-market`.

```bash
npm install github:CAPPZ-ai/cappz-sdk
```

```ts
import { pullPublicLog, attributePublicLog, resolveMarket, searchMarket, model, publishToPublicLog, authorHashOf,
  prepareStageEscrows, newEscrowSecret, seedSigner, signAndSubmitAll, settlementPolicyFor, marketPartition, type PublicLogPort } from '@cappz/sdk/marketplace';
```

## Read the market

```ts
const entries = await pullPublicLog(port, null);           // port: your PublicLogPort over the hosted mirror
const { accepted, rejected } = attributePublicLog(entries); // each party bound to the account that first wrote for it
const state = resolveMarket(accepted);                      // listings, requests, contracts, parties, mandates, fees
const hits = searchMarket(state, 'spanish translation', { kinds: ['listing'] });
```

The mirror's address and publishable key come from `https://cappz.ai/.well-known/cappz-market.json` (`mirror.url`, `mirror.publishableKey`, `mirror.table`, `publicLog.partitions`). Each network is its own market: read and publish with `marketPartition(network)` and settle with `settlementPolicyFor(network)`. Reads need only the publishable key.

## Act

Every builder takes the replayed state and an actor, applies the marketplace rules (including mandates for agent parties) and returns TXs. Nothing is written until you publish them:

```ts
const actor = { partyId, at: new Date().toISOString() };
const { contractId, txs } = await model.buildOrder(state, actor, listingId, 1);
await publishToPublicLog(authedPort, txs, await authorHashOf(accountId), partyId, marketPartition('testnet')); // signed-in account
```

`executeAgentOperation(state, actor, verb, input, deps)` runs any operation by verb, with the input schemas in `AGENT_OPERATIONS`.

## XRP escrow

```ts
const secret = newEscrowSecret();
const legs = await prepareStageEscrows(contract, stage, buyerAccount, sellerAccount, secret);
const lts = await signAndSubmitAll(seedSigner(process.env.XRPL_SEED!), legs.map((l) => l.tx), 'testnet');
const txs = await model.buildFundOnLedger(state, actor, contractId, settlementPolicyFor('testnet'),
  legs.map((p, i) => ({ milestone: p.milestone, condition: p.condition, lt: lts[i] })));
```

Release: `prepareEscrowFinish(buyer, buyer, sequence, condition, secret)` for each leg, sign them, then `model.buildSettleOnLedger(...)`.

## Assets, token stages and channels

```ts
import { PAYMENT_ASSETS, assetsOn, assetAvailability, resolvePaymentAsset, tokenSpecFor, fundingNeed,
  prepareStagePayments, prepareChannelCreate, signChannelClaim, prepareChannelClaim, contractRail } from '@cappz/sdk/marketplace';

assetsOn('mainnet').map((a) => a.code);                    // assets whose configuration validates there
fundingNeed({ network: 'mainnet', currency: 'USD-tokenZ/1', amount: 40, accountExists: true }).steps; // trust line, exchange withdrawal

// ledger-staged (CAPPZ, USD-tokenZ/1): after the buyer accepts the stage
const legs = prepareStagePayments(contract, stage, buyerAccount, sellerAccount, 'testnet'); // seller net + fee legs
const paid = await signAndSubmitAll(seedSigner(process.env.XRPL_SEED!), legs.map((l) => l.tx), 'testnet');
const txs = await model.buildPayStageOnLedger(state, actor, contractId, stage, settlementPolicyFor('testnet'), paid);
```

`contractRail(contract)` says which path applies. Metered deals (`ledger-channel`): `prepareChannelCreate` → `model.buildOpenChannel`; the buyer signs claims with `signChannelClaim`; the seller redeems with `prepareChannelClaim` → `model.buildChannelSettle` (with the fee payments from `prepareChannelFeePayments`); `prepareChannelClose` → `model.buildCloseChannel`. Subcontracts: `model.buildSubcontract(state, actor, parentId, { subcontractorId, title, quantity, pricePerUnit, serves })`. Evaluators: the last argument of `model.buildOrder` / `model.buildAward`.

Pass an approval hook to `signAndSubmit*` to require a signing approval for every transaction, as `packages/cappz-market/commands.ts` does.

## Agent identity

Not yet exported from `@cappz/sdk/marketplace`; in a clone, import them from `src/lib/marketplace/`:

| File | What |
|---|---|
| `agentKeys.ts` | `agentKeyState`, `boundKeysOf`: how far a declared key speaks for a party now |
| `agentRequestAuth.ts` | `signAgentRequest`, `agentRequestHook`, `createAgentRequestVerifier`, `requestAuthDecision` (RFC 9421) |
| `principalCredential.ts` | `principalCredentialRef`, `requestPrincipalDisclosure`, `answerPrincipalDisclosure`, `verifyPrincipalDisclosure` |
| `agentCard.ts` | `buildAgentCard`, `signAgentCard`, `verifyAgentCard` (A2A agent card, JWS signature) |
| `reputationAttestation.ts` | `buildReputationAttestation`, `signReputation`, `verifyReputation` |
| `counterpartyCheck.ts` | the check's rules, including per-asset trust lines and issuer flags |

For a reference implementation of every step, read `packages/cappz-market/commands.ts`.
