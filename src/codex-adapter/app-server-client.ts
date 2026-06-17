import { makeLogger } from "../logger";

const log = makeLogger("codex-app-server");

const REQUEST_TIMEOUT_MS = 15_000;
const INITIAL_RECONNECT_MS = 3_000;
const MAX_RECONNECT_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 50;

// ── Types ─────────────────────────────────────────────────────────

export type ThreadStatus = { type: "active" | "idle" | string; activeFlags?: string[] };

export type ThreadStatusChangedEvent = {
    threadId: string;
    status: ThreadStatus;
};

export type ThreadInfo = {
    id: string;
    cwd?: string;
    status?: ThreadStatus;
    updatedAt?: number;
    createdAt?: number;
    preview?: string;
    ephemeral?: boolean;
};

export type TurnResult = {
    id: string;
    status: string;
};

export type AppServerNotification = {
    method: string;
    params: Record<string, unknown>;
};

type PendingRequest = {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
};

export type AppServerClientOptions = {
    url: string;
    onNotification?: (notification: AppServerNotification) => void;
    onThreadStatusChanged?: (event: ThreadStatusChangedEvent) => void;
    onClose?: () => void;
};

// ── Client ────────────────────────────────────────────────────────

export class AppServerClient {
    private readonly url: string;
    private ws: WebSocket | null = null;
    private initialized = false;
    private closed = false;
    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reqIdCounter = 0;
    private readonly pending = new Map<number, PendingRequest>();
    private readonly onNotification: ((n: AppServerNotification) => void) | undefined;
    private readonly onThreadStatusChanged:
        | ((e: ThreadStatusChangedEvent) => void)
        | undefined;
    private readonly onCloseCallback: (() => void) | undefined;

    constructor(opts: AppServerClientOptions) {
        this.url = opts.url;
        this.onNotification = opts.onNotification;
        this.onThreadStatusChanged = opts.onThreadStatusChanged;
        this.onCloseCallback = opts.onClose;
    }

    // ── Connection ────────────────────────────────────────────────

    async connect(): Promise<void> {
        if (this.closed) return;
        if (
            this.ws &&
            (this.ws.readyState === WebSocket.OPEN ||
                this.ws.readyState === WebSocket.CONNECTING)
        ) {
            return;
        }

        const ws = new WebSocket(this.url);
        this.ws = ws;
        this.initialized = false;

        let connectSettled = false;

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                connectSettled = true;
                try { ws.close(); } catch { /* ignore */ }
                this.ws = null;
                reject(new Error("app-server connection timeout"));
            }, 10_000);

            ws.onopen = () => {
                if (connectSettled) return;
                clearTimeout(timeout);
                connectSettled = true;
                this.reconnectAttempts = 0;
                this.wireMessages(ws);
                resolve();
            };
            ws.onerror = () => {
                clearTimeout(timeout);
                if (!connectSettled) {
                    connectSettled = true;
                    reject(new Error("app-server WS error"));
                }
            };
            ws.onclose = () => {
                clearTimeout(timeout);
                if (!connectSettled) {
                    connectSettled = true;
                    reject(new Error("app-server WS closed before init"));
                } else {
                    this.handleClose();
                }
            };
        });
    }

    async initialize(): Promise<unknown> {
        const result = await this.sendRequest("initialize", {
            clientInfo: {
                name: "ecorelay-codex-adapter",
                title: "EcoRelay Codex Adapter",
                version: "0.9.0",
            },
            capabilities: {
                experimentalApi: true,
            },
        });
        this.sendNotification("initialized");
        this.initialized = true;
        log.info("initialized", { url: this.url });
        return result;
    }

    // ── Thread operations ─────────────────────────────────────────

    async threadLoadedList(): Promise<{ data: string[]; nextCursor: string | null }> {
        const result = (await this.sendRequest("thread/loaded/list")) as {
            data?: string[];
            nextCursor?: string | null;
        };
        return {
            data: result?.data ?? [],
            nextCursor: result?.nextCursor ?? null,
        };
    }

    async threadRead(threadId: string): Promise<ThreadInfo | null> {
        try {
            const result = (await this.sendRequest("thread/read", { threadId })) as {
                thread?: ThreadInfo;
            };
            return result?.thread ?? null;
        } catch {
            return null;
        }
    }

    async threadResume(threadId: string): Promise<boolean> {
        try {
            await this.sendRequest("thread/resume", { threadId });
            return true;
        } catch (e: unknown) {
            const msg =
                e instanceof Error
                    ? e.message
                    : typeof e === "object" && e !== null && "message" in e
                      ? String((e as { message: unknown }).message)
                      : String(e);
            if (msg.includes("no rollout")) {
                log.info("thread_resume_skip_no_rollout", { threadId });
                return false;
            }
            log.warn("thread_resume_failed", { threadId, err: msg });
            return false;
        }
    }

    // ── Turn operations ───────────────────────────────────────────

    async turnStart(
        threadId: string,
        input: Array<{ type: string; text: string }>,
    ): Promise<TurnResult | null> {
        try {
            const result = (await this.sendRequest("turn/start", {
                threadId,
                input,
            })) as { turn?: TurnResult };
            return result?.turn ?? null;
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            log.error("turn_start_failed", { threadId, err: msg });
            return null;
        }
    }

    // ── State ─────────────────────────────────────────────────────

    get isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.initialized;
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
        if (this.ws) {
            try {
                this.ws.close();
            } catch {
                /* ignore */
            }
            this.ws = null;
        }
    }

    // ── JSON-RPC transport ────────────────────────────────────────

    private nextReqId(): number {
        return ++this.reqIdCounter;
    }

    sendRequest(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
        const id = this.nextReqId();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`timeout: ${method} (id=${id})`));
            }, REQUEST_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            try {
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                    throw new Error("ws not connected");
                }
                this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, id, params }));
            } catch (e) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(e);
            }
        });
    }

    private sendNotification(method: string, params: Record<string, unknown> = {}): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    }

    // ── Message routing ───────────────────────────────────────────

    private wireMessages(ws: WebSocket): void {
        ws.onmessage = (event: MessageEvent) => {
            let msg: unknown;
            try {
                msg = JSON.parse(String(event.data));
            } catch {
                log.warn("malformed_json_frame");
                return;
            }

            if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return;
            const obj = msg as Record<string, unknown>;

            if (obj.id !== undefined && this.pending.has(obj.id as number)) {
                const p = this.pending.get(obj.id as number)!;
                clearTimeout(p.timer);
                this.pending.delete(obj.id as number);
                if (obj.error) {
                    p.reject(obj.error);
                } else {
                    p.resolve(obj.result);
                }
                return;
            }

            if (typeof obj.method === "string") {
                if (
                    obj.method === "thread/status/changed" &&
                    this.onThreadStatusChanged
                ) {
                    const params = obj.params as Record<string, unknown> | undefined;
                    if (
                        params &&
                        typeof params.threadId === "string" &&
                        typeof params.status === "object" &&
                        params.status !== null &&
                        typeof (params.status as Record<string, unknown>).type === "string"
                    ) {
                        this.onThreadStatusChanged(params as unknown as ThreadStatusChangedEvent);
                    }
                }
                if (this.onNotification) {
                    this.onNotification({
                        method: obj.method,
                        params: (obj.params as Record<string, unknown>) ?? {},
                    });
                }
            }
        };
    }

    // ── Reconnect ─────────────────────────────────────────────────

    private handleClose(): void {
        this.ws = null;
        this.initialized = false;
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            try { entry.reject(new Error("connection lost")); } catch { /* ignore */ }
        }
        this.pending.clear();
        this.onCloseCallback?.();

        if (this.closed) return;
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
        log.info("reconnect_scheduled", {
            attempt: this.reconnectAttempts,
            delay_ms: delay,
        });
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect()
                .then(() => this.initialize())
                .catch(() => this.scheduleReconnect());
        }, delay);
    }

    // ── Test helpers ──────────────────────────────────────────────

    /** Exposed for tests only — inject a mock WS */
    _setWsForTest(ws: WebSocket): void {
        this.ws = ws;
        this.wireMessages(ws);
    }

    _setInitializedForTest(): void {
        this.initialized = true;
    }
}
