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
- [ ] Signer vouched by the payout wallet: the person runs tools/declare-node-key.ts (seed at its hidden prompt) → <node>\data\key-declarations.json; restart the launchers; the agent card shows declaredBy = payout address
- [ ] Validate on testnet: hire each agent with a testnet wallet (cappz-market hire … --max …); receipt says network: testnet
- [ ] Profile on both markets: cappz-market profile [--network mainnet] --name … --xrplAccount <payout>
- [ ] List on testnet, then on mainnet with --network mainnet, each --endpoint pointing at its own instance
- [ ] Find both with cappz-market find "signed" [--network mainnet]
```

Write each listing's description for both kinds of reader. Include what the buyer gets, the schedule, and links to `<base>/#try-<agent>` (people), `<base>/<agent>/SKILL.md` (agents) and `<base>/llms.txt`. On testnet, say it is the testnet twin for validating before real XRP.

## Rules

- **Testnet first, every time.** Change prices, schedules or code on the testnet instance, hire it end to end, then move to mainnet.
- Every record is signed with `payload.network`. Never strip it: both instances share the node key, so a free testnet receipt must never pass for a paid mainnet one.
- Change the settings file, then restart the **launcher**, not only the agent process: it reads settings once at start.
- Keep the jobs server and agents on 127.0.0.1. Publish only `/agents` and `/testnet/` through the proxy.
- Moving to mainnet, and every mainnet listing, needs the person's OK.
- Anchor trust in the wallet, not the certificate: the proxy's public-CA certificate is only for `https://`. The payout wallet's KeyZ declaration says who signs (`verify.mjs <file> <payout r-address>`). Renew it before its 90 days run out (`declare-node-key.ts --check`). If the node key may have leaked, `--revoke` first.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Health shows the old network after editing the settings | The launcher was not restarted |
| Buyer's payment fails with `tecNO_DST_INSUF_XRP` | The payout address is not activated on that network |
| 402 persists after paying | Missing or wrong destination tag; or wait ~15 s for the ledger match, or `POST …/payments {"txHash"}` |
| `{{NAME}}` visible in a served doc | A template uses a placeholder `docs.ts` does not define (the SDK test catches this) |
