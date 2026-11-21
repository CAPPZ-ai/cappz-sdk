# Vault Guard

Limit what a stolen key can take out of a pooled XRP Ledger account. The XRP Ledger enforces the limit, not your server.

`src/lib/treasury/vaultGuard.ts`, exported from `@cappz/sdk/marketplace` (15.48.0). Tested on the XRPL testnet with `tools/vault-guard-testnet.ts`.

## The problem

A vault that pays out whatever one key signs has no limit except its balance. That one key can be a single key or a threshold "aggregate" key held in pieces by many validators. If someone steals it, or produces its signature outside the normal signing system, the balance leaves in one transaction. Detection doesn't help in time: in the November 2026 Chainflip drain, about $4.86 million went from the vault to a mixer in under ten minutes.

## What it does

1. **Setup.** The vault's master key is disabled, and a signer list makes an independent **guard** co-signer necessary for every transaction:

   | Who signs | Weight | Can move money? |
   |---|---|---|
   | All operator keys together | n | No (quorum is 2n+2) |
   | The guard alone | 2n+2−k | No |
   | The guard + k operators | 2n+2 | Yes, within the policy |
   | Two offline recovery keys | 2(n+1) | Yes (break-glass, always reported) |
   | One recovery key + every operator | 2n+1 | No |

   The ledger refuses everything else with `tefBAD_QUORUM`, including attempts to change the signer list or set a regular key. A refused transaction never enters a ledger.

2. **Policy.** The guard co-signs only what fits the owner's outflow policy:
   - **Destinations:** allowed destinations only, with exact tags where a tag is listed.
   - **Caps:** a per-transaction cap and a rolling-window cap for each asset (XRP in drops, tokens as exact decimals).
   - **Fee and expiry:** a capped fee, and a short `LastLedgerSequence`.
   - **Sequence:** the account's **next sequence**. No tickets and no counter jumps, so a signature made outside the normal counter is refused before it exists.
   - **What it never signs:** partial payments, paths, `SendMax` or extra fields, and any change to keys, signers or account settings.

   Every refusal reason is returned at once.

3. **Reconciliation.** Every validated transaction from the vault must match an approval the guard recorded, matched by intent hash. Anything else is `unapproved`, even if it failed: a failed transaction still carried a quorum signature. The report is hashed, so an incident record can cite it.

## Quick start

```ts
import { Client, Wallet, multisign } from 'xrpl';
import { guardSetupTransactions, checkSignerSetup, guardCosign, reconcileOutflows, type OutflowPolicy } from '@cappz/sdk/marketplace';

const policy: OutflowPolicy = {
  kind: 'cappz-outflow-policy/v1', network: 'testnet', account: vault.classicAddress, guard: guard.classicAddress,
  destinations: [{ address: settlementDesk, label: 'Settlement desk' }],
  limits: [{ asset: 'XRP', perTx: '20000000', perWindow: '30000000' }], // 20 XRP each, 30 XRP per 24 h
  windowHours: 24, maxFeeDrops: 1000, maxLedgerAhead: 20,
};

// 1. Setup, signed by the master key (its last act).
for (const tx of guardSetupTransactions(vault.classicAddress, guard.classicAddress, [op1.classicAddress, op2.classicAddress], { perSpend: 1, recovery: [rec1, rec2] }))
  await client.submitAndWait(tx, { wallet: vault, autofill: true });

// 2. Check it from account_info (signer_lists: true): must be 'guard-load-bearing'.
checkSignerSetup(policy, { flags, regularKey, signerList }, [rec1, rec2]);

// 3. A routine payment: the guard co-signs only inside the policy; record the approval before submitting.
const prepared = await client.autofill({ TransactionType: 'Payment', Account: vault.classicAddress, Destination: settlementDesk, Amount: '15000000' }, 2);
const { decision, txBlob } = await guardCosign(policy, { nextSequence, currentLedger, spent }, prepared, guard, new Date().toISOString());
if (txBlob) await client.submitAndWait(multisign([txBlob, op1.sign({ ...prepared, SigningPubKey: '' }, true).tx_blob]));

// 4. Reconcile the account's history against the recorded approvals, on a schedule.
const report = await reconcileOutflows(policy, approvals, validatedTxs);
```

Run the guard on separate infrastructure under separate people: a different machine, cloud account and operator from the operator keys. If one breach reaches both, the guard adds nothing.

## Refusal reasons

| Code | Meaning |
|---|---|
| `destination-not-allowed`, `destination-tag` | Not on the list, or the wrong tag |
| `over-tx-cap`, `over-window-cap` | Over the single-payment or rolling-window cap |
| `asset-not-allowed` | No limit is set for this asset, so it is never paid out |
| `sequence-gap`, `ticket-sequence` | Not the account's next sequence (an out-of-band signature) |
| `no-expiry`, `expiry-too-far`, `fee-over-cap` | Unbounded validity or fee |
| `partial-payment`, `unexpected-field`, `unexpected-flags` | Could deliver something other than what it names |
| `governance-change`, `type-not-allowed` | Key, signer or account changes, or a type the policy doesn't cover |
| `wrong-account`, `not-the-guard` | Wrong vault, or the wrong signing key |

## Setup findings

`checkSignerSetup` returns `guard-load-bearing`, `guard-bypassable` or `not-set-up`.

- **Blocking findings:** `master-enabled`, `regular-key-set`, `no-signer-list`, `guard-not-listed`, `online-keys-reach-quorum`, `single-key-reaches-quorum`, `recovery-plus-online-reaches-quorum`, `guard-alone-reaches-quorum`.
- **Warnings:**
  - `guard-cannot-spend`: routine outflows are impossible.
  - `no-recovery-path`: losing the guard would freeze the vault.

A plain threshold list with no guard is `guard-bypassable`, for example 100 of 150 validator keys: stealing the online keys is enough.

## What it does not do

- **It bounds the loss; it doesn't make keys safe to leak.** With the guard and k operator keys, an attacker can still move up to one window's cap to an allowed destination (`worstCaseLoss`).
- **Allowed destinations are part of the trust.** Use addresses you control or have confirmed (see `confirming-payees`), not a counterparty's word.
- **Recovery keys can bypass the policy by design.** Keep them offline and with different people. Every use shows up as `unapproved` in reconciliation.
- **It doesn't apply to funds CAPPZ deals already lock.** A marketplace escrow pays only the destination fixed when it was created. The guard is for accounts that pool funds, such as a fee collector, a treasury or a bridge vault.

## Hosted guard (edge node)

An edge node can be the guard for you: `vault-guard` (10 XRP per 30 days, paid from the vault) and `vault-check` (1 XRP) in `packages/cappz-edge-node/agents` (README there). The node derives one guard key per vault. It accepts a period only when the vault paid it, and a policy change only when that payment was signed without the guard. Find one on the marketplace with `cappz-market find "vault guard"`.

## Testnet run

`npx vite-node tools/vault-guard-testnet.ts -- --out run.json`

The run funds a vault from the faucet, sets up the guard and checks it from the ledger. It then submits each attack and records the ledger's answer:

- master key: `tefMASTER_DISABLED`
- every operator key draining the vault: `tefBAD_QUORUM`
- removing the guard: `tefBAD_QUORUM`
- setting a regular key: `tefBAD_QUORUM`

Then it shows the guard's side:

- The guard refuses to co-sign the drain.
- A 15 XRP payment inside the policy succeeds.
- A second payment past the 30 XRP window is refused.
- Break-glass recovery succeeds and reconciles as `unapproved`.
- The attacker's address is never created.
