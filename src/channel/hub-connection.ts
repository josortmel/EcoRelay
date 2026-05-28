import * as net from "node:net";
import { readLines, writeLine } from "../framing";
import { makeLogger } from "../logger";
import { ServerMsgSchema, type ServerMsg } from "../protocol";

const log = makeLogger("channel");

type MessageListener = (msg: ServerMsg) => void;

export type HubConnection = ReturnType<typeof createHubConnection>;

export function createHubConnection(socket: net.Socket) {
    const listeners = new Set<MessageListener>();
    const pending = new Map<string, (msg: ServerMsg) => void>();
    const disconnectListeners = new Set<() => void>();
    let reqCounter = 0;

    function handleLine(line: string): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            return;
        }
        const result = ServerMsgSchema.safeParse(parsed);
        if (!result.success) return;
        const m = result.data;
        log.debug("recv_from_hub", {
            type: m.type,
            ask_id: (m as { ask_id?: string }).ask_id,
            broadcast_id: (m as { broadcast_id?: string }).broadcast_id,
            from: (m as { from?: string }).from,
        });
        for (const l of listeners) {
            try {
                l(m);
            } catch (e) {
                log.error("listener_crash", {
                    type: m.type,
                    err: e instanceof Error ? e.message : String(e),
                });
            }
        }
    }

    function onMessage(cb: MessageListener): () => void {
        listeners.add(cb);
        return () => {
            listeners.delete(cb);
        };
    }

    let disconnected = false;
    function handleDisconnect(): void {
        if (disconnected) return;
        disconnected = true;
        log.warn("hub_disconnect");
        for (const [reqId, resolver] of pending) {
            resolver({ type: "err", code: "hub_unreachable", req_id: reqId });
        }
        pending.clear();
        for (const l of disconnectListeners) l();
    }

    readLines(socket, handleLine);
    socket.on("close", handleDisconnect);
    socket.on("error", handleDisconnect);

    // Correlate req_id replies to in-flight sendRequest calls.
    onMessage((m) => {
        const reqId = (m as { req_id?: string }).req_id;
        if (!reqId) return;
        const resolver = pending.get(reqId);
        if (resolver) {
            pending.delete(reqId);
            resolver(m);
        }
    });

    function send(obj: unknown): void {
        const o = obj as {
            type?: string;
            req_id?: string;
            ask_id?: string;
            broadcast_id?: string;
        };
        if (socket.destroyed) {
            log.warn("send_on_dead_socket", { type: o.type });
            return;
        }
        log.debug("send_to_hub", {
            type: o.type,
            req_id: o.req_id,
            ask_id: o.ask_id,
            broadcast_id: o.broadcast_id,
        });
        try {
            writeLine(socket, obj);
        } catch (e) {
            log.warn("send_to_hub_err", {
                err: e instanceof Error ? e.message : String(e),
            });
        }
    }

    function sendRequest(payload: Record<string, unknown>, timeoutMs: number): Promise<ServerMsg> {
        if (socket.destroyed) {
            return Promise.resolve({ type: "err", code: "hub_unreachable" });
        }
        const reqId = `r${++reqCounter}`;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                if (pending.delete(reqId)) {
                    log.warn("pending_request_timeout", {
                        req_id: reqId,
                        kind: payload.type as string,
                    });
                    resolve({ type: "err", code: "hub_unreachable", req_id: reqId });
                }
            }, timeoutMs);
            pending.set(reqId, (m) => {
                clearTimeout(timer);
                resolve(m);
            });
            log.debug("send_to_hub", {
                type: payload.type as string,
                req_id: reqId,
            });
            try {
                writeLine(socket, { ...payload, req_id: reqId });
            } catch (e) {
                pending.delete(reqId);
                clearTimeout(timer);
                log.warn("send_to_hub_err", {
                    err: e instanceof Error ? e.message : String(e),
                });
                resolve({ type: "err", code: "hub_unreachable", req_id: reqId });
            }
        });
    }

    function onDisconnect(cb: () => void): () => void {
        disconnectListeners.add(cb);
        return () => {
            disconnectListeners.delete(cb);
        };
    }

    function nextMessage(predicate: (m: ServerMsg) => boolean): Promise<ServerMsg> {
        return new Promise((resolve, reject) => {
            const unsubMessage = onMessage((m) => {
                if (predicate(m)) {
                    unsubMessage();
                    unsubDisconnect();
                    resolve(m);
                }
            });
            const unsubDisconnect = onDisconnect(() => {
                unsubMessage();
                unsubDisconnect();
                reject(new Error("hub_unreachable"));
            });
        });
    }

    function close(): void {
        handleDisconnect();
        try {
            socket.end();
        } catch {}
    }

    return {
        onDisconnect,
        send,
        sendRequest,
        onMessage,
        nextMessage,
        close,
    };
}
