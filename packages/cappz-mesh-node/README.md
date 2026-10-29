# cappz-mesh: resilience mesh node

Runs a CAPPZ mesh node on Linux, macOS, Windows, Raspberry Pi or Android (Termux), and serves the phone web app for iPhone, iPad and browser-only phones. Nodes find each other on any local network (hotspot, Wi-Fi Direct, ad-hoc Wi-Fi, Ethernet) and pass signed bundles over TCP. They carry bundles across gaps when people move, and over USB sticks when nothing else connects.

```sh
npm run mesh -- wallet
npm run mesh -- join --charter charter.json --grant grant-<address>.json
npm run mesh -- run --alias Ana                                  # add --lora /dev/ttyUSB0 --lora-region eu868 for a LoRa board

npm run mesh:kit -- --charter charter.json --sign --with-node all   # the go-kit: copy, unzip, run with no internet
```

- Step-by-step setup and use, written for an outage with no network: [docs/MESH_FIELD_GUIDE.md](../../docs/MESH_FIELD_GUIDE.md).
- How it works, the threat model and benchmarks: [docs/MESH_RESILIENCE.md](../../docs/MESH_RESILIENCE.md).

| File | Purpose |
|---|---|
| `main.ts` | CLI: wallet, charter, grant, join, revoke-device, revoke-member, run, web-build, evals |
| `ipLink.ts` | Signed UDP beacon on the mesh's multicast group plus subnet broadcast; CPZ1 frames over TCP |
| `webServe.ts` | HTTPS (self-signed KeyZ X.509 projection) serving `web/`, and a WebSocket `/mesh` link for browsers |
| `kit.ts` | The go-kit: one-file program (esbuild), phone app, Node.js runtimes checked against nodejs.org SHASUMS256, launchers, and an authority-signed manifest (`kit-build`, `verify-kit`). Running nodes serve it at `/kit/`. |
| `serialRadio.ts` | A LoRa board (RNode firmware) or KISS TNC on a serial port, as a `PacketRadio` for `RadioMedium` (`run --lora /dev/ttyUSB0 --lora-region eu868`) |
| `web/` | The phone app: a full `MeshNode` in the browser with names, messages to everyone, voice messages, blocking, and WebRTC pairing codes for phone-to-phone links. Native shells (`packages/cappz-mesh-native`) host the same app. `web-build` bundles `app.ts` into `app.js` |

The protocol lives in the SDK (`@cappz/sdk/mesh`, `src/lib/mesh/`). This package only connects it to sockets and a terminal.
