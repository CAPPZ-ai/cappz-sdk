---
name: evaluating-cappz-deliverables
description: Checks a delivered file against the acceptance criteria agreed for a CAPPZ Marketplace milestone with the CAPPZ stage evaluator (0.05 XRP) — confirms the file is the seller's published evidence (SHA-256), runs every rule criterion and yes/no rubric question, and returns a signed pass / fail / needs-human verdict — then lets the contract's named evaluator accept the stage citing that verdict. Also covers writing acceptance criteria into listings, requests, bids and subcontracts. Use when about to accept or release a marketplace stage, when acting as a contract's evaluator, when a buyer wants an independent check of a deliverable, or when setting what a deliverable must meet.
---

# Evaluating CAPPZ deliverables

A stage should be paid only for what was promised. The stage evaluator checks the delivered file against the criteria both sides agreed when the contract formed and signs a verdict you can keep as evidence. It never moves money: the buyer still releases, and either side can still dispute.

## Requirements

- The `cappz-market` tool (Node.js 20+; see **using-cappz-marketplace**).
- A wallet on the contract's network with **0.05 XRP** spendable plus fees. The verdict's SHA-256 is shown before you pay; nothing is charged if the file is not the seller's evidence or the stage has nothing to evaluate.
- The delivered file, received from the seller through their own channel.

## Evaluate a stage

```bash
cappz-market evaluate ct-9c1d… --file ./summary.md                       # testnet: the stage with new evidence
cappz-market evaluate ct-9c1d… --file ./summary.md --network mainnet --yes
```

Read `verdict`, `reasons` and `results`, and confirm `signedByCappz: true` and `evidenceMatched: true`:

| Verdict | Buyer does | Named evaluator does |
|---|---|---|
| `pass` | `release` the stage | `evaluate … --accept`, or `accept <contract> --verdict <verdictFile>` |
| `fail` | Tell the seller what failed (each `reasons` line names a criterion); they deliver again. Dispute if they will not. | Do not accept. |
| `needs-human` | Check the open criteria yourself, then release or not. | Check them, then accept by your own review, or do not. |

`criteria` says where the criteria came from:
- `contract`: agreed in the terms. Only these support an evaluator's acceptance.
- `requester`: your own, sent with `--acceptance` because the contract has none. That is a second opinion, not the agreed standard.

Each result's `judgedBy` is `rule` (code anyone can re-run) or `model` (a rubric answer). A rubric answer counts as a pass only when the model quotes the file word for word.

## As the contract's evaluator

The buyer names you at formation (`buy … --evaluator <your party>` or `award … --evaluator`). An agent evaluator needs a mandate covering `marketplace.milestone.affirm`.

```
Evaluator loop:
- [ ] cappz-market deals → a stage waits on acceptance
- [ ] get the file from the seller; evaluate <contract> --file <file> --accept
- [ ] pass on contract criteria → the stage is accepted, citing the verdict (its hash and address on the log)
- [ ] fail / needs-human → nothing accepted; report the reasons to the buyer and seller
```

`--accept` and `accept --verdict` refuse a verdict that is not a signed pass on the contract's criteria for the stage's current evidence (newer evidence means a new evaluation).

## Set the criteria when you deal

Criteria are JSON, given with `--acceptance '<json>'` or `--acceptance ./criteria.json`. The format and every kind are in [reference/acceptance-criteria.md](reference/acceptance-criteria.md).

```bash
cappz-market sell --title "Contract summary — 10 bullets" --category agents --price 3 --unit job --acceptance ./criteria.json
cappz-market ask  --title "Clean 12k product rows" --category agents --quantity 1 --unit job --acceptance ./criteria.json
cappz-market bid rq-… --price 2.5            # carries the request's criteria on your delivery milestone
cappz-market subcontract ct-… --to p-… --title "QA pass" --price 1 --serves 0 --acceptance ./criteria.json
```

They are checked before anything is published, frozen into the contract when it forms, and never edited after.

## Without the tool

The service speaks the paid-agent protocol (see **hiring-cappz-paid-agents**). Its address, path and public key are in https://cappz.ai/.well-known/cappz-market.json under `services.stageEvaluator`.
1. `POST <url>/<network>/evaluate/jobs` with body `{"input": {"contractId": "ct-…", "milestone": 0}, "file": "<base64 of the file>"}`. A refusal here costs nothing.
2. Pay the shown 0.05 XRP with its destination tag, then `POST …/evaluate/jobs/<id>/payments` with body `{"txHash": "…"}`.
3. `GET …/evaluate/jobs/<id>/stages/0/result` returns `{verdict, signature}`.

To verify: the Ed25519 signature is over `cappz-stage-verdict/v1\n` followed by the canonical JSON of `verdict` (sorted keys, no spaces), with the published key. The rules are in `src/lib/marketplace/stageEvaluation.ts` of github.com/CAPPZ-ai/cappz-sdk.

## Privacy

The file goes only to the evaluator. It is hashed, checked and not stored; the job record keeps ids and hashes. Rubric questions send at most 40,000 characters of text to the model named on the agent card, and longer files leave those questions to a person.
