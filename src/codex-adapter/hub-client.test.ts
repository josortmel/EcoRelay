import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    HubClient,
    validateBunPath,
    getAuthToken,
    _resetHubSpawnedForTest,
    type HubIncomingMessage,
} from "./hub-client";
import { _resetForTest as resetIdentity } from "./identity";

// ── Mock WebSocket ────────────────────────────────────────────────

type MsgHandler = (event: { data: string }) => void;

class MockWS {
    static readonly OPEN = 1;
    static readonly CONNECTING = 0;
    static readonly CLOSED = 3;

    readyState = MockWS.OPEN;
    onmessage: MsgHandler | null = null;
    sent: string[] = [];
    private _closed = false;

    send(data: string): void {
        if (this.readyState !== MockWS.OPEN) throw new Error("not open");
        this.sent.push(data);
    }

    close(): void {
        this._closed = true;
        this.readyState = MockWS.CLOSED;
    }

    simulateMessage(data: unknown): void {
        if (this.onmessage) this.onmessage({ data: JSON.stringify(data) });
    }

    get lastSentParsed(): Record<string, unknown> | null {
        if (this.sent.length === 0) return null;
        return JSON.parse(this.sent[this.sent.length - 1]!) as Record<string, unknown>;
    }

    sentParsed(idx: number): Record<string, unknown> {
        return JSON.parse(this.sent[idx]!) as Record<string, unknown>;
    }

    get wasClosed(): boolean {
        return this._closed;
    }
}

function makeClient(onMsg?: (msg: HubIncomingMessage) => void): {
    client: HubClient;
    ws: MockWS;
    messages: HubIncomingMessage[];
} {
    const messages: HubIncomingMessage[] = [];
    const client = new HubClient({
        peerName: "codex-test",
        cwd: "/project",
        gitBranch: "main",
        onMessage: onMsg ?? ((m) => messages.push(m)),
    });
    const ws = new MockWS();
    client._setWsForTest(ws as unknown as WebSocket);
    return { client, ws, messages };
}

beforeEach(() => {
    resetIdentity();
    _resetHubSpawnedForTest();
});

afterEach(() => {
    resetIdentity();
    _resetHubSpawnedForTest();
});

// ── Ping/Pong ─────────────────────────────────────────────────────

describe("ping/pong", () => {
    test("auto-pong on ping from Hub", () => {
        const { ws } = makeClient();
        ws.simulateMessage({ type: "ping", req_id: "hub-ping-42" });
        const pong = ws.lastSentParsed!;
        expect(pong.type).toBe("pong");
        expect(pong.req_id).toBe("hub-ping-42");
    });

    test("pong not sent for non-ping messages", () => {
        const { ws } = makeClient();
        ws.simulateMessage({ type: "incoming_message", from: "alice", text: "hi", msg_id: "m1" });
        // Only the incoming_message triggers onMessage, no pong sent
        const hasPong = ws.sent.some((s) => JSON.parse(s).type === "pong");
        expect(hasPong).toBe(false);
    });
});

// ── Message sender tracking ───────────────────────────────────────

describe("messageSenders", () => {
    test("tracks msg_id → from", () => {
        const { client, ws } = makeClient();
        ws.simulateMessage({
            type: "incoming_message",
            from: "alice",
            text: "hello",
            msg_id: "m-1",
        });
        expect(client.messageSenders.get("m-1")).toBe("alice");
    });

    test("tracks ask_id → from", () => {
        const { client, ws } = makeClient();
        ws.simulateMessage({
            type: "incoming_ask",
            from: "bob",
            question: "status?",
            ask_id: "a-1",
        });
        expect(client.messageSenders.get("a-1")).toBe("bob");
    });

    test("ring eviction at 200", () => {
        const { client, ws } = makeClient();
        for (let i = 0; i < 210; i++) {
            ws.simulateMessage({
                type: "incoming_message",
                from: `peer-${i}`,
                text: "hi",
                msg_id: `m-${i}`,
            });
        }
        expect(client.messageSenders.size).toBe(200);
        // Oldest should be evicted
        expect(client.messageSenders.has("m-0")).toBe(false);
        expect(client.messageSenders.has("m-9")).toBe(false);
        // Newest should exist
        expect(client.messageSenders.has("m-209")).toBe(true);
    });
});

// ── Broadcast receipts ────────────────────────────────────────────

describe("broadcastReceipts", () => {
    test("tracks broadcast_ack with peer_count", () => {
        const { client, ws } = makeClient();
        ws.simulateMessage({
            type: "broadcast_ack",
            broadcast_id: "bcast-1",
            peer_count: 3,
        });
        expect(client.broadcastReceipts.get("bcast-1")).toBe("ack:3");
    });

    test("updates on repeated broadcast_ack", () => {
        const { client, ws } = makeClient();
        ws.simulateMessage({ type: "broadcast_ack", broadcast_id: "bcast-1", peer_count: 2 });
        ws.simulateMessage({ type: "broadcast_ack", broadcast_id: "bcast-1", peer_count: 5 });
        expect(client.broadcastReceipts.get("bcast-1")).toBe("ack:5");
    });
});

// ── Incoming message callback ─────────────────────────────────────

describe("onMessage callback", () => {
    test("dispatches incoming_message", () => {
        const { ws, messages } = makeClient();
        ws.simulateMessage({
            type: "incoming_message",
            from: "alice",
            text: "hello",
            msg_id: "m-1",
            urgent: false,
        });
        expect(messages).toHaveLength(1);
        expect(messages[0]!.from).toBe("alice");
        expect(messages[0]!.type).toBe("incoming_message");
    });

    test("dispatches incoming_ask", () => {
        const { ws, messages } = makeClient();
        ws.simulateMessage({
            type: "incoming_ask",
            from: "bob",
            question: "status?",
            ask_id: "a-1",
            broadcast_id: "b-1",
        });
        expect(messages).toHaveLength(1);
        expect(messages[0]!.type).toBe("incoming_ask");
    });

    test("dispatches incoming_room_msg", () => {
        const { ws, messages } = makeClient();
        ws.simulateMessage({
            type: "incoming_room_msg",
            room: "dev",
            from: "charlie",
            text: "deployed",
            msg_id: "rm-1",
        });
        expect(messages).toHaveLength(1);
        expect(messages[0]!.room).toBe("dev");
    });

    test("dispatches incoming_group_msg", () => {
        const { ws, messages } = makeClient();
        ws.simulateMessage({
            type: "incoming_group_msg",
            group: "devs",
            from: "dave",
            text: "merged",
            msg_id: "gm-1",
            ts: "2026-06-17T10:00:00Z",
        });
        expect(messages).toHaveLength(1);
        expect(messages[0]!.group).toBe("devs");
    });

    test("does not dispatch ping as incoming message", () => {
        const { ws, messages } = makeClient();
        ws.simulateMessage({ type: "ping", req_id: "p-1" });
        expect(messages).toHaveLength(0);
    });
});

// ── sendAndWait ───────────────────────────────────────────────────

describe("sendAndWait", () => {
    test("correlates response by req_id", async () => {
        const { client, ws } = makeClient();
        const promise = client.sendAndWait({ type: "list_peers" });
        const sent = ws.lastSentParsed!;
        expect(sent.type).toBe("list_peers");
        const reqId = sent.req_id as string;

        ws.simulateMessage({
            type: "peers",
            peers: [{ name: "alice", cwd: "/a", git_branch: "main", last_seen: 1 }],
            req_id: reqId,
        });
        const result = (await promise) as { type: string; peers: unknown[] };
        expect(result.type).toBe("peers");
        expect(result.peers).toHaveLength(1);
    });

    test("rejects on err response", async () => {
        const { client, ws } = makeClient();
        const promise = client.sendAndWait({ type: "rename", new_name: "taken" });
        const reqId = ws.lastSentParsed!.req_id as string;
        ws.simulateMessage({ type: "err", code: "name_taken", req_id: reqId });

        try {
            await promise;
            expect(true).toBe(false);
        } catch (e) {
            expect((e as { code: string }).code).toBe("name_taken");
        }
    });

    test("rejects on close (cleanup)", async () => {
        const { client } = makeClient();
        const promise = client.sendAndWait({ type: "list_peers" });
        client.close();
        try {
            await promise;
            expect(true).toBe(false);
        } catch (e) {
            expect((e as Error).message).toBe("client closed");
        }
    });

    test("rejects if ws not connected", async () => {
        const { client, ws } = makeClient();
        ws.readyState = MockWS.CLOSED;
        try {
            await client.sendAndWait({ type: "list_peers" });
            expect(true).toBe(false);
        } catch (e) {
            expect((e as Error).message).toBe("hub ws not connected");
        }
    });
});

// ── validateBunPath ───────────────────────────────────────────────

describe("validateBunPath", () => {
    test("accepts real bun path if it exists", () => {
        const bunPath = path.join(os.homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
        if (fs.existsSync(bunPath)) {
            expect(validateBunPath(bunPath)).not.toBeNull();
        } else {
            // skip on systems without bun at default path
            expect(true).toBe(true);
        }
    });

    test("rejects non-bun binary name", () => {
        const tmp = path.join(os.tmpdir(), `not-bun-${Date.now()}.exe`);
        fs.writeFileSync(tmp, "fake");
        expect(validateBunPath(tmp)).toBeNull();
        fs.unlinkSync(tmp);
    });

    test("rejects nonexistent path", () => {
        expect(validateBunPath("/nonexistent/bun")).toBeNull();
    });

    test("VS14: rejects bun outside ~/.bun directory", () => {
        const tmp = path.join(os.tmpdir(), "bun.exe");
        fs.writeFileSync(tmp, "fake");
        expect(validateBunPath(tmp)).toBeNull();
        fs.unlinkSync(tmp);
    });
});

// ── close ─────────────────────────────────────────────────────────

// ── name_taken suffix behavior ─────────────────────────────────────

describe("name_taken suffix", () => {
    test("_setPeerName updates the name getter", () => {
        const { client } = makeClient();
        expect(client.name).toBe("codex-test");
        client._setPeerName("codex-test-2");
        expect(client.name).toBe("codex-test-2");
    });
});

// ── getAuthToken ──────────────────────────────────────────────────

describe("getAuthToken", () => {
    test("returns env token if set", () => {
        const orig = process.env.ECORELAY_WS_TOKEN;
        process.env.ECORELAY_WS_TOKEN = "test-token-123";
        expect(getAuthToken()).toBe("test-token-123");
        if (orig) { process.env.ECORELAY_WS_TOKEN = orig; } else { delete process.env.ECORELAY_WS_TOKEN; }
    });

    test("error message mentions hub-ws-token when file missing", () => {
        const orig = process.env.ECORELAY_WS_TOKEN;
        delete process.env.ECORELAY_WS_TOKEN;
        const tokenPath = path.join(os.homedir(), ".eco-relay", "hub-ws-token");
        if (fs.existsSync(tokenPath)) {
            // Token file exists on this machine — skip (can't test missing file)
            if (orig) process.env.ECORELAY_WS_TOKEN = orig;
            return;
        }
        try {
            getAuthToken();
            expect(true).toBe(false);
        } catch (e) {
            expect((e as Error).message).toContain("EcoRelay WS token not found");
        } finally {
            if (orig) process.env.ECORELAY_WS_TOKEN = orig;
        }
    });
});

// ── BUG1: malformed JSON guard ────────────────────────────────────

describe("malformed frames", () => {
    test("BUG1: bare null/number/array JSON does not crash", () => {
        const { ws, messages } = makeClient();
        ws.simulateMessage(null);
        ws.simulateMessage(42);
        ws.simulateMessage([1, 2]);
        expect(messages).toHaveLength(0);
    });

    test("malformed string does not crash", () => {
        const { ws, messages } = makeClient();
        if (ws.onmessage) ws.onmessage({ data: "not-json{{" });
        expect(messages).toHaveLength(0);
    });
});

// ── BC1: string req_id correlation ────────────────────────────────

describe("string req_id", () => {
    test("sendAndWait uses cdx- prefixed string req_id", async () => {
        const { client, ws } = makeClient();
        const promise = client.sendAndWait({ type: "list_peers" });
        const sent = ws.lastSentParsed!;
        const reqId = sent.req_id as string;
        expect(typeof reqId).toBe("string");
        expect(reqId).toMatch(/^cdx-/);

        ws.simulateMessage({ type: "peers", peers: [], req_id: reqId });
        const result = (await promise) as Record<string, unknown>;
        expect(result.type).toBe("peers");
    });
});

// ── BUG2: broadcastReceipts cap ───────────────────────────────────

describe("broadcastReceipts cap", () => {
    test("evicts oldest when exceeding 200", () => {
        const { client, ws } = makeClient();
        for (let i = 0; i < 210; i++) {
            ws.simulateMessage({ type: "broadcast_ack", broadcast_id: `b-${i}`, peer_count: i });
        }
        expect(client.broadcastReceipts.size).toBe(200);
        expect(client.broadcastReceipts.has("b-0")).toBe(false);
        expect(client.broadcastReceipts.has("b-209")).toBe(true);
    });
});

describe("close", () => {
    test("closes ws and clears maps", () => {
        const { client, ws } = makeClient();
        ws.simulateMessage({ type: "incoming_message", from: "a", text: "hi", msg_id: "m-1" });
        expect(client.messageSenders.size).toBe(1);
        client.close();
        expect(ws.wasClosed).toBe(true);
        expect(client.messageSenders.size).toBe(0);
        expect(client.broadcastReceipts.size).toBe(0);
    });

    test("close is idempotent", () => {
        const { client } = makeClient();
        client.close();
        client.close();
    });
});

// ── isConnected ───────────────────────────────────────────────────

describe("isConnected", () => {
    test("true when ws open and registered", () => {
        const { client } = makeClient();
        expect(client.isConnected).toBe(true);
    });

    test("false after close", () => {
        const { client } = makeClient();
        client.close();
        expect(client.isConnected).toBe(false);
    });
});

// ── name ──────────────────────────────────────────────────────────

describe("peer name", () => {
    test("name getter returns current name", () => {
        const { client } = makeClient();
        expect(client.name).toBe("codex-test");
    });
});

// ── fireSend ──────────────────────────────────────────────────────

describe("fireSend", () => {
    test("sends JSON without waiting for response", () => {
        const { client, ws } = makeClient();
        client.fireSend({ type: "broadcast", question: "hello?", broadcast_id: "b1", exclude_self: true });
        expect(ws.sent).toHaveLength(1);
        const sent = ws.lastSentParsed!;
        expect(sent.type).toBe("broadcast");
    });

    test("no-ops if ws not connected", () => {
        const { client, ws } = makeClient();
        ws.readyState = MockWS.CLOSED;
        client.fireSend({ type: "broadcast", question: "hello?" });
        expect(ws.sent).toHaveLength(0);
    });
});
