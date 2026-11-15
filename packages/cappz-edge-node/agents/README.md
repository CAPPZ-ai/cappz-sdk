# Paid agents for an edge node

Two pay-per-job agents an edge node can sell on the CAPPZ Marketplace, built on the SDK's paid-agent kit (`@cappz/sdk/paidAgent`). Buyers pay in XRP on the XRP Ledger. The node's Ed25519 key signs every result, and anyone can check it offline.

| Agent | What the buyer gets | Price (default) | Schedule |
|---|---|---|---|
| `timestamp` | A receipt saying the node saw a SHA-256 at a time. The file never leaves the buyer. | 0.05 XRP | On completion: the buyer sees the receipt's SHA-256, pays, then downloads it |
| `webhook` | A webhook URL for 30 days. Each POST becomes a signed record, and at the end a signed bundle of all records. | 2 XRP | 30% deposit opens the URL; 70% when the bundle is ready |

Each agent speaks the paid-agent protocol that `cappz-market hire` uses (see [skills/hiring-cappz-paid-agents](../../../skills/hiring-cappz-paid-agents/SKILL.md)). The server also serves docs for both kinds of reader, filled with the instance's live price, network, payout address and signer:

| Path | For |
|---|---|
| `/agents/` | People: what each agent does, try-it forms (hash a file in the browser, pay from any XRPL wallet, download the receipt) and an in-browser verifier. Agents asking for JSON get the agent list with doc links. |
| `/agents/llms.txt` | Agents: one page with the fastest path |
| `/agents/<agent>/SKILL.md` | An Agent Skill per agent |
| `/agents/openapi.json` | OpenAPI 3.1 for every route |
| `/agents/verify.mjs` | Offline verifier: `node verify.mjs receipt.json <node key, or the declaring wallet's r-address>` (Node 20+ or Deno, no dependencies) |
| `/agents/key-declarations.json` | The wallet-signed declaration of the node key and any revocations (15.44.0) |
| `/agents/<agent>/agent` | Agent card (price, stages, payTo, network, signer) with a `docs` field linking the above |

A browser opening an agent's URL, for example from its marketplace card, is redirected to that agent's try-it form.

## A wallet vouches for the signer, not the certificate (15.44.0)

The HTTPS certificate in front of the agents (Caddy with Let's Encrypt) is still needed. Browsers, XRPL wallets and `cappz-market hire` only accept a public-CA certificate for `https://`. But that certificate proves who controls the DNS name, not who signs the receipts. Without a declaration, a buyer learns the signing key from that page, so whoever takes over the name (a hijacked dynamic-DNS account, for example) could serve another key.

With a KeyZ declaration, the payout wallet itself vouches for the node key. There are two ways to sign it.

### On the ledger with Xaman (recommended, no seed anywhere)

The payout account signs one XRPL transaction in Xaman. The transaction is an `AccountSet` that changes nothing on the account; its memo names the node key. Fee: about 0.00001 XRP.

**One-time setup (about 3 minutes).** Xaman shows a sign request only when a registered app creates it:

1. Go to [apps.xumm.dev](https://apps.xumm.dev), sign in with Xaman, and create an app (any name, for example "my CAPPZ node").
2. Copy its API key and API secret into `<node folder>\agents\xaman.env`:
   ```
   CAPPZ_XAMAN_API_KEY=…
   CAPPZ_XAMAN_API_SECRET=…
   ```
   These can only *ask* you to sign. They cannot sign or move funds.
3. Copy `declare-node-key.ps1` into `<node folder>\agents\`, next to `run-agents.ps1`.

**Declare (now, and again before 90 days run out).** Right-click `declare-node-key.ps1` > Run with PowerShell, or:

```powershell
powershell -ExecutionPolicy Bypass -File "<node folder>\agents\declare-node-key.ps1"
```

1. A QR code opens in the browser.
2. In Xaman, tap **Scan**, check the account is your payout address, and slide to accept.
3. The script waits for the ledger to validate the transaction (a few seconds), then writes `<node folder>\data\key-declarations.json`.
4. Restart the launchers (or reboot) the first time. After that, renewals are picked up within a minute.

| Option | Use |
|---|---|
| `-Check` | Show the state (no wallet needed) |
| `-Revoke` | Withdraw it with another Xaman approval. The agents stop signing within 5 minutes; verifiers see it at once |
| `-Network testnet` | Try it with test XRP first (in Xaman: Settings > Advanced > Developer mode) |
| `-Hash <tx>` | Register a declaration you signed and submitted another way |
| `-Json` | One JSON result line, for agents and scripts |

No Xaman app key? The script prints the transaction JSON for any wallet that can sign one, then waits for it on the ledger the same way.

The rules (`ledgerKeyz.ts`, repeated without dependencies in `docs/verify.mjs`):

- Records sign in `payload.signerDeclaration = "xrpl:<network>:<tx hash>"`.
- A declaration counts while it is validated with `tesSUCCESS`, its memo names the key and `signing`, the record falls inside its window (at most 90 days), and no later revocation memo from the same account exists.
- The ledger has already checked the account authorized it, so Ed25519 accounts, regular keys and multisign accounts all work.
- `verify.mjs` reads the transaction and the account's later history from public XRPL servers. With `--offline`, the signer stays unproven.

### Off the ledger with the seed

```powershell
# Once, and again before it expires (at most 90 days). The seed is typed at a hidden prompt, used in memory, never stored.
powershell -ExecutionPolicy Bypass -File "<node folder>\agents\declare-node-key.ps1" -Seed
# or directly:
deno run --config <sdk>\deno.json --allow-read --allow-write --allow-env <sdk>\packages\cappz-edge-node\tools\declare-node-key.ts `
  --env <node folder>\node.env --out <node folder>\data\key-declarations.json --purposes signing,hello --expect <payout r-address>
```

Use this when verification must work fully offline, or the node also needs a `hello` declaration (mesh peers and KeyZ Gate read only wallet-signed declarations). Running it on another machine and copying `key-declarations.json` over (it holds only public data) keeps the seed off the node.

### Either way

- `run-agents.ps1` picks up `<node folder>\data\key-declarations.json` (`CAPPZ_NODE_KEY_DECLARATIONS`).
- From then on every record signs in `payload.signerDeclaration`. Results carry the declaration, and `verify.mjs <file> <r-address>` checks the wallet's secp256k1 signature offline.
- The agent card and `/agents/` show `declaredBy`.
- The same file is the node's own evidence for KeyZ Gate.
- `--check` prints the state.
- `--revoke` signs a revocation into `key-revocations.json`. Within a minute the agents stop signing, and receipts under that declaration then fail `verify.mjs --evidence`.
- Seed method only: the declaring account must be secp256k1 (most family seeds). Ed25519 XRPL accounts are refused. On the ledger, any account works.
- If the file is set but holds no valid declaration of this key, the agents refuse to start or to sign.


## Two networks: validate on testnet, earn on mainnet

Run one instance per network. Both use the same node key, so every signed record carries `payload.network`. A free testnet receipt never passes for a paid mainnet one; the verifiers show the network and flag test records. Each instance's docs link the other ("validate on testnet first").

List each agent on both marketplaces, pointing at its own instance:

```bash
cappz-market sell --category agents --kind service --unit job --price 0.05 --currency XRP --quantity 1000 --leadDays 0 \
  --endpoint https://node.example.com/testnet/agents/timestamp --title "…" --description "… guide: https://node.example.com/testnet/agents/#try-timestamp"
cappz-market sell --network mainnet …  --endpoint https://node.example.com/agents/timestamp …
```

## Run (Windows edge node)

Lay out the files in the node folder that already holds `run.ps1`, `node.env` and `sdk-<commit>\` (see the [edge node README](../README.md)):

```
<node folder>\agents\run-agents.ps1        copy of run-agents.ps1, $sdkCommit = the node's pin
<node folder>\agents\declare-node-key.ps1  copy of declare-node-key.ps1 (reads the pin from run-agents.ps1)
<node folder>\agents\xaman.env             optional: CAPPZ_XAMAN_API_KEY / CAPPZ_XAMAN_API_SECRET for Xaman sign requests
<node folder>\agents\agents.env            from agents.env.example (mainnet)
<node folder>\agents\agents-testnet.env    from agents-testnet.env.example
<node folder>\agents\data\                 jobs, results, logs (created on start)
```

1. Cache the server once: `deno cache --config sdk-<commit>\deno.json sdk-<commit>\packages\cappz-edge-node\agents\server.ts` (the launcher runs with `--cached-only`).
2. Add two Startup shortcuts, one per instance:
   `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<node folder>\agents\run-agents.ps1"` and the same with `-EnvFile agents-testnet.env -Name testnet`.
3. Publish both through the node's TLS proxy. With Caddy:

```
handle /agents* {
	reverse_proxy 127.0.0.1:41460
}
handle_path /testnet/* {
	reverse_proxy 127.0.0.1:41461
}
```

`handle_path` strips `/testnet`, so the testnet instance sees `/agents/…` like the mainnet one.

Settings (env file): `CAPPZ_AGENT_PAYTO` (public payout address, required; it must be activated on that network), `CAPPZ_AGENT_NETWORK`, `CAPPZ_AGENT_PORT`, `CAPPZ_AGENT_PUBLIC_BASE`, `CAPPZ_AGENT_PEER_BASE`, `CAPPZ_AGENT_DATA` (required, one folder per network), `CAPPZ_TIMESTAMP_PRICE_XRP`, `CAPPZ_WEBHOOK_PRICE_XRP`, `CAPPZ_WEBHOOK_DAYS`. Docs templates are re-read on every request, so wording changes need no restart. Settings changes need the launcher restarted.

## Limits and behaviour

- Listens on 127.0.0.1 only and holds no seed: buyers pay the payout address with each stage's destination tag. Payments are matched on the validated ledger every 15 s, or at once via `POST …/payments`.
- Webhook bodies are limited to 64 KB and 10,000 records per period. A POST before the deposit gets 402, after the period 410. The status GET shows a count, never bodies.
- The webhook's completion work sleeps until the period ends; payments for it are matched outside `tick()`, which would otherwise wait on that work.
