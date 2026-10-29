// COPE node crystallized. Node ID: v15-13-00-mesh-native-android
// governingPrinciple: m/44'/144'/100'/principles/cope/v1
//
// CAPPZ Mesh for Android: the mesh web app in a WebView (served from the APK at
// https://appassets.androidplatform.net, a secure context, so WebCrypto works),
// with Google Nearby Connections as its radio (Bluetooth, BLE, Wi-Fi Direct /
// Aware; no access point, no internet). The shell only moves bytes
// (src/lib/mesh/meshNative.ts protocol); keys, verification and routing stay in
// the web app's MeshNode, and every peer must pass the signed mesh hello.
//
// Needs Google Play services (Nearby). Phones without them can use the Termux
// node or the web app from a nearby node.
//
// STATUS: written against the documented APIs; not compiled or run (no Android
// SDK in the environment it was written in). See packages/cappz-mesh-native/README.md.

package ai.cappz.mesh

import android.Manifest
import android.annotation.SuppressLint
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebViewAssetLoader
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import org.json.JSONObject
import java.util.UUID

class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var nearby: ConnectionsClient
    // A random name per launch: radio names are only addresses, never identity.
    private val name = UUID.randomUUID().toString().take(8)
    private val connected = mutableSetOf<String>()
    private var serviceId = "ai.cappz.mesh"
    private var started = false
    private val b64 = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP

    private val permissions = buildList {
        add(Manifest.permission.RECORD_AUDIO)
        add(Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= 31) { add(Manifest.permission.BLUETOOTH_SCAN); add(Manifest.permission.BLUETOOTH_ADVERTISE); add(Manifest.permission.BLUETOOTH_CONNECT) }
        if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.NEARBY_WIFI_DEVICES)
    }.toTypedArray()
    private val askPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { if (started) startRadios() }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        nearby = Nearby.getConnectionsClient(this)
        val assets = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) = assets.shouldInterceptRequest(request.url)
            }
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    runOnUiThread { request.grant(request.resources.filter { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }.toTypedArray()) }
                }
            }
            addJavascriptInterface(Bridge(), "CappzMeshAndroid")
        }
        setContentView(web)
        askPermissions.launch(permissions)
        web.loadUrl("https://appassets.androidplatform.net/assets/web/index.html")
    }

    /** native → web */
    private fun deliver(msg: JSONObject) = runOnUiThread {
        web.evaluateJavascript("window.__cappzMeshNative && window.__cappzMeshNative($msg)", null)
    }

    /** web → native: { t: 'start', service } · { t: 'send', peer, b64 } · { t: 'close', peer } */
    inner class Bridge {
        @JavascriptInterface
        fun post(json: String) {
            val m = JSONObject(json)
            runOnUiThread {
                when (m.optString("t")) {
                    "start" -> { serviceId = "ai.cappz." + m.optString("service", "cappz-mesh"); started = true; startRadios() }
                    "send" -> nearby.sendPayload(m.getString("peer"), Payload.fromBytes(Base64.decode(m.getString("b64"), b64)))
                    "close" -> nearby.disconnectFromEndpoint(m.getString("peer"))
                }
            }
        }
    }

    private fun startRadios() {
        val strategy = Strategy.P2P_CLUSTER // many-to-many: a mesh
        nearby.stopAdvertising(); nearby.stopDiscovery()
        nearby.startAdvertising(name, serviceId, lifecycle, AdvertisingOptions.Builder().setStrategy(strategy).build())
        nearby.startDiscovery(serviceId, discovery, DiscoveryOptions.Builder().setStrategy(strategy).build())
    }

    private val discovery = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            // One side asks, so a pair opens one connection.
            if (name < info.endpointName && endpointId !in connected) nearby.requestConnection(name, endpointId, lifecycle)
        }
        override fun onEndpointLost(endpointId: String) {}
    }

    private val lifecycle = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) { nearby.acceptConnection(endpointId, payloads) }
        override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
            if (result.status.isSuccess) { connected += endpointId; deliver(JSONObject().put("t", "up").put("peer", endpointId).put("carrier", "nearby")) }
        }
        override fun onDisconnected(endpointId: String) {
            if (connected.remove(endpointId)) deliver(JSONObject().put("t", "down").put("peer", endpointId))
        }
    }

    private val payloads = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            val bytes = payload.asBytes() ?: return
            deliver(JSONObject().put("t", "data").put("peer", endpointId).put("b64", Base64.encodeToString(bytes, b64)))
        }
        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {}
    }

    override fun onDestroy() {
        nearby.stopAllEndpoints()
        super.onDestroy()
    }
}
