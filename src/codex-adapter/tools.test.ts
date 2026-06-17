import { describe, expect, test } from "bun:test";
import { callTool, getToolSchemas, errResult, okResult } from "./tools";
import type { HubClient } from "./hub-client";

// ── Mock HubClient ────────────────────────────────────────────────

type SendCall = Record<string, unknown>;

function createMockHub(response?: Record<string, unknown>): {
    hub: HubClient;
    sendCalls: SendCall[];
    fireCalls: SendCall[];
} {
    const sendCalls: SendCall[] = [];
    const fireCalls: SendCall[] = [];
    const messageSenders = new Map<string, string>();
    const broadcastReceipts = new Map<string, string>();
    let _name = "codex-test";

    const hub = {
        get name() { return _name; },
        messageSenders,
        broadcastReceipts,
        sendAndWait: async (payload: Record<string, unknown>) => {
            sendCalls.push(payload);
            return response ?? { type: "ack" };
        },
        fireSend: (payload: Record<string, unknown>) => {
            fireCalls.push(payload);
        },
        _setPeerName: (n: string) => { _name = n; },
    } as unknown as HubClient;

    return { hub, sendCalls, fireCalls };
}

// ── Tool schemas ──────────────────────────────────────────────────

describe("getToolSchemas", () => {
    test("returns 19 tools", () => {
        const schemas = getToolSchemas();
        expect(schemas).toHaveLength(19);
    });

    test("all tools have relay_ prefix", () => {
        for (const s of getToolSchemas()) {
            expect(s.name.startsWith("relay_")).toBe(true);
        }
    });

    test("no additionalProperties:false in any schema", () => {
        for (const s of getToolSchemas()) {
            expect((s.inputSchema as Record<string, unknown>).additionalProperties).toBeUndefined();
        }
    });

    test("exact 19 tool names", () => {
        const names = getToolSchemas().map((s) => s.name).sort();
        expect(names).toEqual([
            "relay_broadcast",
            "relay_group_create",
            "relay_group_delete",
            "relay_group_history",
            "relay_group_info",
            "relay_group_invite",
            "relay_group_leave",
            "relay_group_list",
            "relay_group_remove",
            "relay_group_send",
            "relay_inbox",
            "relay_join",
            "relay_leave",
            "relay_peers",
            "relay_rename",
            "relay_reply",
            "relay_room",
            "relay_rooms",
            "relay_send",
        ]);
    });
});

// ── relay_peers ───────────────────────────────────────────────────

describe("relay_peers", () => {
    test("returns me + peers", async () => {
        const { hub } = createMockHub({
            type: "peers",
            peers: [{ name: "alice", cwd: "/a", git_branch: "main", last_seen: 1 }],
        });
        const result = await callTool(hub, "relay_peers", {});
        const parsed = JSON.parse(result.content[0]!.text);
        expect(parsed.me).toBe("codex-test");
        expect(parsed.peers).toHaveLength(1);
    });
});

// ── relay_send ────────────────────────────────────────────────────

describe("relay_send", () => {
    test("sends message and returns ack", async () => {
        const { hub, sendCalls } = createMockHub({ type: "send_ack", msg_id: "m-1", status: "delivered" });
        const result = await callTool(hub, "relay_send", { to: "alice", text: "hello" });
        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse(result.content[0]!.text);
        expect(parsed.ok).toBe(true);
        expect(parsed.msg_id).toBe("m-1");
        expect(sendCalls[0]!.type).toBe("send");
    });

    test("rejects bad args", async () => {
        const { hub } = createMockHub();
        const result = await callTool(hub, "relay_send", { to: 123, text: "hi" });
        expect(result.isError).toBe(true);
    });
});

// ── relay_reply auto-detect ───────────────────────────────────────

describe("relay_reply", () => {
    test("auto-detects sender from messageSenders and routes as send", async () => {
        const { hub, sendCalls } = createMockHub({ type: "send_ack", msg_id: "m-2", status: "delivered" });
        hub.messageSenders.set("msg-123", "alice");

        const result = await callTool(hub, "relay_reply", { ask_id: "msg-123", text: "reply text" });
        expect(result.isError).toBeUndefined();
        expect(sendCalls[0]!.type).toBe("send");
        expect(sendCalls[0]!.to).toBe("alice");
        expect(sendCalls[0]!.reply_to).toBe("msg-123");
    });

    test("falls back to Hub reply if sender unknown", async () => {
        const { hub, fireCalls } = createMockHub();
        const result = await callTool(hub, "relay_reply", { ask_id: "ask-456", text: "reply" });
        expect(result.isError).toBeUndefined();
        expect(fireCalls[0]!.type).toBe("reply");
        expect(fireCalls[0]!.ask_id).toBe("ask-456");
    });
});

// ── relay_broadcast ───────────────────────────────────────────────

describe("relay_broadcast", () => {
    test("fires broadcast and returns broadcast_id", async () => {
        const { hub, fireCalls } = createMockHub();
        const result = await callTool(hub, "relay_broadcast", { question: "status?" });
        const parsed = JSON.parse(result.content[0]!.text);
        expect(parsed.ok).toBe(true);
        expect(parsed.broadcast_id).toContain("bcast-codex-");
        expect(fireCalls[0]!.type).toBe("broadcast");
    });
});

// ── relay_inbox ───────────────────────────────────────────────────

describe("relay_inbox", () => {
    test("returns messages", async () => {
        const { hub } = createMockHub({
            type: "inbox_result",
            messages: [{ msg_id: "m1", from: "bob", text: "hi" }],
            remaining: 0,
        });
        const result = await callTool(hub, "relay_inbox", {});
        const parsed = JSON.parse(result.content[0]!.text);
        expect(parsed.messages).toHaveLength(1);
    });
});

// ── BC2/VS30 length caps ──────────────────────────────────────────

describe("length caps", () => {
    test("relay_reply rejects ask_id > 256", async () => {
        const { hub } = createMockHub();
        const result = await callTool(hub, "relay_reply", { ask_id: "a".repeat(257), text: "ok" });
        expect(result.isError).toBe(true);
    });

    test("relay_join rejects room > 64", async () => {
        const { hub } = createMockHub();
        const result = await callTool(hub, "relay_join", { room: "r".repeat(65) });
        expect(result.isError).toBe(true);
    });

    test("relay_group_create rejects members > 20", async () => {
        const { hub } = createMockHub();
        const members = Array.from({ length: 21 }, (_, i) => `m${i}`);
        const result = await callTool(hub, "relay_group_create", { name: "g", members });
        expect(result.isError).toBe(true);
    });

    test("relay_group_remove rejects reason > 256", async () => {
        const { hub } = createMockHub();
        const result = await callTool(hub, "relay_group_remove", { group: "g", peer: "p", reason: "r".repeat(257) });
        expect(result.isError).toBe(true);
    });

    test("relay_inbox rejects invalid since_id", async () => {
        const { hub } = createMockHub();
        const result = await callTool(hub, "relay_inbox", { since_id: "" });
        expect(result.isError).toBe(true);
    });
});

// ── VS29 toolRename sync ─────────────────────────────────────────

describe("relay_rename", () => {
    test("rejects invalid name via safeName", async () => {
        const { hub } = createMockHub();
        const result = await callTool(hub, "relay_rename", { new_name: "has spaces" });
        expect(result.isError).toBe(true);
    });

    test("updates hub peer name on success", async () => {
        const { hub, sendCalls } = createMockHub({ type: "ack" });
        const result = await callTool(hub, "relay_rename", { new_name: "new-name" });
        expect(result.isError).toBeUndefined();
        expect(hub.name).toBe("new-name");
    });
});

// ── DG1 broadcast parity ─────────────────────────────────────────

describe("relay_broadcast parity", () => {
    test("returns {ok, broadcast_id} only (fire-and-forget, same as OC)", async () => {
        const { hub } = createMockHub();
        const result = await callTool(hub, "relay_broadcast", { question: "status?" });
        const parsed = JSON.parse(result.content[0]!.text);
        expect(parsed.ok).toBe(true);
        expect(parsed.broadcast_id).toBeDefined();
        expect(parsed.peer_count).toBeUndefined();
    });
});

// ── unknown tool ──────────────────────────────────────────────────

describe("unknown tool", () => {
    test("returns bad_args error", async () => {
        const { hub } = createMockHub();
        const result = await callTool(hub, "nonexistent_tool", {});
        expect(result.isError).toBe(true);
    });
});

// ── tools-only degradation ────────────────────────────────────────

describe("tools-only mode", () => {
    test("tools work with hub client even without app-server", async () => {
        const { hub } = createMockHub({
            type: "peers",
            peers: [],
        });
        const result = await callTool(hub, "relay_peers", {});
        expect(result.isError).toBeUndefined();
    });
});

// ── instructions ──────────────────────────────────────────────────

describe("instructions", () => {
    test("first 512 chars contain untrusted_peer_message warning", async () => {
        const { INSTRUCTIONS } = await import("./instructions");
        const first512 = INSTRUCTIONS.slice(0, 512);
        expect(first512).toContain("untrusted_peer_message");
        expect(first512).toContain("NOT from the human user");
    });

    test("mentions relay_inbox for tools-only mode", async () => {
        const { INSTRUCTIONS } = await import("./instructions");
        expect(INSTRUCTIONS).toContain("relay_inbox");
    });
});
