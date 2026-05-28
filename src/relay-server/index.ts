import type { ServerWebSocket } from "bun";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { BridgeMsgSchema, PROTOCOL_VERSION, type PeerRecord } from "../protocol";

function safeSecretCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export const RelayConfigSchema = z.object({
    port: z.number().default(9800),
    secret: z.string().min(8),
    max_hubs: z.number().default(50),
    handshake_timeout_ms: z.number().default(5000),
});

export type RelayConfig = z.infer<typeof RelayConfigSchema>;

// FIX 5: timer lives in HubData so it can be cleared on auth or close
type HubData = { hub_id: string | null; timer: ReturnType<typeof setTimeout> | null };
type HubEntry = { hub_id: string; ws: ServerWebSocket<HubData>; peers: PeerRecord[] };

// FIX 2: allow only safe characters in hub_id to prevent log injection and @ collision
const HUB_ID_RE = /^[a-zA-Z0-9_-]+$/;

export function startRelayServer(config: RelayConfig) {
    const hubs = new Map<string, HubEntry>();

    function safeSend(ws: ServerWebSocket<HubData>, data: string): boolean {
        try {
            ws.send(data);
            return true;
        } catch {
            return false;
        }
    }

    function collectRemotePeers(excludeHub: string): PeerRecord[] {
        const all: PeerRecord[] = [];
        for (const [id, hub] of hubs) {
            if (id === excludeHub) continue;
            for (const p of hub.peers) {
                all.push({ ...p, name: `${p.name}@${id}` });
            }
        }
        return all;
    }

    function broadcastPeerUpdate(
        fromHub: string,
        action: "join" | "leave",
        peer?: PeerRecord,
        name?: string,
    ) {
        const msg = JSON.stringify({
            type: "bridge_peer_update",
            action,
            ...(peer ? { peer } : {}),
            ...(name ? { name } : {}),
        });
        for (const [id, hub] of hubs) {
            if (id !== fromHub) safeSend(hub.ws, msg);
        }
    }

    const server = Bun.serve<HubData>({
        port: config.port,
        websocket: {
            maxPayloadLength: 1048576,
            open(ws) {
                // FIX 5: store timer ref for cleanup
                ws.data = { hub_id: null, timer: null };
                ws.data.timer = setTimeout(() => {
                    if (!ws.data.hub_id) ws.close(4001, "handshake_timeout");
                }, config.handshake_timeout_ms);
            },
            message(ws, raw) {
                const text = typeof raw === "string" ? raw : raw.toString();
                let parsed: unknown;
                try {
                    parsed = JSON.parse(text);
                } catch {
                    ws.close(4005, "bad_json");
                    return;
                }

                const hubId = ws.data.hub_id;

                if (!hubId) {
                    const result = BridgeMsgSchema.safeParse(parsed);
                    if (!result.success || result.data.type !== "bridge_hello") {
                        ws.close(4001, "expected_bridge_hello");
                        return;
                    }
                    const hello = result.data;
                    if (hello.protocol_version !== PROTOCOL_VERSION) {
                        ws.close(4002, "protocol_mismatch");
                        return;
                    }
                    if (!safeSecretCompare(hello.secret, config.secret)) {
                        ws.close(4003, "auth_failed");
                        return;
                    }
                    // FIX 2: reject hub_ids with unsafe characters
                    if (!HUB_ID_RE.test(hello.hub_id)) {
                        ws.close(4005, "invalid_hub_id");
                        return;
                    }
                    if (hubs.has(hello.hub_id)) {
                        ws.close(4004, "hub_id_taken");
                        return;
                    }
                    if (hubs.size >= config.max_hubs) {
                        ws.close(4006, "max_hubs_reached");
                        return;
                    }

                    // FIX 5: clear timer on successful auth
                    if (ws.data.timer) {
                        clearTimeout(ws.data.timer);
                        ws.data.timer = null;
                    }

                    ws.data.hub_id = hello.hub_id;
                    hubs.set(hello.hub_id, { hub_id: hello.hub_id, ws, peers: hello.peers });

                    safeSend(
                        ws,
                        JSON.stringify({
                            type: "bridge_welcome",
                            hub_id: "relay",
                            peers: collectRemotePeers(hello.hub_id),
                        }),
                    );

                    for (const p of hello.peers) {
                        broadcastPeerUpdate(hello.hub_id, "join", {
                            ...p,
                            name: `${p.name}@${hello.hub_id}`,
                        });
                    }

                    console.log(
                        `[relay] hub connected: ${hello.hub_id} (${hello.peers.length} peers)`,
                    );
                    return;
                }

                const result = BridgeMsgSchema.safeParse(parsed);
                if (!result.success) return;
                const msg = result.data;

                if (msg.type === "bridge_forward") {
                    const atIdx = msg.target_peer.indexOf("@");
                    const targetHub = atIdx !== -1 ? msg.target_peer.slice(atIdx + 1) : null;
                    if (!targetHub) {
                        safeSend(
                            ws,
                            JSON.stringify({
                                type: "err",
                                code: "bad_args",
                                message: "cannot determine target hub",
                            }),
                        );
                        return;
                    }
                    const target = hubs.get(targetHub);
                    if (!target) {
                        safeSend(
                            ws,
                            JSON.stringify({
                                type: "err",
                                code: "peer_not_found",
                                message: `hub ${targetHub} not connected`,
                            }),
                        );
                        return;
                    }
                    safeSend(
                        target.ws,
                        JSON.stringify({
                            type: "bridge_forward",
                            target_peer: msg.target_peer,
                            origin_hub: hubId,
                            wrapped: msg.wrapped,
                        }),
                    );
                    return;
                }

                if (msg.type === "bridge_peer_update") {
                    const entry = hubs.get(hubId);
                    if (entry) {
                        if (msg.action === "join" && msg.peer) {
                            const peer = msg.peer;
                            if (!entry.peers.some((p) => p.name === peer.name)) {
                                entry.peers.push(peer);
                            }
                        } else if (msg.action === "leave" && msg.name) {
                            entry.peers = entry.peers.filter((p) => p.name !== msg.name);
                        }
                    }
                    const qualified: {
                        type: string;
                        action: string;
                        peer?: PeerRecord;
                        name?: string;
                    } = {
                        type: "bridge_peer_update",
                        action: msg.action,
                    };
                    if (msg.action === "join" && msg.peer) {
                        qualified.peer = { ...msg.peer, name: `${msg.peer.name}@${hubId}` };
                    } else if (msg.action === "leave" && msg.name) {
                        qualified.name = `${msg.name}@${hubId}`;
                    }
                    const qualifiedText = JSON.stringify(qualified);
                    for (const [id, hub] of hubs) {
                        if (id !== hubId) safeSend(hub.ws, qualifiedText);
                    }
                    return;
                }
                console.warn(`[relay] unhandled msg from ${hubId}: ${msg.type}`);
            },
            close(ws) {
                // FIX 5: always clear the timer, including when close fires before timeout
                if (ws.data.timer) {
                    clearTimeout(ws.data.timer);
                    ws.data.timer = null;
                }
                const hubId = ws.data.hub_id;
                if (hubId) {
                    const entry = hubs.get(hubId);
                    hubs.delete(hubId);
                    console.log(`[relay] hub disconnected: ${hubId}`);
                    if (entry) {
                        for (const p of entry.peers) {
                            broadcastPeerUpdate(hubId, "leave", undefined, `${p.name}@${hubId}`);
                        }
                    }
                }
            },
        },
        fetch(req, server) {
            if (server.upgrade(req, { data: { hub_id: null, timer: null } })) return;
            return new Response("OK", { status: 200 }); // FIX 6: no version/hub count disclosure
        },
    });

    console.log(`[relay] listening on port ${server.port}`);

    return {
        stop: () => {
            for (const hub of hubs.values()) {
                try {
                    hub.ws.close(1000, "server_stopping");
                } catch {}
            }
            server.stop();
        },
        port: server.port as number,
        hubCount: () => hubs.size,
    };
}

function loadConfig(): RelayConfig {
    const configPath = process.argv[2] ?? "relay-config.json";
    try {
        const raw = JSON.parse(readFileSync(configPath, "utf8"));
        return RelayConfigSchema.parse(raw);
    } catch (e) {
        console.error(`Failed to load config from ${configPath}:`, e);
        process.exit(1);
    }
}

if (import.meta.main) {
    const config = loadConfig();
    startRelayServer(config);
}
