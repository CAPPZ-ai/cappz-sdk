# Paid agents for an edge node

Pay-per-job agents an edge node can sell on the CAPPZ Marketplace, built on the SDK's paid-agent kit (`@cappz/sdk/paidAgent`). Buyers pay in XRP on the XRP Ledger. The node's Ed25519 key signs every result, and anyone can check it offline.

| Agent | What the buyer gets | Price (default) | Schedule |
|---|---|---|---|
| `timestamp` | A receipt saying the node saw a SHA-256 at a time. The file never leaves the buyer. | 0.05 XRP | On completion: the buyer sees the receipt's SHA-256, pays, then downloads it |
| `webhook` | A webhook URL for 30 days. Each POST becomes a signed record, and at the end a signed bundle of all records. | 2 XRP | 30% deposit opens the URL; 70% when the bundle is ready |
| `draw` (15.47.0) | A fair draw: winners picked from a list by the hash of an XRP Ledger ledger closed after the list was locked. Anyone can recompute them. | 0.1 XRP | Pay first (the whole price); the signed draw is free when ready |
| `vault-check` (15.49.0) | A signed report on a pooled XRPL account: whether a guard co-signer is load-bearing or a stolen key could move money alone; with a policy, the worst case; with the guard's approvals, every recent outflow matched. Read from the ledger, no key held. | 1 XRP | On completion |
| `vault-guard` (15.49.0) | The node is the vault's guard co-signer for 30 days: co-signs only inside the owner's outflow policy, signs every decision, reconciles every 10 minutes and POSTs an alert on any outflow it did not approve, then a signed period report. Needs `CAPPZ_VAULT_GUARD_SECRET`. | 10 XRP per 30 days | Pay first, **from the vault**; the report is free |

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

## Fair draw (15.47.0)

Giveaways, raffles, audit samples, selection by lot: the organizer wants winners nobody can say were rigged.

1. The buyer opens a job with the list (`entries`, up to 10,000) or only its fingerprint (`entriesSha256` = SHA-256 of `JSON.stringify(entries)`, plus `count`, up to 1,000,000), `winners`, an optional `drawAt` (≤ `CAPPZ_DRAW_MAX_DAYS`) and `public`.
2. They pay the one stage. The node then signs `DrawCommitted`: fingerprint, count, winners, draw time (never sooner than `CAPPZ_DRAW_MIN_LEAD_SECONDS` after the commitment) and `afterLedger`, the latest validated ledger. The commitment is appended to `<data>/draw/commitments.jsonl`, served at `/agents/draw/log` and `/agents/draw/commitments/<jobId>`. Each names the one before it (`seq`, `previousCommitment`).
3. At the draw time the node finds the first validated ledger closed at or after it (binary search from `afterLedger`), seeds rule `cappz-draw/v1` with its hash, picks, and signs `DrawPerformed`. The result (stage 1, free) holds both records, the winners and the entries if sent. With `public: true` it is also served at `/agents/draw/draws/<jobId>`, a page that re-checks it in the browser.

Why nobody can steer it: the list is paid for and locked before the seed ledger exists. The seed depends only on the ledger hash and the list, so a second commitment of the same list draws the same winners. Another list costs another commitment, and every commitment is on the public log. A buyer who pays after the requested draw time gets the earliest allowed time instead; the commitment records both.

The rule is written out in `draw.ts` and in the served `draw/SKILL.md`. `verify.mjs` repeats it without dependencies: `node verify.mjs draw.json <payout r-address> [--entries list.txt]`. The draw's work waits for its time, so the server matches its payments itself (`watchLong`, as for the webhook) rather than through `tick()`.

## Vault check and vault guard (15.49.0)

Both agents use the SDK's Vault Guard (`src/lib/treasury/vaultGuard.ts`; guide `docs/VAULT_GUARD.md`); the agent code is in `vault.ts`.

- **Guard keys.** Each vault's guard key is derived as HMAC-SHA256(`CAPPZ_VAULT_GUARD_SECRET`, `cappz-vault-guard/v1|<network>|<vault>`), with the first 16 bytes used as Ed25519 entropy. The same vault always gets the same guard address, so renewals keep the signer list. Nothing per vault is stored. Rotating the receipt key (`CAPPZ_NODE_KEY`) never changes a guard. `GET /agents/vault-guard/guard/<vault>` returns the address (free).
- **Who may start or change a guard.** A period counts only when **the vault paid it**. A job with a policy different from the vault's current one counts only if its payment was signed **without** the guard: the master key before setup, or the recovery keys. Operators can renew the same policy through the guard but can never loosen it. Unauthorised jobs answer co-sign with 403. Tested on testnet: a loosened policy paid through the guard returns `policy-change-needs-recovery`, and a stranger's payment returns `not-from-vault`.
- **Co-signing.** `POST /agents/vault-guard/cosign/<jobId> {"tx": <autofilled for 2 signers>}`. The node reads the account's next sequence, the current ledger and its validated history since the first guard period, counts the window (validated outflows plus approvals not yet expired), and signs a `VaultCosignDecided` record either way. The approval is appended to `<data>/vault-guard/approvals-<vault>.jsonl` **before** the blob is returned. Requests are serialised, so two can't share one window.
- **Watching.** Every `CAPPZ_VAULT_RECONCILE_SECONDS` (default 600), each active, authorised period reconciles its vault. Each new unapproved outflow becomes a signed `VaultOutflowUnapproved` record in `alerts-<vault>.jsonl`, POSTed to the buyer's `alertUrl`.
- **End of period:** a signed `VaultGuardPeriodClosed` report (decisions, reconciliation, alerts, setup state, authorisation), free.
- **Back up** `CAPPZ_VAULT_GUARD_SECRET` with `node.env`, and `<data>/vault-guard/` with the jobs. A lost secret changes every guard address; customers then need their recovery keys.
- **Real testnet run:** `npx vite-node tools/vault-agents-testnet.ts` starts this server on 127.0.0.1:41470 with throwaway keys and runs every step above with real payments.

## Sealed store (16.5.0)

Storage a group of wallets shares and only its members can open (`sealed.ts` rules, `sealedServer.ts` I/O; SDK `@cappz/sdk/sealed`). Writers seal each object on their own machine; the node stores ciphertext only.

- **Boxes.** A job `{"gb", "writers", "label"?}` opens a box of whole gigabytes for `CAPPZ_SEALED_DAYS` (default 30) at `CAPPZ_SEALED_PRICE_XRP_PER_GB` × gb, paid up front (`priceFor`). `{"renews": "<boxId>", "gb"?}` pays the next period: it starts when the current one ends, or at payment if later. After the last period the box is read-only for `CAPPZ_SEALED_GRACE_DAYS` (default 7), then its bytes are deleted and `SealedBoxPurged` is signed; the records stay. A renewal paid after the grace never revives a box (refund it by hand). The free second stage is the signed period report.
- **Writes.** `POST /agents/sealed-store/boxes/<boxId>/objects`: sealed bytes as the body, the wallet-signed write record (base64url JSON) in `x-cappz-sealed-record`. The node checks signature, writer, clock (±10 min), size and SHA-256 while streaming, object size (`CAPPZ_SEALED_MAX_OBJECT_MB`, default 256), quota, and that the record names the object's current version (409 otherwise), then signs `SealedObjectStored`. `POST …/purges` frees a version (`SealedVersionPurged`). Reads (`GET …/boxes/<id>`, `GET …/blobs/<sha256>`) and the key directory (`POST /keys`, `POST /keys/revocations`, `GET /keys/<wallet>`) are free.
- **Drive and capacity.** `CAPPZ_SEALED_STORE_DIR` puts the store on any drive (a USB disk, e.g. `D:\cappz-sealed`), one subfolder per network; `run-agents.ps1` grants read and write there. If the drive is missing at start, the sealed store answers 503 and the other agents run. `CAPPZ_SEALED_MAX_GB` (default 50) caps what the instance sells at once: quotas of active and grace boxes plus openings from the last hour not yet paid. Keep the sum over instances under the drive's free space.
- **Tests:** rules in `src/test/edge-node-sealed.test.ts`; the routes end to end under Deno: `deno test --config deno.json --allow-read --allow-write --allow-env packages/cappz-edge-node/agents/sealed_server_test.ts`.

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

### 15.47.0: nothing to copy

The agents read the payout account's ledger history themselves (`discoverLedgerAnchors`, hourly) and use any valid on-ledger declaration of their node key that they find there. After the Xaman approval, first time or renewal, there is no file to copy and no restart: a renewal is picked up within the hour, and the 14-day expiry warning in the log tells you when to renew. Settings: `CAPPZ_KEYZ_ACCOUNT` (default `CAPPZ_AGENT_PAYTO`), `CAPPZ_KEYZ_NETWORK` (default `mainnet`, also for the testnet instance), `CAPPZ_KEYZ_DISCOVER=0` to turn it off. Once the account has declared the key, signing pauses whenever no declaration is valid, as with a file. The script still writes `key-declarations.json`, which keeps working and is what `-Check` reads.

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
