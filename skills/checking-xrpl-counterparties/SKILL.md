---
name: checking-xrpl-counterparties
description: Checks the other side before paying or funding escrow on the XRP Ledger with the CAPPZ counterparty check (0.01 XRP) — whether the address can receive (activated, DepositAuth, destination tag), how old and active it is, its CAPPZ marketplace record and mandate, for RLUSD (USD-tokenZ/1) or CAPPZ payments both trust lines and the issuer's freeze, authorization and escrow settings, and whether the payer can afford it — and returns a signed ok / warn / stop verdict with reasons. Use when about to send XRP, RLUSD or CAPPZ to an unfamiliar address, fund a CAPPZ marketplace escrow or hire an agent, or when asked whether an XRPL address or marketplace party is safe to pay.
---

# Checking XRPL counterparties

One call, before money moves, answers: will this payment land, and should I trust who gets it? The rules are public, and the report is signed by CAPPZ so it can be kept as evidence.

## Requirements

- The `cappz-market` tool (Node.js 20+, one file; see **getting-an-xrpl-wallet**).
- A wallet on the same network with at least 0.01 XRP spendable plus fees. A check costs **0.01 XRP**, paid to the CAPPZ treasury once the result is ready, and the result's SHA-256 is shown before you pay.
- No CAPPZ account is needed.

## Check, then decide

```bash
cappz-market check rP9…xyz --amount 25              # an address you will pay, on testnet
cappz-market check p-1a2b3c4d5e6f7a8b --amount 25   # a marketplace party: its profile's address
cappz-market check rP9…xyz --amount 25 --network mainnet --yes   # mainnet: the person agreed to pay checks
cappz-market check p-1a2b3c4d5e6f7a8b --currency USD-tokenZ/1 --amount 40   # paying 40 RLUSD: trust lines and issuer too
```

`--amount` is in XRP, or in `--currency` when you give one (`CAPPZ` or `USD-tokenZ/1`). The check itself always costs 0.01 XRP.

Read `verdict` and `reasons`, and confirm `signedByCappz: true` and `hashMatched: true`:

| Verdict | Do |
|---|---|
| `stop` | Do not pay. Each reason says why: not activated, DepositAuth, an agent with no mandate, you can't afford it, no trust line, a frozen token… Fix it or ask. |
| `warn` | Paying is possible. Weigh the warnings (new account, open disputes, dispute rate, DisallowXRP) and ask the person you act for when the amount matters. |
| `ok` | Proceed. |

`info` reasons are facts, not problems. For example, a required destination tag: include the tag you were given. For a token, `asset-escrowable` means the issuer allows trust-line locking; `asset-staged` means it does not (RLUSD today), so the deal pays it stage by stage on acceptance instead of escrowing it.

## Where it fits

```
Before paying:
- [ ] check <party or address> --amount <what you will pay>
- [ ] verdict is not stop; warnings accepted (by the person, for significant amounts)
- [ ] fund / pay / hire
- [ ] keep the report file (path in "report") with the deal
```

On the CAPPZ Marketplace, run it before `fund` (checking the seller's party) and before `hire` (checking the agent's `payTo`).

## What it reads

- **Ledger, public:** activation, balance, owned objects, flags (DepositAuth, RequireDestinationTag, DisallowXRP, DisableMaster without a regular key, GlobalFreeze), first and last transaction, live reserves.
- **Marketplace, public log of that network:** the party behind the address, finished deals, disputes (open and total), average rating, and for agents whether the mandate is active and how much is used today.
- **Tokens** (if you pass `--currency`): the issuer's flags (GlobalFreeze, RequireAuth, AllowTrustLineLocking), the recipient's trust line (present, limit room, frozen, authorized) and yours (present, balance against `--amount`). Codes include `asset-unavailable`, `asset-frozen`, `recipient-no-trust-line`, `recipient-limit`, `line-not-authorized`, `payer-no-trust-line`, `payer-short-token`.
- **Your wallet** (if you pass `--amount`): spendable XRP against amount + escrow reserves + fees.

A fact that could not be read is reported as unreadable, never as fine.

## Without the tool

The service speaks the paid-agent protocol (see **hiring-cappz-paid-agents**). Its address and public key are in https://cappz.ai/.well-known/cappz-market.json under `services.counterpartyCheck`.
1. `POST <url>/<network>/jobs` with body `{"input": {"address": "r…", "amountXrp": 25, "payer": "r…"}}` (or `"party": "p-…"`; for a token add `"currency": "USD-tokenZ/1", "amount": 40`).
2. Pay the shown 0.01 XRP with its destination tag.
3. `POST /jobs/<id>/payments` with body `{"txHash": "…"}`.
4. `GET /jobs/<id>/stages/0/result`.

Free, from the same service: `GET <url>/<network>/reputation/<partyId>` returns a signed reputation attestation (a 24-hour snapshot of ledger facts, marketplace history and standing), and `<url>/.well-known/agent-card.json` is the service's signed A2A agent card.

To verify the result: the Ed25519 signature is over the canonical JSON of `report` (sorted keys, no spaces), with the published `publicKey`. The rules are in `src/lib/marketplace/counterpartyCheck.ts` of github.com/CAPPZ-ai/cappz-sdk; re-running them on the report's facts gives the same verdict.
