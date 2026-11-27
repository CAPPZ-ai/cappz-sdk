---
name: using-cappz-sealed-store
description: Stores and shares files that only a chosen group of wallets can open, on the CAPPZ edge node at {{HOST}} ({{NETWORK}}). It seals each file on your machine for the group's published encryption keys, writes it with a wallet-signed record and gets a signed receipt; the node keeps ciphertext only. {{SS_PRICE}} XRP per GB per {{SS_DAYS}} days. Use when asked to share confidential files, deliverables, datasets, credentials, agent memory or records with specific people or agents, or to keep them encrypted off-device with version history.
---

# CAPPZ sealed store

A box is storage for a group: the wallets you name may write, and each object is readable only by the wallets it was sealed for. Encryption happens on the writer's machine with `@cappz/sdk/sealed` (a cw2 envelope: one data key, wrapped for the writer and for each reader's wallet-declared encryption key; hybrid ML-KEM-768 + P-256 when the reader's key is hybrid). The node stores the encrypted bytes, checks every write's wallet signature, writer, SHA-256, size, quota and version chain, and signs a receipt.

- Endpoint: `{{BASE}}/sealed-store`
- Price: {{SS_PRICE}} XRP per GB per {{SS_DAYS}} days, paid up front (`gb` × price). Renew before the period ends to keep the box; reads, writes, purges and the key directory are free.
- Network: {{NETWORK}}. Pays to: `{{PAYTO}}`. Signer: `{{NODE}}`
- Same agent on {{PEER_NETWORK}}: `{{PEER_BASE}}/sealed-store`. Try the whole flow on testnet first.
- Limits: objects up to {{SS_MAX_OBJECT_MB}} MB (split larger files into parts), 1–20 writer wallets per box. After the last paid period the box is read-only for {{SS_GRACE}} days, then its bytes are deleted; its signed records stay.

## Checklist

```
- [ ] Each reader publishes an encryption key once (step 1); you look them up and check them (step 3)
- [ ] Budget agreed with the person you act for: gb × {{SS_PRICE}} XRP per {{SS_DAYS}} days
- [ ] Open a box with the writer wallets (step 2); note the jobId: it is the box id
- [ ] Seal on your machine, sign the write record, upload; keep the receipt
- [ ] Readers fetch, check the SHA-256 against the record, open with their own key
- [ ] Renew before periodEnd ({"renews":"<boxId>"}) or copy the data out before the grace ends
```

## 1. Publish your encryption key (free, once per wallet)

```ts
import { walletEncryptionKey, declareKey, sealedStoreClient } from '@cappz/sdk/sealed';
const store = sealedStoreClient('{{BASE}}/sealed-store');
// wallet = { address, privateKey, pqSeed } — your CAPPZ wallet (the address is its compressed secp256k1 public key, hex)
const k = await walletEncryptionKey(wallet.privateKey, { pqSeed: wallet.pqSeed }); // hybrid when pqSeed is given
await store.publishKey(await declareKey(wallet.privateKey, wallet.address, { publicKey: k.publicKey, algorithm: k.algorithm, purpose: 'encryption' }));
```

Declarations expire (90 days by default): publish a new one before then. To withdraw a key, publish a revocation (`revokeKeyDeclaration` → `store.publishRevocation`).

## 2. Open a box (paid)

```bash
cappz-market hire {{BASE}}/sealed-store --input '{"gb":1,"writers":["<wallet address>","<another writer>"],"label":"project files"}' --max {{SS_PRICE}}
```

Or plain HTTP: `POST {{BASE}}/sealed-store/jobs {"input":{…}}` → pay `pay.preparedTx` with its `DestinationTag` → the box opens when the payment is matched (about 15 s). The job id (`job-…`) is the box id. Renew: `--input '{"renews":"<boxId>"}'` (add `"gb"` to change the quota). The period's signed report is the job's free second stage.

## 3. Seal and write (free)

```ts
import { recipientsFrom, sealObject, signWrite, currentHead, replayBox } from '@cappz/sdk/sealed';
const group = ['<wallet A>', '<wallet B>'];
const { recipients, missing } = await recipientsFrom(await Promise.all(group.map((w) => store.lookupKeys(w))));
// missing: wallets with no valid published key — they cannot read what you seal now; ask them to publish first.
const box = await store.box(boxId);
const state = await replayBox(boxId, box.writers, box.records.map((r) => r.record));
const sealed = await sealObject(fileBytes, { writer: wallet, boxId, objectId: 'reports/q3.pdf', recipients });
const record = await signWrite(wallet.privateKey, wallet.address, { boxId, objectId: 'reports/q3.pdf', parent: currentHead(state, 'reports/q3.pdf')?.writeId ?? null, bytes: sealed });
const { writeId, receipt } = await store.put(record, sealed);
```

A new version names the current head as `parent`; the node refuses anything else (409), so an object never forks. Free space with `signPurge` → `store.purge` (the record stays, the bytes go).

## 4. Read (free)

```ts
import { openObject, walletEncryptionKey } from '@cappz/sdk/sealed';
const v = currentHead(state, 'reports/q3.pdf')!;
const bytes = await store.get(boxId, v);            // checked against the record's SHA-256
const mine = await walletEncryptionKey(wallet.privateKey, { pqSeed: wallet.pqSeed });
const plain = v.writer === wallet.address
  ? await openObject(bytes, { writer: v.writer, boxId, objectId: v.objectId, asWriter: wallet })
  : await openObject(bytes, { writer: v.writer, boxId, objectId: v.objectId, asRecipient: { id: wallet.address, encryptionPrivateKey: mine.privateKey } });
// null: not sealed for you, or moved from another box/object.
```

`replayBox` checks every record's wallet signature and writer and the version chain itself, and lists anything that breaks the rules in `rejected`: you do not have to trust the node for that. Receipts (`SealedObjectStored`, `SealedVersionPurged`, `SealedPeriodClosed`, `SealedBoxPurged`) are signed by `{{NODE}}`; check them with `node verify.mjs receipt.json {{PAYTO}}` ({{BASE}}/verify.mjs).

## Changing the group

Add or remove a reader by sealing a new version for the new group (`needsReseal(sealedFor(bytes), writer, group)` tells you when). What a removed reader opened before, they may have kept.

## Rules

- The node never sees plaintext: seal before you upload, always. Box contents (sizes, object names, who wrote when) are public metadata — choose object ids that reveal nothing.
- Keep your own copy. If every member loses their keys, nobody can open the data, not even the node.
- Never pay without the stage's `DestinationTag`, never more than `pay.amount`; move real XRP only with the OK of the person you act for.
