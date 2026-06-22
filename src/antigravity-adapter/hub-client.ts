import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeLogger } from "../logger";
import { savePeerId, suffixedName } from "./identity";

const log = makeLogger("antigravity-hub");

const PROTOCOL_VERSION = "5";
const HUB_WS_URL = process.env.ECORELAY_WS_URL ?? "ws://127.0.0.1:19736";
const MAX_RECONNECT_ATTEMPTS = 50;
const INITIAL_RECONNECT_MS = 3_000;
const MAX_RECONNECT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_SENDERS = 200;
const MAX_BROADCAST_RECEIPTS = 200;

// ── Types ─────────────────────────────────────────────────────────

export type HubIncomingMessage = {
    type: string;
    from?: string;
    text?: string;
    question?: string;
    msg_id?: string;
    ask_id?: string;
    broadcast_id?: string;
    room?: string;
    group?: string;
    ts?: string;
    urgent?: boolean;
    reply_to?: string | null;
    peer_count?: number;
};

type PendingRequest = {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
};

export type HubClientOptions = {
    peerName: string;
    cwd: string;
    gitBranch: string;
    onMessage?: (msg: HubIncomingMessage) => void;
};

// ── Auth ──────────────────────────────────────────────────────────

export function getAuthToken(): string {
    const envToken = process.env.ECORELAY_WS_TOKEN;
    if (envToken) return envToken;
    const tokenPath = path.join(os.homedir(), ".eco-relay", "hub-ws-token");
    try {
        return fs.readFileSync(tokenPath, "utf8").trim();
    } catch {
        throw new Error(
            `EcoRelay WS token not found at ${tokenPath} — start the Hub first to generate it, or set ECORELAY_WS_TOKEN.`,
        );
    }
}

// ── HubClient (connect-only: never spawns the Hub daemon) ─────────
// The Antigravity adapter is a pure client. Unlike the Codex adapter it
// does NOT auto-spawn the Hub: a spawn here (allowlist env without
// CLAUDE_PLUGIN_DATA) would create a divergent data-dir island. If the
// Hub is down we just log + reconnect; some other CLI (CC/OC) owns it.

export class HubClient {
    private ws: WebSocket | null = null;
    private registered = false;
    private closed = false;
    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reqIdCounter = 0;
    private readonly pending = new Map<string, PendingRequest>();
    readonly messageSenders = new Map<string, string>();
    readonly broadcastReceipts = new Map<string, string>();
    private peerName: string;
    private readonly cwd: string;
    private readonly gitBranch: string;
    private readonly onMessage: ((msg: HubIncomingMessage) => void) | undefined;

    constructor(opts: HubClientOptions) {
        this.peerName = opts.peerName;
        this.cwd = opts.cwd;
        this.gitBranch = opts.gitBranch;
        this.onMessage = opts.onMessage;
    }

    get name(): string {
        return this.peerName;
    }

    get isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.registered;
    }

    // ── Connect + register ────────────────────────────────────────

    async connect(): Promise<void> {
        if (this.closed) return;
        if (
            this.ws &&
            (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
        ) {
            return;
        }

        const token = getAuthToken();

        const ws = new WebSocket(HUB_WS_URL);
        this.ws = ws;
        this.registered = false;

        let nameRetries = 0;

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("register ack timeout"));
            }, 10_000);

            const sendRegister = (name: string): void => {
                ws.send(JSON.stringify({ auth: token }));
                ws.send(
                    JSON.stringify({
                        type: "register",
                        name,
                        cwd: this.cwd,
                        git_branch: this.gitBranch,
                        protocol_version: PROTOCOL_VERSION,
                    }),
                );
            };

            ws.onopen = () => {
                sendRegister(this.peerName);
            };

            ws.onmessage = (event: MessageEvent) => {
                let msg: Record<string, unknown>;
                try {
                    msg = JSON.parse(String(event.data));
                } catch {
                    return;
                }

                if (msg.type === "err") {
                    const code = msg.code as string;
                    if (code === "bad_args" || code === "protocol_mismatch") {
                        clearTimeout(timeout);
                        this.closed = true;
                        try {
                            ws.close();
                        } catch {
                            /* ignore */
                        }
                        reject(new Error(code));
                        return;
                    }
                    if (code === "name_taken") {
                        if (nameRetries < 10) {
                            nameRetries += 1;
                            this.peerName = suffixedName(this.peerName, nameRetries);
                            sendRegister(this.peerName);
                            return;
                        }
                        clearTimeout(timeout);
                        this.closed = true;
                        reject(new Error("name_taken_exhausted"));
                        return;
                    }
                    return;
                }

                if (msg.type === "ack") {
                    clearTimeout(timeout);
                    this.registered = true;
                    this.reconnectAttempts = 0;
                    savePeerId(this.cwd, this.peerName);
                    ws.onmessage = (ev: MessageEvent) => {
                        this.handleWsMessage(String(ev.data));
                    };
                    log.info("registered", { name: this.peerName });
                    resolve();
                }
            };

            ws.onclose = () => {
                clearTimeout(timeout);
                if (!this.registered) {
                    reject(new Error("WS closed before ack"));
                } else {
                    for (const [, entry] of this.pending) {
                        clearTimeout(entry.timer);
                        try {
                            entry.reject(new Error("connection lost"));
                        } catch {
                            /* ignore */
                        }
                    }
                    this.pending.clear();
                    this.scheduleReconnect();
                }
                this.ws = null;
                this.registered = false;
            };

            ws.onerror = () => {
                clearTimeout(timeout);
                reject(new Error("WS connection error"));
            };
        });
    }

    // ── WS message routing ────────────────────────────────────────

    private handleWsMessage(raw: string): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            log.warn("malformed_json_frame");
            return;
        }

        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
        const msg = parsed as Record<string, unknown>;

        const reqId = msg.req_id as string | undefined;
        if (reqId && this.pending.has(reqId)) {
            const p = this.pending.get(reqId);
            if (!p) return;
            clearTimeout(p.timer);
            this.pending.delete(reqId);
            if (msg.type === "err") {
                p.reject(msg);
            } else {
                p.resolve(msg);
            }
            return;
        }

        if (msg.type === "ping") {
            try {
                this.ws?.send(JSON.stringify({ type: "pong", req_id: msg.req_id }));
            } catch {
                /* ignore */
            }
            return;
        }

        const msgId = msg.msg_id as string | undefined;
        const from = msg.from as string | undefined;
        if (msgId && from) this.addMessageSender(msgId, from);

        const askId = msg.ask_id as string | undefined;
        if (askId && from) this.addMessageSender(askId, from);

        if (msg.type === "broadcast_ack" && msg.broadcast_id) {
            const bcastId = String(msg.broadcast_id);
            if (
                !this.broadcastReceipts.has(bcastId) &&
                this.broadcastReceipts.size >= MAX_BROADCAST_RECEIPTS
            ) {
                const oldest = this.broadcastReceipts.keys().next().value;
                if (oldest !== undefined) this.broadcastReceipts.delete(oldest);
            }
            this.broadcastReceipts.set(String(msg.broadcast_id), `ack:${msg.peer_count ?? 0}`);
        }

        const pushTypes = new Set([
            "incoming_message",
            "incoming_ask",
            "incoming_reply",
            "incoming_room_msg",
            "incoming_group_msg",
            "broadcast_ack",
            "send_ack",
            "inbox_result",
            "peers",
            "room_ack",
            "room_send_ack",
            "rooms_list",
            "group_created",
            "group_ack",
            "group_messages",
            "group_list_result",
            "group_info_result",
        ]);

        if (pushTypes.has(msg.type as string) && this.onMessage) {
            this.onMessage(msg as unknown as HubIncomingMessage);
        }
    }

    private addMessageSender(key: string, value: string): void {
        if (this.messageSenders.size >= MAX_MESSAGE_SENDERS) {
            const oldest = this.messageSenders.keys().next().value;
            if (oldest !== undefined) this.messageSenders.delete(oldest);
        }
        this.messageSenders.set(key, value);
    }

    // ── sendAndWait ───────────────────────────────────────────────

    sendAndWait(payload: Record<string, unknown>): Promise<unknown> {
        const id = `agy-${++this.reqIdCounter}-${Date.now()}`;
        payload.req_id = id;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`hub request timeout (id=${id})`));
            }, REQUEST_TIMEOUT_MS);

            this.pending.set(id, { resolve, reject, timer });

            try {
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                    throw new Error("hub ws not connected");
                }
                this.ws.send(JSON.stringify(payload));
            } catch (e) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(e);
            }
        });
    }

    fireSend(payload: Record<string, unknown>): void {
        try {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            this.ws.send(JSON.stringify(payload));
        } catch {
            /* ignore */
        }
    }

    // ── Reconnect ─────────────────────────────────────────────────

    startReconnect(): void {
        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (this.closed) return;
        if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            log.error("max_reconnect_attempts", { max: MAX_RECONNECT_ATTEMPTS });
            return;
        }
        const delay = Math.min(
            INITIAL_RECONNECT_MS * Math.pow(2, this.reconnectAttempts),
            MAX_RECONNECT_MS,
        );
        this.reconnectAttempts++;
        log.info("reconnect_scheduled", { attempt: this.reconnectAttempts, delay_ms: delay });
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect().catch(() => {
                this.scheduleReconnect();
            });
        }, delay);
    }

    // ── Cleanup ───────────────────────────────────────────────────

    close(): void {
        this.closed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            try {
                entry.reject(new Error("client closed"));
            } catch {
                /* ignore */
            }
        }
        this.pending.clear();
        this.messageSenders.clear();
        this.broadcastReceipts.clear();
        if (this.ws) {
            try {
                this.ws.close();
            } catch {
                /* ignore */
            }
            this.ws = null;
        }
    }

    // ── Test helpers ──────────────────────────────────────────────

    _setWsForTest(ws: WebSocket): void {
        this.ws = ws;
        this.registered = true;
        this.ws.onmessage = (ev: MessageEvent) => {
            this.handleWsMessage(String(ev.data));
        };
    }

    _getPeerName(): string {
        return this.peerName;
    }

    _setPeerName(name: string): void {
        this.peerName = name;
    }
}
