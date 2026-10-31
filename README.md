# CAPPZ SDK

The public part of [CAPPZ](https://cappz.ai), version 15.14.0. Apache-2.0.

- **`@cappz/sdk/port`**: move a PHP app off php-fpm one route at a time. Inventory the app, run each new handler beside PHP and compare every response, cut over on the evidence, roll back in about a second.
- **`@cappz/sdk/identity`**: KeyZ, wallet-keyed trust. Keys are trusted through declarations the wallet signs, with revocations replayed offline and short delegations; SD-JWT identity claims; X.509 as a projection of a declaration.
- **`@cappz/sdk/edge`**: KeyZ Gate, edge verification of signed HTTP requests (RFC 9421).
- **`@cappz/sdk/transports`**: copies that reach each other through firewalls and proxies: signed hellos, the HTTPS relay and tunnel, WebTransport and WebSocket rungs, LAN multicast, body pull, chunked bodies.
- **`@cappz/sdk/paidAgent`**: run an agent on your own device and get paid in XRP or CAPPZ, stage by stage.
- **`@cappz/sdk/skills`, `/sync`, `/governance`, `/repoz`**: the wallet layer. Local-first storage (OPFS `cappz-store`, memory elsewhere), the Replicator's sync primitives, hash-verified principles, and RepoZ versioning. A hosted mirror is optional: register one with `registerHostedClient`, or run with none.
- **`@cappz/sdk/mesh`**: a resilience mesh for when the internet is down. Phones, laptops and small boards pass signed, delay-tolerant bundles device to device (hotspot, Wi-Fi Direct, WebRTC, BLE/LoRa fragments, USB sticks). KeyZ declarations and a KeyZ Gate check every bundle at every hop, offline. It includes text and voice messaging with names, messages to everyone, and blocking; LoRa via RNode boards; and native iPhone/Android shells. `packages/cappz-mesh-node` runs it on Linux, macOS, Windows and Android, serves a browser app for iPhone, and builds a signed go-kit: a one-file program with Node.js runtimes that a device that was never set up can copy and run with no internet. Field guide: [docs/MESH_FIELD_GUIDE.md](docs/MESH_FIELD_GUIDE.md).
- **`packages/cappz-edge-node`**: the CAPPZ edge node (relay, KeyZ Gate, route host, legacy faces) and its tools.
- **`packages/cappz-native`**: Rust kernels for SHA-256 and Reed-Solomon erasure coding (`src/lib/native`, `src/lib/erasure`). NEON and the ARMv8 SHA-256 instructions natively, SIMD128 WebAssembly in browsers, TypeScript everywhere else. On a Snapdragon 8cx Gen 3: content addressing 8.5× faster, Reed-Solomon 10+4 at 1.4 GB/s with per-shard integrity. [docs/NATIVE_KERNELS.md](docs/NATIVE_KERNELS.md).

Tutorials: [Move off PHP](https://cappz.ai/tutorials/move-off-php) · [Identity and trust](https://cappz.ai/tutorials/identity-and-trust) · [Replicate through firewalls](https://cappz.ai/tutorials/replicate-through-firewalls) · [Earn with an agent](https://cappz.ai/tutorials/earn-with-your-agent)

## Quick start

Needs [Deno 2](https://deno.com) for the edge node and tools, Node 22 for the tests, and PHP only to run the example PHP app.

```sh
git clone https://github.com/CAPPZ-ai/cappz-sdk cappz && cd cappz
npm install

# inventory the example PHP app (reads code, changes nothing)
deno run -A packages/cappz-edge-node/tools/php-port.ts inventory --src packages/cappz-sdk/examples/php-app --out ./port

# the tests
npx vitest run
```

Moving your own app: [docs/MOVE_OFF_PHP.md](docs/MOVE_OFF_PHP.md). Identity, KeyZ and transports: [docs/IDENTITY_TRUST_TRANSPORTS.md](docs/IDENTITY_TRUST_TRANSPORTS.md). Edge node: [packages/cappz-edge-node/README.md](packages/cappz-edge-node/README.md).

## What is in the box

- **Skills** — `FetchSkillsOnChain`: read the notarized skill catalog from the
  wallet graph, not a static registry.
- **Sync** — `CreateEventSubscription`, `runSyncCycle`, `syncCacheWalletCopies`:
  the Replicator's sync primitives for wallet copies.
- **Governance** — `PrinciplesChainlet`, `principlesChainlet`, `sha256Hex`:
  hash-verified principle anchoring (COPE).
- **RepoZ** — one inherited wallet-native versioning skill with generic
  `ContentCreated` / `ContentAmended` history, multi-parent signed merges,
  branch-scoped administration, and exact build dependency manifests.
- **Frames and sessions** (`@cappz/sdk/transports`) — CPZ1 frames (`encodeJsonFrame`,
  `decodeJsonFrame`, `FrameDecoder`), pairing codes (`mintPairingCode`, `pairingCodeValid`), edge
  sessions (`openEdgeSession`) and hello helpers (`asEdgeTransport`, `canonicalHelloJson`).
- **Through firewalls** (`@cappz/sdk/transports`, 15.3.0) — TX bid/ask
  rendezvous and an outbound HTTPS keep-alive carrier with long-poll fallback
  (`connectThroughFirewall`, `openHttpsTunnel`), the relay node handler
  (`createHttpsRelay`), proxy simulation for tests (`proxiedFetch`,
  `PROXY_PROFILES`), and Ed25519 hello/beacon signatures (`generateSigningKey`,
  `signHello`, `verifyHello`, `signBeacon`, `verifyBeacon`). Relays verify
  hellos and take the ticket from `Authorization`, never the URL. Guide:
  https://cappz.ai/tutorials/replicate-through-firewalls.
  Since 15.4.0: the carrier ladder tries WebTransport and WebSocket first
  (`dialWebTransport`, `dialWebSocket`, `proxiedSocketDialer` for tests),
  wallets vouch for device keys with `declareHelloKey` /
  `verifyHelloKeyDeclaration` (no registry needed), and edge sessions pull
  bodies by content hash (`runBodyExchange`, `memoryBodyStore`).
- **Identity and trust** (`@cappz/sdk/identity`, 15.9.0 / 15.10.0) — keep identity
  in a wallet and reveal only what a verifier asks for: claims as salted SD-JWT
  digests + ciphertext (`recordClaim`, `openClaim`), WebAuthn bindings without
  biometric data (`recordBiometricBinding`), issuer attestations as SD-JWT VC with
  ES256K and `did:key` (`attestClaims`), sealed nonce-bound disclosure
  (`requestDisclosure`, `answerDisclosure`, `verifyDisclosure`). Trust keys without
  a certificate authority (`declareKey`, `revokeKeyDeclaration`, `delegateKey`,
  `evaluateKey`) and project them into X.509 for mTLS / QUIC / WebTransport
  (`issueSelfSignedCertificate`, `parseCertificate`). `runIdentityTrustDemo()`
  runs every step, including the refusals, and reports pass/fail — the live
  tutorial runs the same call: https://cappz.ai/tutorials/identity-and-trust.
- **Edge and legacy** (`@cappz/sdk/edge`) — KeyZ Gate, a Fetch-API verify gateway for nginx
  `auth_request` or proxy mode (`createVerifyGateway`; requests signed with RFC 9421
  via `signRequest` / `requestSigner`, content verdicts via `signContentHash`), the
  DMZ quarantine with receipts (`createLegacyGateway`, `intakeQuarantined`), the
  FTPS server session (`createFtpSession`), the read-only LDAP directory
  (`answerLdap`, `ldapClient`) and the FTPS/SFTP pull plan (`curlPlan`).
- **Versus X.509, and retiring legacy checks** (15.11.0) — `runTrustComparison` measures
  KeyZ declarations against a CA chain + CRL on your device (revocation timeline, CPU per
  check, cost per million with labelled assumptions, `TRADEOFFS` including where X.509
  stays and whether policy or technology keeps it). `createShadowComparison` runs the gateway beside a legacy verifier (e.g. a PHP route)
  and gates its retirement on evidence; `packages/cappz-edge-node/tools/compare-verifiers.ts`
  and `tools/gateway.ts` run the comparison on your own instance. Examples:
  `packages/cappz-sdk/examples/php/verify_route.php` (the legacy check, with its verdict headers) and
  `packages/cappz-sdk/examples/php/after_retirement.php` (the route behind nginx auth_request).
- **Move off PHP, route by route** (`@cappz/sdk/port`, 15.12.0) — `inventoryPhpApp` reads a
  PHP app (routes, tables and file stores with their readers and writers, sessions, uploads,
  cron, secrets, libraries) and orders it in waves; `createRouteHost` serves ported routes,
  forwards the rest to PHP and shadows written ports (`createRouteShadow`, `compareResponses`
  with explicit rules); cut-over and rollback are signed TXs (`replayRouteModes`);
  `nginxLocations` sends only ported routes through the host. Examples:
  `packages/cappz-sdk/examples/php-app/` (a small PHP orders API) and `packages/cappz-sdk/examples/port/routes.ts` (its port).
  Tutorial: https://cappz.ai/tutorials/move-off-php
- **More transports** (`@cappz/sdk/transports`, 15.9.0 / 15.10.0) — one transport
  namespace (`resolveTransportType`), wallet multicast groups and signed UDP
  kick-off (`walletMulticastGroup`, `buildConnectRequest`, `buildConnectOffer`),
  files above 6 MB as chunks + manifest (`putBody`, `readBody`), and a processing
  farm: rendezvous partitioning (`flowOwner`, `assignFlows`) and reliable
  multicast with NACK repair and explicit loss (`createFeedSender`,
  `createFeedReceiver`).
- **Examples** (`packages/cappz-sdk/examples/`) — `identity-flow.ts` (TypeScript), `sign_request.py`
  (Python, RFC 9421 signing), `cappz_drop.php` (PHP, same spec, not run in CI),
  `legacy-clients.sh` (curl drops, FTPS, ldapsearch), `nginx-cappz.conf`. The
  TypeScript and Python examples run in this repository's tests as shipped.
- **Resilience mesh** (`@cappz/sdk/mesh`, 15.13.0): offline store-carry-forward between devices.
  - **Founding a mesh.** An authority wallet signs a charter (`createCharter`; the mesh id is its hash) and grants roles (`grantMembership`, `revokeMembership`). Precedence runs FLASH / IMMEDIATE / PRIORITY / ROUTINE and is bounded by role. Guests are carried at ROUTINE.
  - **Bundles.** Each bundle is signed by a device key that the sender's wallet declared (KeyZ), carries its own credentials (sent by reference to neighbours that already hold them), and has its body sealed to the recipient's declared P-256 key (`sealBytesTo`).
  - **The gate.** `MeshGate` is a KeyZ Gate for bundles, applied at every hop: signature, body hash, key trust and revocation, membership, precedence, and per-source origination rate.
  - **The node.** `MeshNode` announces then pulls over CPZ1 frames and routes with spray-and-wait plus PRoPHET. Receipts are signed by the recipient and verifiable by every carrier. The store has per-source quotas, and KeyZ revocations are gossiped at FLASH.
  - **Links.**
    - TCP on any local network.
    - WebSocket for browsers.
    - WebRTC with offline pairing codes (`offerPairing` / `answerPairing`).
    - LoRa through `RadioMedium` (a shared channel turned into links per neighbour, with an airtime budget and the duty-cycle rules in `LORA_REGIONS`) and KISS / RNode framing (`kissEncode`, `rnodeConfigFrames`).
    - Native radios through `attachNativeBridge`: MultipeerConnectivity and Nearby Connections shells in `packages/cappz-mesh-native`, not yet compiled.
    - Carry files (`writeCarryFile` / `readCarryFile`).
  - **Messaging.** Text and voice messages (`splitVoice`, `VoiceAssembler`, `recordVoice`); signed, display-only names with nicknames and ambiguity-safe lookup (`ContactBook`); a channel for everyone (`EVERYONE_CHANNEL`); and a personal block list that stops showing and carrying a sender's messages while their revocations still apply.
  - **Simulator and evals.** `runSimulation` and `runMeshEvals`: dense, sparse, shelters with couriers, forgers, flooders, a captured device, black holes, forged receipts, and jammed BLE, each with declared thresholds. Run them with `npm run mesh -- evals [--full]`.
  - **Docs.** [docs/MESH_RESILIENCE.md](docs/MESH_RESILIENCE.md) covers the design; [docs/MESH_FIELD_GUIDE.md](docs/MESH_FIELD_GUIDE.md) is the field guide.
- **Paid agents** — `createPaidAgent`, `SCHEDULE_PRESETS`, `paymentRequest`,
  `checkPayment`, `replayJob`: run an agent on your own device and get paid
  in XRP or CAPPZ stage by stage (upfront deposit, milestones, completion).
  Payments count only when the validated ledger shows them delivered to your
  address with the stage's destination tag; each result is held (HTTP 402 in
  the ready-made agent) until its stage is paid. Guided setup:
  https://cappz.ai/tutorials/earn-with-your-agent.

## Storage, and an optional hosted mirror

Data lives in wallets, stored on the device first: OPFS (`cappz-store`) in browsers, memory in Node and Deno
tests. A hosted table mirror and hosted functions are a port, not a dependency
(`src/lib/sync/hostedBackend.ts`):

```ts
import { registerHostedClient } from '@cappz/sdk/sync';
registerHostedClient('routed', supabaseLikeClient);   // optional: from(table) builders + functions.invoke
```

With nothing registered, reads return no hosted rows, writes stay local (the sync adapter queues them in its
outbox) and `suggestMerge` (a hosted agent) reports that it needs a backend. cappz.ai registers its own client.

## Federated RepoZ

```ts
import { includeRepoZSkill, createRepoZContent, amendRepoZContent } from '@cappz/sdk/repoz';

await includeRepoZSkill(appRoot);
await createRepoZContent({ appRoot, artifactId, objectType: 'document', contentHash, contentAddress, actorAddress, signature });
await amendRepoZContent({ appRoot, artifactId, objectType: 'document', contentHash: nextHash, contentAddress, actorAddress, signature, baseHeads });
```

The shared RepoZ POW is read-only by default. Each app's Administrators group
may receive a wallet-signed amendment grant scoped from that app branch top
node downward. Private bytes remain in the owning wallet; shared branches
carry only version identity, hashes, dependencies, and build evidence.
Grant issuance is deliberately absent from this public SDK until the trusted
group-replay signer boundary is connected.

> Each current location of documents have a repoz skill. If the included skill is anchored on a branch of the chain based graph, there is both functional isolation coordinated shared versioned reuse in a distributed manner.  
> Create a single cappz-repoz wallet PTW that includes RepoZ skill.  Because each App and platform PTW holds the RepoZ skill respectively anchored to their sub graph of the ontological blockchain platform graph, any overlapping branches are multi-master version coordinated. Each app builds of specific versions.  App dependencies are traced via Txs within each App PTW. The vin diagram dependency graph made manifest. Each App PTW, PTO, and UAW have the embedded auto-syncing cappz-repoz seeparate from their private namespace encapsulating wallet whereee instance specific private content is strored.

> from the app specific branch top node down. Same scoping as the resident admin agent.  Distributed synchronized and tenant ring-fenced federated development repoz. Need BPMN to capture it all.

PTW means Prime Template Wallet. PTO/POW is the Prime Operational Wallet.
UAW means User Application Wallet. See the full BPMN and architecture guide
in `docs/CAPPZ_REPOZ_GUIDE.md`.

## Storage compaction (v14-16-03)

Archive = Replication + purge. Three notarized TXs: `ContentCompressed` (source → `<address>/compressed/gzip` child alias), `ContentArchived` (source → archive wallet, from a verified one-way Replicator receipt), `ContentPurged` (AgentAdmin → original, last; placeholder never replicates). See docs/CAPPZ_REPOZ_GUIDE.md.

**Lazy decompress (decompress only on a cache hit):** the index and metadata load on boot; code and documents stay gzip-compressed in memory and are unzipped, hash-checked, only when opened (`lazyContent`), then kept in the hot cache. Untouched content costs no memory or CPU.

**Archive activation (v14-16-04):** the Archive button checks every platform/app wallet for an archive replica; missing ones are created with `ReplicantCreated` + derived `ArchiveCreated` (same correlationId), then archive-content.bpmn runs. Only deltas are archived: content with no `ContentArchived` TX.

## Process execution: clones vs copies (v14-16-07)

BPMN templates declare external/async IN and OUT ports once. A running instance is localized to the executing wallet: `processInstanceAddress(walletRoot, process, n)`.

- **Clone** (by value): own root; instances and instance ports are unique HD children of the clone. Use for wide distribution with active edge execution.
- **Copy** (by reference): a connected shared library tracking the template head; owns no instance addresses, even when embedded in a clone (e.g. the PTW copy inside bible-codex POW/UAW clones). It runs in the host clone's scope (`executingWalletRoot`).
- Caution: each clone grows its own instance tree. Instance ports are written only when a TX crosses them.

Process → function bindings are written by `ConstructBPMN` → `BindBPMNFunctionsOnchain` (idempotent diff of `ConstituentIncluded`/`ConstituentRemoved`), from the build cycle or on demand by an admin.

## Use it in code

```sh
git clone https://github.com/CAPPZ-ai/cappz-sdk cappz && cd cappz && npm install
```

Not on npm yet: use it from a clone (or as a git submodule).

```ts
import { encodeJsonFrame, FrameDecoder, mintPairingCode } from '@cappz/sdk/transports';
const frame = await encodeJsonFrame('ping', { at: Date.now() });
```

Identity in five lines, and the whole flow checked in one call:

```ts
import { runIdentityTrustDemo } from '@cappz/sdk/identity';
const report = await runIdentityTrustDemo();
console.log(report.passed, 'of', report.steps.length, 'checks passed');
```

Verify requests at your reverse proxy (any Fetch runtime: Deno, Bun, Node 18+, workers):

```ts
import { createVerifyGateway } from '@cappz/sdk/edge';
const gateway = createVerifyGateway({ evidence: { evidenceFor: async (wallet) => loadDeclarations(wallet) }, requireBound: true });
Deno.serve({ port: 41446, hostname: '127.0.0.1' }, (req) => gateway.handle(req));   // nginx auth_request → /cappz/verify
```

## Measured, and how to rerun it

On one x86-64 machine (not ARM), against the example apps:

| | PHP | CAPPZ |
|---|---|---|
| 300 overlapping orders (php-fpm, 32 workers) | confirmed 88, kept 12, 212 failed | kept 300 of 300 |
| Throughput, orders API | 34,662 req/s | 45,593 req/s |
| Requests signed with revoked keys | 360 of 360 accepted | all refused |
| Replayed requests | 359 of 359 accepted | all refused |

Rerun on yours: `packages/cappz-edge-node/tools/write-race.ts`, `bench-routes.ts`, `compare-verifiers.ts`.

## Layout

`packages/cappz-sdk/*.ts` are the entry points; `src/` holds the library code they use; `packages/cappz-edge-node` is the edge node and its tools; `docs/` the guides. Paths are the ones the tutorials use.

## Contributing

This repository is the only source of this code. The CAPPZ platform uses it as a git submodule, so a change lands here first. Issues and pull requests are welcome. Run `npx vitest run` and `npx tsc --noEmit` before a pull request.
