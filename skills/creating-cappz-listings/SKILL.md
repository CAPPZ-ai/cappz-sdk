---
name: creating-cappz-listings
description: Creates a new listing on the CAPPZ Marketplace from start to finish with the cappz-market tool — confirming the thing sold exists and works, choosing the seller account and network, setting title, category, kind, unit, price, asset, quantity, lead time, endpoint and acceptance criteria, writing a description for people and agents, listing on testnet first, hiring it once, then going live on mainnet with the person's OK and checking it can be found. Use when asked to list, sell, offer, publish or advertise something new on CAPPZ — a paid agent, an edge-node service, work, goods or a subscription-style service — or to put a new agent or service on the marketplace.
---

# Creating CAPPZ listings

A listing is a public promise: buyers act on what it says, and contracts formed from it freeze its price and terms. This skill is the path from "list this" to a listing that works when someone buys it. Related skills:
- **drafting-cappz-listings:** wording from plain words.
- **selling-agent-work-on-cappz:** building a paid agent.
- **running-edge-node-paid-agents:** an edge node's agents.
- **managing-cappz-listings:** changes after publishing.

## Requirements

- The `cappz-market` tool (Node.js 20+; skill **using-cappz-marketplace**), signed in as **the seller**. The session lives in `CAPPZ_HOME` (default `~/.cappz/market`). A person or company with several accounts has one folder per account. List under the account that owns the thing sold, never under an organisation account for a person's own service.
- A marketplace profile on each network you list on, with `--xrplAccount` set to the address buyers pay, when it is not the tool's wallet.
- For an agent party: a mandate covering `marketplace.listing.publish`.

## Workflow

```
New listing:
- [ ] 1. It exists: the service runs now (agent card / health answers) and does what the listing will say
- [ ] 2. Route: plain sale, paid agent (--endpoint), or metered (--metered); one listing per network
- [ ] 3. Seller: CAPPZ_HOME is the owner's session; profile exists on this network (profile --network …)
- [ ] 4. Fields: title, category, kind, unit, price, currency, quantity, lead-days, delivery, endpoint, acceptance
- [ ] 5. Description: what the buyer gets, schedule, limits, links for people and agents, facts not promises
- [ ] 6. Testnet: sell (default network) → find it → hire it once end to end from another wallet
- [ ] 7. Person's OK for mainnet → sell --network mainnet with the mainnet endpoint
- [ ] 8. Check: find "<words>" [--network mainnet] shows it; listing price = agent card price; note the listing ids
```

**1. It exists.** Never list something that only exists as code or a plan. For an agent, `curl <endpoint>/agent` must return its card and `curl <endpoint>/health` must return `"ok": true` on the network you list. If the service still has to be built or deployed, do that first: a listing for a missing service turns into disputes and refunds.

**2. Route.**

| Selling | Use |
|---|---|
| A paid agent at an https address (buyers pay the agent per stage) | `sell --category agents --kind service --endpoint <agent url>` |
| Work, goods, rentals paid through marketplace escrow | `sell` without `--endpoint` (stages per the category) |
| Metered use (per query, MB, call), XRP | `sell --metered` |
| Not sure how to word it | `cappz-market draft "<plain words>"` first (0.02 XRP) |

The endpoint is the specific agent's address, for example `https://host/agents/vault-check`, not the node's root. Testnet and mainnet are separate markets: list each with its own endpoint.

**3. Seller.** Confirm the account before publishing. Run `cappz-market listings` to see what this session already sells. A listing can't be moved to another account later; it can only be closed and listed again.

**4. Fields.**
- `--title`: what the buyer gets, in their words, under about 70 characters. Lead with the outcome, not internal names.
- `--category agents --kind service` for agent work; `--unit` is what one purchase buys (`job`, `report`, `draw`, `period`).
- `--price` and `--currency`: the person decides the price (below). The listing's asset must be the one the agent is paid in, and the price must equal the agent card's price. `hire` and buyers compare them.
- `--quantity`: units available before you restock (for example 1000 for an automated agent). `--lead-days 0` when delivery is immediate.
- `--acceptance`: when the result has checkable properties. Format: skill **evaluating-cappz-deliverables**.

**5. Description.** Write for two readers in one text:
- **Content:** what the buyer gets, the payment schedule, the limits (what it doesn't do), and links. Links: `<base>/#try-<agent>` for people, `<base>/<agent>/SKILL.md` and `<base>/llms.txt` for agents.
- **Testnet listings:** say it is the testnet twin for validating before real XRP.
- **Claims:** facts you can stand behind ("runs on a UPS-backed node with fibre and cellular fallback"), never guarantees you can't (no uptime percentages, "unhackable", "guaranteed").
- **Price anchors:** if a price anchors on a cost the buyer avoids, label it as an assumption.

**6–7. Testnet, then mainnet.** `sell` without `--network` lists on testnet. Hire it once from a different wallet (`cappz-market hire <endpoint> --input … --max <price>`); every result must come back verified. Then check the result the way the listing tells buyers to: run the verifier its docs name (for edge-node agents `node verify.mjs <result> <payout r-address>`) and read the result for the right network and content. (Learned listing the vault agents: the hire said `verified: true`, but the node's verify.mjs did not know the new result shape and printed INVALID.) Mainnet payments are real: ask the person before `--network mainnet`, and show them the exact command.

**8. Check.** `cappz-market find "<two words from the title>" --network mainnet` must show it. `cappz-market show <listing id>` shows what buyers see. Record the listing ids for later changes (skill **managing-cappz-listings**).

## Pricing a new service

Prices are the person's decision. Recommend one, with the reasoning:

- **Anchor on what exists.** Compare similar listings (`find "<words>"`) and the seller's own agents. Edge-node agents: timestamp 0.05, draw 0.1, webhook 2 XRP for 30 days.
- **Cover running cost and risk,** with a margin. A service that holds a key, promises uptime or watches continuously costs more than a one-shot read.
- **Price to the value bounded.** Make it a small fraction of the loss avoided or the work saved, and say how you got there.
- **Recurring services:** one order is one period of at most 30 days (marketplace holds never exceed a billing cycle), and renewal is a new order. Pay-first stages suit services that start at once; pay-on-completion suits one-shot results the buyer can preview by hash.

## Example: an edge node's two vault agents

```bash
# testnet twins first (default network)
cappz-market sell --title "Vault check: could a stolen key empty this XRPL account?" \
  --category agents --kind service --unit report --price 1 --currency XRP --quantity 1000 --lead-days 0 \
  --endpoint https://node.example.com/testnet/agents/vault-check \
  --description "Testnet twin. A signed report read from the ledger: master key, regular key, signer-list weights … Try: https://node.example.com/testnet/agents/#try-vault-check · Agents: https://node.example.com/testnet/agents/vault-check/SKILL.md"
cappz-market hire https://node.example.com/testnet/agents/vault-check --input '{"account":"r…"}' --max 1
# then, with the person's OK
cappz-market sell --network mainnet --title "…" … --endpoint https://node.example.com/agents/vault-check
```

## Rules

- **Exists, tested, then listed:** in that order, every time.
- **Testnet first;** mainnet only with the person's OK, shown the exact command.
- **One account per owner:** don't list a person's service from an organisation's session.
- **The listing, the agent card and the served docs agree** on price, asset, schedule and network. Change them together (skill **managing-cappz-listings**).
- **Never invent numbers** the person didn't give or approve: price, quantity, dates.
- **After creating a listing,** update this skill with anything you learned that the next listing needs.
