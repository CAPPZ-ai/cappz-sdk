# CAPPZ resilience mesh: design, threat model, evals

`@cappz/sdk/mesh` (15.13.0) is a replacement network for when the internet is cut by physical or cyber attack. Devices that run it pass signed bundles directly to each other and carry them across gaps. Every device verifies every bundle with no server. For how to set it up and run it, see the [field guide](MESH_FIELD_GUIDE.md).

## Shape

```
 app / Replicator                       (unchanged: what to sync, history, conflicts)
        │ deliveries, receipts
 MeshNode ── BundleStore ── MeshGate     (src/lib/mesh/)       Transporter role, transport type `mesh-dtn`
        │ CPZ1 frames: hello · inv · getdata · frame · ack · bye
 MeshLink:  TCP (hotspot / Wi-Fi Direct / ad-hoc / Ethernet)   packages/cappz-mesh-node/ipLink.ts
            WebSocket from a browser (iPhone, iPad)            packages/cappz-mesh-node/webServe.ts
            WebRTC data channel, offline pairing codes         src/lib/mesh/meshWebRtc.ts
            LoRa (RNode / KISS on a serial port)               src/lib/mesh/meshRadio.ts + kiss.ts, packages/cappz-mesh-node/serialRadio.ts
            Native radios through a WebView shell              src/lib/mesh/meshNative.ts, packages/cappz-mesh-native (Multipeer, Nearby)
            USB stick / SD card carry file                     src/lib/mesh/meshCarry.ts
 app layer: text and voice messages, names, everyone, block   src/lib/mesh/meshChat.ts, meshVoice.ts
```

The mesh is a **carrier**. It moves sealed payloads one contact at a time and hands the ones addressed to this device to the app. The Replicator's sync semantics do not change. Replication and transport stay separate, as in design-guide §5.

### What it reuses

| Need | Existing CAPPZ piece |
|---|---|
| Device key speaks for a wallet; revocation without a CRL server | KeyZ `declareKey` / `revokeKeyDeclaration` / `evaluateKey` (`identity/keyDeclaration.ts`) |
| Verify at the edge, cheap checks first, lifecycle verdicts | KeyZ Gate pattern (`identity/edgeVerify.ts`) applied to bundles (`MeshGate`) |
| Framing, checksums, incremental decoding | CPZ1 `frameCodec.ts` (`hello`, `inv`, `getdata`, `frame`, `ack`, `bye`, `manifest`) |
| Ed25519 on every runtime, with a pure-JS fallback | `helloSignature.ts` `signCanonical` / `verifyCanonical` |
| Encrypt to a recipient | `sealedBox.ts`, plus a compact byte form (`sealBytesTo`) |
| Multicast group from an id, with no allocation | `walletMulticastGroup(meshId)` |
| HTTPS with no certificate authority | KeyZ X.509 projection `issueSelfSignedCertificate` |
| Carrier vocabulary | `transportTypes.ts`: new `mesh-dtn`, `webrtc-datachannel`, `ble-gatt`, `lora` |
| Event vocabulary | `MeshChartered`, `MeshMembershipGranted` / `MeshMembershipRevoked` in `MDMEventTxRegistry.ts` |

New primitives, and why each was needed:

- **The charter and membership grant.** Key declarations say which key speaks for a wallet, not what that wallet may do on a given mesh. Roles needed a signed, revocable statement that carries its own scope.
- **The bundle.** Hellos and frames assume a live session. A bundle must verify hours later, after many hops.

## Thin links: shared radio, airtime, smaller bundles

**Shared radio (`meshRadio.ts`).** On LoRa, one transmission reaches every neighbour. `RadioMedium` turns that shared channel into one virtual `MeshLink` per neighbour:
- Each packet carries a 9-byte header: type, sender radio id, destination radio id. Frames are split into fragments to fit the packet.
- Devices announce themselves now and then. A neighbour that is heard gets a link, and the signed hello then authenticates it. A neighbour that goes silent is dropped.
- Radio ids are addresses only, never trust.

**Duty cycle.** Every packet is charged its LoRa time on air (the Semtech formula, tested against the reference value of 118 ms for 64 bytes at SF7/125 kHz) against an `AirtimeBudget`. The node waits rather than exceed the configured duty cycle. Region presets are in `LORA_REGIONS`.

**KISS / RNode (`kiss.ts`, `serialRadio.ts`).** KISS framing and the RNode configuration commands (frequency, bandwidth, transmit power, spreading factor, coding rate, radio on). The serial port needs no dependency: `stty` sets it raw and it is opened as a file (Linux, macOS).

**Credential references.** A bundle must carry its signer's key declaration and grant (about 1.1–1.3 KB) so any later hop can verify it. Between neighbours that already hold those credentials, that is waste. So:
- An `inv` entry carries a 64-bit prefix of the credentials' hash.
- The receiver's `getdata` lists the credentials it already holds.
- The sender sends `{ ref }` in place of the credentials. On a miss, the receiver answers `need-cred` and the bundle is sent again in full.
- Bundles are stored with full credentials, so every later hop can still verify them.

Measured in the simulator: frames fell from 1,882 to 1,619 bytes on average. Total traffic fell 11–17% at quick scale, and 32–34% at full scale with spray-and-wait, where the same people meet repeatedly. The header, signature and sealed body make up the rest; they cannot shrink without weakening verification.

## Native radios

`meshNative.ts` is a byte bridge between the web app and a native shell that owns radios browsers cannot use:
- **Apple:** MultipeerConnectivity (peer-to-peer Wi-Fi and Bluetooth, no access point).
- **Android:** Nearby Connections (Bluetooth, BLE, Wi-Fi Direct, Wi-Fi Aware).

The shells in `packages/cappz-mesh-native` only move bytes. Keys, verification and routing stay in the `MeshNode`, so a native peer is held to the same signed hello as any other.

## Messaging (`meshChat.ts`, `meshVoice.ts`)

- **Text and voice.** Voice messages are recorded clips (Opus or AAC at about 12 kbit/s, 30 s by default, 60 s maximum). They are split into ≤10 KB parts so each fits the charter's body limit, and reassembled on arrival. Plain-text bodies from earlier nodes still read as text.
- **Names.** Identity is the wallet; a name is display text. The alias rides in the contact bundle, signed by the device key, so nobody can name someone else.
  - Names are cleaned of control and direction-override characters, because those can make one name look like another.
  - Names are always shown with the start of the address, and a name used by several people is flagged.
  - A user's own nicknames win on their device. `ContactBook.find` reports ambiguity rather than picking one.
- **Everyone.** `EVERYONE_CHANNEL` (`alerts`) is read by every node. Precedence, bounded by role, marks what is important.
- **Block.** A personal list. The node neither delivers nor carries `msg` bundles from a blocked wallet, and drops those it holds. Control bundles (revocations, receipts, contacts) from that wallet still apply. Removal from the whole mesh is an authority's membership revocation.

The platform wallet-agent's microphone path streams raw 24 kHz PCM to a hosted realtime service. It cannot work offline and would be about 30 times larger, so the mesh records compressed clips on the device instead.

## Trust model

- **Trust anchor:** the **charter**, signed by the founding authority wallet. The mesh id is the charter's hash. Devices receive it during provisioning, and a node that shows a different charter is a different mesh.
- **Roles.** An authority wallet signs a grant: member wallet, role, expiry. Any charter authority may revoke any grant. Role bounds precedence (coordinator FLASH, responder IMMEDIATE, member PRIORITY, guest ROUTINE), broadcast rights, origination rate per minute, and store share. These are policy fields in the charter.
- **Device keys.** The wallet declares the device's Ed25519 key (purpose `hello`) and P-256 box key (purpose `encryption`) through KeyZ. A lost device is cut off with a KeyZ revocation signed by its wallet, and a person is cut off with a membership revocation. Both spread as FLASH bundles that anyone may carry, because they are self-authenticating.
- **Verdicts are states, never booleans:**
  - success: `admitted`, `admitted-guest`
  - already handled or out of date: `duplicate`, `expired`, `future-dated`, `hop-limit`, `wrong-mesh`
  - tampering: `malformed`, `too-large`, `bad-signature`, `body-mismatch`, `bad-control`
  - identity: `key-revoked`, `key-untrusted`, `membership-revoked`, `not-member`
  - policy: `precedence-denied`, `broadcast-denied`, `rate-limited`

  Business state (a delivered message), local history (the gate's verdicts) and anchored proof (none: no ledger is reachable) are kept apart.

## Threat model

| Threat | Defence | Measured by |
|---|---|---|
| Forged or altered bundles (fake evacuation order) | Device-key signature over the header; body hash; key must be declared by the source wallet; role bounds precedence | `hostile-injection`: forged bundles admitted = 0 |
| Impersonating a coordinator with copied credentials | The declaration names the coordinator's key, not the attacker's → `key-untrusted` | `hostile-injection` |
| Unprovisioned devices | Guests: ROUTINE direct messages only, 3 per minute, 1% of store; or dropped (`guests: 'drop'`) | `hostile-injection`, unit tests |
| Captured device | KeyZ revocation gossiped at FLASH. Hellos and bundles from the key are refused once known | `captured-device`: reach, p90 spread time, admissions after learning = 0, exposure window reported |
| Flooding by a member | Per-source origination cap per minute of `created`, checked at every hop; per-source store share; precedence-ranked eviction | `flood`: flooder store share ≤ policy, FLASH+IMMEDIATE delivery |
| Black-hole relays | Spray-and-wait keeps several copies; custody is handed over only to nodes PRoPHET rates likelier to meet the recipient | `blackholes` (20% of nodes) |
| Forged receipts to suppress messages | A receipt carries the original header; a carrier purges only if the signer is the recipient that header names | `receipt-forgery`: illegitimate purges = 0 |
| Replays | Dedupe by id until expiry; expiry bounded by the charter | replays admitted after seen = 0 |
| Junk floods costing CPU | Shape, size, mesh, time and dedupe checks before any signature; failed signatures remembered by (id, sig); per-key abuse count closes and shuns links | gate verdict counts |
| Planted USB carry files | Each bundle passes the gate; a corrupt file fails its checksums | unit test |
| Reading direct messages | Sealed to the recipient's declared P-256 key; relays carry ciphertext | unit test (a relay cannot open) |

**Not defended, by design or not yet:**

- **Traffic analysis.** Sender wallet, recipient tag (salted per mesh; linkable), time and precedence are visible to carriers. PRoPHET predictabilities in hellos reveal who meets whom.
- **Radio direction-finding.** It locates transmitters, so the field guide tells people to transmit only when needed.
- **Unsigned hop fields.** A relay can misstate the hop and copy counts; expiry and dedupe bound the effect.
- **Seized devices.** A seized device keeps whatever it was carrying until revoked, and channel broadcasts are readable by every member.
- **Radio jamming.** Jamming of every carrier at once is out of scope. Bundles wait and move by hand (carry files).
- **No security audit yet.**

## Routing

- **Channel and control bundles** (revocations, receipts, contacts) spread to every node, deduplicated by id.
- **Direct bundles and receipts:**
  - go straight to the recipient when in contact;
  - otherwise use binary **spray-and-wait** (8 copies, halved at each hand-off);
  - in the wait phase, custody passes only to a neighbour with a higher **PRoPHET** delivery predictability for the recipient.
  Custody moves on an explicit `ack` frame.
- **Announce, then pull.** A node announces ids it would give a neighbour (`inv`); the neighbour fetches what it lacks (`getdata`); in-flight fetches are deduplicated. In the dense scenario this cut transmissions per delivery from 233 to 41 and duplicates from 5,156 to 19, compared with pushing.

## Benchmarks and evals

`npm run mesh -- evals` runs the quick scale (CI). `--full` runs the benchmark scale (60 devices, 3 simulated hours, router comparisons). Every scenario declares its thresholds in `src/lib/mesh/meshEvals.ts` before it runs.

The simulator runs the real `MeshNode`: real Ed25519, secp256k1 and AES-GCM, and the real gate, store and routing. Devices move, links rise and fall with range, each link carries a byte budget per tick, and hostile devices take part. It does **not** model radio contention, battery, phone background limits or discovery cost, so the results are an upper bound for the protocol, not field performance.

Full scale, run 2026-10-28 after credential references were added: 60 devices, 3 simulated hours, 150–200 direct messages and 8 FLASH alerts per scenario. All 9 passed in 580 s of wall time.

| scenario | delivery | p50 / p95 latency | alert coverage | transmissions per delivery | security result |
|---|---|---|---|---|---|
| dense-connected (one connected cluster) | 150/150 | under 15 s (one tick) | 100% | 110 | 0 forged, 0 replays |
| sparse-dtn (walking, rarely in range) | 145/150 (97%) | 31 / 80 min | 100% | 50 | 0 forged |
| shelters-couriers | 150/150 | 14 / 47 min | 100% | 53 | 0 forged |
| hostile-injection (forgers, impersonators, outsiders, replayer) | 150/150 | 12 / 41 min | 100% | 68 | 9,901 attack bundles injected, 0 admitted; 488 abusive links closed |
| flood (2 members spamming) | 200/200 | 13 / 51 min | 100% | 1,198 (the flood's admitted share is relayed too) | flooder share of any store at most 14% (cap 16%); FLASH + IMMEDIATE 100% |
| captured-device | 150/150 | 11 / 38 min | 100% | 135 | revocation reached 100% of nodes, p90 9.5 min; 0 admissions after a node knew; 417 admitted before it knew (the exposure window) |
| blackholes (20% of nodes drop everything) | 145/150 (97%) | 16 / 68 min | 100% | 60 | — |
| receipt-forgery | 150/150 | 11 / 46 min | 100% | 129 | 0 illegitimate purges |
| jammed-ble (MTU 180, 20 kB/s, 20% link failure per tick) | 150/150 | 11 / 33 min | 100% | 81 | — |

Router comparison on the same seed. Bytes sent before credential references were added are in brackets:

| scenario | router | delivery | p95 latency | transmissions per delivery | bytes sent |
|---|---|---|---|---|---|
| sparse-dtn | spray-prophet (default) | 97% | 80 min | 50 | 20.8 MB (31.4) |
| sparse-dtn | epidemic | 100% | 47 min | 107 | 46.2 MB (56.0) |
| sparse-dtn | direct (deliver only on meeting) | 44% | 124 min | 9 | 8.2 MB (11.9) |
| blackholes | spray-prophet | 97% | 68 min | 60 | 34.3 MB (50.4) |
| blackholes | epidemic | 100% | 23 min | 101 | 70.1 MB (80.1) |

How to read these numbers:

- Epidemic routing delivers more, and sooner, at these sizes, for about 2× the bytes. Spray-and-wait trades latency for battery and airtime, and the trade grows with more devices and more traffic.
- Choose per deployment (`router` option). For a small group with lots of battery, epidemic is better. Use spray-and-wait where airtime is scarce (BLE, LoRa) or where transmissions should be few, for example when radio direction-finding is a risk.
- Most thresholds are floors well below the measured values. They catch regressions; they are not targets.
- Transmissions per delivery counts all of a node's sends: alerts, contacts, receipts and revocations, not only direct messages. It is high in the dense scenario because every alert reaches every node.

Reproduce with `npm run mesh -- evals --full --out report.md`. The report includes the per-scenario gate verdict counts.

## What is verified

| Claim | Evidence |
|---|---|
| Gate, store, routing, receipts, revocation, fragmentation, carry files | `src/test/mesh.test.ts` (14 tests) |
| Security thresholds under hostile scenarios | the evals above, quick scale in CI |
| Two or three real processes find each other by multicast, relay A→B→guest, seal DMs and return receipts | live run of `packages/cappz-mesh-node` on one Linux host (loopback and LAN address) |
| Browser node: setup from the node's page, broadcast, sealed DM with receipt, guest refusal, WebRTC pairing between two pages | driven in Google Chrome (Playwright) against a live node |
| Go-kit | A signed kit with a bundled Linux runtime was downloaded from a live node's `/kit/` and unzipped outside the repo. `verify-kit` → `verified-by-authority`; a one-line edit → `tampered`. `quickstart` with the bundled Node.js made a guest. An authority's `/grant` arrived over the mesh, and after `/accept-grant` the device sent as a member. `src/test/mesh-kit.test.ts` covers every kit state. |
| LoRa stack: KISS, RNode configuration, shared-radio layer, duty cycle | `src/test/mesh-radio.test.ts`: airtime matches the reference value; the budget enforces the duty cycle; A reaches C only through B on a 255-byte shared channel. Two `cappz-mesh` processes exchanged a FLASH broadcast over a **virtual serial pair** (KISS framing end to end); 67 packets and 24 s of airtime at SF7 to bring the link up. |
| Native bridge (JavaScript side) | `src/test/mesh-radio.test.ts`: two nodes linked through fake shells exchange a message after the signed hello |
| Messaging | `src/test/mesh-chat.test.ts` (aliases, ambiguity, voice reassembly, blocking stops display and carrying, and unblocking restores). In Chrome against a live node: names propagate; "to everyone" shows the sender's name; `/dm @Ben` from the CLI arrives; a 3 s voice message recorded with Chrome's fake microphone arrives playable; block hides the sender's message to everyone, and unblock restores new ones. |
| **Not yet verified** | iOS Safari (WebKit could not launch on the test host), physical phones over a real hotspot, Termux on Android, the Windows and macOS launchers and runtimes (built and checksummed, not run), AP-isolating hotspots, RNode or other LoRa hardware (only a virtual serial pair), the native shells (not compiled: no Xcode or Android SDK was available), voice in iOS Safari, long runs |
