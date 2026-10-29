# cappz-mesh-native: phone radios without an access point

Browsers cannot use a phone's Bluetooth or peer-to-peer Wi-Fi, so two iPhones with no hotspot nearby cannot reach each other from Safari. These shells host the same mesh web app (`packages/cappz-mesh-node/web`) in a native WebView and give it the platform's own device-to-device radio:

| Shell | Radio | Links |
|---|---|---|
| `apple/CappzMeshApp.swift` (iPhone, iPad, Mac) | MultipeerConnectivity | Apple devices over peer-to-peer Wi-Fi (AWDL) and Bluetooth, no access point |
| `android/` (Android 8+) | Google Nearby Connections, `P2P_CLUSTER` | Android devices over Bluetooth, BLE, Wi-Fi Direct and Wi-Fi Aware. Needs Google Play services. |

The shells only move bytes. They implement the bridge protocol in `src/lib/mesh/meshNative.ts`. Keys, encryption, verification and routing stay in the web app's `MeshNode`, and every native peer must pass the signed mesh hello like any other link. The web app detects the shell, starts its radio, and keeps its other links: WebSocket to a node, WebRTC pairing codes.

> **Status: not yet compiled or run.** The shells were written against Apple's and Google's documented APIs in an environment with no Xcode and no Android SDK. The JavaScript side of the bridge is unit-tested with a fake shell (`src/test/mesh-radio.test.ts`). Build them, fix what the compilers find, and test on two devices before relying on them. Two things to check first:
> - **iOS:** whether a `file://` page in WKWebView gets `crypto.subtle`. WebKit treats `file:` as a secure context, but confirm it. If not, serve the app from a loopback HTTP server inside the app; `http://localhost` is a secure context.
> - **Android:** Nearby `BYTES` payloads are capped at 32 KiB. The bridge sends 16 KiB chunks, and the frame decoder reassembles them.

## Build: iPhone / iPad / Mac (Xcode 15+)

1. Build the web app: `npm run mesh -- web-build`.
2. In Xcode, create a new **App** project (SwiftUI, Swift), with targets for iOS and, if you want it, macOS.
3. Replace the generated `App` and `ContentView` files with `apple/CappzMeshApp.swift`.
4. Drag `packages/cappz-mesh-node/web` into the project as a **folder reference** (blue folder) named `web`. It needs only `index.html` and `app.js`.
5. Add these keys to Info.plist:
   - `NSLocalNetworkUsageDescription`: "Finds nearby CAPPZ Mesh devices."
   - `NSBonjourServices`: `_cappz-mesh._tcp`, `_cappz-mesh._udp`
   - `NSMicrophoneUsageDescription`: "Records voice messages you choose to send."
6. On macOS, turn on the App Sandbox capabilities *Incoming/Outgoing Connections* and *Audio Input*.
7. Run the app on two devices with Wi-Fi and Bluetooth on (no network needed). They connect within seconds.

iOS suspends apps in the background. Keep the app open while you need to relay.

## Build: Android (Android Studio Hedgehog+)

1. Build the web app: `npm run mesh -- web-build`. Gradle copies `index.html` and `app.js` into the APK's assets.
2. Open `packages/cappz-mesh-native/android` in Android Studio, which adds the Gradle wrapper, and build.
3. Install on two phones and grant the Nearby devices, location (Android ≤ 12) and microphone permissions.

The page is served from `https://appassets.androidplatform.net` (WebViewAssetLoader), which is a secure context, so WebCrypto works.

For an APK that can be shared during an outage, build a release APK ahead of time and put it on the go-kit stick. Android installs it offline once "install unknown apps" is allowed.
