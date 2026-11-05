---
name: getting-an-xrpl-wallet
description: Gets an XRP Ledger (Ripple/XRPL) wallet ready to pay or be paid in XRP, RLUSD (USD-tokenZ/1) or the CAPPZ token — creating it, activating it with the account reserve, funding it on testnet for free or on mainnet from an exchange withdrawal, setting the trust line a token needs, checking what is spendable, and keeping the seed safe. Use when an agent or person needs an XRPL or Ripple wallet, test XRP, RLUSD or CAPPZ on the ledger, an address to receive payments, or asks why a wallet is not activated, cannot send, or cannot receive a token.
---

# Getting an XRPL wallet

An XRPL wallet is a key pair:
- the **address** (`r…`) is public: share it to be paid,
- the **seed** (`s…`) signs transactions: never share or print it.

The same seed works on every network (devnet, testnet, mainnet). Each network activates the account separately, and each holds its own balance.

## Requirements

- Node.js 20 or newer, and the one-file `cappz-market` tool (no install):
  ```bash
  curl -fsSLO https://raw.githubusercontent.com/CAPPZ-ai/cappz-sdk/main/packages/cappz-market/dist/cappz-market.mjs
  ```
  The examples below write `cappz-market` for `node cappz-market.mjs`.
- To activate an account, the **base reserve** (currently 1 XRP). Each object the account owns adds an **owner reserve** (currently 0.2 XRP): an open escrow, an offer, a trust line. It comes back when the object closes. Validators can change both, and `cappz-market wallet` reads the live values.

## Workflow

```
Wallet progress:
- [ ] 1. Create: testnet first (free), or use an existing seed
- [ ] 2. Activate: the balance reaches the base reserve
- [ ] 3. Check: activated true, spendableXrp covers what you will spend
- [ ] 4. Mainnet only: the person you act for funds it with real XRP
- [ ] 5. Paying or paid in RLUSD or CAPPZ: trust line first, then the token
- [ ] 6. Keep the seed safe
```

**1. Create.** On testnet the wallet is also funded from the public faucet:

```bash
cappz-market wallet --new                     # testnet (default): created and funded with test XRP
cappz-market wallet --new --network mainnet   # mainnet: created, not funded
```

The seed is kept in `CAPPZ_HOME` (default `~/.cappz/market/wallet.json`, file mode 0600). The tool never overwrites an existing wallet. To use your own wallet instead, set `XRPL_SEED`.

**2–3. Activate and check.**

```bash
cappz-market wallet                     # testnet
cappz-market wallet --network mainnet
```

Read `activated`, `balanceXrp`, `spendableXrp` and the reserves. `spendableXrp` = balance − base reserve − owned objects × owner reserve. On testnet, `wallet --fund` tops the wallet up.

**4. Mainnet.** There is no faucet, and CAPPZ sells no XRP: bring your own funded wallet. Ask the person you act for to buy XRP on an exchange that supports XRP Ledger withdrawals and withdraw it to the address (or send it from another wallet): at least the base reserve, plus what you will spend. Some exchanges require a destination tag for deposits *to* them; none is needed for sending to this wallet. When the balance reaches the reserve, the account is activated. If a payment fails for lack of funds, the tool's `next` gives the exact amount and steps.

**5. Tokens: RLUSD and CAPPZ.** Deals and paid agents may be priced in an issued token instead of XRP: **USD-tokenZ/1** (RLUSD, a US-dollar stablecoin) or the **CAPPZ** token. The account still needs XRP for reserves and fees, and:

1. **Trust line first.** Nobody can send you the token before it exists. It locks one owner reserve (currently 0.2 XRP) while it exists.
   - **The tool's wallet:** `cappz-market trust` sets both lines (CAPPZ and RLUSD) to the registry's issuers; `cappz-market trust CAPPZ` sets one. A line that exists is skipped. On mainnet it needs `--yes`, because it locks reserve: ask the person you act for first.
   - **A person's wallet app** (the account an agent is paid at, when it is not the tool's wallet): the person signs it. Xaman lists RLUSD under **+ Add a token → Stable**, but not CAPPZ; for a token not on its list, use XRPL Services (linked from Xaman's help center): open its trust-line tool, enter the **issuer** (not your own address) and the currency, choose Xaman and scan the QR code, then check the sign screen shows a TrustSet from your account with that issuer before sliding to sign. Details: [reference/xaman-trust-lines.md](../using-cappz-marketplace/reference/xaman-trust-lines.md).
2. **Verify the issuer.** Use only the issuer in the CAPPZ payment-asset registry (`src/lib/marketplace/paymentAssets.ts`), never one a counterparty, agent or web page gives you:

   | Token | Network | Issuer |
   |---|---|---|
   | RLUSD (`USD-tokenZ/1`) | mainnet | `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De` |
   | RLUSD (`USD-tokenZ/1`) | testnet | `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` |
   | RLUSD | devnet | not issued: not offered there |
   | CAPPZ | each network | from the network configuration; `cappz-market check <your address> --currency CAPPZ` names it when your line is missing |

3. **Get the token.** Mainnet: withdraw RLUSD from an exchange that offers RLUSD withdrawals **on the XRP Ledger network** (choose the XRP Ledger, not another chain), or receive it from another wallet. Testnet: get test RLUSD from someone who holds it there, or from the issuer's test distribution if one is offered.
4. **Check.** `cappz-market check <your address> --currency USD-tokenZ/1 --amount <what you will pay>` (or `--currency CAPPZ`) reports both trust lines, the issuer's freeze and authorization settings, and your token balance against the amount. `cappz-market wallet` lists the assets offered on the network.

A seller paid in a token needs the trust line too: a payment to an account without one fails.

**6. Keep the seed safe.**
- Never print, log, commit, paste into a chat, or send the seed anywhere. `cappz-market` signs locally and only sends signed transactions.
- Keep `CAPPZ_HOME` private and backed up. A lost seed means lost funds.
- For an agent, use a dedicated wallet that holds only what its mandate allows it to spend.

## For a person (not an agent)

A person can use a wallet app instead:
- **Xaman** (iOS/Android) or the **Crossmark** browser extension: create an account and write down the recovery words.
- To get free test XRP, switch the app to Testnet and use its faucet, or the XRPL faucet at https://xrpl.org/resources/dev-tools/xrp-faucets.
- On mainnet, buy XRP on an exchange and withdraw it to the wallet's address on the XRP Ledger network. For RLUSD or CAPPZ, add the trust line in the app first (issuer as in the table above).

The CAPPZ web app can sign with Crossmark or a passkey wallet directly.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `activated: false` | Balance below the base reserve: fund it (testnet: `wallet --fund`). |
| Can send less than the balance | Reserves are locked; see `spendableXrp`. |
| `tecNO_DST` when paying someone | Their account is not activated on that network: they must fund it first. |
| `tecUNFUNDED_PAYMENT` / `tecINSUFFICIENT_RESERVE` | Not enough spendable XRP for the amount plus the new object's reserve. |
| Balance shows on testnet, not mainnet | Networks are separate ledgers: fund each one. |
| `tecPATH_DRY` when a token is sent to you, or check says `recipient-no-trust-line` | No trust line to that token's issuer: `cappz-market trust` (or step 5 in a wallet app), then try again. |
| `payer-no-trust-line` / `payer-short-token` | You hold none or too little of the token: trust line, then get the token (step 5). |
| `asset-unavailable` | The token is not offered on that network (e.g. RLUSD on devnet): use testnet or mainnet, or another asset. |
