# CAPPZ SDK

The public part of [CAPPZ](https://cappz.ai), version 16.0.3. Apache-2.0.

**Agents:** find the skill for a task with `cappz-market skills "what you need"`, or search [skills/index.json](skills/index.json) (every skill's when-to-use, commands and guide); [llms.txt](llms.txt) is the short map. **People:** start with the guide for what you are doing, below; the [Constraint Guard walkthrough](docs/tutorials/constraint-guard.html) is animated (open it in a browser).

- **`@cappz/sdk/port`**: move a PHP app off php-fpm one route at a time. Inventory the app, run each new handler beside PHP and compare every response, cut over on the evidence, roll back in about a second.
- **`@cappz/sdk/identity`**: KeyZ, wallet-keyed trust. Keys are trusted through declarations the wallet signs, with revocations replayed offline and short delegations; SD-JWT identity claims; X.509 as a projection of a declaration.
- **`@cappz/sdk/edge`**: KeyZ Gate, edge verification of signed HTTP requests (RFC 9421).
- **`@cappz/sdk/transports`**: copies that reach each other through firewalls and proxies: signed hellos, the HTTPS relay and tunnel, WebTransport and WebSocket rungs, LAN multicast, body pull, chunked bodies.
- **`@cappz/sdk/paidAgent`**: run an agent on your own device and get paid in XRP, CAPPZ or USD-tokenZ/1 (RLUSD), stage by stage.
- **`@cappz/sdk/marketplace`** and **`cappz-market`**: the CAPPZ Marketplace engine (governed contracts paid in any registered payment asset — XRP, CAPPZ, USD-tokenZ/1 (RLUSD) or USD — milestone escrow or stage-by-stage payment on the XRP Ledger, metered payment channels, subcontracts, receipts, a securities path, agents under mandates) and a one-file tool that lets any agent use it as a CLI or as MCP tools. Agents start with the skill [skills/using-cappz-marketplace](skills/using-cappz-marketplace/SKILL.md); all agent skills: [skills/](skills/README.md). The CAPPZ counterparty check (`packages/cappz-check-worker`, a paid agent on a Cloudflare Worker) checks an address or party before you pay: `cappz-market check`; the same service evaluates a delivered stage against its agreed acceptance criteria (`cappz-market evaluate`), drafts listings from plain words (`cappz-market draft`) and scouts subcontractors (`cappz-market scout`). Before a large payment, the **payee confirmation** (15.38.0, `cappz-market confirm-payee`) checks that payment instructions are the ones the payee declared on the market and endorsed from their own XRPL wallet, past a 72-hour cooling period — not merely an address that exists — and flags changed instructions and lookalike (poisoned) addresses; payees publish with `cappz-market payee declare` (an XRPL address, or a bank account by salted digest). Rules in `src/lib/marketplace/payeeConfirmation.ts`; skill [skills/confirming-payees](skills/confirming-payees/SKILL.md). The same service approves, for free, the exact escrow, stage payment or payment-channel transaction a deal allows before a wallet signs it (`POST /<network>/authorize`, rules in `src/lib/marketplace/signingApproval.ts`); `cappz-market fund`, `release`, `redeem` and `close` sign nothing without it.
- **`@cappz/sdk/skills`, `/sync`, `/governance`, `/repoz`**: the wallet layer. Local-first storage (OPFS `cappz-store`, memory elsewhere), the Replicator's sync primitives, hash-verified principles, and RepoZ versioning. A hosted mirror is optional: register one with `registerHostedClient`, or run with none.
- **`@cappz/sdk/mesh`**: a resilience mesh for when the internet is down. Phones, laptops and small boards pass signed, delay-tolerant bundles device to device (hotspot, Wi-Fi Direct, WebRTC, BLE/LoRa fragments, USB sticks). KeyZ declarations and a KeyZ Gate check every bundle at every hop, offline. It includes text and voice messaging with names, messages to everyone, and blocking; LoRa via RNode boards; and native iPhone/Android shells. `packages/cappz-mesh-node` runs it on Linux, macOS, Windows and Android, serves a browser app for iPhone, and builds a signed go-kit: a one-file program with Node.js runtimes that a device that was never set up can copy and run with no internet. Field guide: [docs/MESH_FIELD_GUIDE.md](docs/MESH_FIELD_GUIDE.md).
- **`@cappz/sdk/network`**: network addresses and testnet → mainnet promotion as one governed run: app-declared promotion checks, preflight evidence that a start must cite (same session, network pair and apps; any network switch invalidates it), a run view replayed from its own TXs (resume from the first step not completed; rollback clean until the first irreversible step), the issuer-grant dry run (DefaultRipple before holder lines, NoRipple repair, fee lines, owner reserve), the config manifest a run compares and anchors (shared entries must match; only a value that differs blocks), and which ledger authority (master or regular key) lets a key sign for an account. [docs/NETWORK_PROMOTION.md](docs/NETWORK_PROMOTION.md).
- **`@cappz/sdk/constraints`** and the **Constraint Guard** (15.40.0): keep physical systems inside their safe envelope. One signed envelope per device (range, rate, dwell, sensor agreement, response, who may command what, when; loosening needs two operators and a cooling period), **reconciliation** that finds every change nobody signed for and every breach from data the plant already has (historian exports, setpoint read-back, sealed observations), and an **inline guard** on the edge node for HTTP panels, Modbus TCP, BACnet/IP, DNP3, IEC 60870-5-104, MQTT/Sparkplug B and Gremlin (Apache TinkerPop) — shadow first, enforced per point on its report, refusing in each protocol's own terms. Advisory navigation and air-data integrity for vehicles (GNSS spoofing, unreliable airspeed). Marketplace agents: `cappz-market constraints-draft`, `constraints-review`, `constraints-triage`. Guide: [docs/CONSTRAINT_GUARD.md](docs/CONSTRAINT_GUARD.md); skills [securing-control-systems](skills/securing-control-systems/SKILL.md), [monitoring-constraints](skills/monitoring-constraints/SKILL.md).
- **Vault Guard** (15.48.0, in `@cappz/sdk/marketplace`): limit what a stolen key can take from a pooled XRPL account (a fee collector, treasury or bridge vault), enforced by the ledger. The master key is off and a signer list makes an independent guard co-signer necessary; the guard signs only inside the owner's outflow policy (allowed destinations, per-payment and rolling-window caps, the account's next sequence only); every validated outflow is reconciled against the guard's approvals. [docs/VAULT_GUARD.md](docs/VAULT_GUARD.md).
- **`packages/cappz-edge-node`**: the CAPPZ edge node (relay, KeyZ Gate, route host, legacy faces), its tools, and its paid agents (signed timestamp, signed webhook receiver, fair draw, vault check, vault guard co-signer; [agents/README.md](packages/cappz-edge-node/agents/README.md)).
- **`packages/cappz-native`**: Rust kernels for SHA-256, Reed-Solomon erasure coding and signature verification (`src/lib/native`, `src/lib/erasure`). NEON and the ARMv8 SHA-256 instructions natively, SIMD128 WebAssembly in browsers, TypeScript everywhere else. On a Snapdragon 8cx Gen 3: content addressing 8.5× faster, Reed-Solomon 10+4 at 1.4 GB/s with per-shard integrity, notarization hashing (file hash + salted leaf in one streamed pass) 28× faster than `crypto-js`, and secp256k1 signature checks 50× faster (258× on all cores). [docs/NATIVE_KERNELS.md](docs/NATIVE_KERNELS.md).
- **Hardware-backed keys and notarization** (`src/lib/identity`, `src/lib/crypto`): wallet keys wrapped by a passkey (WebAuthn PRF), data keys wrapped by a wallet, notarization receipts signed by an enrolled device, batch notarization under one ledger anchor (RFC 9162 Merkle proofs), and attestation checks for Apple, Android Keystore, Windows TPM and packed authenticators. [docs/HARDWARE_TRUST.md](docs/HARDWARE_TRUST.md).

Tutorials: [Move off PHP](https://cappz.ai/tutorials/move-off-php) · [Identity and trust](https://cappz.ai/tutorials/identity-and-trust) · [Replicate through firewalls](https://cappz.ai/tutorials/replicate-through-firewalls) · [Earn with an agent](https://cappz.ai/tutorials/earn-with-your-agent)

## What's new in 16.0.3

Version alignment, no code change. From 16.0.3 CAPPZ (the app) and this SDK move in lockstep: every
CAPPZ release vX-YY-ZZ pins SDK X.YY.Z. 16.0.1 and 16.0.2 were CAPPZ-only releases (the charts on
recharts 3; the MCP server reading its version at runtime), so the SDK steps from 16.0.0 to 16.0.3.

## What's new in 16.0.0

The v16 line: CAPPZ (the app) moves to v16-00-00 with it (React 19, vite 6, vitest 5). No API was
removed from the SDK. What changed since 15.48 and may matter when you upgrade:

- **xrpl 5.** `Wallet.fromSeed(seed)` without an algorithm now derives a secp256k1 family seed (`s…`,
  not `sEd…`) as secp256k1; xrpl 4 read it as Ed25519 and returned another account. Both readings are
  accounts the seed controls. If you stored addresses derived under xrpl 4, sign through
  `walletForAccount(Wallet, seed, account)` (`@cappz/sdk/marketplace`), which picks the reading that
  controls the account and reports `legacy-ed25519` (15.49.3, 15.49.4).
- **@noble/curves 2.** Import paths end in `.js` (`@noble/curves/ed25519.js`, `@noble/curves/nist.js`);
  keys and signatures are byte-identical to 1.9 (15.49.2).
- **Tests run on vitest 5**, which no longer carries vite-node or esbuild; both are declared. A host app
  that runs the SDK's tests with its own vitest should be on vitest 5 as well.

## What's new in 15.49.1

- **`verify.mjs` and the guide's in-browser verifier read vault reports** (`{report, decisions?, alerts?}`). They check the report, the decisions hash, and every decision and alert signed by the same declared key. The first live testnet hire of `vault-check` returned a valid report, but the verifier read it as a bare record and printed INVALID. Test added in `src/test/edge-node-agents.test.ts`.
- `creating-cappz-listings`: check a test hire with the verifier the listing names, not only the hire's hash check.

## What's new in 15.49.0

- **The edge node sells the Vault Guard as two paid agents** (`packages/cappz-edge-node/agents/vault.ts`, wired in `agents/server.ts`; served docs `vault-check.SKILL.md`, `vault-guard.SKILL.md`, guide cards, `llms.txt`, OpenAPI).
  - **`vault-check`** (1 XRP, on completion): a signed report on a pooled XRPL account. It says whether a guard co-signer is load-bearing or a stolen key could move money alone; with a policy, the worst case; with the guard's approvals, every recent outflow matched. Read from the ledger; no key held.
  - **`vault-guard`** (10 XRP per 30 days, pay first; the report is free): the node is the vault's guard co-signer.
    - **Co-signing:** `POST /vault-guard/cosign/<jobId>` co-signs only inside the owner's policy. Every decision is signed. Approvals are recorded before the blob is returned, and requests are serialised.
    - **Watching:** outflows are reconciled every 10 minutes from the first guard period. A signed alert is POSTed to `alertUrl` for any outflow the guard didn't approve. The period ends with a signed report.
    - **Guard keys:** derived from `CAPPZ_VAULT_GUARD_SECRET` by network and vault, so the same vault keeps the same guard and the receipt key can rotate freely.
  - **Only the vault can start or change its guard.** A period counts only when the vault paid it, and a policy change only when that payment was signed without the guard (recovery keys or the master key). A thief holding operator keys can't pay for a looser policy through the guard. Unauthorised jobs get 403.
  - **Tested on the XRPL testnet** with the real server (`tools/vault-agents-testnet.ts`):
    - vault check `not-set-up`, then `guard-load-bearing`;
    - a period paid from the vault was authorised, and an in-policy payment was co-signed and settled;
    - a drain was refused;
    - a loosened policy paid through the guard was refused (`policy-change-needs-recovery`), and a stranger-paid period too (`not-from-vault`), both answering 403;
    - break-glass recovery was alerted by the node.
  - Unit tests: `src/test/edge-node-vault.test.ts`.
- **New skill `creating-cappz-listings`:** the path from "list this" to a listing that works when bought. It covers:
  - the service exists and is tested
  - the seller account and network
  - fields and pricing (recurring services as at most 30-day periods)
  - a description for people and agents
  - testnet, one hire, then mainnet with the person's OK
  - a final `find` check

  Linked from skills/README (start here), `llms.txt`, and the using, drafting, managing, selling and edge-node skills.
- `npm run market:build` now writes `skills/index.json` before bundling the tool. Before, the tool shipped the previous skills index, so a new skill couldn't be found with `cappz-market skills` until a second build.

## What's new in 15.48.1

- `src/test/vault-guard.test.ts` runs in the node environment (as the other XRPL-key tests do): under a host app's jsdom suite, `Wallet.generate()` failed noble-curves' byte check. No code change.

## What's new in 15.48.0

- **Vault Guard: a stolen key cannot empty a pooled account** (`src/lib/treasury/vaultGuard.ts`, exported from `@cappz/sdk/marketplace`; guide [docs/VAULT_GUARD.md](docs/VAULT_GUARD.md)).
  - **Why:** on 2026-11-21 an attacker drained Chainflip's Ethereum vault (about $4.86 million) with a valid signature from its threshold signing key, made outside the normal signing system (a 39-digit nonce where the counter stood near 315,000), and laundered it in under ten minutes. A vault that pays whatever one key signs is limited only by its balance.
  - **Setup** (`guardSetupTransactions`, `checkSignerSetup`): master key off; a signer list where every operator key together cannot reach quorum, the guard alone cannot, the guard plus k operators can, two offline recovery keys can, and one recovery key plus every operator cannot (operator 1, recovery n+1, quorum 2n+2, guard 2n+2−k). The check reads account_info and names every way a key could bypass the guard.
  - **Policy** (`evaluateOutflow`, `guardCosign`): allowed destinations and tags, per-transaction and rolling-window caps per asset (exact token decimals), capped fee, short expiry, the account's next sequence only (no tickets, no counter jumps), no partial payments, paths or extra fields, never a key/signer/account change. Every reason is returned.
  - **Reconciliation** (`reconcileOutflows`): every validated outflow must match a recorded approval by intent hash (API v2 `DeliverMax` handled); a failed but validated transaction without approval is still `unapproved`; the report is hashed.
  - **Tested on the XRPL testnet** (`tools/vault-guard-testnet.ts`): master key `tefMASTER_DISABLED`; both operator keys draining, removing the guard, or setting a regular key `tefBAD_QUORUM`; the guard refused the drain (sequence-gap, destination-not-allowed, over-tx-cap, over-window-cap); a 15 XRP in-policy payment succeeded; 20 more XRP past the 30 XRP window was refused; two recovery keys moved 5 XRP and reconciliation reported it `unapproved`; the attacker address was never created. Unit tests: `src/test/vault-guard.test.ts`.

## What's new in 15.47.0

- **A fair draw the edge node sells: winners nobody can steer, not even the node, and anyone can recompute** (`packages/cappz-edge-node/agents/draw.ts`, the `draw` agent in `agents/server.ts`).
  - **What people use it for:** giveaway and raffle winners, audit samples, members or reviewers chosen by lot, random group assignment, tie-breaks. 0.1 XRP per draw, paid once up front.
  - **How it works:** the buyer sends the list, or only its SHA-256 and size if it is private, plus the number of winners and a draw time (up to 30 days ahead). After payment the node signs a `DrawCommitted` record (the list's fingerprint, size, winners, draw time and the latest validated ledger). It goes on a public, hash-chained log (`GET /agents/draw/log`, one record per commitment, each naming the one before it). At the draw time the seed is the hash of the first validated XRP Ledger ledger closed at or after it; partial Fisher–Yates over a SHA-256 counter stream with rejection sampling picks distinct entries (rule `cappz-draw/v1`). The node signs `DrawPerformed`.
  - **Why nobody can steer it:** the list is locked (and paid for) before the seed ledger exists. The seed depends only on the ledger and the list, so committing the same list twice changes nothing. A different list is a new paid commitment, visible on the log.
  - **Checking it:** `verify.mjs` checks both signatures and the timing, reads the seed ledger and the one before it from public XRPL servers, and recomputes the winners (`--entries` for a private list, `--hash-entries list.txt` to fingerprint one). A buyer can ask for a public draw: `/agents/draw/draws/<jobId>` then serves a page that re-runs every check in the browser, reading the ledger over a public XRPL WebSocket.
  - **No declaration file to copy:** the agents find the payout account's on-ledger KeyZ declarations of the node key themselves, in that account's ledger history (`discoverLedgerAnchors` in `agents/ledgerKeyz.ts`; `CAPPZ_KEYZ_ACCOUNT`, default the payout address, on `CAPPZ_KEYZ_NETWORK`, default mainnet, so the testnet twin uses the same declaration; re-read hourly). A declaration approved in Xaman, first time or renewal, now reaches the node with nothing copied. Once the account has declared the key, signing pauses whenever no declaration is valid (expired or revoked), exactly as with a file. `CAPPZ_KEYZ_DISCOVER=0` turns it off; a `key-declarations.json` still works. Tested on the XRPL testnet: declare from the payout wallet, the agents' card shows `declaredBy`, a paid receipt verifies by r-address, revoke, signing pauses.
  - **Paid-agent kit:** a completion stage may now be free (share 0) after upfront stages that carry the whole price (`isFreeCompletion`): pay first, collect when ready, one payment. `cappz-market hire` handles it as is.
  - The guide page has a "Run a fair draw" form, and the draw has its own `draw/SKILL.md`, OpenAPI entries and `llms.txt` line. Tested end to end on the XRPL testnet with `cappz-market hire`; the public page was checked in Chrome. Tests: `src/test/edge-node-draw.test.ts`.

## What's new in 15.46.1

- `src/lib/sync/__tests__/kvSegments.test.ts`: the scoped-flush tests drain their backend before they end. A queued write's timer from one test fired under a loaded suite (cappz's full run) and wrote into the next test's stand-in file system. No code change.

## What's new in 15.46.0

- **A small durable save no longer fails because a large unrelated write did.** On an iPhone, a page that cached megabytes (the Bible canon) left those rows queued; the next signed-in save flushed them too, Safari failed the large write with `UnknownError` ("unknown transient reason (e.g. out of memory)") and the save failed.
  - `offlineCache.set(..., { durable: true })`, `setMany` (and so `chainletStorage.setItems` and every `requireDurable` event batch) now await only their own batch: `KvBackend.flush({ store, keys })` writes the queued batches holding those keys as one segment and leaves the rest queued. A batch that shares a key with them goes with them, so no batch is split. `flushActiveKvEngine(scope?)` takes the same scope.
  - Background flushes write segments of about 2 MB (`SEGMENT_TARGET_CHARS`), never splitting a write batch. One store's failed write no longer stops the others; it is retried with back-off (1 s doubling to 1 min).
  - Compaction after a segment write runs as its own step; the save that triggered it is already on disk, and a failed compaction only leaves more segments to replay. A full `flush()` still waits for it.
  - `opfsWriteFile` retries a transient `UnknownError` once after 150 ms, then once through the sync-access worker (a separate heap). Other errors fail at once. A failed writable is aborted so the retry can open the file.
  - Tests: `src/lib/sync/__tests__/kvSegments.test.ts` (scoped flush beside a failing store, no split batch, segment-sized background writes, transient retry).

## What's new in 15.45.0

- **The payout account can vouch for the paid agents' signer on the XRP Ledger, signed in Xaman, with no seed anywhere.**
  - **Before:** a KeyZ declaration needed the account's family seed, typed into `declare-node-key.ts` on some machine.
  - **Now, for people:** run `packages/cappz-edge-node/agents/declare-node-key.ps1`. A QR code opens; scan it in Xaman and approve. That signs one `AccountSet` from the payout account which changes nothing on the account (fee about 0.00001 XRP) and whose `cappz/keyz` memo names the node key and how long it lasts (at most 90 days). The script waits for the ledger, then writes an anchor into `key-declarations.json`. `-Revoke` withdraws it the same way; `-Check`, `-Network testnet`, `-Hash` and `-Json` are there too. One-time setup: an app key from apps.xumm.dev in `xaman.env`, since Xaman shows sign requests only from a registered app. Without one, the transaction JSON is printed for any wallet.
  - **For agents:** `skills/running-edge-node-paid-agents` covers it step by step, with the JSON result and exit codes (0 done, 3 declined or expired in Xaman, 4 not seen in time, 1 error).
  - **Checking it:** records sign in `payload.signerDeclaration = "xrpl:<network>:<tx hash>"`. The agents (every 5 minutes) and `verify.mjs <file> <r-address>` read the declaration and the account's later revocations from public XRPL servers (`agents/ledgerKeyz.ts`; `verify.mjs` stays dependency-free). The ledger has already checked that the account authorized the transaction, so Ed25519 accounts, regular keys and multisign accounts work too. The agents stop signing once the declaration expires or is revoked.
  - Tested end to end on the XRPL testnet: declare, serve, verify by r-address, revoke, refuse. The Xaman path was tested against a stand-in for its API. `src/test/edge-node-ledger-keyz.test.ts` covers the rules, and `verify.mjs` against a stand-in ledger.

## What's new in 15.44.1

- `src/test/edge-node-agents.test.ts` runs in the node environment (`// @vitest-environment node`, like the other SDK tests). cappz runs the SDK's tests under jsdom, where `xrpl`'s `Wallet.fromSeed` rejected Node buffers from another realm ("Uint8Array expected"). No code change.

## What's new in 15.44.0

- **A wallet, not the website's certificate, vouches for the paid agents' signer** (KeyZ).
  - **The problem:** buyers learned the signing key from the HTTPS page. That page's public-CA certificate proves who controls a DNS name, so whoever took over the name (for example a hijacked dynamic-DNS account) could serve another key.
  - **New tool:** `packages/cappz-edge-node/tools/declare-node-key.ts` has a wallet sign a KeyZ declaration of the node key into the node's `key-declarations.json`. The wallet is ideally the payout account; its seed is typed at a hidden prompt and never stored. `--expect <r-address>` guards against the wrong seed, `--check` prints the state, and `--revoke` signs revocations.
  - **Agents:** with the declarations file set (`CAPPZ_NODE_KEY_DECLARATIONS`, picked up by `run-agents.ps1`), every record signs in `payload.signerDeclaration`, and every result carries the declarations and revocations it needs. Agent cards show `declaredBy`. `GET /agents/key-declarations.json` serves the current evidence.
  - **Fail closed:** with the file set but no valid, unrevoked declaration of this key, the agents refuse to start or to sign. A revocation stops signing within a minute.
- **`verify.mjs` checks who vouches, offline and still with no dependencies.**
  - It verifies the declaration's secp256k1 wallet signature (BigInt ECDSA, low-S, as `@noble/secp256k1`) and prints the wallet's XRPL address (RIPEMD-160 + base58check, as `xrpl`'s `deriveAddress`).
  - `node verify.mjs <file> <r-address>` requires that wallet. A signed revocation in the file or in `--evidence key-declarations.json` fails the record.
- The public-CA certificate (Caddy/Let's Encrypt) stays, only for the browser-facing `https://` front door.
- Found while building: xrpl 4.x's `Wallet.fromSeed` defaults to Ed25519 even for a secp256k1 seed, which derives a different account. The tool reads the algorithm from the seed (`decodeSeed`).

## What's new in 15.43.1

- **The paid agents' Windows launcher lets them read their own data folder** (`packages/cappz-edge-node/agents/run-agents.ps1`). 15.43.0 granted `--allow-read` on the SDK only, so the agents wrote jobs and results they could not read back: a paid result came back empty, and a restart forgot every job (nothing was lost on disk). The server now stops on any read error other than a missing file, instead of taking it for "no jobs yet" (`onlyMissing` in `agents/server.ts`).

## What's new in 15.43.0

- **Paid agents for the edge node** (`packages/cappz-edge-node/agents`). The node key's signatures become two agents on the marketplace, paid in XRP stage by stage on the paid-agent kit: a **signed timestamp** (a file's SHA-256 in, a receipt signed by the node key out; 0.05 XRP on completion, the file never leaves the buyer) and a **signed webhook receiver** (a URL for 30 days that signs every POST; 2 XRP, 30% deposit, 70% for the signed bundle of all records). Run one instance per network: testnet validates every flow with free test XRP before mainnet takes real XRP. Every record is signed with `payload.network`, so a free testnet receipt never passes for a paid mainnet one.
- **Docs for people and agents, served by each instance** (`agents/docs.ts`, templates in `agents/docs/`): a guide with try-it forms (hash a file in the browser, pay from any XRPL wallet, download and verify the receipt), `llms.txt`, a `SKILL.md` per agent, OpenAPI 3.1, and `verify.mjs`, an offline verifier for receipts and bundles (Node 20+ or Deno, no dependencies). All are filled with the instance's live price, network, payout address and signer. Agent cards link them in `docs`; a browser opening an agent's URL lands on its try-it form. Windows launcher, example settings and Caddy routes in [agents/README.md](packages/cappz-edge-node/agents/README.md); new skill [running-edge-node-paid-agents](skills/running-edge-node-paid-agents/SKILL.md).

## What's new in 15.42.0

- **The edge node's jobs server binds `127.0.0.1` everywhere** (`main.ts --jobs`, `timers.ts`, `serveJobs`). `main.ts` used to bind every interface, so a node published for peers (for example `--relay` behind a reverse proxy) also offered `GET /txs`, its signed job history, to its whole network. Timer ticks need outbound HTTPS only. `CAPPZ_JOBS_HOST` names another address (`0.0.0.0` for peers or webhook senders on the network); `jobsHostFrom` and `DEFAULT_JOBS_HOST` in `src/lib/functions/edgeJobs.ts`.

## What's new in 15.41.0

- **Timers-only edge node** (`packages/cappz-edge-node/timers.ts`). Runs just the BPMN timers: no peer, relay, gateway or directory listener, and no npm package (the node key is imported with WebCrypto in `signingKey.ts`). The jobs server binds `127.0.0.1` (`CAPPZ_JOBS_HOST` changes it); ticks need outbound HTTPS only. `deno run --cached-only --no-config … timers.ts --jobs 41444`.
- **`main.ts` starts only the services you name** (`--tcp`, `--quic`, `--ws`, `--relay`, `--verify`, `--legacy`, `--ftps`, `--ldap`, `--routes`, `--saml`, `--constraints`, `--jobs`; none named = all, as before). Each service starts on its own: one that cannot bind its port is logged and the rest keep running; the node exits 1 only when all of them failed. A busy FTPS port no longer ends the node.

## What's new in 15.40.1

- **COPE principle checked once per page** (`bootstrapCopeSubstrate`, `PrinciplesChainlet.ts`). RepoZ checked the governing principle before every artifact it saved, and each check re-read `/soul.md` uncached, hashed it and could race to adopt or amend it. Concurrent callers now share one check, reused for the life of the page; a check that fell back to the offline stub is retried after a minute, and the stub no longer amends a real adoption (it used to, offline). `resetCopeSubstrateCheck()` forgets the shared check.

## What's new in 15.40.0

- **Constraint envelopes** (`src/lib/constraints/envelope.ts`, `@cappz/sdk/constraints`). The owner's signed statement of what a device may do, for any setpoint-controlled device — a freezer, an oven, a dosing pump, a breaker. Constraint kinds are registry accounts (`cappz/config/constraint-kinds/<id>`): `range`, `rate`, `dwell`, `agreement`, `response`, `authority`, `schedule`; units are UCUM-checked; mode-scoped limits refuse while the mode is unknown. A tightening is active at once; a loosening (each listed in plain words) needs `minRelaxSigners` operators and a cooling period; forks and edits are refused.
- **Signed and armed commands** (`authority.ts`): one point, one value, ≤ 15 min, a nonce, an operator key; KeyZ declarations and revocations for grants that name a wallet. Protocols without a signature field use commands armed at the guard, one write each.
- **Reconciliation** (`reconcile.ts`, `tools/constraint-reconcile.ts`): every change needs a matching authorised command (`orphan-change`), every value stays in the envelope; disagreeing sensors name the outlier; changes without effect, silence and gaps are their own states. **Sealed observations** (`seal.ts`): signed, chained batches at the collector, so an edited historian shows as `sealed-broken`.
- **Constraint Guard** (`guard.ts`, `gateways.ts`, edge node `CAPPZ_CONSTRAINTS_CONFIG`): HTTP/REST, Modbus TCP, BACnet/IP, DNP3, IEC 60870-5-104 (sequence numbers kept consistent across a refusal), MQTT 3.1.1/5 with Sparkplug B, and Gremlin Server bytecode. Shadow first; per-point enforcement on an operator-signed record citing the shadow report hash; fail modes per point (`hold-last-good` / `pass-and-alarm`); writes are atomic; privileged operations need the operator's allowance by name. `tools/constraint-wizard.ts` (keygen, init, draft-graph, declare, endorse, revoke, status, command/arm, enforce, shadow, doctor) and `tools/constraint-selftest.ts` (every protocol over real sockets).
- **Adapters** (`adapters/`): Modbus, BACnet, DNP3 (link CRCs), IEC 104, MQTT, Sparkplug B (bounded protobuf reader, alias births/deaths), OPC UA PubSub JSON, historian CSV/JSON (long and wide), Apache TinkerPop GraphSON (writes, observations, envelope drafts from explicit graph structure).
- **Vehicles, advisory only** (`vehicle.ts`): separation and offset between position sources, implied speed and GNSS clock offset; redundant air data as `agreement`.
- **Finding your way:** an animated walkthrough (`docs/tutorials/constraint-guard.html`) and diagram in the guide; `constraint-wizard` with no step prints what is in place and the next step; `cappz-market help` is grouped by task; `cappz-market skills <words>` and `skills/index.json` find the right skill; each check-service agent, its agent card and the marketplace discovery document link the skill that says how to use it.
- **Marketplace agents** on the check service (`advisor.ts`; `/<net>/envelope`, `/review`, `/triage`): the envelope drafter keeps a limit only when its quote is in the manual verbatim with every number; the shadow-report reviewer and incident triage are rules only; inputs are checked against their `reportHash`; answers are signed. `cappz-market constraints-draft | constraints-review | constraints-triage`.

## What's new in 15.32.0

- **Acceptance criteria** (`src/lib/marketplace/acceptance.ts`). A listing, request, bid or subcontract can state what a deliverable must meet as data: media type, size, JSON keys, word count, sections, phrases, or yes/no rubric questions. They are checked before publishing and frozen into the milestone's terms when the contract forms (`MilestoneTerm.acceptance`). Use `--acceptance` on `sell`, `ask`, `bid` and `subcontract`.
- **Stage evaluator** (`stageEvaluation.ts`; `cappz-market evaluate`, 0.05 XRP; skill [evaluating-cappz-deliverables](skills/evaluating-cappz-deliverables/SKILL.md)).
  - It checks that the delivered file is the seller's published evidence, then checks each criterion: by rule, or by a model whose "yes" counts only with a verbatim quote.
  - It returns a signed pass / fail / needs-human verdict. The verdict says whether the criteria were agreed in the contract or supplied by the requester.
  - The contract's named evaluator can accept citing the verdict (`accept --verdict`, `evaluate --accept`; `MilestoneAffirmed.basis`). The buyer still pays.
  - The file is not stored.
- **Listing drafter** (`listingDraft.ts`; `cappz-market draft`, 0.02 XRP; skill [drafting-cappz-listings](skills/drafting-cappz-listings/SKILL.md)). Plain words become a checked `sell` or `ask` command. Catalog fields are validated, and numbers the person did not write are dropped and asked for.
- **Subcontract scout** (`subcontractScout.ts`; `cappz-market scout`, 0.05 XRP; skill [scouting-cappz-subcontractors](skills/scouting-cappz-subcontractors/SKILL.md)). It proposes work packages within what is unreleased, each serving an open milestone, with candidates from market search and replayed reputation, and a ready `subcontract` command for each.
- All three run as paid agents on the check service (`packages/cappz-check-worker`: `/<network>/evaluate`, `/draft`, `/scout`), each with its own card, price and pay-to address. The model is configured (`MODEL`, default `claude-haiku-5-5`; key as a Worker secret). Without a key, the evaluator runs rule criteria only and the scout plans by rules.

## What's new in 15.31.0

- **Payment assets and rails** (`src/lib/marketplace/paymentAssets.ts`). Each asset is an MDM account at `cappz/config/payment-assets/<id>` and each way it settles is a rail at `cappz/config/payment-rails/<id>`; ids are vendor-neutral. Assets: XRP, the CAPPZ token, USD-tokenZ/1 (RLUSD, the first member of the USD-tokenZ family `usd-tokenz`) and USD. Every asset is an equal option: a listing, request or bid is priced in it, the contract keeps that asset, nothing is converted, and fees come from the same fee schedule keyed by asset. An asset is offered on a network only when its configuration validates there (RLUSD is not issued on devnet).
- **Rails.** `ledger-escrow` (XRP, one escrow per stage leg, as before); `ledger-staged` (CAPPZ and RLUSD: each accepted stage is paid directly on the ledger, seller net plus fee legs; `cappz-market release` pays it); `ledger-channel` (metered XRP use through a payment channel: `sell --metered`, `fund` opens the channel, `claim`, `redeem`, `close`); `card` (USD through the payment processor); `by-reference`. The ledger's TokenEscrow amendment is enabled, but RLUSD's issuer does not allow trust-line locking, so RLUSD is paid stage by stage; `cappz-market check --currency` reports `asset-escrowable` or `asset-staged`.
- **Bring your own funded wallet** (`walletFunding.ts`; no purchase provider is linked or integrated): `fundingNeed()` says what an account needs for a payment (amount, reserves, a trust line first for tokens) and how to get it: the faucet on testnet and devnet, an exchange withdrawal on mainnet.
- **Counterparty check per asset**: `currency` and `amount` request fields, both trust lines, and the issuer's freeze, authorization and trust-line-locking flags.
- **Signing approvals** also cover token stage Payments (`pay`), PaymentChannelCreate (`channel`) and PaymentChannelClaim (`claim`).
- **Agent identity**: a KeyZ request-signing key declared on the agent's profile (`agentKeys.ts`); mandates that bind it (`mandate --bind-key`); RFC 9421 signed requests to `/authorize` and to paid agents (`agentRequestAuth.ts`); SD-JWT principal credentials with sealed, nonce-bound disclosure (`principalCredential.ts`); a signed A2A agent card at `https://check.cappz.ai/.well-known/agent-card.json` (`agentCard.ts`); signed reputation attestations at `GET /<network>/reputation/<partyId>` (`reputationAttestation.ts`). `packages/cappz-market/server.json` is the MCP Registry entry; the npm package it names is not published yet.
- **Subcontracts and evaluators**: a seller hands part of a contract to another party as a child contract (`cappz-market subcontract`), and a buyer may name a third-party evaluator (`--evaluator`) who accepts milestones (`accept`).
- **Mandates per asset**: a mandate covers one asset, and daily totals are counted per asset.

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
- **SAML: catch forged logins, then refuse them** (15.37.0) — `reconcileSamlLogins` (`@cappz/sdk/identity`)
  finds SaaS logins your identity provider never issued, from two read-only log exports (Okta System Log,
  Entra sign-ins, or any CSV/JSON by field mapping), with gaps reported as their own state; `sealIssuedBatch`
  makes the issuance record tamper-evident. `createSamlGuard` (`@cappz/sdk/edge`) is a second, independent
  check in front of a SAML ACS you host: one assertion in one place, no DOCTYPE/comments/namespace rebinding,
  signatures referencing their own element, SHA-256+, operator-signed certificate pins, issuer / destination /
  recipient / audience / time / InResponseTo / replay — shadow first, enforce on its report.
  `packages/cappz-edge-node/tools/saml-reconcile.ts` and `tools/saml-guard.ts`; [docs/SAML_GUARD.md](docs/SAML_GUARD.md).
  15.37.0: **multi-tenant** — one guard for every customer of a SaaS, the tenant chosen by the login URL,
  pins signed per tenant, and a response naming another tenant refused as `cross-tenant`; the **XML signature
  verified built in** (exclusive C14N, RSA/ECDSA, pinned keys only; tested against signxml/lxml), so a broken SP
  check is covered; onboarding from IdP metadata (`idpFromMetadata`), the configuration doctor
  (`lintSamlTenants`), per-tenant shadow → enforce by operator-signed records, and `tools/saml-wizard.ts`
  (guided or step by step, monitoring timers included). Agent skills:
  [securing-saml-sso](skills/securing-saml-sso/SKILL.md), [monitoring-saml-logins](skills/monitoring-saml-logins/SKILL.md).
- **Payee confirmation: stop payment-instruction fraud** (15.38.0, `@cappz/sdk/marketplace`) — a payee
  declares where it is paid (`buildPayeeInstructions`: XRPL address + tag, or a bank account as a salted digest
  that never publishes the number) on the market's public log, which only its own account can write, and endorses
  the declaration from its own XRPL wallet with a no-op AccountSet naming the declaration's hash
  (`prepareEndorsement`); new instructions wait a 72-hour cooling period, revocation is immediate.
  `runPayeeConfirmation` answers, for a payer: declared by this payee and nobody else, endorsed, in force, not
  revoked, replaced or expired, not a change from where you paid them before, not a lookalike of an address in your
  history — plus every counterparty-check fact — as a signed ok / warn / stop report (`signPayeeReport`). Paid agents
  may now pay each stage to its own address (`PaymentStage.payTo`): the service charges a platform fee up front to
  the CAPPZ treasury and its service fee to the operator. Skill: [confirming-payees](skills/confirming-payees/SKILL.md).
- **Shared admin-governed logs: bindings follow the account, not the browser** (15.39.0, `@cappz/sdk/sync`) — a
  `CappzEventCache` opened with `{ shared: true }` keeps a public copy of governed writes in one partition of the
  hosted mirror per log (`pub:<event-log address>`): writes publish there first and reach the wallet only after the
  mirror accepted them; every device merges the copy on refresh and keeps it for offline use. Agent window bindings
  and skill compositions (`agentSkillCache.persistBatch(entries, { share: true })`) and shared app ledgers
  (`createAppLedger({ shared: true })`) use it, and `shareExisting()` backfills an admin's earlier records. The app
  registers the port (`registerSharedEventLog(mirrorSharedEventLog(mirror, authorOf))`) and owns the insert rule;
  unregistered, caches run local-only. `sharedState` says `synced`, `unreachable` (device copy shown) or `local-only`.
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
  in XRP, CAPPZ or USD-tokenZ/1 (RLUSD) stage by stage (upfront deposit,
  milestones, completion). Payments count only when the validated ledger shows
  them delivered to your address with the stage's destination tag (and, for a
  token, from its registered issuer); each result is held (HTTP 402 in
  the ready-made agent) until its stage is paid. Guided setup:
  https://cappz.ai/tutorials/earn-with-your-agent.
- **Usage billing and the subscription agent** (also `@cappz/sdk/paidAgent`) —
  for marketplace apps, services and agents billed by use.
  - **Plans** (`AppUsagePlan`, `quoteUsage`): pay as you go, subscription,
    subscription with overage, or sponsored (the app's treasury funds its
    users' app wallets). Prices in USD, XRP or both; conversion only with a
    fresh rate, never a guessed one.
  - **Default prices are proposals** (`proposeDefaultPrices`): marked as not
    validated by the app owner and never charged until the owner acknowledges
    or changes them (`applyOwnerDecisions`).
  - **Top-up rules** (`FundingRule`, `decideFunding`): low balance or short
    runway → propose a one-click or typed-command top-up, or top up
    automatically. Auto top-up needs caps (overall, per month, week, day,
    hour; `capRoom`); a rule with none only proposes.
  - **Splits from the contract** (`splitCharge`, `postingsFor`): platform,
    app owner (ebb tenant) and talent shares in basis points, null or 0
    allowed; unallocated shares need a named remainder party. Exact rounding;
    each line is an AP/AR pair.
  - **Short on money** (`planWithinBudget`): critical tasks first, the rest
    deferred with exact shortfalls. `estimateRunway` and `projectedVsActual`
    report spend.
  - **The agent** (`createSubscriptionAgent`): storage, payment, notices and
    rates are ports; it holds no key. `subscriptionWatchJob` runs it on an
    edge node for sponsored top-ups from the app owner's treasury.
  - **Platform adapter templates** (`PLATFORM_ADAPTER_TEMPLATES`,
    `endpointOrder`, `withFailover`): prioritised, weighted endpoints per
    service with back-off, and no hosting provider assumed.
  - **Guide.** [docs/USAGE_BILLING.md](docs/USAGE_BILLING.md).

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
