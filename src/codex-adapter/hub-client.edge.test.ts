// Verifier edge cases — T3 hub-client.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    HubClient,
    validateBunPath,
    _resetHubSpawnedForTest,
    type HubIncomingMessage,
} from "./hub-client";
import { _resetForTest as resetIdentity } from "./identity";

// ── WebSocket handshake mock ──────────────────────────────────────
// We intercept globalThis.WebSocket to test connect() handshake path

type WsHandler = (event: MessageEvent) => void;
type OpenHandler = () => void;
type CloseHandler = () => void;
type ErrorHandler = () => void;

class HandshakeMockWS {
    static readonly OPEN = 1;
    static readonly CONNECTING = 0;
    static readonly CLOSED = 3;

    readyState: number = HandshakeMockWS.CONNECTING;
    onopen: OpenHandler | null = null;
    onmessage: WsHandler | null = null;
    onclose: CloseHandler | null = null;
    onerror: ErrorHandler | null = null;
    sent: string[] = [];
    private _closed = false;

    send(data: string): void {
        this.sent.push(data);
    }

    close(): void {
        this._closed = true;
        this.readyState = HandshakeMockWS.CLOSED;
    }

    triggerOpen(): void {
        this.readyState = HandshakeMockWS.OPEN;
        this.onopen?.();
    }

    triggerMessage(data: unknown): void {
        const event = { data: JSON.stringify(data) } as MessageEvent;
        this.onmessage?.(event);
    }

    triggerClose(): void {
        this.readyState = HandshakeMockWS.CLOSED;
        this.onclose?.();
    }

    triggerError(): void {
        this.onerror?.();
    }

    sentAt(i: number): Record<string, unknown> {
        return JSON.parse(this.sent[i]!) as Record<string, unknown>;
    }

    get wasClosed(): boolean { return this._closed; }
}

let capturedWs: HandshakeMockWS | null = null;
const OriginalWebSocket = globalThis.WebSocket;

function installMockWs(): HandshakeMockWS {
    const ws = new HandshakeMockWS();
    capturedWs = ws;
    (globalThis as unknown as Record<string, unknown>).WebSocket = class {
        static readonly OPEN = HandshakeMockWS.OPEN;
        static readonly CONNECTING = HandshakeMockWS.CONNECTING;
        static readonly CLOSED = HandshakeMockWS.CLOSED;
        constructor() { return ws; }
    };
    return ws;
}

function restoreWs(): void {
    (globalThis as unknown as Record<string, unknown>).WebSocket = OriginalWebSocket;
    capturedWs = null;
}

// Make auth token available for handshake tests
const TOKEN_DIR = path.join(os.homedir(), ".eco-relay");
const TOKEN_FILE = path.join(TOKEN_DIR, "hub-ws-token");
const ORIG_TOKEN_ENV = process.env.ECORELAY_WS_TOKEN;

function setTestToken(token: string): void {
    process.env.ECORELAY_WS_TOKEN = token;
}

function clearTestToken(): void {
    if (ORIG_TOKEN_ENV === undefined) {
        delete process.env.ECORELAY_WS_TOKEN;
    } else {
        process.env.ECORELAY_WS_TOKEN = ORIG_TOKEN_ENV;
    }
}

// ── MockWS for already-connected tests ────────────────────────────

class MockWS {
    static readonly OPEN = 1;
    static readonly CONNECTING = 0;
    static readonly CLOSED = 3;
    readyState = MockWS.OPEN;
    onmessage: ((e: { data: string }) => void) | null = null;
    sent: string[] = [];
    send(data: string): void {
        if (this.readyState !== MockWS.OPEN) throw new Error("not open");
        this.sent.push(data);
    }
    close(): void { this.readyState = MockWS.CLOSED; }
    simulateMessage(data: unknown): void {
        this.onmessage?.({ data: JSON.stringify(data) });
    }
    simulateRaw(raw: string): void {
        this.onmessage?.({ data: raw });
    }
    get lastSentParsed(): Record<string, unknown> | null {
        return this.sent.length === 0 ? null : JSON.parse(this.sent[this.sent.length - 1]!) as Record<string, unknown>;
    }
}

function makeClient(onMsg?: (msg: HubIncomingMessage) => void): { client: HubClient; ws: MockWS; messages: HubIncomingMessage[] } {
    const messages: HubIncomingMessage[] = [];
    const client = new HubClient({ peerName: "codex-test", cwd: "/project", gitBranch: "main", onMessage: onMsg ?? ((m) => messages.push(m)) });
    const ws = new MockWS();
    client._setWsForTest(ws as unknown as WebSocket);
    return { client, ws, messages };
}

beforeEach(() => {
    resetIdentity();
    _resetHubSpawnedForTest();
    setTestToken("test-token-xyz");
});

afterEach(() => {
    restoreWs();
    clearTestToken();
    resetIdentity();
    _resetHubSpawnedForTest();
});

// ── PLAN GAP: handshake ───────────────────────────────────────────

describe("Verifier: handshake (plan gap)", () => {
    test("AT1: connect sends {auth} then {type:register} on open", async () => {
        const ws = installMockWs();
        const client = new HubClient({ peerName: "codex-myrepo", cwd: "/proj", gitBranch: "main" });

        const connectPromise = client.connect();
        ws.triggerOpen();
        // Should have sent auth + register
        expect(ws.sent).toHaveLength(2);
        expect(ws.sentAt(0)).toEqual({ auth: "test-token-xyz" });
        const reg = ws.sentAt(1);
        expect(reg.type).toBe("register");
        expect(reg.name).toBe("codex-myrepo");
        expect(reg.protocol_version).toBe("5");
        expect(reg.cwd).toBe("/proj");

        // Resolve handshake
        ws.triggerMessage({ type: "ack" });
        await connectPromise;
        expect(client.isConnected).toBe(true);
    });

    test("AT2: ack saves peer id (calls savePeerId)", async () => {
        const ws = installMockWs();
        const client = new HubClient({ peerName: "codex-save-test", cwd: "/save-proj", gitBranch: "main" });

        const connectPromise = client.connect();
        ws.triggerOpen();
        ws.triggerMessage({ type: "ack" });
        await connectPromise;

        // Check that the peer id was saved — reload from cache
        const { loadPeerId } = await import("./identity");
        const cached = loadPeerId("/save-proj");
        expect(cached).toBe("codex-save-test");
    });

    test("AT3: name_taken retries up to 10x with suffixedName", async () => {
        const ws = installMockWs();
        const client = new HubClient({ peerName: "codex-taken", cwd: "/proj", gitBranch: "main" });

        const connectPromise = client.connect();
        ws.triggerOpen();

        // Fire 10 name_taken responses
        for (let i = 0; i < 10; i++) {
            ws.triggerMessage({ type: "err", code: "name_taken" });
        }
        // On 11th attempt (10 retries exhausted), ack to resolve
        ws.triggerMessage({ type: "ack" });
        await connectPromise;

        // Should have sent: auth + register, then 10 more retry pairs (auth+register each time)
        // Actually looking at the code: sendRegister sends auth + register each retry
        // 1 initial + 10 retries = 11 pairs = 22 messages
        expect(ws.sent.length).toBe(22); // (auth+register) x 11

        // Final name should be suffixed
        const finalName = client._getPeerName();
        expect(finalName).not.toBe("codex-taken"); // should have been suffixed
    });

    test("AT4: name_taken 11x → name_taken_exhausted (no more retries)", async () => {
        const ws = installMockWs();
        const client = new HubClient({ peerName: "codex-busy", cwd: "/proj", gitBranch: "main" });

        const connectPromise = client.connect();
        ws.triggerOpen();

        // Fire 11 name_taken — first 10 retry, 11th exhausts
        for (let i = 0; i < 11; i++) {
            ws.triggerMessage({ type: "err", code: "name_taken" });
        }

        await expect(connectPromise).rejects.toThrow("name_taken_exhausted");
    });

    test("AT5: bad_args error closes immediately, rejects with 'bad_args'", async () => {
        const ws = installMockWs();
        const client = new HubClient({ peerName: "codex-x", cwd: "/proj", gitBranch: "main" });

        const connectPromise = client.connect();
        ws.triggerOpen();
        ws.triggerMessage({ type: "err", code: "bad_args" });

        await expect(connectPromise).rejects.toThrow("bad_args");
        expect(ws.wasClosed).toBe(true);
    });

    test("AT6: protocol_mismatch closes immediately, rejects", async () => {
        const ws = installMockWs();
        const client = new HubClient({ peerName: "codex-x", cwd: "/proj", gitBranch: "main" });

        const connectPromise = client.connect();
        ws.triggerOpen();
        ws.triggerMessage({ type: "err", code: "protocol_mismatch" });

        await expect(connectPromise).rejects.toThrow("protocol_mismatch");
    });

    test("AT7: ws closed before ack → rejects with 'WS closed before ack'", async () => {
        const ws = installMockWs();
        const client = new HubClient({ peerName: "codex-x", cwd: "/proj", gitBranch: "main" });

        const connectPromise = client.connect();
        ws.triggerOpen();
        ws.triggerClose(); // close before ack

        await expect(connectPromise).rejects.toThrow("WS closed before ack");
    });
});

// ── validateBunPath edge cases ────────────────────────────────────

describe("Verifier: validateBunPath edge cases", () => {
    test("AT8: 'evil.exe' at temp path → null (wrong basename)", () => {
        const evil = path.join(os.tmpdir(), `evil-${Date.now()}.exe`);
        fs.writeFileSync(evil, "fake");
        expect(validateBunPath(evil)).toBeNull();
        fs.unlinkSync(evil);
    });

    test("AT9: 'bun.exe.malicious' → null (wrong basename)", () => {
        const fake = path.join(os.tmpdir(), `bun.exe.malicious-${Date.now()}`);
        fs.writeFileSync(fake, "fake");
        expect(validateBunPath(fake)).toBeNull();
        fs.unlinkSync(fake);
    });

    test("AT10: empty string path → null", () => {
        expect(validateBunPath("")).toBeNull();
    });
});

// ── broadcastReceipts unbounded growth ────────────────────────────

describe("Verifier: broadcastReceipts unbounded growth", () => {
    test("AT11: broadcastReceipts capped at 200 (OBS2 fixed — now has eviction)", () => {
        const { client, ws } = makeClient();
        for (let i = 0; i < 300; i++) {
            ws.simulateMessage({ type: "broadcast_ack", broadcast_id: `bcast-${i}`, peer_count: i });
        }
        // After fix: MAX_BROADCAST_RECEIPTS = 200 eviction cap added
        expect(client.broadcastReceipts.size).toBe(200);
    });
});

// ── Malformed frame handling ──────────────────────────────────────

describe("Verifier: malformed frames after connect", () => {
    test("AT12: malformed JSON in handleWsMessage silently ignored", () => {
        const { ws, messages } = makeClient();
        ws.simulateRaw("{broken JSON!!!");
        expect(messages).toHaveLength(0);
    });

    test("AT13: null JSON frame → silently ignored (BUG1 fixed: null guard added)", () => {
        const { ws, messages } = makeClient();
        // JSON.parse("null") = null (valid JSON). After fix: guard `parsed === null` returns early.
        // Previously crashed with TypeError; now silently discarded.
        expect(() => ws.simulateRaw("null")).not.toThrow();
        expect(messages).toHaveLength(0);
    });

    test("AT14: req_id response for unknown pending id ignored", async () => {
        const { client, ws } = makeClient();
        const p = client.sendAndWait({ type: "list_peers" });
        // Send a response for a req_id that doesn't exist in pending
        ws.simulateMessage({ type: "peers", peers: [], req_id: "99999" });
        // Real request still pending — resolve it
        const realId = ws.lastSentParsed!.req_id as string;
        ws.simulateMessage({ type: "peers", peers: [], req_id: realId });
        const result = await p;
        expect((result as { type: string }).type).toBe("peers");
    });
});

// ── Ring eviction boundary ────────────────────────────────────────

describe("Verifier: messageSenders ring boundary", () => {
    test("AT15: exactly 200 messages → no eviction yet", () => {
        const { client, ws } = makeClient();
        for (let i = 0; i < 200; i++) {
            ws.simulateMessage({ type: "incoming_message", from: `p${i}`, text: "x", msg_id: `m-${i}` });
        }
        expect(client.messageSenders.size).toBe(200);
        expect(client.messageSenders.has("m-0")).toBe(true); // not yet evicted
    });

    test("AT16: 201st message evicts m-0", () => {
        const { client, ws } = makeClient();
        for (let i = 0; i <= 200; i++) {
            ws.simulateMessage({ type: "incoming_message", from: `p${i}`, text: "x", msg_id: `m-${i}` });
        }
        expect(client.messageSenders.size).toBe(200);
        expect(client.messageSenders.has("m-0")).toBe(false);
        expect(client.messageSenders.has("m-200")).toBe(true);
    });
});
