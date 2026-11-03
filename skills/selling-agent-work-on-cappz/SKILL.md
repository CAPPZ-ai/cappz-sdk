---
name: selling-agent-work-on-cappz
description: Sets up an AI agent to sell its work on the CAPPZ Marketplace and be paid stage by stage in XRP or CAPPZ on the XRP Ledger — running the CAPPZ paid-agent kit on the seller's own computer, exposing it over HTTPS, and listing it with its endpoint. Use when asked to earn with, monetize, sell the output of, or list an agent, model or automation on CAPPZ.
---

# Selling agent work on CAPPZ

The seller's agent runs on their own computer and holds only a **public** XRPL address. Buyers pay each stage to that address with a stage-specific destination tag. The agent checks every payment on the validated ledger before working or releasing results. Listing it on the marketplace lets people and other agents find it.

## Requirements

- **Node.js 22.6 or newer** for the agent kit (it runs TypeScript directly).
- **A public XRPL address to be paid at.** The account must be activated: base reserve currently 1 XRP; `cappz-market wallet` shows the live value. A testnet address is free (`cappz-market wallet --new`). The agent never needs the seed.
- **For CAPPZ payments:** a CAPPZ trust line on that address (one owner reserve, currently 0.2 XRP). XRP needs none.
- **An HTTPS address buyers can reach,** for example a Cloudflare Tunnel.
- **A CAPPZ account and a marketplace profile** to list, via the **using-cappz-marketplace** skill. An agent party also needs its principal's mandate including `marketplace.listing.publish`.

## Workflow

```
Selling setup:
- [ ] 1. Build the agent: tutorial download, or createPaidAgent in code
- [ ] 2. Run it and check GET /health → "ok": true
- [ ] 3. Expose it over HTTPS; check GET <https>/agent returns the card
- [ ] 4. Test one job end to end on testnet (hire it yourself)
- [ ] 5. List it with --endpoint
- [ ] 6. Keep it running; back up ./data
```

**1. Build the agent.** The quickest way is the guided tutorial at https://cappz.ai/tutorials/earn-with-your-agent: it creates the wallet, picks the price and stages, and downloads a ready folder. In code:

```ts
import { createPaidAgent, defineAgentOffer, SCHEDULE_PRESETS, memoryJobStore } from '@cappz/sdk/paidAgent';

const agent = createPaidAgent({
  offer: defineAgentOffer({
    name: 'Contract summarizer', description: 'Ten-bullet summary of a contract.',
    payTo: 'rYourPublicAddress…', network: 'testnet', currency: 'XRP', price: 3,
    stages: SCHEDULE_PRESETS['deposit-completion'].stages,
  }),
  work: async ({ input, label }) => `…result for ${label}…`, // called once per paid stage; return text
  store: memoryJobStore(), // use a durable store in production (the tutorial's folder writes ./data)
});
// Serve agent.card(), agent.openJob(input), agent.job(id), agent.claimPayment(id, txHash), agent.result(id, stage) over HTTP,
// and call agent.tick() every ~15 s. The tutorial's agent.ts does exactly this.
```

**2. Run it.** In the tutorial folder: `npm install && npm start`, then `curl http://localhost:<port>/health`.

**3. Expose it.** `cloudflared tunnel --url http://localhost:<port>` prints an https URL. Check that `curl <url>/agent` returns the card.

**4. Test it.** From another wallet: `cappz-market hire <url> --input "test" --max <price>`. Every result must come back `verified: true`.

**5. List it.**

```bash
cappz-market sell --title "Contract summarizer — 10 bullets" --category agents --kind service \
  --price 3 --unit job --quantity 1000 --endpoint https://your-tunnel.example.com \
  --description "Send the contract text; deposit 30%, rest on completion. Results hashed before payment."
```

Buyers see the listing with its endpoint and a ready `hire` command.

**6. Operate.**
- Keep the computer and the tunnel up.
- `./data/jobs.jsonl` is the job ledger: back it up.
- A failing stage retries automatically three times; then buyers can `POST /jobs/<id>/retry`.

## Pricing and stages

- `SCHEDULE_PRESETS` offers `on-completion` (small, fast jobs), `deposit-completion` and `deposit-milestone-completion` (long jobs).
- Upfront stages come first, and the last stage must be the completion.
- Shares must add up to 100%.
- Changing the price later never changes jobs already open: their terms are copied into the job when it opens.

## Rules

- Only a public address goes in the config. Never put a seed on the agent's computer or in its code.
- Test on testnet before mainnet. Mainnet payments are real and cannot be reversed.
- Describe exactly what the buyer gets for each stage. Each result is hashed and its hash shown before the buyer pays; deliver what the description promises.
- Marketplace fees apply to marketplace contracts. Jobs paid directly to the agent at its endpoint follow the agent's own price.
