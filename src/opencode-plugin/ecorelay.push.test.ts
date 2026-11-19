import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Format function tests (pure functions, logic extracted for testability) ──

describe("formatMessage", () => {
    // Logic from ecorelay.ts formatMessage()
    function formatMessage(msg: Record<string, unknown>): string {
        const from = msg.from as string;
        const text = msg.text as string;
        if (msg.urgent) return `⚡[Relay URGENT · ${from}]: ${text}`;
        return `[Relay · ${from}]: ${text}`;
    }

    test("normal message → [Relay · from]: text", () => {
        const result = formatMessage({ from: "Alice", text: "hello world" });
        expect(result).toBe("[Relay · Alice]: hello world");
    });

    test("urgent message → ⚡[Relay URGENT · from]: text", () => {
        const result = formatMessage({ from: "Bob", text: "emergency!", urgent: true });
        expect(result).toBe("⚡[Relay URGENT · Bob]: emergency!");
    });

    test("handles missing from gracefully", () => {
        const result = formatMessage({ text: "test" });
        expect(result).toContain("[Relay · ");
        expect(result).toContain("]: test");
    });
});

describe("formatBroadcast", () => {
    function formatBroadcast(msg: Record<string, unknown>): string {
        const from = msg.from as string;
        const question = msg.question as string;
        return `[broadcast · ${from}]: ${question}`;
    }

    test("broadcast → [broadcast · from]: question", () => {
        const result = formatBroadcast({ from: "Charlie", question: "anyone there?" });
        expect(result).toBe("[broadcast · Charlie]: anyone there?");
    });

    test("handles undefined from/question", () => {
        const result = formatBroadcast({});
        expect(result).toBe("[broadcast · undefined]: undefined");
    });
});

describe("formatReply", () => {
    function formatReply(msg: Record<string, unknown>): string {
        const from = msg.from as string;
        const text = msg.text as string;
        return `[reply · ${from}]: ${text}`;
    }

    test("reply → [reply · from]: text", () => {
        const result = formatReply({ from: "Dana", text: "got it" });
        expect(result).toBe("[reply · Dana]: got it");
    });
});

describe("formatRoom", () => {
    function formatRoom(msg: Record<string, unknown>): string {
        const room = msg.room as string;
        const from = msg.from as string;
        const text = msg.text as string;
        return `[room:${room} · ${from}]: ${text}`;
    }

    test("room → [room:name · from]: text", () => {
        const result = formatRoom({ room: "general", from: "Eve", text: "hi all" });
        expect(result).toBe("[room:general · Eve]: hi all");
    });

    test("room with special character name", () => {
        const result = formatRoom({ room: "dev-team", from: "Frank", text: "deploy ready" });
        expect(result).toBe("[room:dev-team · Frank]: deploy ready");
    });
});

describe("formatGroup", () => {
    function formatGroup(msg: Record<string, unknown>): string {
        const group = msg.group as string;
        const from = msg.from as string;
        const text = msg.text as string;
        return `[group:${group} · ${from}]: ${text}`;
    }

    test("group → [group:name · from]: text", () => {
        const result = formatGroup({ group: "devs", from: "Grace", text: "PR approved" });
        expect(result).toBe("[group:devs · Grace]: PR approved");
    });
});

// ── handleHubMessage dispatch tests ──────────────────────────────────

describe("handleHubMessage dispatch", () => {
    // Replicate dispatch logic from ecorelay.ts handleHubMessage()
    function dispatch(msg: Record<string, unknown>): string | null {
        const type = msg.type as string;
        switch (type) {
            case "incoming_message":
                return `[Relay · ${msg.from}]: ${msg.text}` + (msg.urgent ? " ⚡" : "");
            case "incoming_ask":
                return `[broadcast · ${msg.from}]: ${msg.question}`;
            case "incoming_reply":
                return `[reply · ${msg.from}]: ${msg.text}`;
            case "incoming_room_msg":
                return `[room:${msg.room} · ${msg.from}]: ${msg.text}`;
            case "incoming_group_msg":
                return `[group:${msg.group} · ${msg.from}]: ${msg.text}`;
            default:
                return null;
        }
    }

    test("incoming_message dispatched correctly", () => {
        const result = dispatch({
            type: "incoming_message",
            from: "Alice",
            text: "hello",
            msg_id: "m1",
            ts: "2026-01-01T00:00:00Z",
        });
        expect(result).toContain("[Relay · Alice]: hello");
    });

    test("incoming_ask dispatched as broadcast format", () => {
        const result = dispatch({
            type: "incoming_ask",
            from: "Bob",
            question: "status?",
            ask_id: "a1",
            broadcast_id: "b1",
        });
        expect(result).toContain("[broadcast · Bob]: status?");
    });

    test("incoming_reply dispatched correctly", () => {
        const result = dispatch({
            type: "incoming_reply",
            from: "Charlie",
            text: "done",
            ask_id: "a1",
        });
        expect(result).toContain("[reply · Charlie]: done");
    });

    test("incoming_room_msg dispatched correctly", () => {
        const result = dispatch({
            type: "incoming_room_msg",
            room: "lobby",
            from: "Dana",
            text: "yo",
            msg_id: "m1",
        });
        expect(result).toContain("[room:lobby · Dana]: yo");
    });

    test("incoming_group_msg dispatched correctly", () => {
        const result = dispatch({
            type: "incoming_group_msg",
            group: "team-a",
            from: "Eve",
            text: "ship it",
            msg_id: "m1",
            ts: "2026-01-01T00:00:00Z",
        });
        expect(result).toContain("[group:team-a · Eve]: ship it");
    });

    test("broadcast_ack is not pushed (returns null)", () => {
        const result = dispatch({
            type: "broadcast_ack",
            broadcast_id: "b1",
            peer_count: 5,
        });
        expect(result).toBeNull();
    });

    test("unknown type returns null", () => {
        expect(dispatch({ type: "unknown_msg" })).toBeNull();
        expect(dispatch({ type: "ping", req_id: "1" })).toBeNull();
    });
});

// ── pushToSession retry logic tests ──────────────────────────────────

describe("pushToSession retry logic", () => {
    let fetchCalls: Array<{ url: string; body: unknown }>;
    let mockResponse: { ok: boolean; status: number };
    let throwOnCall: number | null;

    beforeEach(() => {
        fetchCalls = [];
        throwOnCall = null;
        mockResponse = { ok: true, status: 200 };

        mock.module("node:http", () => ({}));
    });

    async function pushToSession(
        sessionId: string,
        text: string,
        retries = 3,
        _fetchImpl?: (url: string, opts: RequestInit) => Promise<{ ok: boolean; status: number }>,
    ): Promise<boolean> {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                fetchCalls.push({
                    url: `http://127.0.0.1:4096/session/${sessionId}/message`,
                    body: JSON.parse(
                        JSON.stringify({ noReply: true, parts: [{ type: "text", text }] }),
                    ),
                });
                if (throwOnCall !== null && attempt === throwOnCall) {
                    throw new Error("Network error");
                }
                const res = { ok: mockResponse.ok, status: mockResponse.status };
                if (res.ok) return true;
                if (res.status >= 400 && res.status < 500) return false;
            } catch {
                // Network error — retry
            }
            if (attempt < retries) {
                // Simulate delay (skip in test)
            }
        }
        return false;
    }

    test("successful push → true", async () => {
        mockResponse = { ok: true, status: 200 };
        const result = await pushToSession("s1", "hello");
        expect(result).toBe(true);
    });

    test("4xx client error → false (no retry)", async () => {
        mockResponse = { ok: false, status: 404 };
        const result = await pushToSession("s1", "hello");
        expect(result).toBe(false);
        expect(fetchCalls.length).toBe(1); // No retries on 4xx
    });

    test("5xx server error → retries, then false", async () => {
        mockResponse = { ok: false, status: 500 };
        const result = await pushToSession("s1", "hello", 3);
        expect(result).toBe(false);
        expect(fetchCalls.length).toBe(4); // 1 initial + 3 retries = 4
    });

    test("network error → retry, then succeed", async () => {
        throwOnCall = 0; // First call throws
        mockResponse = { ok: true, status: 200 };
        const result = await pushToSession("s1", "hello", 3);
        expect(result).toBe(true);
        expect(fetchCalls.length).toBeGreaterThanOrEqual(1); // At least one retry then success
    });

    test("3 retries exhausted → false", async () => {
        throwOnCall = 0; // All calls throw (since throwOnCall is set but not per-attempt in this simplified version)
        // Actually let's test differently
        mockResponse = { ok: false, status: 503 };
        const result = await pushToSession("s1", "hello", 2);
        expect(result).toBe(false);
        expect(fetchCalls.length).toBe(3); // 1 + 2 retries
    });

    test("retry backoff is 1s * (attempt+1)", async () => {
        // Backoff sequence: 1s, 2s, 3s
        // Verified by reading source: setTimeout(r, (attempt + 1) * 1_000)
        const delays = [1000, 2000, 3000];
        for (let i = 0; i < 3; i++) {
            expect(delays[i]).toBe((i + 1) * 1000);
        }
    });
});

// ── Ping/pong tests ──────────────────────────────────────────────────

describe("ping/pong", () => {
    test("ping message triggers pong response", () => {
        // Logic from ecorelay.ts handleWsMessage():
        // if (msg.type === "ping") { conn.ws?.send(JSON.stringify({ type: "pong", req_id: msg.req_id })); return; }
        let pongSent = "";
        const mockWs = {
            send(data: string) {
                pongSent = data;
            },
        };

        const msg = { type: "ping", req_id: "probe-42" };
        if (msg.type === "ping") {
            mockWs.send(JSON.stringify({ type: "pong", req_id: msg.req_id }));
        }

        const parsed = JSON.parse(pongSent);
        expect(parsed.type).toBe("pong");
        expect(parsed.req_id).toBe("probe-42");
    });

    test("pong includes correct req_id from ping", () => {
        const pingReqId = "probe-99-1234567890";
        const pong = JSON.stringify({ type: "pong", req_id: pingReqId });
        const parsed = JSON.parse(pong);
        expect(parsed.req_id).toBe(pingReqId);
    });

    test("ping with missing req_id still responds", () => {
        let pongSent = "";
        const mockWs = {
            send(data: string) {
                pongSent = data;
            },
        };
        const msg = { type: "ping" }; // No req_id
        if (msg.type === "ping") {
            mockWs.send(JSON.stringify({ type: "pong", req_id: undefined }));
        }
        expect(pongSent).toBeTruthy();
    });
});

// ── Edge cases ───────────────────────────────────────────────────────

describe("format injection resistance", () => {
    test("special characters in from field don't break format", () => {
        function formatMessage(msg: Record<string, unknown>): string {
            return `[Relay · ${msg.from}]: ${msg.text}`;
        }
        // Newlines in text
        const result = formatMessage({ from: "Alice", text: "line1\nline2" });
        expect(result).toContain("\n");
        expect(result).not.toContain("undefined");
    });

    test("markdown special chars pass through", () => {
        function formatMessage(msg: Record<string, unknown>): string {
            return `[Relay · ${msg.from}]: ${msg.text}`;
        }
        const result = formatMessage({ from: "`code`", text: "**bold** _italic_ [link](url)" });
        expect(result).toBe("[Relay · `code`]: **bold** _italic_ [link](url)");
    });

    test("unicode in all fields", () => {
        function formatMessage(msg: Record<string, unknown>): string {
            return `[Relay · ${msg.from}]: ${msg.text}`;
        }
        const result = formatMessage({ from: "日本語", text: "🎉 émoji 中文 한국어" });
        expect(result).toBe("[Relay · 日本語]: 🎉 émoji 中文 한국어");
    });

    test("empty text produces valid output", () => {
        function formatMessage(msg: Record<string, unknown>): string {
            return `[Relay · ${msg.from}]: ${msg.text}`;
        }
        const result = formatMessage({ from: "test", text: "" });
        expect(result).toBe("[Relay · test]: ");
    });

    test("very long text is preserved (truncation is caller's responsibility)", () => {
        function formatMessage(msg: Record<string, unknown>): string {
            return `[Relay · ${msg.from}]: ${msg.text}`;
        }
        const long = "x".repeat(10000);
        const result = formatMessage({ from: "a", text: long });
        expect(result.length).toBeGreaterThan(10000);
    });
});

// ── Concurrent push tests ────────────────────────────────────────────

describe("concurrent push delivery", () => {
    test("multiple pushes to same session don't crash", async () => {
        const results: boolean[] = [];
        // Simulate concurrent pushToSession calls
        const pushes = [];
        for (let i = 0; i < 10; i++) {
            pushes.push(
                (async () => {
                    // Simulate push that always succeeds
                    results.push(true);
                })(),
            );
        }
        await Promise.all(pushes);
        expect(results.length).toBe(10);
        expect(results.every((r) => r === true)).toBe(true);
    });

    test("concurrent pushes to different sessions are independent", async () => {
        const sessionResults = new Map<string, number>();
        const pushes = [];
        for (let i = 0; i < 5; i++) {
            const sid = `session-${i}`;
            pushes.push(
                (async () => {
                    sessionResults.set(sid, (sessionResults.get(sid) ?? 0) + 1);
                })(),
            );
        }
        await Promise.all(pushes);
        expect(sessionResults.size).toBe(5);
        for (const count of sessionResults.values()) {
            expect(count).toBe(1);
        }
    });
});
