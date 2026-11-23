---
name: using-cappz-key-exposure
description: Gets a signed report from the CAPPZ edge node at {{HOST}} on up to 10 XRP Ledger accounts — which keys that can sign have published their public key on the ledger (what a quantum computer would attack), since when, whether the master key is still live, and which accounts are safe receive-only vaults — with the unsigned transactions to rotate keys, disable an exposed master key and quickSweep funds to a never-signed vault, for {{KE_PRICE}} XRP on {{NETWORK}}. Use when asked about quantum risk to XRPL accounts, key rotation, key exposure, or moving funds to a safer vault.
---

# CAPPZ quantum key exposure check

An XRPL address is a hash of a public key. The public key appears on the ledger only when the key signs; receiving money reveals nothing. A quantum computer running Shor's algorithm recovers a private key from its public key, so the attack surface is every key that **has signed and can still sign**. This check reads each account's full history and says exactly that. The node never holds a key.

- Endpoint: `{{BASE}}/key-exposure`
- Price: {{KE_PRICE}} XRP per report (up to 10 accounts), paid on completion: you see the report's SHA-256 first.
- Network: {{NETWORK}}. Pays to: `{{PAYTO}}`. Signer: `{{NODE}}`.
- Same agent on {{PEER_NETWORK}}: `{{PEER_BASE}}/key-exposure`.

## Input

```json
{
  "accounts": ["r… working account", "r…"],
  "vault": "r… an account whose keys never signed (optional)",
  "bufferXrp": 20,
  "maxExposureDays": 30
}
```

Only `accounts` is required.

## What the report says

Per account, `posture`:
- `unexposed`: no key that can sign this account has published its public key.
- `rotating`: the signing key is exposed, but for less than `maxExposureDays`.
- `stale-exposure`: exposed longer than that: rotate the regular key.
- `master-exposed`: the master key signed and is still enabled: set a regular key, then disable the master key.
- `multisig`: a signer list governs; every exposed signer key is listed.
- `unknown`: the history was too long to read completely (over 5000 transactions), so "never signed" cannot be claimed.

`master` and `regularKey` give each key's state (`never-signed`, `exposed`, `exposed-disabled`, `none`, `unknown`) with the first transaction that exposed it. `ledgerSignatures` is always `classical-only`: the XRP Ledger's own signatures are not post-quantum yet. Rotation and sweeping shorten how long a key can be attacked and keep reserves behind keys that never signed; they do not change that.

`plans` per account: unsigned transactions to fix it.
- `SetRegularKey` to a fresh key (generate it offline and fill in `<fresh r-address>`). `regularKeyFor` in `@cappz/sdk/marketplace` derives one per rotation from a private root secret.
- `AccountSet` disabling the master key. Submit it only after the new regular key has signed something successfully.
- `quickSweep` (with `vault`): a Payment of everything above reserve + `bufferXrp` to the vault. It is refused when the vault's own keys have signed, or its history could not be read fully.

**Pay from an account you are not checking.** Paying signs a transaction, and signing publishes that account's public key. The report is made before you pay, so it would show the paying account as unexposed, but your payment exposes it a moment later.

## Hire it

```bash
cappz-market hire {{BASE}}/key-exposure --input '{"accounts":["r…"],"vault":"r…"}' --max {{KE_PRICE}}
```

With plain HTTP:
1. `POST {{BASE}}/key-exposure/jobs {"input":{…}}`.
2. `GET …/jobs/<id>/stages/0/result` returns 402 with `pay` and `resultSha256`.
3. Pay with the destination tag.
4. `GET` the result again.

Check the signature with `node verify.mjs report.json {{PAYTO}}` ({{BASE}}/verify.mjs). Run the same check yourself with `keyExposure` from `@cappz/sdk/marketplace`.
