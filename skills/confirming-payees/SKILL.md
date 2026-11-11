---
name: confirming-payees
description: Stops payment-instruction fraud (business email compromise, "updated wiring instructions", poisoned XRPL addresses) with the CAPPZ payee confirmation (0.01 XRP platform fee + 0.1 XRP). Payers confirm that the address and tag, or the bank account (hashed on their own computer), are the ones the payee declared on the CAPPZ market and endorsed from its own XRPL wallet, past a 72-hour cooling period and not revoked or replaced. The check also flags a change from where the payer paid this payee before and lookalike addresses in the payer's history, and returns a signed ok / warn / stop report. Payees publish and revoke their instructions with cappz-market payee. Use before a large or first payment to instructions that arrived by email, chat or invoice, when instructions changed, when asked whether an address or bank account really belongs to a payee, or when setting up how buyers should pay you.
---

# Confirming payees

A counterparty check tells you an address *can* receive. This tells you it is *the payee's*. Payment-instruction fraud works because instructions arrive on a channel the payee never signed, such as a spoofed email, a hijacked inbox or a copied address. Here the instructions come from the payee itself:

1. **Declared** on the market's public log. Only the payee's own account can write for its party.
2. **Endorsed** from the payee's own XRPL wallet: a no-op AccountSet whose memo names the declaration's hash. A hijacked sign-in alone cannot produce it, and the ledger timestamps it.
3. **In force after a cooling period** of 72 hours from the endorsement, or from the moment the profile took that wallet, whichever is later. A payee whose account is taken over has that window, in public, to revoke. Revoking takes effect at once.

## Requirements

- The `cappz-market` tool (Node.js 20+; see **getting-an-xrpl-wallet**) and a wallet on the payment's network.
- Payers: 0.11 XRP spendable plus fees. The 0.01 XRP platform fee goes to the CAPPZ treasury up front. The 0.1 XRP service fee is paid when the report is ready, after its SHA-256 is shown. No CAPPZ account is needed.
- Payees: a CAPPZ account and marketplace profile whose `xrplAccount` is a wallet you control.

## Payer: confirm before paying

```bash
cappz-market confirm-payee p-1a2b3c4d5e6f7a8b --address rP9…xyz --tag 7 --amount 25000
cappz-market confirm-payee p-1a2b3c4d5e6f7a8b --routing 021000021 --account 987654321 --network mainnet --yes
cappz-market confirm-payee p-1a2b… --address rP9… --contract ct-9f8e7d…   # the payee must be the deal's seller
```

**Take the payee id from the contract or an earlier, trusted exchange. Never take it from the message that carried the instructions.** A fraudster can register a lookalike party. The check warns on a new party or a shared name, but it cannot know which party you meant.

Bank details are hashed on this computer, once for each salt the payee declared. Only the digests are sent.

Read `verdict`, `binding.state` and `reasons`, and confirm that `signedByCappz` and `hashMatched` are both `true`:

| `binding.state` | Meaning | Do |
|---|---|---|
| `confirmed` | Declared and endorsed by the payee, in force | Pay, with a second approver (see `advice`) |
| `declared-by-other`, `not-declared` | The payee never declared these instructions | **Do not pay.** This is the fraud pattern. Call the payee on a number you already had |
| `cooling` | Endorsed recently. `inForceFrom` says when it is in force | Wait, or confirm by phone at a known number |
| `unanchored` | Declared but not endorsed from the payee's wallet, or the profile wallet changed since | Do not pay. Ask the payee to endorse |
| `revoked`, `superseded`, `expired`, `not-yet-valid` | Not the current instructions | Ask the payee for its current instructions through the market |
| `no-instructions`, `unknown-payee` | Nothing to confirm against | Do not pay these instructions |
| `anchor-unreadable` | The ledger could not be read | Retry. Never treat this as fine |

Other reasons:

- `instructions-changed` (warn): you paid this payee somewhere else before.
- `lookalike-address` (stop): the address shares its first five and last four characters with an address you paid or the payee declared. This is address poisoning. Copy the address from the declaration (`cappz-market payee list --party <id>`), never from your history.
- `control-not-proven` (warn): the payee's wallet endorsed the address, but the address itself never signed an anchor. That is normal for an exchange deposit address with a tag.
- `bank-holder-unverified` (info): only the bank can confirm the account holder's name. Ask your bank for an account-name check as well.
- Every counterparty-check reason for an XRPL address: `deposit-auth`, `not-activated`, `new-account`, …

## Payee: publish how you are paid

```bash
cappz-market payee declare --address rMy…addr --purpose "Land purchase, Block 12 Lot 3"
cappz-market payee declare --address rExchange… --tag 482913            # exchange deposit address
cappz-market payee declare --routing 021000021 --account 987654321 --hint "First Bank ••4321"
cappz-market payee declare --address rNew… --replaces pi-0123456789ab   # replaces earlier instructions
cappz-market payee list                                                 # states, cooling, control
cappz-market payee revoke --id pi-0123456789ab --reason "email compromised"
```

- When this tool's wallet is your profile wallet, `declare` endorses at once (on mainnet add `--yes`; the cost is the network fee only, with no reserve). Otherwise it prints the unsigned AccountSet. Sign it from your profile wallet, then run `payee anchor --id <pi-…> --tx <hash>`.
- To prove you control a declared address that is not your profile wallet, sign the same AccountSet from that address and anchor it as well.
- Give buyers your party id in the contract. Tell them that instructions arriving any other way are not yours until `confirm-payee` says so.
- Run `payee list` regularly. A declaration you did not make means your account is compromised: revoke it, then change your CAPPZ password and your profile wallet.

## Where it fits

```
Before paying instructions you were sent:
- [ ] payee id from the contract (not the message)
- [ ] confirm-payee <payee> <instructions> --amount <amount> [--contract <ct>]
- [ ] verdict not stop; warnings weighed with a second approver
- [ ] large amount: small first payment confirmed back by the payee (or a conditional escrow with CancelAfter)
- [ ] keep the report file (path in "report") with the payment record
```

## Without the tool

The discovery document at https://cappz.ai/.well-known/cappz-market.json gives `services.payeeConfirmation` (`url`, `path`, `publicKey`).

1. `POST <url>/<network>/payee/jobs` with body `{"input": {"payee": "p-…", "address": "r…", "destinationTag": 7, "payer": "r…", "amount": 25000}}`. For a bank account, send `"bankDigests": [...]` instead of the address: SHA-256 of `cappz-payee-bank|<salt>|<routing>|<account>`, uppercase alphanumerics only, one per declared salt. An unknown payee answers 404 and nothing is charged.
2. Pay stage 0, the platform fee, to the address and destination tag shown. Then `POST /jobs/<id>/payments` with body `{"txHash": "…"}`. The check runs.
3. Pay stage 1, the service fee, the same way. It goes to a different address and tag, both given in `pay`.
4. `GET /jobs/<id>/stages/1/result`.

To verify the result: the Ed25519 signature is over `cappz-payee-confirmation/v1\n` followed by the canonical JSON of `report` (sorted keys, no spaces), checked against the published `publicKey`. The rules are in `src/lib/marketplace/payeeConfirmation.ts` of github.com/CAPPZ-ai/cappz-sdk; re-running them on the report's facts gives the same verdict.
