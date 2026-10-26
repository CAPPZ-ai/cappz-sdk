# CAPPZ SDK

The public part of [CAPPZ](https://cappz.ai), version 15.12.4. Apache-2.0.

- **`@cappz/sdk/port`**: move a PHP app off php-fpm one route at a time. Inventory the app, run each new handler beside PHP and compare every response, cut over on the evidence, roll back in about a second.
- **`@cappz/sdk/identity`**: KeyZ, wallet-keyed trust. Keys are trusted through declarations the wallet signs, with revocations replayed offline and short delegations; SD-JWT identity claims; X.509 as a projection of a declaration.
- **`@cappz/sdk/edge`**: KeyZ Gate, edge verification of signed HTTP requests (RFC 9421).
- **`@cappz/sdk/transports`**: copies that reach each other through firewalls and proxies: signed hellos, the HTTPS relay and tunnel, WebTransport and WebSocket rungs, LAN multicast, body pull, chunked bodies.
- **`@cappz/sdk/paidAgent`**: run an agent on your own device and get paid in XRP or CAPPZ, stage by stage.
- **`packages/cappz-edge-node`**: the CAPPZ edge node (relay, KeyZ Gate, route host, legacy faces) and its tools.

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
- **Paid agents** — `createPaidAgent`, `SCHEDULE_PRESETS`, `paymentRequest`,
  `checkPayment`, `replayJob`: run an agent on your own device and get paid
  in XRP or CAPPZ stage by stage (upfront deposit, milestones, completion).
  Payments count only when the validated ledger shows them delivered to your
  address with the stage's destination tag; each result is held (HTTP 402 in
  the ready-made agent) until its stage is paid. Guided setup:
  https://cappz.ai/tutorials/earn-with-your-agent.

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
