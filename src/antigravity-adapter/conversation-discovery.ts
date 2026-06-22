import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeLogger } from "../logger";

const log = makeLogger("antigravity-discovery");

const AGY_DATA_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli");
const LOG_DIR = path.join(AGY_DATA_DIR, "log");
const LAST_CONVERSATIONS = path.join(AGY_DATA_DIR, "cache", "last_conversations.json");

const POLL_INTERVAL_MS = 5_000;

// ── LS address discovery ──────────────────────────────────────────
// Preferred: ANTIGRAVITY_LS_ADDRESS env (set by agy when it launches a
// sidecar/MCP child). Fallback: parse the newest CLI log for the HTTP
// port the language server bound to. We use the HTTP port (NOT the gRPC
// port): agentapi speaks HTTP/2 there; the pure-gRPC port rejects with
// a TLS/preface error.

export function lsAddressFromEnv(): string | null {
    const env = process.env.ANTIGRAVITY_LS_ADDRESS;
    return env && env.length > 0 ? env : null;
}

function newestLog(): string | null {
    try {
        const files = fs
            .readdirSync(LOG_DIR)
            .filter((f) => f.startsWith("cli-") && f.endsWith(".log"))
            .map((f) => path.join(LOG_DIR, f));
        if (files.length === 0) return null;
        files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        return files[0] ?? null;
    } catch {
        return null;
    }
}

export function lsHttpPortFromLog(): number | null {
    const file = newestLog();
    if (!file) return null;
    try {
        const text = fs.readFileSync(file, "utf8");
        // "Language server listening on random port at 11564 for HTTP"
        const matches = [...text.matchAll(/listening on random port at (\d+) for HTTP/g)];
        const last = matches[matches.length - 1];
        if (last?.[1]) return Number(last[1]);
    } catch {
        /* ignore */
    }
    return null;
}

const UUID_RE_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// The newest CLI log belongs to the current agy session; the most recent
// "conversation <uuid>" reference is the conversation the user is actually in.
// This is authoritative for the LIVE session — last_conversations.json lags
// (only updated on save/switch) and can point at a stale conversation.
export function activeConversationFromLog(): string | null {
    const file = newestLog();
    if (!file) return null;
    try {
        const text = fs.readFileSync(file, "utf8");
        const matches = [...text.matchAll(new RegExp(`conversation (${UUID_RE_SRC})`, "g"))];
        const last = matches[matches.length - 1];
        return last?.[1] ?? null;
    } catch {
        return null;
    }
}

// ── Active conversation discovery ─────────────────────────────────
// agy records the last conversation per workspace in last_conversations.json.
// Shape is not guaranteed stable, so parse defensively.

function normalizeCwd(p: string): string {
    let s = p;
    try {
        s = decodeURIComponent(s);
    } catch {
        /* not URI-encoded */
    }
    return s
        .replace(/^file:\/\/\/?/i, "")
        .replace(/\\/g, "/")
        .replace(/\/+$/, "")
        .toLowerCase();
}

// Path-boundary containment: same path, or one is a real subdirectory of
// the other. Avoids the false-positive suffix matches of endsWith.
function sameOrWithin(a: string, b: string): boolean {
    return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

async function healthOk(address: string): Promise<boolean> {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const res = await fetch(`http://${address}/healthz`, { signal: ctrl.signal });
        clearTimeout(t);
        return res.ok;
    } catch {
        return false;
    }
}

function uuidLike(v: unknown): v is string {
    return typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
}

function extractConvId(value: unknown): string | null {
    if (uuidLike(value)) return value;
    if (value && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        for (const k of ["conversationId", "conversation_id", "id", "rootConversationId"]) {
            if (uuidLike(obj[k])) return obj[k] as string;
        }
    }
    return null;
}

export function conversationIdForCwd(cwd: string): string | null {
    // env override first (in case agy exposes it to children)
    for (const k of ["ANTIGRAVITY_CONVERSATION_ID", "ECORELAY_AGY_CONVERSATION_ID"]) {
        const v = process.env[k];
        if (uuidLike(v)) return v as string;
    }

    // Live session log is authoritative for the ACTIVE conversation.
    const fromLog = activeConversationFromLog();
    if (fromLog) return fromLog;

    // last_conversations.json is HISTORICAL cache, NOT authoritative for the live
    // session: after a relaunch it points at a dead conversation, and injecting
    // there succeeds at the API level (exit 0) but is invisible in the live TUI.
    // Never use it for push by default — a temporary false-negative (buffer until
    // the live conversation is logged) is safer than an invisible stale inject.
    if (process.env.ECORELAY_AGY_ALLOW_STALE_CONVERSATION_FALLBACK !== "1") {
        return null;
    }

    let data: unknown;
    try {
        data = JSON.parse(fs.readFileSync(LAST_CONVERSATIONS, "utf8"));
    } catch {
        return null;
    }
    if (!data || typeof data !== "object") return null;

    const target = normalizeCwd(cwd);
    const entries = Array.isArray(data) ? data : Object.entries(data as Record<string, unknown>);

    // Object map keyed by workspace path/URI → value
    if (!Array.isArray(data)) {
        for (const [key, value] of entries as Array<[string, unknown]>) {
            const k = normalizeCwd(key.replace(/^file:\/\/\/?/, ""));
            if (sameOrWithin(k, target)) {
                const id = extractConvId(value);
                if (id) return id;
            }
        }
    } else {
        // Array of records
        for (const rec of data as unknown[]) {
            if (!rec || typeof rec !== "object") continue;
            const obj = rec as Record<string, unknown>;
            const ws =
                obj.workspace ?? obj.cwd ?? obj.workspaceUri ?? obj.workspaceFolderAbsoluteUri;
            if (typeof ws === "string") {
                const k = normalizeCwd(ws.replace(/^file:\/\/\/?/, ""));
                if (sameOrWithin(k, target)) {
                    const id = extractConvId(obj);
                    if (id) return id;
                }
            }
        }
    }

    // Last resort: if there is exactly one conversation recorded, use it.
    if (!Array.isArray(data)) {
        const vals = Object.values(data as Record<string, unknown>);
        if (vals.length === 1) {
            const id = extractConvId(vals[0]);
            if (id) return id;
        }
    }
    return null;
}

// ── ConversationDiscovery: minimal tracker (replaces ThreadTracker) ─

export type ConversationDiscoveryOptions = {
    cwd: string;
    onConversationAvailable?: () => void;
    pollIntervalMs?: number;
};

export class ConversationDiscovery {
    private readonly cwd: string;
    private readonly onAvailable: (() => void) | undefined;
    private readonly pollIntervalMs: number;
    private conversationId: string | null = null;
    private lsAddress: string | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private closed = false;

    constructor(opts: ConversationDiscoveryOptions) {
        this.cwd = opts.cwd;
        this.onAvailable = opts.onConversationAvailable;
        this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    }

    start(): void {
        this.refresh();
        this.timer = setInterval(() => this.refresh(), this.pollIntervalMs);
    }

    refresh(): void {
        if (this.closed) return;
        void this.refreshAsync();
    }

    private async refreshAsync(): Promise<void> {
        if (this.closed) return;
        const prevReady = !!(this.conversationId && this.lsAddress);

        // LS address: env (sidecar, trusted) wins; otherwise the log-derived
        // candidate is validated by probing /healthz before we trust it, so a
        // stale log or a second agy session can't make us inject into the
        // wrong conversation.
        const fromEnv = lsAddressFromEnv();
        if (fromEnv) {
            this.lsAddress = fromEnv;
        } else {
            const port = lsHttpPortFromLog();
            const candidate = port ? `127.0.0.1:${port}` : null;
            this.lsAddress = candidate && (await healthOk(candidate)) ? candidate : null;
        }

        const conv = conversationIdForCwd(this.cwd);
        if (conv) this.conversationId = conv;

        if (this.conversationId && this.lsAddress && !prevReady) {
            log.info("conversation_discovered", {
                conversationId: this.conversationId,
                lsAddress: this.lsAddress,
            });
            if (this.onAvailable) this.onAvailable();
        }
    }

    getConversationId(): string | null {
        return this.conversationId;
    }

    getLsAddress(): string | null {
        return this.lsAddress;
    }

    close(): void {
        this.closed = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
