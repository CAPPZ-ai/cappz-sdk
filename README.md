# CAPPZ SDK

The public part of [CAPPZ](https://cappz.ai), version 15.12.2. Apache-2.0.

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
