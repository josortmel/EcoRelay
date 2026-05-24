import * as net from "node:net";
import { readLines, writeLine } from "../framing";
import { makeLogger } from "../logger";
import type { BridgeMsg, PeerRecord } from "../protocol";
import { BridgeMsgSchema, PROTOCOL_VERSION } from "../protocol";
import type { BridgeConfig, BridgePeerConfig, RelayConfig } from "./bridge-config";
import type { PeerRegistry } from "./registry";

const log = makeLogger("bridge");

const HANDSHAKE_TIMEOUT_MS = 5000;
const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export type Bridge = ReturnType<typeof createBridge>;

export function createBridge(config: BridgeConfig, registry: PeerRegistry) {
    const connections = new Map<string, net.Socket>();
    let server: net.Server | null = null;
    let stopped = false;
    let onForward:
        | ((msg: {
              target_peer: string;
              origin_hub: string;
              wrapped: Record<string, unknown>;
          }) => void)
        | null = null;
    let onBridgeDisconnect: ((hubId: string) => void) | null = null;

    // WS relay state
    let relayWs: WebSocket | null = null;
    const relayHubs = new Set<string>();

    function setOnBridgeDisconnect(handler: typeof onBridgeDisconnect) {
        onBridgeDisconnect = handler;
    }

    function setForwardHandler(handler: typeof onForward) {
        onForward = handler;
    }

    function handleBridgeMsg(msg: BridgeMsg, remoteHubId: string): void {
        switch (msg.type) {
            case "bridge_peer_update": {
                if (msg.action === "join" && msg.peer) {
                    registry.addRemotePeer(remoteHubId, msg.peer);
                    log.info("remote_peer_join", { hub: remoteHubId, peer: msg.peer.name });
                } else if (msg.action === "leave" && msg.name) {
                    registry.removeRemotePeer(remoteHubId, msg.name);
                    log.info("remote_peer_leave", { hub: remoteHubId, peer: msg.name });
                }
                break;
            }
            case "bridge_forward": {
                if (onForward) onForward({ ...msg, origin_hub: remoteHubId });
                break;
            }
        }
    }

    function getLocalPeers(): PeerRecord[] {
        return registry.list().filter((p) => !p.name.includes("@"));
    }

    function listen(): net.Server | null {
        if (config.listen === 0) return null;
        server = net.createServer((socket) => {
            let handshakeDone = false;
            let remoteHubId = "";
            const handshakeTimer = setTimeout(() => {
                if (!handshakeDone) {
                    log.warn("bridge_handshake_timeout");
                    socket.destroy();
                }
            }, HANDSHAKE_TIMEOUT_MS);

            readLines(socket, (line) => {
                let raw: unknown;
                try {
                    raw = JSON.parse(line);
                } catch {
                    log.warn("bridge_bad_msg", { remote_hub: remoteHubId || "unknown" });
                    return;
                }
                const parsed = BridgeMsgSchema.safeParse(raw);
                if (!parsed.success) {
                    log.warn("bridge_bad_msg", { remote_hub: remoteHubId || "unknown" });
                    return;
                }

                if (!handshakeDone) {
                    clearTimeout(handshakeTimer);
                    if (parsed.data.type !== "bridge_hello") {
                        socket.destroy();
                        return;
                    }
                    const hello = parsed.data;
                    if (hello.protocol_version !== PROTOCOL_VERSION) {
                        log.warn("bridge_protocol_mismatch", {
                            expected: PROTOCOL_VERSION,
                            got: hello.protocol_version,
                        });
                        socket.destroy();
                        return;
                    }
                    if (hello.secret !== config.secret) {
                        log.warn("bridge_auth_failed", { hub_id: hello.hub_id });
                        socket.destroy();
                        return;
                    }
                    if (connections.has(hello.hub_id)) {
                        log.warn("bridge_duplicate", { hub_id: hello.hub_id });
                        socket.destroy();
                        return;
                    }
                    for (const peer of hello.peers) registry.addRemotePeer(hello.hub_id, peer);
                    writeLine(socket, {
                        type: "bridge_welcome",
                        hub_id: config.hub_id,
                        peers: getLocalPeers(),
                    });
                    remoteHubId = hello.hub_id;
                    connections.set(remoteHubId, socket);
                    handshakeDone = true;
                    log.info("bridge_connected", { remote_hub: remoteHubId });
                    return;
                }

                handleBridgeMsg(parsed.data, remoteHubId);
            });

            socket.on("close", () => {
                clearTimeout(handshakeTimer);
                if (remoteHubId) {
                    connections.delete(remoteHubId);
                    registry.removeAllRemotePeersForHub(remoteHubId);
                    log.info("bridge_disconnected", { remote_hub: remoteHubId });
                    if (onBridgeDisconnect) onBridgeDisconnect(remoteHubId);
                }
            });

            socket.on("error", (err) => {
                log.error("bridge_socket_error", {
                    remote_hub: remoteHubId || "unknown",
                    err: err.message,
                });
            });
        });

        const bindAddr = config.bind ?? "0.0.0.0";
        server.listen(config.listen, bindAddr, () => {
            log.info("bridge_listening", { port: config.listen, bind: bindAddr });
        });
        return server;
    }

    function connectToPeerWithRetry(peerConfig: BridgePeerConfig, attempt = 0): void {
        if (stopped) return;
        if (connections.has(peerConfig.hub_id)) return;

        let remoteHubId = "";
        let handshakeDone = false;

        const socket = net.createConnection(
            { host: peerConfig.host, port: peerConfig.port },
            () => {
                writeLine(socket, {
                    type: "bridge_hello",
                    hub_id: config.hub_id,
                    secret: config.secret,
                    protocol_version: PROTOCOL_VERSION,
                    peers: getLocalPeers(),
                });

                readLines(socket, (line) => {
                    let raw: unknown;
                    try {
                        raw = JSON.parse(line);
                    } catch {
                        log.warn("bridge_bad_msg", { hub_id: peerConfig.hub_id });
                        return;
                    }
                    const parsed = BridgeMsgSchema.safeParse(raw);
                    if (!parsed.success) {
                        log.warn("bridge_bad_msg", { hub_id: peerConfig.hub_id });
                        return;
                    }

                    if (!handshakeDone) {
                        if (parsed.data.type !== "bridge_welcome") {
                            socket.destroy();
                            return;
                        }
                        const welcome = parsed.data;
                        if (welcome.hub_id !== peerConfig.hub_id) {
                            log.warn("bridge_hub_id_mismatch", {
                                expected: peerConfig.hub_id,
                                got: welcome.hub_id,
                            });
                            socket.destroy();
                            return;
                        }
                        for (const peer of welcome.peers)
                            registry.addRemotePeer(welcome.hub_id, peer);
                        remoteHubId = welcome.hub_id;
                        connections.set(remoteHubId, socket);
                        clearTimeout(handshakeTimer);
                        handshakeDone = true;
                        log.info("bridge_connected", { remote_hub: remoteHubId });
                        return;
                    }

                    handleBridgeMsg(parsed.data, remoteHubId);
                });
            },
        );

        const handshakeTimer = setTimeout(() => {
            if (!handshakeDone) {
                log.warn("bridge_client_handshake_timeout", { hub_id: peerConfig.hub_id });
                socket.destroy();
            }
        }, HANDSHAKE_TIMEOUT_MS);

        socket.on("close", () => {
            clearTimeout(handshakeTimer);
            if (remoteHubId) {
                connections.delete(remoteHubId);
                registry.removeAllRemotePeersForHub(remoteHubId);
                log.info("bridge_disconnected", { remote_hub: remoteHubId });
                if (onBridgeDisconnect) onBridgeDisconnect(remoteHubId);
            }
            if (!stopped) {
                // Reset backoff if connection was established; escalate if handshake never completed
                const nextAttempt = handshakeDone ? 0 : attempt + 1;
                const delay = RETRY_DELAYS[Math.min(nextAttempt, RETRY_DELAYS.length - 1)];
                log.info("bridge_reconnect_scheduled", {
                    hub_id: peerConfig.hub_id,
                    delay_ms: delay,
                    attempt: nextAttempt,
                });
                setTimeout(() => connectToPeerWithRetry(peerConfig, nextAttempt), delay);
            }
        });

        socket.on("error", (err) => {
            clearTimeout(handshakeTimer);
            log.warn("bridge_connect_failed", {
                hub_id: peerConfig.hub_id,
                host: peerConfig.host,
                port: peerConfig.port,
                err: err.message,
            });
        });
    }

    function connectToRelayWs(relayConfig: RelayConfig, attempt = 0): void {
        if (stopped) return;

        const ws = new WebSocket(relayConfig.url);
        let handshakeDone = false;

        const handshakeTimer = setTimeout(() => {
            if (!handshakeDone) {
                log.warn("relay_ws_handshake_timeout", { url: relayConfig.url });
                ws.close();
            }
        }, HANDSHAKE_TIMEOUT_MS);

        ws.onopen = () => {
            ws.send(
                JSON.stringify({
                    type: "bridge_hello",
                    hub_id: config.hub_id,
                    secret: relayConfig.token,
                    protocol_version: PROTOCOL_VERSION,
                    peers: getLocalPeers(),
                }),
            );
        };

        ws.onmessage = (event) => {
            const text =
                typeof event.data === "string" ? event.data : (event.data as Buffer).toString();
            let raw: unknown;
            try {
                raw = JSON.parse(text);
            } catch {
                return;
            }
            const parsed = BridgeMsgSchema.safeParse(raw);
            if (!parsed.success) return;

            if (!handshakeDone) {
                clearTimeout(handshakeTimer);
                if (parsed.data.type !== "bridge_welcome") {
                    ws.close();
                    return;
                }
                // Welcome peers are already qualified: "name@hub_id"
                for (const peer of parsed.data.peers) {
                    const atIdx = peer.name.indexOf("@");
                    if (atIdx !== -1) {
                        const remoteHub = peer.name.slice(atIdx + 1);
                        const localPeer = { ...peer, name: peer.name.slice(0, atIdx) };
                        if (!localPeer.name || localPeer.name.includes("@")) {
                            log.warn("relay_invalid_peer_name", { raw: peer.name });
                            continue;
                        }
                        registry.addRemotePeer(remoteHub, localPeer);
                        relayHubs.add(remoteHub);
                    }
                }
                relayWs = ws;
                handshakeDone = true;
                log.info("relay_ws_connected", { url: relayConfig.url });
                return;
            }

            const msg = parsed.data;

            if (msg.type === "bridge_peer_update") {
                if (msg.action === "join" && msg.peer) {
                    // Peer names from relay are always qualified: "name@hub_id"
                    const atIdx = msg.peer.name.indexOf("@");
                    if (atIdx !== -1) {
                        const remoteHub = msg.peer.name.slice(atIdx + 1);
                        const localPeer = { ...msg.peer, name: msg.peer.name.slice(0, atIdx) };
                        if (!localPeer.name || localPeer.name.includes("@")) {
                            log.warn("relay_invalid_peer_name", { raw: msg.peer.name });
                            return;
                        }
                        registry.addRemotePeer(remoteHub, localPeer);
                        relayHubs.add(remoteHub);
                    }
                } else if (msg.action === "leave" && msg.name) {
                    const atIdx = msg.name.indexOf("@");
                    if (atIdx !== -1) {
                        const remoteHub = msg.name.slice(atIdx + 1);
                        const localName = msg.name.slice(0, atIdx);
                        registry.removeRemotePeer(remoteHub, localName);
                    }
                }
                return;
            }

            if (msg.type === "bridge_forward") {
                const originHub = msg.origin_hub;
                if (!originHub) {
                    log.warn("relay_forward_unknown_origin", { origin_hub: originHub });
                    return;
                }
                // Relay is trusted; auto-discover peer-less hubs on first forward
                if (!relayHubs.has(originHub)) relayHubs.add(originHub);
                const atIdx = msg.target_peer.indexOf("@");
                const localTarget =
                    atIdx !== -1 ? msg.target_peer.slice(0, atIdx) : msg.target_peer;
                if (onForward)
                    onForward({
                        target_peer: localTarget,
                        origin_hub: originHub,
                        wrapped: msg.wrapped,
                    });
                return;
            }
        };

        ws.onclose = () => {
            clearTimeout(handshakeTimer);
            if (handshakeDone) {
                relayWs = null;
                for (const hubId of relayHubs) {
                    registry.removeAllRemotePeersForHub(hubId);
                    if (!stopped && onBridgeDisconnect) onBridgeDisconnect(hubId);
                }
                relayHubs.clear();
                if (!stopped) log.info("relay_ws_disconnected", { url: relayConfig.url });
            }
            if (!stopped) {
                const nextAttempt = handshakeDone ? 0 : attempt + 1;
                const delay = RETRY_DELAYS[Math.min(nextAttempt, RETRY_DELAYS.length - 1)];
                log.info("relay_ws_reconnect_scheduled", { delay_ms: delay, attempt: nextAttempt });
                setTimeout(() => connectToRelayWs(relayConfig, nextAttempt), delay);
            }
        };

        ws.onerror = (err) => {
            log.warn("relay_ws_error", { url: relayConfig.url, err: String(err) });
        };
    }

    // Send a bridge_forward for a remote peer, routing via TCP or relay WS as appropriate
    function sendForward(qualifiedName: string, wrapped: unknown): boolean {
        const remote = registry.getRemotePeer(qualifiedName);
        if (!remote) return false;

        const socket = connections.get(remote.hub_id);
        if (socket) {
            try {
                writeLine(socket, {
                    type: "bridge_forward",
                    target_peer: remote.localName,
                    origin_hub: config.hub_id,
                    wrapped,
                });
                return true;
            } catch {
                return false;
            }
        }

        if (relayWs) {
            try {
                relayWs.send(
                    JSON.stringify({
                        type: "bridge_forward",
                        target_peer: qualifiedName,
                        origin_hub: config.hub_id,
                        wrapped,
                    }),
                );
                return true;
            } catch {
                return false;
            }
        }

        return false;
    }

    // Broadcast a peer update to all TCP connections and the relay WS
    function broadcastPeerUpdate(msg: Record<string, unknown>): void {
        for (const socket of connections.values()) {
            try {
                writeLine(socket, msg);
            } catch {}
        }
        if (relayWs) {
            try {
                relayWs.send(JSON.stringify(msg));
            } catch {}
        }
    }

    function connectToAllPeers(): void {
        for (const p of config.peers) connectToPeerWithRetry(p);
        if (config.relay) connectToRelayWs(config.relay);
    }

    function sendBridgeMsg(hubId: string, msg: Record<string, unknown>): boolean {
        const socket = connections.get(hubId);
        if (!socket) return false;
        try {
            writeLine(socket, msg);
            return true;
        } catch {
            return false;
        }
    }

    async function close(): Promise<void> {
        stopped = true;
        for (const s of connections.values()) s.destroy();
        connections.clear();
        if (relayWs) {
            for (const hubId of relayHubs) {
                registry.removeAllRemotePeersForHub(hubId);
                if (onBridgeDisconnect) onBridgeDisconnect(hubId);
            }
            relayHubs.clear();
            relayWs.close();
            relayWs = null;
        }
        if (server) {
            const s = server;
            await new Promise<void>((resolve) => s.close(() => resolve()));
            server = null;
        }
    }

    return {
        listen,
        connectToAllPeers,
        connectToPeer: connectToPeerWithRetry,
        sendBridgeMsg,
        sendForward,
        broadcastPeerUpdate,
        setForwardHandler,
        setOnBridgeDisconnect,
        close,
        get hubId() {
            return config.hub_id;
        },
        get connections() {
            return connections;
        },
        get relayConnected() {
            return relayWs !== null;
        },
    };
}
