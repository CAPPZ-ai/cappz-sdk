---
name: running-edge-node-paid-agents
description: Runs the ready-made paid agents of a CAPPZ edge node — a signed timestamp (a file's SHA-256 in, a receipt signed by the node key out) and a signed webhook receiver (a 30-day URL that signs every POST, then delivers a signed bundle) — as a testnet instance and a mainnet instance behind HTTPS, with their guide, llms.txt, SKILL.md, OpenAPI and offline verifier, and offers both on the testnet and mainnet marketplaces. Use when asked to earn XRP from an always-on edge node, put a node's signing key to paid use, offer timestamping or tamper-evident webhook logs, or validate paid agents on testnet before mainnet.
---

# Running an edge node's paid agents

An always-on edge node already holds an Ed25519 node key. `packages/cappz-edge-node/agents/server.ts` turns that key into two paid agents buyers hire over HTTP and pay in XRP, stage by stage, with each stage's destination tag. Full reference: [packages/cappz-edge-node/agents/README.md](../../packages/cappz-edge-node/agents/README.md).

| Agent | Buyer gets | Default price | Schedule |
|---|---|---|---|
| `timestamp` | A receipt: "the node saw this SHA-256 at this time". The file stays with the buyer. | 0.05 XRP | On completion |
| `webhook` | A 30-day URL. Each POST becomes a signed record; at the end, a signed bundle of all records. | 2 XRP | 30% deposit, 70% at the end |

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
- [ ] Validate on testnet: hire each agent with a testnet wallet (cappz-market hire … --max …); receipt says network: testnet
- [ ] Profile on both markets: cappz-market profile [--network mainnet] --name … --xrplAccount <payout>
- [ ] List on testnet, then on mainnet with --network mainnet, each --endpoint pointing at its own instance
- [ ] Find both with cappz-market find "signed" [--network mainnet]
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
| 0 | `{"ok":true,"action":"declare","txHash","ref":"xrpl:mainnet:…","until"}` | Restart both launchers the first time (later renewals are picked up within a minute). Confirm `GET <base>/timestamp/agent` shows `declaredBy.onLedger` and `isPayTo: true` |
| 3 | `declined` or `expired` in Xaman | Ask whether to try again. Never retry on your own |
| 4 | not seen on the ledger in time | Ask the person for the transaction hash from Xaman's history, then run `-Hash <hash>` |
| 1 | `error` text | Usually: the account is not activated on that network, the app key is wrong (Xaman refused), or the XRP Ledger was unreachable. Fix that and rerun |

- **Try it on testnet first** if the person has never done it: `-Network testnet` (in Xaman: Settings > Advanced > Developer mode, using a funded testnet account). Use `-Account <r…>`, since agents.env holds the mainnet payout address.
- **Renew** the same way before `until` passes; the agents' log warns 14 days ahead. A declaration lasts at most 90 days (`-Days`).
- **Revoke** if `node.env` may have leaked: `declare-node-key.ps1 -Revoke` (another Xaman approval). The agents stop signing within 5 minutes and verifiers refuse right away. Then rotate the node key.
- **No Xaman?** Without an app key, the tool prints the transaction JSON for any wallet that signs one, and waits for it on the ledger the same way. `-Seed` is the older off-ledger method: the person types the seed at a hidden prompt, ideally on another machine, then copies `key-declarations.json` over.

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
