---
name: sharing-sealed-files
description: Shares files, datasets, deliverables, credentials, agent memory or records with a chosen group of people and agents so that only they can open them, using a CAPPZ edge node's sealed store — files are encrypted on your own machine for each reader's published wallet key (post-quantum hybrid when their key is), the node keeps ciphertext with signed receipts and version history, and a box is rented per GB per 30 days in XRP. Use when asked to send or store something confidential for specific recipients, hand off private work between agents, keep encrypted versioned copies off-device, or set up a shared private folder for a team.
---

# Sharing sealed files

A sealed store keeps a group's files where every member can fetch them and nobody else can read them, including the host. You encrypt on your machine with `@cappz/sdk/sealed`; the host (a CAPPZ edge node offering the `sealed-store` agent) stores the encrypted bytes, checks each write's wallet signature and signs a receipt.

## When it fits, and when it does not

- Fits: confidential handoffs between people and agents, a team's private documents, a buyer-only deliverable, an agent's memory across machines, records several parties must share.
- Not for: public files (publish them instead), anything you cannot keep a copy of (if every member loses their keys, the data is gone), or hiding *that* you share: sizes, object names and write times are public metadata.

## Steps

```
- [ ] Find a node: cappz-market search sealed store   (or a node's {base}/llms.txt lists sealed-store)
- [ ] Try the flow on that node's testnet instance first (free test XRP)
- [ ] Every reader publishes an encryption key once: walletEncryptionKey + declareKey(purpose 'encryption') → POST {node}/sealed-store/keys
- [ ] Agree the budget: gb × price per 30 days (the agent card shows the price per GB)
- [ ] Open a box: cappz-market hire {node}/sealed-store --input '{"gb":1,"writers":["<wallet>",…]}' --max <budget>
- [ ] Look up readers' keys (recipientsFrom checks each wallet's own signature); ask anyone listed in `missing` to publish first
- [ ] sealObject → signWrite (parent = current head) → put; keep the receipt
- [ ] Readers: get (SHA-256 checked) → openObject with their own key
- [ ] Renew before periodEnd with {"renews":"<boxId>"}, or copy everything out before the grace ends
```

The node serves the full how-to with code for each step at `{node}/sealed-store/SKILL.md`; its routes are in `{node}/openapi.json`.

## Rules

- Seal before uploading, always. Never send plaintext to a host, and choose object ids that reveal nothing (`f/7c1e` rather than `acquisition-target.pdf`).
- Verify, do not trust: `replayBox` checks every record's wallet signature, writer and version chain itself; `recipientsFrom` uses only keys a wallet declared for itself.
- To remove a reader, seal a new version for the remaining group; what they opened before, they may have kept.
- Wallet keys and seeds stay on the machine that owns them. Move real XRP only with the OK of the person you act for.
