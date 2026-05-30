import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { dataDir, groupsDir } from "../data-dir";
import { readLines, writeLine } from "../framing";
import { makeLogger } from "../logger";
import { ClientMsgSchema, ServerMsgSchema, type ServerMsg } from "../protocol";
import { createBridge, type Bridge } from "./bridge";
import { loadBridgeConfig } from "./bridge-config";
import { createGroupStore } from "./groups";
import {
    handleBroadcast,
    handleGroupCreate,
    handleGroupDelete,
    handleGroupHistory,
    handleGroupInfo,
    handleGroupInvite,
    handleGroupLeave,
    handleGroupList,
    handleGroupRemove,
    handleGroupSend,
    handleInbox,
    handleJoinRoom,
    handleLeaveRoom,
    handleListPeers,
    handleListRooms,
    handleRegister,
    handleRename,
    handleRoomMsg,
    handleSend,
    type HubContext,
} from "./handlers/index";
import { createMailboxStore } from "./mailbox";
import { createPeerRegistry } from "./registry";
import { listenWithRecovery } from "./socket-recovery";
import { addWsEndpoint, VirtualSocket, type WsHandler } from "./ws-endpoint";

const log = makeLogger("hub");

export type StartHubOptions = {
    socketPath: string;
    idleExitMs?: number;
    onIdleExit?: () => void;
    /**
     * Interval in ms for the proactive sweep that probes all registered peers
     * and evicts the ones that don't respond. Catches orphan plugins whose
     * Claude Code parent died but whose socket is still up.
     * Set to 0 to disable. Default: 30000.
     */
    sweepIntervalMs?: number;
    /**
     * Timeout in ms for each probe during the sweep. Default: 1000.
     */
    sweepProbeTimeoutMs?: number;
    /** WebSocket port for non-Unix-socket peers (e.g. OpenCode plugin). */
    wsPort?: number;
};

export type HubHandle = { close: () => Promise<void> };

export async function startHub(opts: StartHubOptions): Promise<HubHandle> {
    const { socketPath } = opts;
    const idleExitMs = opts.idleExitMs ?? 10 * 1000;
    const onIdleExit = opts.onIdleExit ?? (() => process.exit(0));

    const dir = path.dirname(socketPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const registry = createPeerRegistry();
    const groups = createGroupStore(groupsDir());
    const mailboxes = createMailboxStore(path.join(dataDir(), "mailboxes"));

    const bridgeConfig = loadBridgeConfig();
    const bridge: Bridge | null = bridgeConfig ? createBridge(bridgeConfig, registry) : null;

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelIdleTimer = () => {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
    };
    const cancelIdleTimerLogged = () => {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
            log.debug("idle_exit_cancelled");
        }
    };
    const scheduleIdleTimerIfEmpty = () => {
        if (registry.isEmpty() && !idleTimer) {
            log.debug("idle_exit_scheduled", { ms: idleExitMs });
            idleTimer = setTimeout(() => {
                idleTimer = null;
                log.info("idle_exit_fired");
                onIdleExit();
            }, idleExitMs);
        }
    };

    const sendTo = (name: string, msg: ServerMsg): boolean => {
        const s = registry.getSocket(name);
        if (s) {
            try {
                if (s instanceof VirtualSocket) {
                    s.write(JSON.stringify(msg) + "\n");
                } else {
                    writeLine(s, msg);
                }
                return true;
            } catch {
                return false;
            }
        }
        if (bridge) return bridge.sendForward(name, msg);
        return false;
    };

    const ctx: HubContext = {
        registry,
        sendTo,
        groups,
        mailboxes,
        onLocalPeerJoin: bridge
            ? (name: string) => {
                  const entry = registry.list().find((p) => p.name === name);
                  if (!entry) return;
                  bridge.broadcastPeerUpdate({
                      type: "bridge_peer_update",
                      action: "join",
                      peer: entry,
                  });
              }
            : undefined,
    };

    const handleLine = (line: string, socket: net.Socket, send: (msg: ServerMsg) => void) => {
        let raw: unknown;
        try {
            raw = JSON.parse(line);
        } catch (e) {
            log.warn("bad_msg", {
                err: e instanceof Error ? e.message : String(e),
                raw_sample: line.slice(0, 200),
            });
            send({ type: "err", code: "bad_msg" });
            return;
        }
        const parsed = ClientMsgSchema.safeParse(raw);
        if (!parsed.success) {
            log.warn("bad_msg", {
                err: parsed.error.message,
                raw_sample: line.slice(0, 200),
            });
            send({ type: "err", code: "bad_msg" });
            return;
        }
        const msg = parsed.data;
        ctx.registry.touch(socket);
        try {
            switch (msg.type) {
                case "register":
                    handleRegister(ctx, socket, msg, send).catch((e) => {
                        log.error("handler_crash", {
                            type: msg.type,
                            err: e instanceof Error ? e.message : String(e),
                        });
                        send({ type: "err", code: "unexpected" });
                    });
                    return;
                case "rename":
                    return handleRename(ctx, socket, msg, send);
                case "list_peers":
                    return handleListPeers(ctx, socket, msg, send);
                case "broadcast":
                    return handleBroadcast(ctx, socket, msg, send);
                case "join_room":
                    return handleJoinRoom(ctx, socket, msg, send);
                case "leave_room":
                    return handleLeaveRoom(ctx, socket, msg, send);
                case "room_msg":
                    return handleRoomMsg(ctx, socket, msg, send);
                case "list_rooms":
                    return handleListRooms(ctx, socket, msg, send);
                case "group_create":
                    return handleGroupCreate(ctx, socket, msg, send);
                case "group_invite":
                    return handleGroupInvite(ctx, socket, msg, send);
                case "group_remove":
                    return handleGroupRemove(ctx, socket, msg, send);
                case "group_leave":
                    return handleGroupLeave(ctx, socket, msg, send);
                case "group_send":
                    return handleGroupSend(ctx, socket, msg, send);
                case "group_history":
                    return handleGroupHistory(ctx, socket, msg, send);
                case "group_list":
                    return handleGroupList(ctx, socket, msg, send);
                case "group_info":
                    return handleGroupInfo(ctx, socket, msg, send);
                case "group_delete":
                    return handleGroupDelete(ctx, socket, msg, send);
                case "send":
                    return handleSend(ctx, socket, msg, send);
                case "inbox":
                    return handleInbox(ctx, socket, msg, send);
                case "ping":
                    return send({ type: "pong", req_id: msg.req_id });
                case "pong":
                    return ctx.registry.handlePong(msg.req_id);
            }
        } catch (e) {
            log.error("handler_crash", {
                type: msg.type,
                err: e instanceof Error ? e.message : String(e),
            });
            send({ type: "err", code: "unexpected" });
        }
    };

    const server = net.createServer((socket) => {
        log.debug("peer_connect");
        if (idleTimer) cancelIdleTimerLogged();

        const send = (msg: ServerMsg) => {
            writeLine(socket, msg);
        };

        readLines(socket, (line) => handleLine(line, socket, send));

        socket.on("close", () => {
            const name = registry.removeBySocket(socket);
            if (name) {
                if (bridge && !name.includes("@")) {
                    bridge.broadcastPeerUpdate({
                        type: "bridge_peer_update",
                        action: "leave",
                        name,
                    });
                }
            }
            scheduleIdleTimerIfEmpty();
        });

        socket.on("error", (err) => {
            log.debug("peer_socket_error", {
                err: (err as Error).message,
                name: registry.getName(socket) ?? "unregistered",
            });
        });
    });

    await listenWithRecovery(server, socketPath);
    fs.chmodSync(socketPath, 0o600);
    log.info("listen_start", { socketPath });
    scheduleIdleTimerIfEmpty();

    let wsEndpoint: { close: () => Promise<void> } | null = null;
    if (opts.wsPort !== undefined) {
        try {
            wsEndpoint = addWsEndpoint(registry, handleLine as unknown as WsHandler, {
                port: opts.wsPort,
                onDisconnect: (name: string) => {
                    if (bridge && !name.includes("@")) {
                        bridge.broadcastPeerUpdate({
                            type: "bridge_peer_update",
                            action: "leave",
                            name,
                        });
                    }
                    scheduleIdleTimerIfEmpty();
                },
            });
        } catch (e) {
            log.error("ws_endpoint_failed", {
                port: opts.wsPort,
                err: e instanceof Error ? e.message : String(e),
            });
        }
    }

    if (bridge) {
        bridge.setForwardHandler((fwd) => {
            const localSocket = registry.getSocket(fwd.target_peer);
            if (!localSocket) {
                log.warn("bridge_forward_miss", {
                    target: fwd.target_peer,
                    origin_hub: fwd.origin_hub,
                });
                return;
            }
            const wrapped = { ...fwd.wrapped } as Record<string, unknown>;

            if (typeof wrapped.from === "string") {
                const baseName = wrapped.from.split("@")[0];
                wrapped.from = `${baseName}@${fwd.origin_hub}`;
            }

            const validated = ServerMsgSchema.safeParse(wrapped);
            if (!validated.success) {
                log.warn("bridge_forward_invalid_wrapped", {
                    target: fwd.target_peer,
                    origin_hub: fwd.origin_hub,
                });
                return;
            }
            try {
                writeLine(localSocket, validated.data);
            } catch (e) {
                log.error("bridge_forward_write_err", {
                    target: fwd.target_peer,
                    err: e instanceof Error ? e.message : String(e),
                });
            }
        });
        bridge.listen();
        bridge.connectToAllPeers();
    }

    const sweepIntervalMs = opts.sweepIntervalMs ?? 30_000;
    const sweepProbeTimeoutMs = opts.sweepProbeTimeoutMs ?? 1000;
    let sweepTimer: ReturnType<typeof setInterval> | null = null;
    if (sweepIntervalMs > 0) {
        sweepTimer = setInterval(() => {
            const sockets = [...registry.sockets()];
            if (sockets.length === 0) return;
            log.debug("sweep_start", { peer_count: sockets.length });
            void Promise.all(
                sockets.map(async (s) => {
                    const name = registry.getName(s);
                    if (!name) return false;
                    const alive = await registry.probeAlive(s, sweepProbeTimeoutMs);
                    if (alive) return false;
                    log.info("sweep_evicted", { name, reason: "probe_timeout" });
                    // Destroying the socket fires socket.on("close") which already
                    // does the full cleanup (removeBySocket + pendingAsks + peerGone
                    // notifications). Reuse that path instead of duplicating logic.
                    try {
                        s.destroy();
                    } catch {}
                    return true;
                }),
            ).then((results) => {
                const evicted = results.filter((r) => r === true).length;
                if (evicted > 0) log.info("sweep_done", { evicted });
            });
        }, sweepIntervalMs);
        sweepTimer.unref?.();
    }

    return {
        close: async () => {
            if (sweepTimer !== null) {
                clearInterval(sweepTimer);
                sweepTimer = null;
            }
            cancelIdleTimer();
            await bridge?.close();
            await wsEndpoint?.close();
            await new Promise<void>((resolve) => {
                server.close(() => {
                    try {
                        fs.unlinkSync(socketPath);
                    } catch {}
                    resolve();
                });
                for (const s of registry.sockets()) {
                    try {
                        s.destroy();
                    } catch {}
                }
            });
        },
    };
}
