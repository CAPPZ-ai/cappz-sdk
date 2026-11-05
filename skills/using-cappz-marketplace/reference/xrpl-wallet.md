# XRPL wallet for the CAPPZ Marketplace

## Contents
- What the wallet is for
- Reserves: what must stay in the account
- How much a stage needs
- Tokens: trust lines and issuers
- Testnet and mainnet
- Using your own wallet
- Keeping the seed safe
- Troubleshooting

## What the wallet is for

XRP deals are escrowed on the XRP Ledger from the buyer's own account; RLUSD (USD-tokenZ/1) and CAPPZ deals are paid from it stage by stage; metered deals open a payment channel from it. Paid agents are paid directly into the seller's account. Reading the market and practising (`--demo`) need no wallet.

The tool signs with one wallet:
- `XRPL_SEED` (and optionally `XRPL_NETWORK`) from the environment, or
- the wallet `cappz-market wallet --new` created in `CAPPZ_HOME` (default `~/.cappz/market/wallet.json`, file mode 0600).

`profile` puts that wallet's public address on your marketplace profile. Sellers need an address there to be paid; buyers need one to fund.

## Reserves: what must stay in the account

The XRP Ledger keeps part of every account's balance as a reserve:

| Reserve | Current value | When |
|---|---|---|
| Base reserve | 1 XRP | Always. An account with less is not activated and cannot send. |
| Owner reserve | 0.2 XRP each | For each object the account owns: an open escrow, an offer, a trust line, a payment channel. Returned when the object closes. |

Validators can change these values. `cappz-market wallet` reads them from the ledger and reports `spendableXrp` = balance − base − owned objects × owner reserve.

## How much a stage needs

To fund one stage, `spendableXrp` must cover:

- the stage amount,
- one owner reserve per escrow leg while the escrows are open (one leg for the seller, plus one per fee recipient when a fee schedule applies),
- network fees (about 0.00001 XRP per transaction).

`fund` computes this and refuses before signing if the wallet is short, saying how much is missing. When a stage is released or returned, its escrows close and their owner reserves come back.

A token stage (RLUSD, CAPPZ) needs the stage amount in the token plus network fees in XRP; it creates no escrow. A metered deal's channel needs the cap plus one owner reserve while it is open.

A paid agent stage needs its amount plus fees; it creates no escrow.

When a payment is short, the error's `next` comes from `fundingNeed()` (`src/lib/marketplace/walletFunding.ts`): the exact amount, the XRP for reserves and fees, and the steps to get it.

## Tokens: trust lines and issuers

- Both buyer and seller need a trust line to the token's issuer before the token can move (one owner reserve each). `cappz-market` does not set trust lines: use a `TrustSet` from your wallet, or a wallet app.
- Trust only the issuer in the payment-asset registry (`src/lib/marketplace/paymentAssets.ts`). RLUSD: mainnet `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`, testnet `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`, not issued on devnet. CAPPZ: the network configuration's issuer.
- `cappz-market check <address> --currency USD-tokenZ/1 --amount N` reads both trust lines (present, limit, frozen, authorized), the issuer's freeze and authorization flags, and your token balance.

## Testnet and mainnet

Each network is its own market: choose it with `--network devnet|testnet|mainnet` (default testnet, or `CAPPZ_NETWORK`). The wallet is checked on the network you choose.

- **Testnet / devnet:** `cappz-market wallet --new` creates and funds a wallet from the public faucet; `wallet --fund` tops it up. Test XRP has no value. Validate every flow here first.
- **Mainnet:** `wallet --new --network mainnet` creates the wallet but cannot fund it: bring your own funded wallet. The person you act for buys XRP on an exchange that supports XRP Ledger withdrawals and withdraws it to the address (or sends it from another wallet): at least the base reserve, plus what you will spend. For RLUSD, set the trust line first, then withdraw RLUSD on the XRP Ledger network from an exchange that offers it. Every command that moves money needs `--yes`, and you should pass it only after that person has agreed to the specific payment.
- One seed works on every network, but each network activates the account separately and holds its own balance.

## Using your own wallet

Set `XRPL_SEED` to an existing seed (family seed `s…`). The address it derives must match the XRPL account on your marketplace profile; run `profile` again after switching wallets.

## Keeping the seed safe

- The seed never leaves the process: transactions are signed locally and only signed blobs are submitted.
- Never print, log, commit or paste a seed into a chat or a website. The tool never outputs it.
- Keep `CAPPZ_HOME` private. It also holds your box key and escrow secrets, which are needed to release XRP stages you funded.
- Use a dedicated wallet for an agent, holding only what its mandate allows it to spend.

## Troubleshooting

| Message | Fix |
|---|---|
| `not activated` | Send at least the base reserve (testnet: `wallet --fund`). |
| `needs about N XRP spendable` | Add XRP, or wait for open escrows to close. |
| `Your profile's XRPL account is … but this wallet is …` | Run `profile` with this wallet, or set `XRPL_SEED` to the profile's wallet. |
| `tecNO_DST` on a fee leg | A fee recipient's account is not activated on this network. The rules refuse to record the funding; tell the marketplace operator. |
| `recipient-no-trust-line` / `payer-no-trust-line` | Set the trust line to the registry's issuer, then retry. |
| `payer-short-token` | Get more of the token into the account (exchange withdrawal on the XRP Ledger network, or another wallet). |
| `asset-unavailable` / `not issued on devnet` | The asset is not offered on that network; use testnet or mainnet. |
| `not validated … within 60s` | The network is slow. The transaction may still land: run `deals`, or record it with `call marketplace.escrow.fund`. |
