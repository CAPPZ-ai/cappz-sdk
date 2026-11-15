---
name: using-cappz-signed-webhook-receiver
description: Rents a {{DAYS}}-day webhook URL from the CAPPZ edge node at {{HOST}} that signs every POST it receives (time, body and its SHA-256) with the node's Ed25519 key, then delivers a signed bundle of all records. Price {{WH_PRICE}} XRP on the XRP Ledger ({{NETWORK}}): a {{WH_DEPOSIT}} XRP deposit opens the URL, and {{WH_REST}} XRP is due at the end. Use when asked for tamper-evident webhook logs, third-party proof of what a service sent and when, an audit trail for payment, CI or IoT callbacks, or a temporary webhook inbox.
---

# CAPPZ signed webhook receiver

You get a webhook URL. A third party (Stripe, GitHub, a sensor, your own service) POSTs to it. Each body is stored as a `WebhookReceived` record signed by the node, so it shows the time received, the content type, the body and its SHA-256. After {{DAYS}} days the node signs a `WebhookPeriodClosed` record covering the count and the SHA-256 of all records, and delivers that bundle.

- Endpoint: `{{BASE}}/webhook`
- Price: {{WH_PRICE}} XRP in two stages:
  1. **Deposit: endpoint opens**: {{WH_DEPOSIT}} XRP. The URL opens when the deposit is seen on the ledger.
  2. **Period ended: signed bundle**: {{WH_REST}} XRP, after {{DAYS}} days. You see the bundle's SHA-256 before paying.
- Network: {{NETWORK}}. Pays to: `{{PAYTO}}`. Signer: `{{NODE}}`
- Same agent on {{PEER_NETWORK}}: `{{PEER_BASE}}/webhook`. Test the flow on testnet (free test XRP) before paying real XRP. Records state their network in `payload.network`.
- Limits: 64 KB per body, 10,000 records per period. Any content type is accepted; JSON is stored parsed, anything else as text.

## Checklist

```
- [ ] Budget agreed with the person you act for: {{WH_PRICE}} XRP over {{DAYS}} days, plus network fees
- [ ] Open the job and pay the deposit (A or B)
- [ ] GET {{BASE}}/webhook/hooks/<jobId> shows "active": true
- [ ] Give {{BASE}}/webhook/hooks/<jobId> to the sending service
- [ ] Record the period's end date. After it: pay stage 1, download the bundle, verify it
```

## A. With the cappz-market tool

```bash
cappz-market hire {{BASE}}/webhook --input '{"label":"stripe prod"}' --max {{WH_PRICE}} --timeout 2
```

It pays the deposit, then times out while the period runs (expected) and prints `next`, a command to resume the same job. Run that command after the period ends to pay the rest and download the bundle. Never rerun without `--job`, because that opens and charges a new job.

## B. With plain HTTP and any XRPL wallet

```bash
curl -s -X POST {{BASE}}/webhook/jobs -H 'content-type: application/json' -d '{"input":{"label":"stripe prod"}}'
# → {"job":{"jobId":"job-…"},"pay":{"amount":"{{WH_DEPOSIT}}","destination":"{{PAYTO}}","destinationTag":…}}
```

1. Pay the deposit with its `destinationTag`. Optional: `POST …/webhook/jobs/<jobId>/payments {"txHash":"…"}`.
2. Check the URL is open: `curl -s {{BASE}}/webhook/hooks/<jobId>` returns `{"active":true,"periodEnd":"…","records":0}`.
3. Senders POST to `{{BASE}}/webhook/hooks/<jobId>`. Each POST returns `{txId, txHash, receivedAt}`; the sender can keep these as its own receipt.
4. After `periodEnd`: `GET …/webhook/jobs/<jobId>/stages/1/result` returns 402 with `pay` for {{WH_REST}} XRP. Pay it, then the same GET returns `{bundle, records, verify}`.

The GET on the hook URL shows only status and a count, never the bodies. Bodies are delivered only in the paid bundle.

## Check the bundle

```bash
curl -fsSLO {{BASE}}/verify.mjs
node verify.mjs bundle.json {{NODE}}
```

**Who vouches for the signer.** When the agent card (`{{BASE}}/webhook/agent`) shows `declaredBy`, a wallet has declared this node key (KeyZ). Pass that wallet's XRPL address instead of the key. Usually it is the payout address `{{PAYTO}}`, the account you paid:

```bash
node verify.mjs bundle.json {{PAYTO}}
```

`VALID` with `declared by expected wallet {{PAYTO}}` means that account vouched for the key that signed the bundle and every record in it. The check rests on the wallet, not on this website's HTTPS certificate or its DNS name. It comes in two forms:

- **On the XRP Ledger** (`declaredBy.onLedger` on the card; `payload.signerDeclaration` starts with `xrpl:`). The account signed a ledger transaction naming the key. `verify.mjs` reads that transaction, and any later revocation, from public XRPL servers, so it needs network access (Deno: `--allow-net --allow-env`). With `--offline`, the signer is reported as unchecked.
- **Wallet-signed** (a `declarations` list in the result). `verify.mjs` checks the wallet's signature offline. For the latest revocations, add `--evidence key-declarations.json`, downloaded from {{BASE}}/key-declarations.json.

The verifier checks every record's signature, the bundle's signature, and that `bundle.payload.recordsSha256` equals the SHA-256 of `JSON.stringify(records)` and `count` equals the number of records. If one record is removed or edited, the check fails.

## Errors

| Response | Meaning |
|---|---|
| 402 on POST /hooks | Deposit not yet seen. Pay it, or wait up to about 15 s after paying. |
| 410 on POST /hooks | The period has ended. Collect the bundle. |
| 413 / 429 | Body over 64 KB, or 10,000 records reached. |
| 409 on `/result` | The period has not ended yet. |
