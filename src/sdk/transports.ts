/** Edge transports: frame codec, transport contract, discovery, sessions, carriers. Node capability TXs and the XRPL header watcher write to the app's storage, so they are exported by the root SDK (@cappz/sdk). */
export { encodeFrame, encodeJsonFrame, decodeJsonFrame, FrameDecoder, FRAME_COMMANDS, MAX_FRAME_PAYLOAD } from '../lib/sync/frameCodec';
export type { FrameCommand, WireFrame } from '../lib/sync/frameCodec';
export { asEdgeTransport, canonicalHelloJson } from '../lib/sync/transportContract';
export type { EdgeTransport, EdgeTransportKind, DiscoveryMethod, TransportHello } from '../lib/sync/transportContract';
export { BeaconRateLimiter, mintPairingCode, pairingCodeValid } from '../lib/sync/discovery/discoveryPlugins';
export { openEdgeSession, memoryDuplexPair } from '../lib/sync/edgeSession';
export type { ByteDuplex, EdgePeerSession } from '../lib/sync/edgeSession';
// v15-03-00 — copies behind firewalls: TX bid/ask rendezvous + outbound HTTPS keep-alive carrier, and the relay node handler.
export { connectThroughFirewall, requestReplicaConnect, openHttpsTunnel, inProcessFetch, CARRIER_LADDER, RUNG_LABEL } from '../lib/sync/transports/httpsTunnel';
export type { HttpsTunnel, HttpsTunnelOptions, TunnelStats, ConnectOptions, FetchLike } from '../lib/sync/transports/httpsTunnel';
export { createHttpsRelay, REPLICA_CONNECT_BPMN_PATH } from '../lib/sync/transports/httpsRelay';
export type { HttpsRelay, RelayPolicy, RelayStats, CarrierRung, RendezvousRequest, RendezvousDecision, RendezvousOffer, RendezvousReject } from '../lib/sync/transports/httpsRelay';
export { proxiedFetch, PROXY_PROFILES } from '../lib/sync/transports/proxySimulator';
export type { ProxyProfile, ProxyCounters } from '../lib/sync/transports/proxySimulator';
// v15-03-00 — Ed25519 hello and beacon signatures (WebCrypto); checks return a lifecycle state.
export { generateSigningKey, importSigningKey, signHello, verifyHello, signBeacon, verifyBeacon, acceptsSignature, HELLO_MAX_AGE_MS } from '../lib/sync/helloSignature';
export type { SigningKey, SignatureCheck, VerifyOptions } from '../lib/sync/helloSignature';
export { assertSignedHello } from '../lib/sync/edgeSession';
export type { EdgeSessionOptions } from '../lib/sync/edgeSession';
// v15-04-00 — socket rungs (WebTransport, WebSocket) above the HTTPS floor, wallet-signed key declarations, body pull.
export { defaultSocketDialer, runtimeRungs, isSocketRung } from '../lib/sync/transports/httpsTunnel';
export type { SocketDialer } from '../lib/sync/transports/httpsTunnel';
export type { CarrierEndpoints, SocketRung } from '../lib/sync/transports/httpsRelay';
export { dialWebSocket, dialWebTransport, webSocketDuplex } from '../lib/sync/transports/socketDuplex';
export { proxiedSocketDialer } from '../lib/sync/transports/proxySimulator';
export { declareHelloKey, verifyHelloKeyDeclaration, canonicalDeclaration, DECLARATION_TTL_MS } from '../lib/sync/helloKeyDeclaration';
export type { HelloKeyDeclaration, DeclarationCheck } from '../lib/sync/helloKeyDeclaration';
export { runBodyExchange, memoryBodyStore, MAX_BODY_BYTES } from '../lib/sync/edgeBodyPull';
export type { BodyStore, BodyPullStats } from '../lib/sync/edgeBodyPull';
// v15-05-00 — member table (per-device endpoint records) and connect-by-name: LAN, then public endpoint, then a relay.
export { signEndpointRecord, signEndpointRecordWithWallet, verifyEndpointRecord, replayEndpointDirectory, resolvePeerPaths, canonicalEndpointRecord, PATH_LABEL } from '../lib/sync/endpointDirectory';
export type { EndpointRecord, DeviceEndpoint, DirectoryEntry, EndpointTrust, PeerPath } from '../lib/sync/endpointDirectory';
export { connectToPeer } from '../lib/sync/transports/peerConnect';
export type { PeerConnectOptions } from '../lib/sync/transports/peerConnect';
// v15-09-00 — one transport namespace (MDM accounts at cappz/config/transports/<id>; old kind names resolve).
export { TRANSPORT_TYPES, resolveTransportType, transportTypeAddressFor, commonCarriers } from '../lib/sync/transportTypes';
export type { TransportType, TransportLayer } from '../lib/sync/transportTypes';
// v15-09-00 / v15-10-00 — wallet multicast groups, signed UDP kick-off of side channels (padded asks, port-only offers).
export { walletMulticastGroup, buildConnectRequest, readConnectRequest, buildConnectOffer, readConnectOffer, planSideChannels, endpointUrl, compactEndpoint, NonceWindow, UDP_DATAGRAM_MAX, WALLET_GROUP_PORT } from '../lib/sync/discovery/walletMulticast';
export type { WalletGroup, UdpConnectRequest, UdpConnectOffer, OfferedEndpoint, ConnectCheck } from '../lib/sync/discovery/walletMulticast';
// v15-10-00 — files above 6 MB as chunks + manifest; processing farm: rendezvous partitioning + reliable multicast feed.
export { putBody, readBody, parseManifest, CHUNK_BYTES } from '../lib/sync/chunkedBodies';
export type { ChunkManifest, ReadResult } from '../lib/sync/chunkedBodies';
export { flowOwner, assignFlows, createFeedSender, createFeedReceiver, FEED_MAX_NACK } from '../lib/sync/farmFeed';
export type { FarmNode, FeedDatagram, Delivery } from '../lib/sync/farmFeed';
