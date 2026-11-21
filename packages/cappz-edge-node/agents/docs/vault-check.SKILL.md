---
name: using-cappz-vault-check
description: Gets a signed report from the CAPPZ edge node at {{HOST}} on a pooled XRP Ledger account (treasury, fee collector, bridge vault) — whether a guard co-signer is load-bearing or a stolen key could move money alone, what the stated outflow policy would still let a thief take, and whether recent outflows match the guard's approvals — for {{VC_PRICE}} XRP on {{NETWORK}}, read from the ledger with no key held. Use when asked to audit an XRPL account's signing setup, check multisig or signer-list safety, find out what a key compromise could drain, or reconcile a vault's outflows.
---

# CAPPZ vault check

A read-only audit of one XRP Ledger account. The node reads the account's master-key flag, regular key, signer list and recent transactions from the ledger, then signs a `VaultChecked` report. It never holds a key for the account.

- Endpoint: `{{BASE}}/vault-check`
- Price: {{VC_PRICE}} XRP per report, paid on completion: you see the report's SHA-256 first.
- Network: {{NETWORK}}. Pays to: `{{PAYTO}}`. Signer: `{{NODE}}`.
- Same agent on {{PEER_NETWORK}}: `{{PEER_BASE}}/vault-check`. Every report states its network in `payload.network`.

## Input

```json
{
  "account": "r… the pooled account",
  "guard": "r… the co-signer it should require (optional)",
  "recovery": ["r… offline recovery signer", "r…"],
  "policy": { "destinations": [{"address": "r…", "label": "Settlement desk"}], "limits": [{"asset": "XRP", "perTx": "20000000", "perWindow": "50000000"}] },
  "approvals": [ /* the guard's recorded approvals, with policy */ ],
  "limit": 200
}
```

Only `account` is required. XRP limits are in drops (1 XRP = 1000000); tokens are `<currency>/<issuer>` with decimal limits.

## What the report says

- `state`:
  - `guard-load-bearing`: no key other than the guard can move money.
  - `guard-bypassable`: some key or set of online keys can. The findings say which.
  - `not-set-up`: there is no signer list.
- `findings`. Blocking: `master-enabled`, `regular-key-set`, `no-signer-list`, `guard-not-listed`, `online-keys-reach-quorum`, `single-key-reaches-quorum`, `recovery-plus-online-reaches-quorum`, `guard-alone-reaches-quorum`. Warnings: `guard-cannot-spend`, `no-recovery-path`.
- `worstCase` (with a policy): the most the policy lets leave in one window, per asset. That is the honest loss if a guard and enough operator keys are both taken.
- `reconciliation` (with policy and approvals): every recent outflow matched to an approval, or listed as `unapproved`. A failed but validated transaction without an approval is unapproved too: it still carried a quorum signature.

Without `guard`, a threshold list such as 100 of 150 validator keys reports `guard-bypassable` with `online-keys-reach-quorum`: stealing the online keys is enough.

## Hire it

```bash
cappz-market hire {{BASE}}/vault-check --input '{"account":"r…","guard":"r…"}' --max {{VC_PRICE}}
```

With plain HTTP:
1. `POST {{BASE}}/vault-check/jobs {"input":{…}}`.
2. `GET …/jobs/<id>/stages/0/result` returns 402 with `pay` and `resultSha256`.
3. Pay with the destination tag.
4. `GET` the result again.

Check the signature with `node verify.mjs report.json {{PAYTO}}` ({{BASE}}/verify.mjs).

## Fixing what it finds

To make a guard load-bearing, use `guardSetupTransactions` and `checkSignerSetup` from `@cappz/sdk/marketplace` (guide: https://github.com/CAPPZ-ai/cappz-sdk/blob/main/docs/VAULT_GUARD.md). For this node as your guard, see `{{BASE}}/vault-guard/SKILL.md`. Disabling a master key is permanent unless the signer list re-enables it, so check the list with this report before the second transaction.
