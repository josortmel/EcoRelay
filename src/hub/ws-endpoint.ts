import type { Server, ServerWebSocket } from "bun";
import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import type * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { makeLogger } from "../logger";
import type { ServerMsg } from "../protocol";
import type { PeerRegistry } from "./registry";

const log = makeLogger("hub:ws");

export interface SocketLike {
    writable: boolean;
    destroyed: boolean;
    remoteAddress: string;
    write(data: string): boolean;
    end(): void;
    destroy(): void;
    on(event: string, listener: (...args: unknown[]) => void): this;
    emit(event: string, ...args: unknown[]): boolean;
}

/** The part of a WebSocket that VirtualSocket uses: Bun's ServerWebSocket, or a test fake. */
export interface WsLike {
    send(data: string): unknown;
    close(code?: number, reason?: string): void;
}

/** Per-connection state, kept in Bun's `ws.data` instead of ad-hoc properties on the socket. */
interface WsData {
    vs?: VirtualSocket;
    authTimer?: ReturnType<typeof setTimeout>;
}

export class VirtualSocket extends EventEmitter implements SocketLike {
    writable = true;
    destroyed = false;
    remoteAddress = "127.0.0.1";

    private ws: WsLike;

    constructor(ws: WsLike) {
        super();
        this.ws = ws;
    }

    write(data: string): boolean {
        if (this.destroyed || !this.writable) return false;
        try {
            this.ws.send(data);
            return true;
        } catch {
            return false;
        }
    }

    end(): void {
        this.writable = false;
        try {
            this.ws.close();
        } catch {
            // WS already closing
        }
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.writable = false;
        try {
            this.ws.close();
        } catch {
            // WS already closing
        }
        this.emit("close");
    }
}

export type WsHandler = (line: string, socket: SocketLike, send: (msg: ServerMsg) => void) => void;

function loadOrCreateToken(): string {
    const envToken = process.env.ECORELAY_WS_TOKEN;
    if (envToken) return envToken;

    const tokenPath = path.join(os.homedir(), ".eco-relay", "hub-ws-token");

    function generate(): string {
        const token = crypto.randomBytes(32).toString("hex");
        const dir = path.dirname(tokenPath);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(tokenPath, token, { mode: 0o600 });
        log.info("ws_token_generated", { path: tokenPath });
        return token;
    }

    try {
        const existing = fs.readFileSync(tokenPath, "utf8").trim();
        if (existing.length < 16) {
            log.warn("ws_token_too_short", { path: tokenPath, len: existing.length });
            return generate();
        }
        return existing;
    } catch {
        return generate();
    }
}

export function addWsEndpoint(
    registry: PeerRegistry,
    handleLine: WsHandler,
    opts: { port: number; onDisconnect?: (name: string) => void },
): { close: () => Promise<void> } {
    const token = loadOrCreateToken();
    const tokenBuf = Buffer.from(token);

    const wsServer = Bun.serve<WsData>({
        port: opts.port,
        hostname: "127.0.0.1",
        websocket: {
            maxPayloadLength: 1_048_576, // 1 MiB
            open(ws: ServerWebSocket<WsData>): void {
                const vs = new VirtualSocket(ws);
                ws.data.vs = vs;

                const authTimer = setTimeout(() => {
                    log.warn("ws_auth_timeout");
                    try {
                        ws.close(4003, "auth_timeout");
                    } catch {
                        // ignore
                    }
                }, 5000);
                ws.data.authTimer = authTimer;
            },
            message(ws: ServerWebSocket<WsData>, data: string | Buffer): void {
                const vs = ws.data.vs;
                if (!vs || vs.destroyed) return;

                const raw = typeof data === "string" ? data : data.toString();
                const authTimer = ws.data.authTimer;

                if (authTimer) {
                    // F1-VS4: auth payload size validation
                    if (raw.length > 1024) {
                        log.warn("ws_auth_oversize", { len: raw.length });
                        try {
                            ws.close(4003, "auth_failed");
                        } catch {
                            // ignore
                        }
                        return;
                    }
                    let parsed: unknown;
                    try {
                        parsed = JSON.parse(raw);
                    } catch {
                        log.warn("ws_auth_malformed");
                        try {
                            ws.close(4003, "auth_failed");
                        } catch {
                            // ignore
                        }
                        return;
                    }
                    // Valid JSON is not necessarily an object: `null`, `3` or `"x"` have no .auth.
                    const auth =
                        typeof parsed === "object" && parsed !== null
                            ? (parsed as { auth?: unknown }).auth
                            : undefined;
                    if (typeof auth !== "string") {
                        log.warn("ws_auth_missing_field");
                        try {
                            ws.close(4003, "auth_failed");
                        } catch {
                            // ignore
                        }
                        return;
                    }
                    const receivedBuf = Buffer.from(auth);
                    if (
                        receivedBuf.length !== tokenBuf.length ||
                        !crypto.timingSafeEqual(receivedBuf, tokenBuf)
                    ) {
                        log.warn("ws_auth_bad_token");
                        try {
                            ws.close(4003, "auth_failed");
                        } catch {
                            // ignore
                        }
                        return;
                    }
                    clearTimeout(authTimer);
                    ws.data.authTimer = undefined;
                    log.info("ws_auth_ok");
                    return;
                }

                // F1-VS1: message size guard (already capped by maxPayloadLength,
                // but guard against multi-line accumulation bypass)
                if (raw.length > 1_048_576) {
                    log.warn("ws_msg_oversize", { len: raw.length });
                    return;
                }

                const send = (msg: ServerMsg): void => {
                    vs.write(JSON.stringify(msg) + "\n");
                };

                const lines = raw.split("\n");
                for (const line of lines) {
                    if (!line) continue;
                    handleLine(line, vs, send);
                }
            },
            close(ws: ServerWebSocket<WsData>): void {
                const { vs, authTimer } = ws.data;
                if (authTimer) clearTimeout(authTimer);

                if (vs) {
                    const name = registry.removeBySocket(vs as unknown as net.Socket);
                    vs.destroy();
                    if (name && opts.onDisconnect) {
                        opts.onDisconnect(name);
                    }
                }
            },
        },
        fetch(req: Request, server: Server<WsData>): Response | undefined {
            if (server.upgrade(req, { data: {} })) return;
            return new Response("EcoRelay WS endpoint", { status: 426 });
        },
    });

    log.info("ws_listen_start", {
        port: opts.port,
        hostname: "127.0.0.1",
    });

    return {
        close: async (): Promise<void> => {
            wsServer.stop();
            log.info("ws_listen_stop");
        },
    };
}
