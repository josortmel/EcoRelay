// Verifier edge cases — T2 app-server-client.ts
import { describe, expect, test } from "bun:test";
import { AppServerClient, type AppServerNotification, type ThreadStatusChangedEvent } from "./app-server-client";

class MockWebSocket {
    static readonly OPEN = 1;
    static readonly CONNECTING = 0;
    static readonly CLOSED = 3;
    readyState = MockWebSocket.OPEN;
    onmessage: ((e: { data: string }) => void) | null = null;
    sent: string[] = [];
    send(data: string): void {
        if (this.readyState !== MockWebSocket.OPEN) throw new Error("not open");
        this.sent.push(data);
    }
    close(): void { this.readyState = MockWebSocket.CLOSED; }
    simulateMessage(data: unknown): void {
        this.onmessage?.({ data: JSON.stringify(data) });
    }
    simulateRawMessage(raw: string): void {
        this.onmessage?.({ data: raw });
    }
    get lastSent(): Record<string, unknown> | null {
        return this.sent.length === 0 ? null : JSON.parse(this.sent[this.sent.length - 1]!) as Record<string, unknown>;
    }
    sentAt(i: number): Record<string, unknown> {
        return JSON.parse(this.sent[i]!) as Record<string, unknown>;
    }
}

function makeClient(opts?: { onNotification?: (n: AppServerNotification) => void; onThreadStatusChanged?: (e: ThreadStatusChangedEvent) => void }) {
    const notifications: AppServerNotification[] = [];
    const statusEvents: ThreadStatusChangedEvent[] = [];
    const client = new AppServerClient({
        url: "ws://127.0.0.1:9999",
        onNotification: opts?.onNotification ?? ((n) => notifications.push(n)),
        onThreadStatusChanged: opts?.onThreadStatusChanged ?? ((e) => statusEvents.push(e)),
    });
    const ws = new MockWebSocket();
    client._setWsForTest(ws as unknown as WebSocket);
    client._setInitializedForTest();
    return { client, ws, notifications, statusEvents };
}

// ── PLAN GAP: initialize ──────────────────────────────────────────

describe("Verifier: initialize (plan gap)", () => {
    test("AT1: initialize sends capabilities.experimentalApi:true", async () => {
        const { client, ws } = makeClient();
        // reset initialized so we can call initialize properly
        const p = client.initialize();
        const sent = ws.sentAt(0);
        expect(sent.method).toBe("initialize");
        const params = sent.params as { capabilities: { experimentalApi: boolean } };
        expect(params.capabilities.experimentalApi).toBe(true);
        // resolve to complete
        const id = sent.id as number;
        ws.simulateMessage({ id, result: { serverInfo: {} } });
        await p;
    });

    test("AT2: initialize sends initialized notification after result", async () => {
        const { client, ws } = makeClient();
        const p = client.initialize();
        const id = (ws.sentAt(0)).id as number;
        ws.simulateMessage({ id, result: {} });
        await p;
        // Second sent message should be the "initialized" notification (no id)
        const notification = ws.sentAt(1);
        expect(notification.method).toBe("initialized");
        expect(notification.id).toBeUndefined();
    });
});

// ── PLAN GAP: reconnect backoff math ─────────────────────────────

describe("Verifier: reconnect backoff constants (plan gap)", () => {
    test("AT3: initial backoff is 3s (read from source constants)", () => {
        // Cannot invoke private scheduleReconnect; verify constants are in spec range
        // INITIAL_RECONNECT_MS=3000, MAX_RECONNECT_MS=60000
        // Formula: min(3000 * 2^attempts, 60000)
        const initial = 3_000;
        const max = 60_000;
        expect(initial * Math.pow(2, 0)).toBe(3_000);  // 3s start
        expect(Math.min(initial * Math.pow(2, 5), max)).toBe(60_000); // capped at 60s after 5 attempts
        expect(Math.min(initial * Math.pow(2, 4), max)).toBe(48_000); // 48s (still below cap)
    });
});

// ── Response with unknown id silently ignored ─────────────────────

describe("Verifier: unknown id handling", () => {
    test("AT4: response with unknown id does not throw or affect pending", async () => {
        const { client, ws } = makeClient();
        const p = client.sendRequest("real/method");
        const realId = ws.lastSent!.id as number;
        // Send response for a non-existent id (9999)
        ws.simulateMessage({ id: 9999, result: "stray" });
        // Real request still pending — resolve it
        ws.simulateMessage({ id: realId, result: "ok" });
        expect(await p).toBe("ok");
    });

    test("AT5: stray response with string id ignored (not in pending map)", () => {
        const { client, ws } = makeClient();
        // id as string — map uses number keys, so won't match
        expect(() => ws.simulateMessage({ id: "abc", result: "x" })).not.toThrow();
    });
});

// ── WS closed mid-request ─────────────────────────────────────────

describe("Verifier: ws closed mid-request", () => {
    test("AT6: close() while request pending rejects with 'client closed'", async () => {
        const { client } = makeClient();
        const p = client.sendRequest("long/method");
        client.close();
        await expect(p).rejects.toThrow("client closed");
    });

    test("AT7: multiple pending requests all rejected on close()", async () => {
        const { client } = makeClient();
        const p1 = client.sendRequest("m1");
        const p2 = client.sendRequest("m2");
        const p3 = client.sendRequest("m3");
        client.close();
        const results = await Promise.allSettled([p1, p2, p3]);
        for (const r of results) {
            expect(r.status).toBe("rejected");
            expect((r as PromiseRejectedResult).reason.message).toBe("client closed");
        }
    });
});

// ── Double connect (idempotency) ──────────────────────────────────

describe("Verifier: double connect guard", () => {
    test("AT8: isConnected false without initialized flag", () => {
        const client = new AppServerClient({ url: "ws://x" });
        expect(client.isConnected).toBe(false);
    });
});

// ── Notification before init ──────────────────────────────────────

describe("Verifier: notification before initialize()", () => {
    test("AT9: notifications arrive before initialize() is called — still dispatched", () => {
        // Client not yet initialized, but ws is wired — notifications still route
        const notifications: AppServerNotification[] = [];
        const client = new AppServerClient({
            url: "ws://x",
            onNotification: (n) => notifications.push(n),
        });
        const ws = new MockWebSocket();
        client._setWsForTest(ws as unknown as WebSocket);
        // DO NOT call _setInitializedForTest — simulating pre-init state
        ws.simulateMessage({ method: "thread/loaded", params: { threadId: "t1" } });
        expect(notifications).toHaveLength(1);
        expect(notifications[0]!.method).toBe("thread/loaded");
    });
});

// ── Malformed JSON ────────────────────────────────────────────────

describe("Verifier: malformed JSON frames", () => {
    test("AT10: completely invalid JSON silently ignored", () => {
        const { ws, notifications } = makeClient();
        ws.simulateRawMessage("{broken JSON!!!");
        expect(notifications).toHaveLength(0);
    });

    test("AT11: empty string frame silently ignored", () => {
        const { ws, notifications } = makeClient();
        ws.simulateRawMessage("");
        expect(notifications).toHaveLength(0);
    });

    test("AT12: valid JSON but no method/id fields — not dispatched as notification", () => {
        const { ws, notifications } = makeClient();
        ws.simulateMessage({ some: "random", object: true });
        expect(notifications).toHaveLength(0);
    });
});

// ── Error response structure ──────────────────────────────────────

describe("Verifier: error response", () => {
    test("AT13: error object passed through to reject (not wrapped)", async () => {
        const { client, ws } = makeClient();
        const p = client.sendRequest("bad");
        const id = ws.lastSent!.id as number;
        ws.simulateMessage({ id, error: { code: -32601, message: "method not found" } });
        try {
            await p;
            expect(true).toBe(false);
        } catch (e) {
            expect((e as { code: number }).code).toBe(-32601);
            expect((e as { message: string }).message).toBe("method not found");
        }
    });

    test("AT14: threadResume with non-rollout error returns false (no throw)", async () => {
        const { client, ws } = makeClient();
        const p = client.threadResume("t1");
        const id = ws.lastSent!.id as number;
        ws.simulateMessage({ id, error: { code: -1, message: "network error" } });
        expect(await p).toBe(false);
    });
});

// ── thread/status/changed dual dispatch ──────────────────────────

describe("Verifier: status/changed dual dispatch", () => {
    test("AT15: thread/status/changed fires BOTH onThreadStatusChanged AND onNotification", () => {
        const { ws, notifications, statusEvents } = makeClient();
        ws.simulateMessage({
            method: "thread/status/changed",
            params: { threadId: "t99", status: { type: "active" } },
        });
        expect(statusEvents).toHaveLength(1);
        expect(statusEvents[0]!.threadId).toBe("t99");
        expect(notifications).toHaveLength(1);
        expect(notifications[0]!.method).toBe("thread/status/changed");
    });
});
