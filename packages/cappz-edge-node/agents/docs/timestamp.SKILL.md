---
name: using-cappz-signed-timestamp
description: Gets a signed timestamp receipt for a file from the CAPPZ edge node at {{HOST}}. It sends only the file's SHA-256, pays {{TS_PRICE}} XRP on the XRP Ledger ({{NETWORK}}) after seeing the receipt's fingerprint, and checks the receipt's Ed25519 signature. Use when asked to timestamp, notarize or prove the existence of a file, document, dataset or model output at a point in time, without uploading it.
---

# CAPPZ signed timestamp

This agent proves that a file existed by a given time, without the file leaving your computer. You send its SHA-256. The node returns a receipt it signs with its Ed25519 key: a `HashTimestamped` record holding your hash, an optional note and the time.

- Endpoint: `{{BASE}}/timestamp`
- Price: {{TS_PRICE}} XRP per receipt, paid on completion. You see the receipt's SHA-256 first, then pay, then download it.
- Network: {{NETWORK}}. Pays to: `{{PAYTO}}`.
- Signer: `{{NODE}}`
- Same agent on {{PEER_NETWORK}}: `{{PEER_BASE}}/timestamp`. Test the flow on testnet (free test XRP) before paying real XRP. A receipt states its network in `payload.network`; only a mainnet receipt is real proof.

## Checklist

```
- [ ] Hash the file locally: sha256sum file  |  shasum -a 256 file  |  certutil -hashfile file SHA256
- [ ] Budget agreed with the person you act for (≥ {{TS_PRICE}} XRP plus a network fee of about 0.00001 XRP)
- [ ] Hire (A or B below)
- [ ] Check the receipt: payload.sha256 equals your hash, the signature is valid, and signerPublicKey is {{NODE}}
- [ ] Keep receipt.json next to the file
```

## A. With the cappz-market tool

```bash
cappz-market hire {{BASE}}/timestamp --input '{"sha256":"<64 hex>","note":"contract v3 final"}' --max {{TS_PRICE}}
```

The receipt is saved in `./cappz-results/`, and `verified: true` means its bytes match the fingerprint you were shown. Tool setup is in the **using-cappz-marketplace** skill.

## B. With plain HTTP and any XRPL wallet

```bash
curl -s -X POST {{BASE}}/timestamp/jobs -H 'content-type: application/json' \
  -d '{"input":{"sha256":"<64 hex>","note":"optional"}}'
# → {"job":{"jobId":"job-…"}, …}
curl -s {{BASE}}/timestamp/jobs/<jobId>/stages/0/result
# → 402 {"resultSha256":"…","pay":{"amount":"{{TS_PRICE}}","destination":"{{PAYTO}}","destinationTag":…,"preparedTx":{…}}}
```

1. Pay `pay.amount` XRP to `pay.destination` **with** `pay.destinationTag`. Alternatively, sign `pay.preparedTx` after adding your `Account`.
2. Optional: `POST {{BASE}}/timestamp/jobs/<jobId>/payments {"txHash":"…"}`. Without it, the node matches the payment within about 15 s.
3. `GET …/stages/0/result` now returns 200 with the receipt. Check that `sha256(body) == resultSha256`.

The input must be `sha256` (64 hex characters) and may include `note` (≤ 200 characters). Anything else is refused with 422.

## Check a receipt

```bash
curl -fsSLO {{BASE}}/verify.mjs
node verify.mjs receipt.json {{NODE}}
```

**Who vouches for the signer.** When the agent card (`{{BASE}}/timestamp/agent`) shows `declaredBy`, a wallet has declared this node key (KeyZ). Pass that wallet's XRPL address instead of the key. Usually it is the payout address `{{PAYTO}}`, the account you paid:

```bash
node verify.mjs receipt.json {{PAYTO}}
```

`VALID` with `declared by expected wallet {{PAYTO}}` means that account vouched for the key that signed this receipt. The check rests on the wallet, not on this website's HTTPS certificate or its DNS name. It comes in two forms:

- **On the XRP Ledger** (`declaredBy.onLedger` on the card; `payload.signerDeclaration` starts with `xrpl:`). The account signed a ledger transaction naming the key. `verify.mjs` reads that transaction, and any later revocation, from public XRPL servers, so it needs network access (Deno: `--allow-net --allow-env`). With `--offline`, the signer is reported as unchecked.
- **Wallet-signed** (a `declarations` list in the result). `verify.mjs` checks the wallet's signature offline. For the latest revocations, add `--evidence key-declarations.json`, downloaded from {{BASE}}/key-declarations.json.

Or paste it into the verifier on {{BASE}}/. The signature check needs no network access and nothing from this node; only the on-ledger "who vouches" check reads the XRP Ledger. The node hashes the canonical JSON of the record without `txHash`, `signature` and `signerPublicKey`, with keys sorted, and signs that hex string with Ed25519. Any field changed breaks the check.

## Errors

| Response | Meaning |
|---|---|
| 422 | Bad input. The message says which field. |
| 402 | Not paid yet. Pay exactly `pay.amount` with its tag. |
| 409 on `/payments` | The transaction is not a validated payment of this stage, or it was already used. |
| 409 on `/result` | The receipt is still being made. Retry in a few seconds. |
| Unreachable | The node is offline. Try later; jobs and payments are kept. |
