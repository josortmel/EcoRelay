import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { groupsDir } from "../data-dir";
import { readLines, writeLine } from "../framing";
import { makeLogger } from "../logger";
import { ClientMsgSchema, type ServerMsg } from "../protocol";
import { createGroupStore } from "./groups";
import {
    handleAsk,
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
    handleJoinRoom,
    handleLeaveRoom,
    handleListPeers,
    handleListRooms,
    handleRegister,
    handleRename,
    handleReply,
    handleRoomMsg,
    type HubContext,
} from "./handlers";
import { createPendingAsks, type PendingAsk } from "./pending-asks";
import { createPeerRegistry } from "./registry";
import { listenWithRecovery } from "./socket-recovery";

const log = makeLogger("hub");

export type { PendingAsk } from "./pending-asks";

export type StartHubOptions = {
    socketPath: string;
    defaultAskTimeoutMs?: number;
    pendingAsks?: Map<string, PendingAsk>;
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
};

export type HubHandle = { close: () => Promise<void> };

export async function startHub(opts: StartHubOptions): Promise<HubHandle> {
    const { socketPath } = opts;
    const defaultAskTimeoutMs = opts.defaultAskTimeoutMs ?? 600_000;
    const idleExitMs = opts.idleExitMs ?? 5 * 60 * 1000;
    const onIdleExit = opts.onIdleExit ?? (() => process.exit(0));

    const dir = path.dirname(socketPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const registry = createPeerRegistry();
    const pendingAsks = createPendingAsks(opts.pendingAsks);
    const groups = createGroupStore(groupsDir());

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
        if (!s) return false;
        try {
            writeLine(s, msg);
            return true;
        } catch {
            return false;
        }
    };

    const ctx: HubContext = { registry, pendingAsks, defaultAskTimeoutMs, sendTo, groups };

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
                case "ask":
                    return handleAsk(ctx, socket, msg, send);
                case "reply":
                    return handleReply(ctx, socket, msg, send);
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
                const { peerGone } = pendingAsks.cleanupForDisconnect(name);
                for (const { askId, caller } of peerGone) {
                    sendTo(caller, { type: "err", code: "peer_gone", ask_id: askId });
                }
            }
            scheduleIdleTimerIfEmpty();
        });

        socket.on("error", () => {});
    });

    await listenWithRecovery(server, socketPath);
    fs.chmodSync(socketPath, 0o600);
    log.info("listen_start", { socketPath });
    scheduleIdleTimerIfEmpty();

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
        close: () =>
            new Promise<void>((resolve) => {
                if (sweepTimer !== null) {
                    clearInterval(sweepTimer);
                    sweepTimer = null;
                }
                cancelIdleTimer();
                pendingAsks.clearAll();
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
            }),
    };
}
