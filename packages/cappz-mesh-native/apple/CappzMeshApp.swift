// COPE node crystallized. Node ID: v15-13-00-mesh-native-apple
// governingPrinciple: m/44'/144'/100'/principles/cope/v1
//
// CAPPZ Mesh for iPhone, iPad and Mac: the mesh web app in a WKWebView, with
// Apple MultipeerConnectivity as its radio. Multipeer links Apple devices over
// peer-to-peer Wi-Fi (AWDL) and Bluetooth with no access point and no internet.
// This shell only moves bytes (src/lib/mesh/meshNative.ts protocol); keys,
// verification and routing stay in the web app's MeshNode, and every peer must
// pass the signed mesh hello.
//
// STATUS: written against the documented APIs; not compiled or run (no Xcode
// in the environment it was written in). See packages/cappz-mesh-native/README.md.

import SwiftUI
import WebKit
import MultipeerConnectivity

@main
struct CappzMeshApp: App {
    var body: some Scene {
        WindowGroup { MeshWebView().ignoresSafeArea() }
    }
}

// MARK: - Multipeer: one session, every nearby device running the app

final class MeshPeers: NSObject, MCSessionDelegate, MCNearbyServiceAdvertiserDelegate, MCNearbyServiceBrowserDelegate {
    // A random name per launch: radio names are only addresses, never identity.
    private let me = MCPeerID(displayName: String(UUID().uuidString.prefix(8)))
    private lazy var session: MCSession = {
        let s = MCSession(peer: me, securityIdentity: nil, encryptionPreference: .required)
        s.delegate = self
        return s
    }()
    private var advertiser: MCNearbyServiceAdvertiser?
    private var browser: MCNearbyServiceBrowser?
    private var peers: [String: MCPeerID] = [:]
    /// Called on the main queue with a message for the web app.
    var deliver: (([String: Any]) -> Void)?

    func start(service: String) {
        guard advertiser == nil else { return }
        advertiser = MCNearbyServiceAdvertiser(peer: me, discoveryInfo: nil, serviceType: service)
        advertiser?.delegate = self
        advertiser?.startAdvertisingPeer()
        browser = MCNearbyServiceBrowser(peer: me, serviceType: service)
        browser?.delegate = self
        browser?.startBrowsingForPeers()
    }

    func send(peer: String, base64url: String) {
        guard let p = peers[peer], let data = Data(base64URL: base64url) else { return }
        try? session.send(data, toPeers: [p], with: .reliable)
    }

    func close(peer: String) {
        if let p = peers[peer] { session.cancelConnectPeer(p) }
    }

    // One side invites, so a pair opens one session link.
    func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String: String]?) {
        if me.displayName < peerID.displayName { browser.invitePeer(peerID, to: session, withContext: nil, timeout: 20) }
    }
    func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {}

    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didReceiveInvitationFromPeer peerID: MCPeerID, withContext context: Data?, invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        invitationHandler(true, session)
    }

    func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        DispatchQueue.main.async {
            switch state {
            case .connected:
                self.peers[peerID.displayName] = peerID
                self.deliver?(["t": "up", "peer": peerID.displayName, "carrier": "multipeer"])
            case .notConnected:
                if self.peers.removeValue(forKey: peerID.displayName) != nil {
                    self.deliver?(["t": "down", "peer": peerID.displayName])
                }
            default: break
            }
        }
    }

    func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        DispatchQueue.main.async { self.deliver?(["t": "data", "peer": peerID.displayName, "b64": data.base64URLString]) }
    }

    func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {}
    func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {}
    func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {}
}

// MARK: - The web app, and the bridge to it

final class Bridge: NSObject, WKScriptMessageHandler, WKUIDelegate {
    let peers = MeshPeers()
    weak var webView: WKWebView?

    override init() {
        super.init()
        peers.deliver = { [weak self] msg in
            guard let json = try? JSONSerialization.data(withJSONObject: msg), let s = String(data: json, encoding: .utf8) else { return }
            self?.webView?.evaluateJavaScript("window.__cappzMeshNative && window.__cappzMeshNative(\(s))")
        }
    }

    // web → native: { t: 'start', service } · { t: 'send', peer, b64 } · { t: 'close', peer }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any], let t = m["t"] as? String else { return }
        switch t {
        case "start": peers.start(service: (m["service"] as? String) ?? "cappz-mesh")
        case "send": if let p = m["peer"] as? String, let b = m["b64"] as? String { peers.send(peer: p, base64url: b) }
        case "close": if let p = m["peer"] as? String { peers.close(peer: p) }
        default: break
        }
    }

    // Voice messages: let the page use the microphone (the app's Info.plist explains why).
    @available(iOS 15.0, macOS 12.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(type == .microphone ? .grant : .deny)
    }
}

func makeMeshWebView(bridge: Bridge) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.userContentController.add(bridge, name: "cappzMesh")
    #if os(iOS)
    config.allowsInlineMediaPlayback = true
    #endif
    let web = WKWebView(frame: .zero, configuration: config)
    web.uiDelegate = bridge
    bridge.webView = web
    // The bundled web app (index.html + app.js copied into the app's "web" folder reference).
    if let index = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") {
        web.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
    }
    return web
}

#if os(iOS)
struct MeshWebView: UIViewRepresentable {
    private let bridge = Bridge()
    func makeUIView(context: Context) -> WKWebView { makeMeshWebView(bridge: bridge) }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
#else
struct MeshWebView: NSViewRepresentable {
    private let bridge = Bridge()
    func makeNSView(context: Context) -> WKWebView { makeMeshWebView(bridge: bridge) }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
#endif

// MARK: - base64url (the bridge's byte encoding)

extension Data {
    init?(base64URL s: String) {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        self.init(base64Encoded: b)
    }
    var base64URLString: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
