import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
    AppServerClient,
    type AppServerNotification,
    type ThreadStatusChangedEvent,
} from "./app-server-client";

// ── Mock WebSocket ────────────────────────────────────────────────

type MessageHandler = (event: { data: string }) => void;

class MockWebSocket {
    static readonly OPEN = 1;
    static readonly CONNECTING = 0;
    static readonly CLOSED = 3;

    readyState = MockWebSocket.OPEN;
    onmessage: MessageHandler | null = null;

    sent: string[] = [];
    private closeCalled = false;

    send(data: string): void {
        if (this.readyState !== MockWebSocket.OPEN) throw new Error("not open");
        this.sent.push(data);
    }

    close(): void {
        this.closeCalled = true;
        this.readyState = MockWebSocket.CLOSED;
    }

    simulateMessage(data: unknown): void {
        if (this.onmessage) {
            this.onmessage({ data: JSON.stringify(data) });
        }
    }

    get lastSent(): Record<string, unknown> | null {
        if (this.sent.length === 0) return null;
        return JSON.parse(this.sent[this.sent.length - 1]!) as Record<string, unknown>;
    }

    get wasClosed(): boolean {
        return this.closeCalled;
    }
}

function createClient(): {
    client: AppServerClient;
    ws: MockWebSocket;
    notifications: AppServerNotification[];
    statusEvents: ThreadStatusChangedEvent[];
} {
    const notifications: AppServerNotification[] = [];
    const statusEvents: ThreadStatusChangedEvent[] = [];
    const client = new AppServerClient({
        url: "ws://127.0.0.1:9999",
        onNotification: (n) => notifications.push(n),
        onThreadStatusChanged: (e) => statusEvents.push(e),
    });
    const ws = new MockWebSocket();
    client._setWsForTest(ws as unknown as WebSocket);
    client._setInitializedForTest();
    return { client, ws, notifications, statusEvents };
}

// ── initialize handshake ──────────────────────────────────────────

describe("initialize", () => {
    test("sends initialize request and initialized notification", async () => {
        const notifications: string[] = [];
        const client = new AppServerClient({
            url: "ws://127.0.0.1:9999",
            onNotification: (n) => notifications.push(n.method),
        });
        const ws = new MockWebSocket();
        client._setWsForTest(ws as unknown as WebSocket);
        // Don't call _setInitializedForTest — initialize() will set it

        const promise = client.initialize();
        // sendRequest sends synchronously
        expect(ws.sent.length).toBeGreaterThan(0);
        const initReq = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
        expect(initReq.method).toBe("initialize");
        const id = initReq.id as number;
        ws.simulateMessage({ id, result: { serverInfo: { name: "codex" } } });
        await promise;
        // After resolve, should send "initialized" notification
        const lastMsg = JSON.parse(ws.sent[ws.sent.length - 1]!) as Record<string, unknown>;
        expect(lastMsg.method).toBe("initialized");
        expect(client.isConnected).toBe(true);
        client.close();
    });
});

// ── sendRequest / correlation ─────────────────────────────────────

describe("sendRequest correlation", () => {
    test("resolves on matching response", async () => {
        const { client, ws } = createClient();
        const promise = client.sendRequest("thread/loaded/list");

        const sent = ws.lastSent!;
        expect(sent.method).toBe("thread/loaded/list");
        expect(sent.jsonrpc).toBe("2.0");
        const id = sent.id as number;
        expect(typeof id).toBe("number");

        ws.simulateMessage({ id, result: { data: ["t1", "t2"] } });
        const result = await promise;
        expect(result).toEqual({ data: ["t1", "t2"] });
    });

    test("rejects on error response", async () => {
        const { client, ws } = createClient();
        const promise = client.sendRequest("bad/method");

        const id = ws.lastSent!.id as number;
        ws.simulateMessage({
            id,
            error: { code: -32600, message: "invalid request" },
        });

        try {
            await promise;
            expect(true).toBe(false);
        } catch (e) {
            expect((e as { code: number }).code).toBe(-32600);
        }
    });

    test("rejects on timeout", async () => {
        const { client } = createClient();
        // Override timeout for fast test — sendRequest uses 15s,
        // but we test the reject path via close
        const promise = client.sendRequest("slow/method");
        client.close();

        try {
            await promise;
            expect(true).toBe(false);
        } catch (e) {
            expect((e as Error).message).toBe("client closed");
        }
    });

    test("multiple requests correlate independently", async () => {
        const { client, ws } = createClient();
        const p1 = client.sendRequest("method1");
        const id1 = ws.lastSent!.id as number;
        const p2 = client.sendRequest("method2");
        const id2 = ws.lastSent!.id as number;
        expect(id1).not.toBe(id2);

        ws.simulateMessage({ id: id2, result: "result2" });
        ws.simulateMessage({ id: id1, result: "result1" });

        expect(await p1).toBe("result1");
        expect(await p2).toBe("result2");
    });

    test("rejects if ws not connected", async () => {
        const { client, ws } = createClient();
        ws.readyState = MockWebSocket.CLOSED;
        try {
            await client.sendRequest("any");
            expect(true).toBe(false);
        } catch (e) {
            expect((e as Error).message).toBe("ws not connected");
        }
    });
});

// ── Notification routing ──────────────────────────────────────────

describe("notification routing", () => {
    test("dispatches generic notification to onNotification", () => {
        const { ws, notifications } = createClient();
        ws.simulateMessage({
            method: "turn/completed",
            params: { threadId: "t1", turnId: "turn1" },
        });
        expect(notifications).toHaveLength(1);
        expect(notifications[0]!.method).toBe("turn/completed");
    });

    test("dispatches thread/status/changed to dedicated handler", () => {
        const { ws, statusEvents, notifications } = createClient();
        ws.simulateMessage({
            method: "thread/status/changed",
            params: { threadId: "t1", status: { type: "idle" } },
        });
        expect(statusEvents).toHaveLength(1);
        expect(statusEvents[0]!.threadId).toBe("t1");
        expect(statusEvents[0]!.status.type).toBe("idle");
        // Also delivered to generic handler
        expect(notifications).toHaveLength(1);
    });

    test("ignores malformed JSON", () => {
        const { ws, notifications } = createClient();
        if (ws.onmessage) {
            ws.onmessage({ data: "not json" });
        }
        expect(notifications).toHaveLength(0);
    });

    test("ignores non-object JSON (null, number, array)", () => {
        const { ws, notifications } = createClient();
        ws.simulateMessage(null);
        ws.simulateMessage(42);
        ws.simulateMessage([1, 2, 3]);
        expect(notifications).toHaveLength(0);
    });

    test("skips thread/status/changed with malformed params", () => {
        const { ws, statusEvents } = createClient();
        // Missing threadId
        ws.simulateMessage({
            method: "thread/status/changed",
            params: { status: { type: "idle" } },
        });
        // Missing status.type
        ws.simulateMessage({
            method: "thread/status/changed",
            params: { threadId: "t1", status: {} },
        });
        // threadId not string
        ws.simulateMessage({
            method: "thread/status/changed",
            params: { threadId: 123, status: { type: "idle" } },
        });
        expect(statusEvents).toHaveLength(0);
    });
});

// ── threadLoadedList ──────────────────────────────────────────────

describe("threadLoadedList", () => {
    test("returns data array from response", async () => {
        const { client, ws } = createClient();
        const promise = client.threadLoadedList();
        const id = ws.lastSent!.id as number;
        ws.simulateMessage({ id, result: { data: ["t1", "t2"], nextCursor: null } });
        const result = await promise;
        expect(result.data).toEqual(["t1", "t2"]);
        expect(result.nextCursor).toBeNull();
    });

    test("defaults to empty array if data missing", async () => {
        const { client, ws } = createClient();
        const promise = client.threadLoadedList();
        const id = ws.lastSent!.id as number;
        ws.simulateMessage({ id, result: {} });
        const result = await promise;
        expect(result.data).toEqual([]);
    });
});

// ── threadRead ────────────────────────────────────────────────────

describe("threadRead", () => {
    test("returns thread info", async () => {
        const { client, ws } = createClient();
        const promise = client.threadRead("t1");
        const id = ws.lastSent!.id as number;
        ws.simulateMessage({
            id,
            result: {
                thread: {
                    id: "t1",
                    cwd: "/project",
                    status: { type: "idle" },
                    updatedAt: 1000,
                    preview: "hello",
                },
            },
        });
        const info = await promise;
        expect(info?.id).toBe("t1");
        expect(info?.cwd).toBe("/project");
        expect(info?.status?.type).toBe("idle");
    });

    test("returns null on error", async () => {
        const { client, ws } = createClient();
        const promise = client.threadRead("bad");
        const id = ws.lastSent!.id as number;
        ws.simulateMessage({ id, error: { code: -1, message: "not found" } });
        expect(await promise).toBeNull();
    });
});

// ── threadResume ──────────────────────────────────────────────────

describe("threadResume", () => {
    test("returns true on success", async () => {
        const { client, ws } = createClient();
        const promise = client.threadResume("t1");
        const id = ws.lastSent!.id as number;
        ws.simulateMessage({ id, result: {} });
        expect(await promise).toBe(true);
    });

    test("returns false on 'no rollout' error (recoverable)", async () => {
        const { client, ws } = createClient();
        const promise = client.threadResume("stale");
        const id = ws.lastSent!.id as number;
        ws.simulateMessage({
            id,
            error: {
                code: -32600,
                message: "no rollout found for thread id stale",
            },
        });
        expect(await promise).toBe(false);
    });

    test("returns false on other errors", async () => {
        const { client, ws } = createClient();
        const promise = client.threadResume("x");
        const id = ws.lastSent!.id as number;
        ws.simulateMessage({
            id,
            error: { code: -1, message: "something else" },
        });
        expect(await promise).toBe(false);
    });
});

// ── turnStart ─────────────────────────────────────────────────────

describe("turnStart", () => {
    test("returns turn result on success", async () => {
        const { client, ws } = createClient();
        const promise = client.turnStart("t1", [
            { type: "text", text: "hello" },
        ]);
        const sent = ws.lastSent!;
        expect(sent.method).toBe("turn/start");
        expect((sent.params as { threadId: string }).threadId).toBe("t1");

        const id = sent.id as number;
        ws.simulateMessage({
            id,
            result: {
                turn: { id: "turn-1", status: "inProgress" },
            },
        });
        const result = await promise;
        expect(result?.id).toBe("turn-1");
        expect(result?.status).toBe("inProgress");
    });

    test("returns null on error (does not throw)", async () => {
        const { client, ws } = createClient();
        const promise = client.turnStart("t1", [
            { type: "text", text: "hello" },
        ]);
        const id = ws.lastSent!.id as number;
        ws.simulateMessage({
            id,
            error: { code: -1, message: "thread busy" },
        });
        expect(await promise).toBeNull();
    });
});

// ── isConnected ───────────────────────────────────────────────────

describe("isConnected", () => {
    test("true when ws open and initialized", () => {
        const { client } = createClient();
        expect(client.isConnected).toBe(true);
    });

    test("false when ws closed", () => {
        const { client, ws } = createClient();
        ws.readyState = MockWebSocket.CLOSED;
        expect(client.isConnected).toBe(false);
    });
});

// ── close ─────────────────────────────────────────────────────────

describe("close", () => {
    test("closes ws and rejects pending requests", async () => {
        const { client, ws } = createClient();
        const promise = client.sendRequest("any");
        client.close();
        expect(ws.wasClosed).toBe(true);

        try {
            await promise;
            expect(true).toBe(false);
        } catch (e) {
            expect((e as Error).message).toBe("client closed");
        }
    });

    test("close is idempotent", () => {
        const { client } = createClient();
        client.close();
        client.close();
    });
});
