# Identity, trust and transports (v15-09-00, v15-10-00)

Live tutorial and validation: **/tutorials/identity-and-trust** runs every step below in the
browser (`runIdentityTrustDemo`, the same call as `src/test/identity-trust-demo.test.ts`).

How CAPPZ keeps identity in a wallet, sends it to other wallets, proves keys without a
certificate authority, verifies at the reverse proxy, and talks to legacy systems — and how
each legacy path upgrades without anything breaking.

**Names:** **KeyZ** is the trust system — wallet-signed key declarations, revocations and
delegations (`src/lib/identity/keyDeclaration.ts`). **KeyZ Gate** is the edge verification
gateway that checks requests against them (`src/lib/identity/edgeVerify.ts`,
`packages/cappz-edge-node/verifyGateway.ts`). The identity layer as a whole is the WAS Protocol
(design guide §8). Code identifiers keep their names.

## 1. Identity vault

| Layer | What it is | Where |
|---|---|---|
| Claim | SD-JWT disclosure `[salt, name, value]`; the TX carries the salted digest and the disclosure encrypted with the holder's content key | `<root>/identity/claims/<type>/<id>` |
| Biometric binding | Hash of a WebAuthn credential id (user verification required). Templates never leave the authenticator | `<root>/identity/bindings/<id>` |
| Attestation | Issuer-signed SD-JWT VC (ES256K, issuer/subject `did:key`) over claim digests, with evidence level (NIST 800-63 IAL1-3) and method | `<root>/identity/attestations/<id>` |
| Disclosure | `IdentityDisclosureRequested` → `IdentityDisclosed` (presentation sealed to the verifier, key-bound to nonce + audience) or `IdentityDisclosureDeclined` | `<root>/identity/disclosures/<id>` |

Code: `src/lib/identity/identityVault.ts`, `sdJwt.ts`, `didKey.ts`. Process:
`src/bpmn/substrate/identity-disclosure.bpmn`. Verbs: `identity.*` (user-owned).

Verification states are layered and never collapsed: `verified`, `self-asserted`, `revoked`,
`expired`, `digest-mismatch`, `bad-key-binding`, `nonce-mismatch`, `bad-issuer-signature` —
and the ledger anchor separately (`unchecked` until read on the ledger). A holder reveals
only requested claims; revoking a claim stops future disclosures, a delivered one stays
delivered. Keep the identity wallet separate from participation and settlement wallets.

**Interop:** presentations are standard SD-JWT (`issuer-jwt~disclosure~…~kb-jwt`) with JOSE
ES256K signatures that any SD-JWT library verifies. Wallet login signatures
(`signMessage`) hash twice and are not JOSE; `sdJwt.ts` signs JOSE bytes with the same key.

## 2. Trust: KeyZ declarations instead of a CA

| | X.509 / PKI | KeyZ declarations |
|---|---|---|
| Who vouches | A CA chain | The wallet itself (secp256k1), optionally attested by others |
| Revocation | CRL / OCSP lookup (often skipped or stale) | Wallet-signed `KeyDeclarationRevoked`, replayed offline by every verifier |
| Rotation | New cert, old one unverifiable after expiry | `supersedes` keeps every earlier signature verifiable |
| Answer | valid / invalid | `declared`, `delegated`, `operator-listed`, `undeclared`, `revoked`, `expired`, `wrong-purpose` |
| Cost | Issuance and renewal | None |

A declaration names one purpose: `hello`, `tls`, `signing`, `encryption`. A declared key can
delegate a short-lived key (≤ 13 days) for one purpose — the edge node's declared key vouches
for the TLS key it generates at boot. Code: `src/lib/identity/keyDeclaration.ts`.

**X.509 is a projection** (`src/lib/identity/x509.ts`): a self-signed certificate whose SAN
names the wallet (`did:key:…`) and the declaration/delegation (`cappz:keydecl:<sha256>`).
It is trusted exactly as far as its key is declared for `tls`. Use it for mTLS, QUIC peering,
WebTransport and enterprise clients.

**Not for public browser HTTPS.** Browsers trust only public CA roots: keep a public-CA
certificate (Let's Encrypt) on nginx/Caddy for visitors. WebTransport certificate hashes
accept only ECDSA P-256 certificates valid ≤ 14 days — hence P-256 and the 13-day window.

## 3. Verify at the reverse proxy

`src/lib/identity/edgeVerify.ts`, served by the edge node on `--verify 41446`
(`packages/cappz-edge-node/verifyGateway.ts`, nginx config in its header). A check is a hash
plus a signature: no database, no network, cheap on ARM, scales by adding nodes. Content
verdicts are cached by hash; key trust is re-read each request, so a revocation applies at
once. Client-sent `Cappz-Verified-*` headers are stripped.

| Mode | How | Who checks the body |
|---|---|---|
| `auth_request` | nginx asks `/cappz/verify`, forwards on 204 | the origin, with `checkContentDigest` |
| proxy | `CAPPZ_VERIFY_UPSTREAM` | the gateway |
| content verdict | `POST /cappz/verify/content` (detached signature over a hash) | — |

## 4. Transports: one namespace

Transport types are MDM accounts at `cappz/config/transports/<id>`
(`src/lib/sync/transportTypes.ts`): `udp-multicast`, `udp-unicast`, `direct`, `relay`,
`store-forward`, `tcp`, `quic`, `webtransport`, `wss`, `https-stream`, `https-poll`, `bundle`,
`pairing-code`, `relay-rendezvous`, `wallet-breadcrumbs`, `chain-xrpl`, `chain-memory`,
`http-drop`, `ftps`, `sftp`. Channel configs cross-reference the type by address
(`ChannelConfig.transportType`); which node serves which type stays declared per node.

## 5. UDP kick-off and multi-channel

Each wallet has its own multicast group derived from its address (`ff15::/16` or
`239.192.0.0/14`, UDP 41448; `src/lib/sync/discovery/walletMulticast.ts`). A copy sends one
signed connect request (≤ 1200 bytes) naming carriers it can open; a holder answers unicast
with where it accepts them — never a larger answer than the ask, never a secret. The copy may
open several offered carriers at once; frames are deduped by id/hash. Each side channel
authenticates with its own signed hello. Multicast stays on the LAN; across networks the
member table and the relay apply.

## 6. DMZ quarantine and the legacy front end

The edge node on `--legacy 41447` (`packages/cappz-edge-node/legacy.ts`) holds files from
senders that do not speak CPZ1 by hash, runs and records each check (hash, size, type sniffed
from bytes, sender signature, malware scan), releases by policy or a listed operator's signed
decision, and lets internal clients list and fetch released files. It also pulls partner
FTPS/SFTP directories with the system curl (credentials from the environment, on stdin).

| Endpoint | Purpose |
|---|---|
| `POST\|PUT /legacy/v1/drop/<name>` | file in → receipt (201 released, 202 held, 422 rejected) |
| `GET /legacy/v1/receipts/<sha256>` | checks and decision |
| `GET /legacy/v1/released[?format=text]` | directory listing |
| `GET /legacy/v1/objects/<sha256>` | released bytes |
| `POST /legacy/v1/decide/<sha256>` | operator release/reject (signed) |
| `GET /legacy/v1/directory` | the node's directory view (ontology placement, unplaced listed) |

## 7. v15-10-00 additions

| | What | Where |
|---|---|---|
| Several carriers per UDP answer | bind addresses offered as ports; an ask for several paths pads itself (signed) to 1200 bytes, so the answer may be as large (1:1) | `walletMulticast.ts` |
| Files above 6 MB | chunks (≤ 4 MB) + manifest, all ordinary bodies: the unchanged exchange replicates them; reassembly checks every chunk and the whole hash | `chunkedBodies.ts`, node `objects.ts` |
| Processing farm | rendezvous hashing for flow ownership (no coordinator; only a leaving node's flows move); reliable multicast feed with NACK repair, NACK suppression and explicit `lost` markers | `farmFeed.ts` |
| TLS rotation without restart | auto certificates every 6 days with the next hash offered for 10 min before the switch; operator PEM files reloaded on change; QUIC, WebTransport and FTPS re-listen | node `tlsIdentity.ts` |
| QUIC dial on Deno 2.5 | `unsafelyTrustAnyCertificate` is ignored; `dialQuic` pins the peer's own certificate via `caCerts` (served at `<relay>/cpz1/tls`) | node `quic.ts`, `relay.ts` |
| FTPS server face | implicit FTPS (`--ftps 41449`), write-only drop box into the same quarantine; receipt in the reply | `ftpServer.ts`, node `legacy.ts` |
| LDAP face | read-only LDAPv3 (`--ldap 41389`), anonymous, search only, entries from the directory view | `ldapDirectory.ts`, node `ldap.ts` |
| Sender check | a valid signature from an undeclared key is `not-evaluated` (never worse than unsigned); bad or revoked keys fail | `quarantine.ts` |
| SDK | `@cappz/sdk/identity`, `@cappz/sdk/edge`, examples in TypeScript, Python, PHP, shell, nginx | `packages/cappz-sdk` |

## 8. v15-11-00: versus X.509, measured — and retiring PHP checks

**Revocation window** — the difference that matters most. An X.509 verifier trusts a revoked
certificate until its CRL or cached OCSP answer expires; CAPPZ applies the signed revocation record
when it arrives. Measured on a virtual clock with the real verifiers (`trustComparison.ts`): one hour
after revocation the X.509 chain + held CRL still answers `valid`, KeyZ Gate `403 revoked`.
The tutorial charts the window (log scale, assumptions editable) and lists where X.509 stays,
with what keeps it there (`TradeoffConstraint` in `trustComparison.ts`):

| Where X.509 stays | What keeps it | Way forward |
|---|---|---|
| Public browser HTTPS | Policy: browser root programs and CA/Browser Forum rules; browsers can already trust a key by hash (WebTransport) | Keep the public cert; KeyZ behind it; propose key-declaration trust to IETF / W3C / root programs |
| Regulated credentials (eIDAS, PSD2, PIV/CAC) | Policy: the rule names the certificate | Comply; bring shadow reports and revocation windows to ETSI ESI, EBA RTS and FIPS 201 reviews; EUDI wallets already take SD-JWT VC |
| HSM / smart-card tooling | Adoption, partly technology: P-256/Ed25519 keys work, tools expect certificates; many lack secp256k1 | Delegate P-256/Ed25519 keys held in the device; wallet key in WebAuthn or the vault |

**PHP route, same machine** (`tools/compare-verifiers.ts`, `src/content/benchmarks/legacy-vs-edge-2026-10-26.json`,
x86-64 WSL2 — rerun on your ARM instance):

| Deployment | req/s | p50 ms | Revoked keys | Replays |
|---|---|---|---|---|
| PHP verifies | 8,566 | 2.28 | 360 let through | 359 let through |
| KeyZ Gate proxies to the app (4 processes) | 6,298 | 3.48 | all refused | all refused |
| nginx auth_request + 4 KeyZ Gate processes | 8,915 | 2.78 | all refused | all refused |

Shadow report: 11,332 agree, 719 CAPPZ stricter (revoked, replayed), 0 CAPPZ looser → retire gate
ready. Retire with `edge.legacy.retire` (admin, `LegacyVerifierRetired` cites the report hash).

**Performance tuning** (one gateway started at 3,028 req/s): buffer upstream responses up to 1 MB
(streaming them through stalled ~40 ms per request on Nagle / delayed ACK); native WebCrypto Ed25519
(16× the pure-JS fallback); evidence indexed per wallet once per file version and stat'ed at most once
a second; several gateway processes with nginx `hash $http_cappz_wallet consistent` so each signer's
replay cache stays exact; `auth_request` so the body goes to the app directly (it checks only the digest).

**Security review:** docs/EDGE_GATEWAY_SECURITY_REVIEW.md (body caps, fail-closed evidence, a load-
found startup race, input shapes, bounded replay cache, DER lengths; PHP CVE compensating controls).

### Where KeyZ fits best, and common claims checked (v15-11-01)

Best fits, each checked against the code:

- **High-volume machine-to-machine APIs** (agents, replicas, the marketplace): yes. Each request is
  signed and replay-checked, revocation applies in seconds, and verification is local
  (0.26 ms per check measured). No people involved means no browser root-program constraint.
- **Content where integrity matters more than secrecy** (datasets, model weights, build artifacts,
  notarized documents): yes, via the content verdict (`/cappz/verify/content`: hash, key, signature),
  and the verdict holds wherever the bytes came from: mirror, CDN, IPFS or FTPS drop. Signatures do not
  encrypt: use TLS, or the sealed bodies, when the content is also secret.
- **Partners behind corporate proxies:** yes, with two caveats. The HTTPS relay runs on 443 behind
  nginx, and the KeyZ Gate sits behind the same nginx, so both run on one host. A TLS-inspecting proxy
  breaks certificate pinning and mTLS, but it does not break KeyZ signatures, which travel inside the
  request. Proxies that strip unknown headers (`Signature`, `Signature-Input`, `Content-Digest`) or
  re-encode bodies will cause refusals that report the reason. Test one partner path before rollout.

Claims that are not accurate as stated (seen in drafted guidance, 2026-10-26):

| Claim | What the code does |
|---|---|
| The X.509 private key is the node's Ed25519 key | No. `CAPPZ_TLS_AUTO=1` makes a separate in-memory **P-256** key (WebTransport hash pinning requires ECDSA and validity ≤ 14 days; keys stay one-purpose). The node's Ed25519 key delegates it: wallet → node key → TLS key (`tlsIdentity.ts`) |
| The node key is derived from the HD wallet root | No. `CAPPZ_NODE_KEY` is generated separately and declared by the wallet (`declared-hello-keys.json`, key declarations) |
| SAN carries `URI:did:cappz:<wallet>` | It carries `did:key:` of the wallet's secp256k1 key and `cappz:keydecl:<delegation hash>`, plus DNS (`CAPPZ_TLS_DNS`) and IP 127.0.0.1 / ::1 |
| No external web server is needed | Only for QUIC (`cpz1`, UDP 41443), WebTransport (HTTP/3 on the relay port, UDP) and FTPS, which terminate TLS in-process. TCP HTTPS (the relay, KeyZ Gate, the legacy faces) is plain HTTP on the node and is served behind nginx/Caddy |
| The node can obtain Let's Encrypt certificates via ACME | Not implemented. Use certbot or Caddy; the node reads `CAPPZ_TLS_CERT/KEY` and reloads them on renewal |
| PHP is replaced entirely | Only the PHP *signature check* retires (on a shadow report, `edge.legacy.retire`); the PHP application stays behind `auth_request` until its own logic moves to handlers |
| PHP endpoints mostly fail on CA bundles and chains | Not what was measured here: PHP verified signatures correctly but let through revoked keys and replays |
| Needs scaffolding for an in-memory X.509 generator | Already shipped (v15-09-00 `CAPPZ_TLS_AUTO`, v15-10-00 rotation with hash overlap) |

Confirmed as stated: QUIC peers pin the peer certificate (`caCerts` from `/cpz1/tls`) and trust the
signed TransportHello against declared keys, not Web PKI. WebTransport offers the certificate hash
(automatically with `CAPPZ_TLS_AUTO`, with `CAPPZ_RELAY_WT_SELF_SIGNED=1` for file certs). Sessions dial
`/cpz1/ws`, `/cpz1/wt` or QUIC `cpz1`. Bodies are stored at `<CAPPZ_NODE_DATA>/objects/<sha256>`, and
`jobs.ts` (41444) signs every TX it writes with the node key.

## 9. Upgrade paths

| Today | Works unchanged | Next step | Native |
|---|---|---|---|
| FTP drop folder | `inbox/` (trusted operator) | FTPS push to the node's drop box, HTTP drop, or FTPS/SFTP pull into quarantine | CPZ1 replication |
| LDAP address book | — | read-only LDAP face of the directory | the ontology directory |
| Raw HTTP POST | unsigned drop (`sender-signature: not-evaluated`) | sign with HTTP Message Signatures (RFC 9421) | CPZ1 relay |
| PHP route that verifies signatures itself | unchanged, gateway in shadow beside it | retire on the shadow report (`edge.legacy.retire`) | auth_request: PHP keeps a digest check |
| PHP-side checks per request | — | `auth_request` to KeyZ Gate | signed requests, verdict headers |
| X.509 client certs from a CA | — | wallet-projected client cert (mTLS) | key declarations |
| Operator key list (`declared-hello-keys.json`) | honoured, reported `operator-listed`; revoked keys dropped | wallet declarations in `key-declarations.json` | presented with each hello |
| Operator TLS files | `CAPPZ_TLS_CERT/KEY` win | `CAPPZ_TLS_AUTO=1` | delegated TLS key |
| v15-04-00 hello declarations | verify as purpose `hello` | `KeyDeclared` v2 with purpose | — |
| Old channel configs (kind only) | replay with the type address filled in | new configs carry the address | — |
