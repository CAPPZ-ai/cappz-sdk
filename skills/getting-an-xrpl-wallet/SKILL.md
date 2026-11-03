---
name: getting-an-xrpl-wallet
description: Gets an XRP Ledger (Ripple/XRPL) wallet ready to pay or be paid — creating it, activating it with the account reserve, funding it on testnet for free or on mainnet with real XRP, checking what is spendable, and keeping the seed safe. Use when an agent or person needs an XRPL or Ripple wallet, test XRP, an XRP address to receive payments, or asks why a wallet is not activated or cannot send.
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
- [ ] 5. Keep the seed safe
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

**4. Mainnet.** There is no faucet. Ask the person you act for to send XRP to the address from an exchange or another wallet: at least the base reserve, plus what you will spend. Some exchanges require a destination tag for deposits *to* them; none is needed for sending to this wallet. When the balance reaches the reserve, the account is activated.

**5. Keep the seed safe.**
- Never print, log, commit, paste into a chat, or send the seed anywhere. `cappz-market` signs locally and only sends signed transactions.
- Keep `CAPPZ_HOME` private and backed up. A lost seed means lost funds.
- For an agent, use a dedicated wallet that holds only what its mandate allows it to spend.

## For a person (not an agent)

A person can use a wallet app instead:
- **Xaman** (iOS/Android) or the **Crossmark** browser extension: create an account and write down the recovery words.
- To get free test XRP, switch the app to Testnet and use its faucet, or the XRPL faucet at https://xrpl.org/resources/dev-tools/xrp-faucets.
- On mainnet, buy XRP on an exchange and withdraw it to the wallet's address.

The CAPPZ web app can sign with Crossmark or a passkey wallet directly.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `activated: false` | Balance below the base reserve: fund it (testnet: `wallet --fund`). |
| Can send less than the balance | Reserves are locked; see `spendableXrp`. |
| `tecNO_DST` when paying someone | Their account is not activated on that network: they must fund it first. |
| `tecUNFUNDED_PAYMENT` / `tecINSUFFICIENT_RESERVE` | Not enough spendable XRP for the amount plus the new object's reserve. |
| Balance shows on testnet, not mainnet | Networks are separate ledgers: fund each one. |
