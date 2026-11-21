---
name: running-edge-node-paid-agents
description: Runs the ready-made paid agents of a CAPPZ edge node — a signed timestamp (a file's SHA-256 in, a receipt signed by the node key out), a signed webhook receiver (a 30-day URL that signs every POST, then delivers a signed bundle), a fair draw (winners picked by an XRP Ledger hash nobody knew when the list was locked), a vault check (a signed report on whether a stolen key could empty an XRPL account) and a vault guard (the node as a pooled account's policy-bound co-signer for 30 days) — as a testnet instance and a mainnet instance behind HTTPS, with their guide, llms.txt, SKILL.md, OpenAPI and offline verifier, and offers them on the testnet and mainnet marketplaces. Use when asked to earn XRP from an always-on edge node, put a node's signing key to paid use, offer timestamping, tamper-evident webhook logs, provably fair draws or vault protection, or validate paid agents on testnet before mainnet.
---

# Running an edge node's paid agents

An always-on edge node already holds an Ed25519 node key. `packages/cappz-edge-node/agents/server.ts` turns that key into paid agents buyers hire over HTTP and pay in XRP, stage by stage, with each stage's destination tag. Full reference: [packages/cappz-edge-node/agents/README.md](../../packages/cappz-edge-node/agents/README.md).

| Agent | Buyer gets | Default price | Schedule |
|---|---|---|---|
| `timestamp` | A receipt: "the node saw this SHA-256 at this time". The file stays with the buyer. | 0.05 XRP | On completion |
| `webhook` | A 30-day URL. Each POST becomes a signed record; at the end, a signed bundle of all records. | 2 XRP | 30% deposit, 70% at the end |
| `draw` | Winners from a list, seeded by the first XRP Ledger ledger closed at or after the draw time; a signed commitment first, on a public log. | 0.1 XRP | Pay first; the draw is free |
| `vault-check` | A signed report on a pooled XRPL account: guard load-bearing or bypassable, worst case under a policy, outflows matched to approvals. No key held. | 1 XRP | On completion |
| `vault-guard` | The node is the vault's guard co-signer for 30 days: co-signs only inside the owner's policy, signs every decision, reconciles every 10 minutes, alerts, signed period report. Paid from the vault itself. | 10 XRP per 30 days | Pay first; the report is free |

## Requirements

- A running edge node with `CAPPZ_NODE_KEY` / `CAPPZ_NODE_PUB` in `node.env` (edge node README), Deno, and a public HTTPS name (for example Caddy on 443 with a DDNS name).
- A **public** payout address, activated on each network it is paid on. On mainnet it holds the base reserve, currently 1 XRP, so small payments can arrive. Never put a seed on the node.
- A CAPPZ account, signed in **by the person** (`cappz-market login`; the password is theirs to type), and a profile with `--xrplAccount <payout address>` on each network you list on.

## Workflow

```
Progress:
- [ ] Settings: agents.env (mainnet) and agents-testnet.env from the .example files; one data folder per network
- [ ] Launcher: run-agents.ps1 with $sdkCommit = the node's pin; deno cache the server once
- [ ] Startup shortcuts for both instances; TLS proxy routes /agents → 41460 and /testnet/* → 41461
- [ ] Check both: GET <base>/timestamp/health shows the right network; <base>/llms.txt and /SKILL.md load
- [ ] Signer vouched by the payout wallet, on the ledger with Xaman (see "Vouching for the signer"); restart the launchers; the agent card shows declaredBy = payout address
- [ ] Validate on testnet: hire each agent with a testnet wallet (cappz-market hire … --max …); receipt says network: testnet. For the draw: hire with a short list, then `node verify.mjs <result> <payout address>` must print VALID with the seed ledger checked
- [ ] Profile on both markets: cappz-market profile [--network mainnet] --name … --xrplAccount <payout>
- [ ] List on testnet, then on mainnet with --network mainnet, each --endpoint pointing at its own instance (follow skill **creating-cappz-listings**)
- [ ] Find them with cappz-market find "signed" and find "draw" [--network mainnet]
```

Write each listing's description for both kinds of reader. Include what the buyer gets, the schedule, and links to `<base>/#try-<agent>` (people), `<base>/<agent>/SKILL.md` (agents) and `<base>/llms.txt`. On testnet, say it is the testnet twin for validating before real XRP.

## Vouching for the signer (on the ledger, with Xaman)

The payout account signs one no-op `AccountSet` in Xaman whose memo names the node key. You run the tool; the person only approves on their phone. Never ask for a seed, and never type one.

1. **Check first:** `powershell -ExecutionPolicy Bypass -File "<node>\agents\declare-node-key.ps1" -Check -Json`. Nothing to do if a declaration is `declared` and its `until` is more than 14 days away.
2. **Xaman app key.** `<node>\agents\xaman.env` must hold `CAPPZ_XAMAN_API_KEY` and `CAPPZ_XAMAN_API_SECRET`. If it is missing, ask the person to create an app at https://apps.xumm.dev (sign in with Xaman, about 3 minutes) and save the two values there themselves. They can only request signatures, but they are still the person's credentials: do not paste them into chats or logs.
3. **Tell the person what to expect**, then run `declare-node-key.ps1 -Json`: "A QR code will open. In Xaman tap Scan, check the account is <payout address>, and slide to accept. It changes nothing on the account; the fee is about 0.00001 XRP." Progress goes to stderr; the last stdout line is the JSON result. It waits up to 15 minutes.
4. **Read the result:**

| Exit | stdout JSON | Do |
|---|---|---|
| 0 | `{"ok":true,"action":"declare","txHash","ref":"xrpl:mainnet:…","until"}` | From 15.47.0 the agents find it on the ledger themselves within the hour (restart the launchers to see it at once); nothing to copy, and it doesn't matter which machine ran the script. Older agents: restart both launchers the first time. Confirm `GET <base>/timestamp/agent` shows `declaredBy.onLedger` and `isPayTo: true` |
| 3 | `declined` or `expired` in Xaman | Ask whether to try again. Never retry on your own |
| 4 | not seen on the ledger in time | Ask the person for the transaction hash from Xaman's history, then run `-Hash <hash>` |
| 1 | `error` text | Usually: the account is not activated on that network, the app key is wrong (Xaman refused), or the XRP Ledger was unreachable. Fix that and rerun |

- **Try it on testnet first** if the person has never done it: `-Network testnet` (in Xaman: Settings > Advanced > Developer mode, using a funded testnet account). Use `-Account <r…>`, since agents.env holds the mainnet payout address.
- **Renew** the same way before `until` passes; the agents' log warns 14 days ahead. A declaration lasts at most 90 days (`-Days`).
- **Revoke** if `node.env` may have leaked: `declare-node-key.ps1 -Revoke` (another Xaman approval). The agents stop signing within 5 minutes and verifiers refuse right away. Then rotate the node key.
- **No Xaman?** Without an app key, the tool prints the transaction JSON for any wallet that signs one, and waits for it on the ledger the same way. `-Seed` is the older off-ledger method: the person types the seed at a hidden prompt, ideally on another machine, then copies `key-declarations.json` over.

## Fair draw notes

- Update an older node: copy the new `server.ts`, `draw.ts` and `docs/` (or move the SDK pin), add the three `CAPPZ_DRAW_*` lines to both settings files, and restart both launchers. The draw needs no new route in the proxy: it lives under `/agents/draw` and `/testnet/agents/draw`.
- List it on each market with its own endpoint, e.g. `cappz-market sell --category agents --kind service --unit draw --price 0.1 --currency XRP --quantity 1000 --leadDays 0 --endpoint <base>/draw --title "Fair draw: provably unrigged giveaway and raffle winners" --description "… try it: <base>/#try-draw · agents: <base>/draw/SKILL.md"`.
- `<data>/draw/commitments.jsonl` is the public log. Never edit or delete lines: verifiers rely on the chain (`seq`, `previousCommitment`), and a gap looks like a hidden commitment. Back it up with the jobs.
- A paid draw whose node was down at its draw time is still drawn when the node returns, from the ledger the rule names. Nothing is redrawn.

## Vault agents notes (15.49.0)

- **Guard secret.** The vault guard needs `CAPPZ_VAULT_GUARD_SECRET` (32 random bytes, hex) in `node.env`. Both instances share it; the network is part of each guard key's derivation. Generate it on the node:

  ```powershell
  $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  Add-Content node.env ("CAPPZ_VAULT_GUARD_SECRET=" + (($b | ForEach-Object { $_.ToString('x2') }) -join ''))
  ```

  Back it up with `node.env`. If it is lost, every customer's guard address changes, and their routine payments stop until their recovery keys replace the guard. Never rotate it while guards are active. Without it, only `vault-check` is offered.
- **Settings.** `CAPPZ_VAULT_CHECK_PRICE_XRP`, `CAPPZ_VAULT_GUARD_PRICE_XRP` and `CAPPZ_VAULT_GUARD_DAYS` go in both settings files. Restart both launchers. No new proxy route is needed: the agents live under `/agents/vault-*` and `/testnet/agents/vault-*`.
- **What customers rely on.** While a guard period is active, the customer's routine payments need this node. Keep it up, and keep `<data>/vault-guard/` (approvals, decisions, alerts) with the job backups.
- **Abuse is closed by design.** A guard period counts only when the vault itself paid it, and a policy change only when that payment was signed without the guard (recovery keys or the master key). An unauthorised job answers co-sign requests with 403.

## Rules

- **Testnet first, every time.** Change prices, schedules or code on the testnet instance, hire it end to end, then move to mainnet.
- Every record is signed with `payload.network`. Never strip it: both instances share the node key, so a free testnet receipt must never pass for a paid mainnet one.
- Change the settings file, then restart the **launcher**, not only the agent process: it reads settings once at start.
- Keep the jobs server and agents on 127.0.0.1. Publish only `/agents` and `/testnet/` through the proxy.
- Moving to mainnet, and every mainnet listing, needs the person's OK.
- Anchor trust in the wallet, not the certificate: the proxy's public-CA certificate is only for `https://`. The payout wallet's KeyZ declaration, on the ledger, says who signs (`verify.mjs <file> <payout r-address>`). Renew it before its 90 days run out (`declare-node-key.ps1 -Check`). If the node key may have leaked, `-Revoke` first.
- A wallet approval moves the person's account, even when it only costs a fee. Run the tool only when the person has asked for it, and always say what they are about to approve.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Health shows the old network after editing the settings | The launcher was not restarted |
| Buyer's payment fails with `tecNO_DST_INSUF_XRP` | The payout address is not activated on that network |
| 402 persists after paying | Missing or wrong destination tag; or wait ~15 s for the ledger match, or `POST …/payments {"txHash"}` |
| `{{NAME}}` visible in a served doc | A template uses a placeholder `docs.ts` does not define (the SDK test catches this) |
| Agents exit at start: "on-ledger declaration … could not be read" | The XRP Ledger was unreachable at start. The launcher retries every 10 s; once running, the last good answer is kept |
| Log: "signing paused" | The declaration expired or was revoked. Renew with `declare-node-key.ps1` |
| Xaman says the request is for another network | `-Network` does not match the network Xaman is on |
