# cappz-check — CAPPZ check service on a Cloudflare Worker

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

## Stage evaluator, listing drafter, subcontract scout (15.32.0)

Three more paid agents on the same worker, each with its own card, price and pay-to address (`AGENT_PAY_TO_MAINNET` / `AGENT_PAY_TO_TESTNET`; the testnet address must be an activated testnet account):

| Route | What | Price (`PRICE_*_XRP`) | Guide |
|---|---|---|---|
| `/<net>/evaluate` | A signed pass / fail / needs-human verdict on a delivered file against the milestone's agreed acceptance criteria. Body `{"input": {"contractId", "milestone"?, "acceptance"?}, "file": "<base64>"}`; the file is hashed, checked and not stored. Refusals (not the evidence, nothing to evaluate) cost nothing. | 0.05 XRP | [skills/evaluating-cappz-deliverables](../../skills/evaluating-cappz-deliverables/SKILL.md) |
| `/<net>/draft` | Plain words → a checked `cappz-market sell` / `ask` command. Input `{"text", "intent"?, "region"?}`. | 0.02 XRP | [skills/drafting-cappz-listings](../../skills/drafting-cappz-listings/SKILL.md) |
| `/<net>/envelope` | Manual or datasheet text → a draft Constraint Guard envelope; every limit quoted verbatim with its numbers, authority never drafted. Input `{"text", "device"?}`. | 0.05 XRP | [skills/securing-control-systems](../../skills/securing-control-systems/SKILL.md) |
| `/<net>/review` | A guard's shadow report → enforce now / keep shadow / investigate per point, with the exact command. Rules only. Input `{"report"}`. | 0.02 XRP | [skills/securing-control-systems](../../skills/securing-control-systems/SKILL.md) |
| `/<net>/triage` | A reconciliation report → severity, likely meaning, ordered actions. Rules only. Input `{"report"}`. | 0.02 XRP | [skills/monitoring-constraints](../../skills/monitoring-constraints/SKILL.md) |
| `/<net>/scout` | Work packages, candidates and `subcontract` commands for a contract. Input `{"contractId", "budgetShare"?, "need"?}`. | 0.05 XRP | [skills/scouting-cappz-subcontractors](../../skills/scouting-cappz-subcontractors/SKILL.md) |

Each answers `/agent`, `/health`, `POST /jobs`, `/jobs/<id>`, `/jobs/<id>/payments`, `/jobs/<id>/stages/0/result`, like the check. Jobs are partitioned per agent in D1 (`<network>:<agent>`).

**Model.** Rubric questions, drafts and scout plans use `MODEL` (default `claude-haiku-5-5`, low effort, structured output) with the key as a secret: `wrangler secret put ANTHROPIC_API_KEY`. Larger models (`claude-sonnet-5-5`, `claude-opus-5-5`) also get the server-side refusal fallback. Without a key, the evaluator runs rule criteria only (rubric questions → needs-human), the scout plans one package per open milestone, and the drafter answers 503 before any job opens. Model answers never bind: `src/lib/marketplace/{stageEvaluation,listingDraft,subcontractScout}.ts` check every one.

**Cost per job** (assumptions: `claude-haiku-5-5` at $0.10 / $0.50 per million input / output tokens; XRP at $2.50; Workers and D1 on the free plan):

| Agent | Model tokens (worst case) | Model cost | Price | Price in USD |
|---|---|---|---|---|
| evaluate, rules only | none | $0 | 0.05 XRP | $0.125 |
| evaluate with rubric | ≤ 10k in (40,000-character cap) + ~1k out | ≤ $0.0015 | 0.05 XRP | $0.125 |
| draft | ~2.5k in + ~1k out | ~$0.0008 | 0.02 XRP | $0.05 |
| scout | ~1k in + ~1k out | ~$0.0006 | 0.05 XRP | $0.125 |

The stable instructions and catalog are prompt-cached. The price pays for the model, the ledger reads and the operator's time; prices are configuration (`PRICE_*_XRP`) and change only for jobs opened after the change.

## Payee confirmation (15.38.0)

`/<net>/payee`: are these payment instructions the ones the payee declared on the market and endorsed from its own XRPL wallet, past the cooling period — not merely an address that exists? Input `{"payee": "p-…", "address": "r…", "destinationTag"?}` or `{"payee": "p-…", "bankDigests": [...]}`, optionally `payer`, `amount`, `currency`, `contractId`, `coolingHours`. An unknown payee answers 404 before any job opens. Rules: [payeeConfirmation.ts](../../src/lib/marketplace/payeeConfirmation.ts); guide: [skills/confirming-payees](../../skills/confirming-payees/SKILL.md).

One job pays two parties, nobody forwarding money: stage 0 (upfront) is the **platform fee**, `PRICE_PAYEE_PLATFORM_XRP` (0.01 XRP) to the treasury (`PAY_TO_*`); stage 1 (completion) is the **service fee**, `PRICE_PAYEE_XRP` (0.1 XRP) to the operator (`AGENT_PAY_TO_*`), paid once the report's SHA-256 is shown. Each stage's payment is checked against its own address (`PaymentStage.payTo`). Paying the platform fee runs the check (`POST /jobs/<id>/payments` waits for it). A report that could not read the ledger is never delivered: the stage fails and is retried, and the service fee is not due.

Cost per job: no model; about 5–8 JSON-RPC reads (anchors, the payer's last 400 transactions, the counterparty check) and one public-log read, on the free plans. Price 0.11 XRP ($0.275 at XRP $2.50, an assumption).

## Deploy

```bash
cd packages/cappz-check-worker
wrangler d1 create cappz-check                       # put the database_id in wrangler.toml
wrangler d1 execute cappz-check --remote --file=schema.sql
wrangler deploy
python3 -c 'import secrets;print(secrets.token_hex(32))' | wrangler secret put CHECK_SIGNING_SEED
wrangler secret put ANTHROPIC_API_KEY                # optional: rubric questions, drafts, scout plans
curl https://<worker>/key                            # publish this publicKey in /.well-known/cappz-market.json
```

Local: put `CHECK_SIGNING_SEED=<hex>` in `.dev.vars`, then `wrangler d1 execute cappz-check --local --file=schema.sql && wrangler dev`.

Pay-to addresses (`PAY_TO_MAINNET`, `PAY_TO_TESTNET`) must be activated accounts without DepositAuth, because a 0.01 XRP payment cannot activate an account.

## Custom domain

Production is served at **https://check.cappz.ai** (a custom domain on the cappz.ai zone, set in `wrangler.toml` `routes`), and also at the account's workers.dev address. The marketplace's discovery document (`services.counterpartyCheck.url`) names check.cappz.ai.
