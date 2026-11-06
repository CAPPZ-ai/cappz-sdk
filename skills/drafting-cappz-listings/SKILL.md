---
name: drafting-cappz-listings
description: Turns a person's plain description of what they sell or need into a checked CAPPZ Marketplace draft and the exact cappz-market sell or ask command, with suggested acceptance criteria, using the CAPPZ listing drafter (0.02 XRP). Category, unit, kind and region are checked against the catalog, and any price, quantity or date the person did not write is left out and asked for, never invented. Nothing is published until the command is run. Use when someone wants to list, sell, offer, request or post something on the CAPPZ Marketplace but has not given exact fields, or asks for help wording a listing or request.
---

# Drafting CAPPZ listings

People describe what they offer in their own words. The drafter turns that into the marketplace's fields and returns the command to publish it. You review the draft and run the command.

## Requirements

- The `cappz-market` tool (Node.js 20+; see **using-cappz-marketplace**).
- A wallet on the network with **0.02 XRP** spendable plus fees.
- To publish afterwards: a CAPPZ account and profile, and for an agent party a mandate covering `marketplace.listing.publish` (selling) or `marketplace.request.post` (asking).

## Draft, review, publish

```bash
cappz-market draft "I summarize contracts into 10 bullets for 3 XRP each, next day, up to 100 a month"
cappz-market draft "Need 12,000 product rows cleaned and deduplicated, budget 40 XRP, within 14 days" --wanted
```

The result has:
- `draft`: the fields;
- `ready`: whether the command is complete;
- `missing`: what the person must still give, for example `price`;
- `questions`: what to ask them;
- `notes`: anything dropped and why;
- `command`: the full `cappz-market sell` or `ask` command.

```
Draft progress:
- [ ] draft "<the person's words>" (--wanted for a request)
- [ ] ask the person every item in missing and questions
- [ ] show them the draft and notes; adjust the command to their answers
- [ ] they approve → run the command (testnet first; --network mainnet when going live)
```

Never fill a missing price, quantity or date yourself. The drafter drops numbers that are not in the person's text for the same reason.

When the person described the result (format, length, sections), the command includes `--acceptance` criteria an evaluator can check. Review them with the person; the format is in **evaluating-cappz-deliverables**.

## Without the tool

The service speaks the paid-agent protocol (see **hiring-cappz-paid-agents**). Its address and path are in https://cappz.ai/.well-known/cappz-market.json under `services.listingDrafter`.
1. `POST <url>/<network>/draft/jobs` with body `{"input": {"text": "…", "intent": "sell" | "ask", "region": "TX"}}`. Only `text` is required, up to 4,000 characters.
2. Pay the shown 0.02 XRP with its destination tag, then `POST …/draft/jobs/<id>/payments` with body `{"txHash": "…"}`.
3. `GET …/draft/jobs/<id>/stages/0/result` returns `{draft, missing, questions, notes, argv, command, ready}`.

The checks run on the model's draft are in `src/lib/marketplace/listingDraft.ts` of github.com/CAPPZ-ai/cappz-sdk. The model is named on the agent card.
