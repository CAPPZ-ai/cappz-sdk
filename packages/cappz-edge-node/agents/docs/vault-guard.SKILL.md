---
name: using-cappz-vault-guard
description: Makes the CAPPZ edge node at {{HOST}} the guard co-signer of a pooled XRP Ledger account for {{VG_DAYS}} days ({{VG_PRICE}} XRP on {{NETWORK}}), so a stolen operator key cannot move money and the guard co-signs only inside the owner's outflow policy (allowed destinations, per-payment and rolling-window caps, next sequence only), with every decision signed, outflows reconciled every 10 minutes, alerts on anything unapproved and a signed period report. Use when asked to protect a treasury, fee collector or vault from key theft, add an independent co-signer, rate-limit outflows on the XRPL, or renew such a guard.
---

# CAPPZ vault guard

The node holds one guard key per vault, derived for your account and network. The signer list you set makes that guard necessary: every operator key together cannot reach quorum, the guard alone cannot, and the guard plus one operator (or k) can. The guard co-signs only what fits your policy. A stolen operator key, or all of them, moves nothing. The ledger refuses with `tefBAD_QUORUM`.

- Endpoint: `{{BASE}}/vault-guard`
- Price: {{VG_PRICE}} XRP per {{VG_DAYS}}-day period, paid up front. The signed period report at the end is free. Renew with a new job: the guard address stays the same.
- Network: {{NETWORK}} (it guards {{NETWORK}} accounts). Pays to: `{{PAYTO}}`. Signer: `{{NODE}}`.
- Same agent on {{PEER_NETWORK}}: `{{PEER_BASE}}/vault-guard`. Set it up there first.

## Checklist

```
- [ ] GET {{BASE}}/vault-guard/guard/<vault> → your guard address (free)
- [ ] Write the policy with the person you act for: destinations (include {{PAYTO}} so renewals can pass the guard), perTx and perWindow per asset (XRP in drops)
- [ ] Open the job (POST {{BASE}}/vault-guard/jobs, or cappz-market hire … --max {{VG_PRICE}} run as the vault) and pay {{VG_PRICE}} XRP FROM THE VAULT with the job's destination tag, while the master key still works
- [ ] Set up: guardSetupTransactions(vault, guard, operators, { perSpend: 1, recovery: [two or more offline keys] })
- [ ] Submit the SignerListSet, check it (checkSignerSetup or {{BASE}}/vault-check), THEN the AccountSet that disables the master key
- [ ] Each payment: autofill for 2 signers → POST /vault-guard/cosign/<jobId> → add one operator signature → submit
- [ ] Watch alerts (alertUrl); renew before the period ends: a new job with the same policy, paid by the vault through the guard
```

Pay the first period before you disable the master key. After that, only the guard (same policy) or the recovery keys (any policy) can pay for a period, because only the vault's own payments count.

## Input

```json
{
  "account": "r… the vault",
  "policy": {
    "destinations": [{"address": "r…", "label": "Settlement desk"}, {"address": "r…", "tag": 77, "label": "Exchange"}],
    "limits": [{"asset": "XRP", "perTx": "20000000", "perWindow": "50000000"}],
    "windowHours": 24, "maxFeeDrops": 1000, "maxLedgerAhead": 20
  },
  "recovery": ["r…", "r…"],
  "alertUrl": "https://… (optional: receives a signed alert for any outflow the guard did not approve)",
  "label": "optional"
}
```

## Co-signing a payment

```js
import { Client, Wallet, multisign } from 'xrpl';
const prepared = await client.autofill({ TransactionType: 'Payment', Account: vault, Destination: desk, Amount: '15000000' }, 2);
const r = await fetch('{{BASE}}/vault-guard/cosign/<jobId>', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx: prepared }) }).then((x) => x.json());
if (!r.approved) throw new Error(r.reasons.map((x) => x.code).join(', '));
const blob = multisign([r.txBlob, operator.sign({ ...prepared, SigningPubKey: '' }, true).tx_blob]);
await client.submitAndWait(blob);
```

Refusals (422) list every reason: `destination-not-allowed`, `destination-tag`, `over-tx-cap`, `over-window-cap`, `asset-not-allowed`, `sequence-gap`, `ticket-sequence`, `no-expiry`, `expiry-too-far`, `fee-over-cap`, `partial-payment`, `unexpected-field`, `unexpected-flags`, `governance-change`, `type-not-allowed`, `wrong-account`. Every decision, approved or refused, is a signed `VaultCosignDecided` record. Within the window, approvals that have not expired count as spent until they are validated or their `LastLedgerSequence` passes. `GET /vault-guard/status/<jobId>` shows the period, the policy and the decision count.

## What it does not do

- **It bounds the loss.** With the guard and enough operator keys, a thief can move one window's cap to an allowed destination. Set the caps to what you could lose in a day.
- **Recovery keys bypass it by design.** Keep them offline with different people. Reconciliation reports every use as unapproved.
- **If this node is down,** routine payments wait until it is back, and the recovery keys still work. The policy, the guard key and the decisions persist across restarts.
- **Only the vault can start or change its guard.** A period counts only when the vault paid it, so nobody can pay for a guard on your account with their own policy. A job with a different policy counts only if its payment was signed **without** the guard: by the master key before setup, or by your recovery keys. Stolen operator keys can renew the same policy through the guard, but never loosen it. An unauthorised job answers co-sign requests with 403 and its reason. `GET /vault-guard/status/<jobId>` shows `authorized`.
- Every record carries `payload.network`. Check any record with `node verify.mjs <file> {{PAYTO}}` ({{BASE}}/verify.mjs).

Guide: https://github.com/CAPPZ-ai/cappz-sdk/blob/main/docs/VAULT_GUARD.md
