# cappz-check — CAPPZ counterparty check on a Cloudflare Worker

A paid agent (the `@cappz/sdk/paidAgent` protocol) that checks an XRPL address or a CAPPZ marketplace party before someone pays it, and returns a signed ok / warn / stop report. It costs 0.01 XRP per check, paid to the CAPPZ treasury. Agents use it with `cappz-market check`; the guide is [skills/checking-xrpl-counterparties](../../skills/checking-xrpl-counterparties/SKILL.md).

- **Runs on the Cloudflare free plan:** Workers (100k requests a day) and D1 (the job log). Ledger reads use XRPL JSON-RPC over HTTPS; marketplace history comes from the public log.
- **Holds no seed:** only the treasury's public addresses, plus `CHECK_SIGNING_SEED` (Ed25519, a Worker secret) to sign reports. Publish the matching public key in the marketplace's discovery document.
- **Routes:**
  - `GET /`: service, price, public key.
  - `/<testnet|mainnet>/agent`: the agent card.
  - `POST /<net>/jobs`, then pay, then `GET /<net>/jobs/<id>/stages/0/result`.
  - `POST /<net>/jobs` input: `address` or `party`, optional `amountXrp`, `payer`, `escrowLegs`, and `currency` + `amount` for CAPPZ or USD-tokenZ/1 (RLUSD), which adds both trust lines and the issuer's flags.
  - `POST /<net>/authorize` (free): a deal-bound signing approval. Body `{"contractId", "milestone", "tx"}` with the unsigned, autofilled transaction: an escrow (`EscrowCreate`/`Finish`/`Cancel`), a token stage `Payment`, or a `PaymentChannelCreate`/`PaymentChannelClaim`. It replays the public log now (never cached) and answers a signed approval of exactly that transaction, or the reasons it is refused. It verifies the request's RFC 9421 signature against the agent's declared key and records the state; when the agent's mandate binds a key, only `verified-bound` requests are approved. Same key, separate signature domain. Rules: `src/lib/marketplace/signingApproval.ts`.
  - `GET /.well-known/agent-card.json` (and `/<net>/.well-known/agent-card.json`): the service's signed A2A agent card.
  - `GET /<net>/reputation/<partyId>` (free): a signed reputation attestation (`src/lib/marketplace/reputationAttestation.ts`).

## Deploy

```bash
cd packages/cappz-check-worker
wrangler d1 create cappz-check                       # put the database_id in wrangler.toml
wrangler d1 execute cappz-check --remote --file=schema.sql
wrangler deploy
python3 -c 'import secrets;print(secrets.token_hex(32))' | wrangler secret put CHECK_SIGNING_SEED
curl https://<worker>/key                            # publish this publicKey in /.well-known/cappz-market.json
```

Local: put `CHECK_SIGNING_SEED=<hex>` in `.dev.vars`, then `wrangler d1 execute cappz-check --local --file=schema.sql && wrangler dev`.

Pay-to addresses (`PAY_TO_MAINNET`, `PAY_TO_TESTNET`) must be activated accounts without DepositAuth, because a 0.01 XRP payment cannot activate an account.

## Custom domain

Production is served at **https://check.cappz.ai** (a custom domain on the cappz.ai zone, set in `wrangler.toml` `routes`), and also at the account's workers.dev address. The marketplace's discovery document (`services.counterpartyCheck.url`) names check.cappz.ai.
