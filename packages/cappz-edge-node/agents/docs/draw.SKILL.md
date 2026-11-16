---
name: using-cappz-fair-draw
description: Runs a fair, publicly checkable random draw with the CAPPZ edge node at {{HOST}}. Winners are picked from a list by the hash of an XRP Ledger ledger that closes after the list is locked, so neither the organizer nor the node can steer them, and anyone can recompute them. Costs {{DRAW_PRICE}} XRP ({{NETWORK}}), paid once up front. Use when asked to pick giveaway, raffle or contest winners, choose an audit sample, select reviewers or members by lot, assign groups at random, or break a tie, and the result must be provably unrigged.
---

# CAPPZ fair draw

This agent picks winners from a list so that nobody can steer the result: not you, not the people in the list, not this node. Each step:

1. You send the list (or only its SHA-256, if the list is private) and how many winners.
2. You pay {{DRAW_PRICE}} XRP. That is the whole price; the result is free.
3. The node signs a **commitment**: the list's SHA-256, its size, the number of winners and a **draw time**. It publishes the commitment on its public log at once. Share the commitment link before the draw.
4. At the draw time, the winners come from the hash of the first XRP Ledger ledger that closes at or after it. Nobody can know that hash in advance.
5. The node signs the draw. Anyone can recompute it from the public ledger.

- Endpoint: `{{BASE}}/draw`
- Price: {{DRAW_PRICE}} XRP per draw, one payment. The draw itself (stage 1) costs nothing.
- Network: {{NETWORK}}. Pays to: `{{PAYTO}}`. Signer: `{{NODE}}`
- Same agent on {{PEER_NETWORK}}: `{{PEER_BASE}}/draw`. Rehearse there with free test XRP. Records state their network in `payload.network`; only a mainnet draw counts as proof.

## Checklist

```
- [ ] Freeze the list: one entry per ticket (list a name twice for two tickets), in a fixed order. No emails or phone numbers if the draw is public: use handles or ticket numbers
- [ ] Check the giveaway is lawful where it runs: in many places a prize chosen by chance with a paid entry is a lottery. This agent makes the pick fair; the rules (free entry, eligibility) are the organizer's
- [ ] Decide winners and the draw time (at most {{DRAW_MAX_DAYS}} days ahead; never sooner than {{DRAW_LEAD}} min after the commitment)
- [ ] Budget agreed with the person you act for ({{DRAW_PRICE}} XRP plus a network fee of about 0.00001 XRP)
- [ ] Hire (A or B below) and pay before the draw time
- [ ] Publish the commitment link ({{BASE}}/draw/commitments/<jobId>) before the draw time
- [ ] After the draw time: collect the result, check it (verify.mjs), announce with the public link
```

## Input

| Field | Meaning |
|---|---|
| `entries` | The list: 1–10,000 texts of up to 200 characters. Order matters: it is part of the fingerprint. |
| `entriesSha256` + `count` | Instead of `entries`: a private list's fingerprint and size (up to 1,000,000). Reveal the list later so others can check. |
| `winners` | How many to pick, 1–1,000 (default 1). Picks are distinct tickets, first drawn first. |
| `drawAt` | ISO time of the draw, e.g. `2026-12-01T20:00:00Z`. Default and earliest: {{DRAW_LEAD}} min after the commitment. An earlier time is moved to that and both are recorded. |
| `label` | Up to 100 characters, e.g. `December giveaway`. Public, on the log. |
| `public` | `true` serves the result, entries included, at `{{BASE}}/draw/draws/<jobId>` with a page that re-checks it in the browser. Default `false`. |

Fingerprint of a list: `sha256` of the UTF-8 bytes of `JSON.stringify(entries)`. From a text file with one entry per line (lines trimmed, blank lines dropped):

```bash
node verify.mjs --hash-entries list.txt     # prints entriesSha256 and count
```

## A. With the cappz-market tool

```bash
cappz-market hire {{BASE}}/draw --input '{"entries":["ann","bob","cy","dee"],"winners":1,"label":"December giveaway","public":true}' --max {{DRAW_PRICE}}
```

It pays the one stage and waits for the result. Default `--timeout` is 15 minutes. For a later draw time, it returns with `next`: run that command after the draw time. Meanwhile, the commitment is at `{{BASE}}/draw/commitments/<jobId>`.

## B. With plain HTTP and any XRPL wallet

```bash
curl -s -X POST {{BASE}}/draw/jobs -H 'content-type: application/json' \
  -d '{"input":{"entries":["ann","bob","cy","dee"],"winners":1,"drawAt":"2026-12-01T20:00:00Z","public":true}}'
# → {"job":{"jobId":"job-…"}, "pay":{"amount":"{{DRAW_PRICE}}","destination":"{{PAYTO}}","destinationTag":…,"preparedTx":{…}}}
```

1. Pay `pay.amount` XRP to `pay.destination` **with** `pay.destinationTag`, before the draw time. You can also sign `pay.preparedTx` after adding your `Account`.
2. Within about 15 s, `GET {{BASE}}/draw/commitments/<jobId>` returns the signed `DrawCommitted`. Publish this link.
3. After the draw time, `GET {{BASE}}/draw/jobs/<jobId>/stages/1/result` returns the result: `draw` (signed `DrawPerformed`), `commitment`, `winners` (place, index, entry), and `entries` if you sent them. 409 means not drawn yet.

## What makes it fair

- **The list is locked before the randomness exists.** The commitment is signed after payment and names `afterLedger`, the latest validated ledger at that moment. The draw time is at least {{DRAW_LEAD}} min later.
- **The randomness is public.** The seed ledger is the first validated ledger with close time ≥ `drawAt`. Its hash comes from the XRP Ledger's consensus, not from this node.
- **A second try is visible.** The same list for the same ledger always gives the same winners. A different list needs a new paid commitment, and every commitment is on the node's hash-chained log at `{{BASE}}/draw/log`, each naming the one before it. An organizer who commits two lists for one giveaway shows up there.
- **Anyone can recompute it.** Rule `cappz-draw/v1`:

```
seed   = sha256("cappz-draw/v1|" + seedLedgerHash (upper hex) + "|" + entriesSha256 + "|" + count + "|" + winners)
stream = sha256(seed bytes ‖ uint32 big-endian counter), counter 0, 1, …, read as uint32 big-endian words
pick n = next word w below 2^32 − (2^32 mod n); then w mod n
picks  = for i in 0 … winners−1: j = i + pick(count − i); swap positions i and j; take position i  (0-based entry indices)
```

## Check a draw

```bash
curl -fsSLO {{BASE}}/verify.mjs
node verify.mjs draw.json {{PAYTO}}                       # draws with entries in the file
node verify.mjs draw.json {{PAYTO}} --entries list.txt    # a list sent only as a hash
```

It checks:
- both signatures, and who vouches for the key
- that the commitment came before the draw time
- that the seed ledger and the ledger before it, read from public XRPL servers, match the rule
- the recomputed winners
- the list's fingerprint

`VALID` means the winners follow from the committed list and the public ledger. A public draw's page, `{{BASE}}/draw/draws/<jobId>`, runs the same checks in the browser.

## Errors

| Response | Meaning |
|---|---|
| 422 | Bad input. The message says which field. |
| 413 | Body over 3 MB. Send `entriesSha256` and `count` instead. |
| 404 on `/draw/commitments/<id>` | Not paid yet, or unknown job. |
| 409 on `/stages/1/result` | Not drawn yet. Try again after `drawAt`. |
| Unreachable | The node is offline. Paid jobs are kept and drawn when it is back; the seed ledger is still the first one closed at or after `drawAt`. |
