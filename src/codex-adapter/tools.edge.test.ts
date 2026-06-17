// Verifier edge cases — T6 tools.ts + instructions.ts
import { describe, expect, test } from "bun:test";
import { callTool, errResult, okResult } from "./tools";
import type { HubClient } from "./hub-client";

// ── Mock helpers ──────────────────────────────────────────────────

function makeMock(response?: Record<string, unknown>): {
    hub: HubClient;
    sends: Record<string, unknown>[];
    fires: Record<string, unknown>[];
} {
    const sends: Record<string, unknown>[] = [];
    const fires: Record<string, unknown>[] = [];
    const messageSenders = new Map<string, string>();
    let _name = "test-peer";
    const hub = {
        get name() { return _name; },
        messageSenders,
        broadcastReceipts: new Map(),
        sendAndWait: async (p: Record<string, unknown>) => { sends.push(p); return response ?? { type: "ack" }; },
        fireSend: (p: Record<string, unknown>) => { fires.push(p); },
        _setPeerName: (n: string) => { _name = n; },
    } as unknown as HubClient;
    return { hub, sends, fires };
}

function makeThrowingMock(): HubClient {
    return {
        get name() { return "x"; },
        messageSenders: new Map(),
        broadcastReceipts: new Map(),
        sendAndWait: async () => { throw new Error("simulated WS error"); },
        fireSend: () => {},
        _setPeerName: () => {},
    } as unknown as HubClient;
}

// ── AT1–AT6: Exact-at-boundary cap tests ─────────────────────────

describe("Verifier: exact-at-boundary caps (should PASS)", () => {
    test("AT1: relay_send with `to` exactly 64 chars passes", async () => {
        const { hub } = makeMock({ type: "send_ack", msg_id: "m1", status: "delivered" });
        const result = await callTool(hub, "relay_send", { to: "a".repeat(64), text: "hi" });
        expect(result.isError).toBeUndefined();
    });

    test("AT2: relay_reply with ask_id exactly 256 chars passes", async () => {
        const { hub } = makeMock({ type: "send_ack", msg_id: "m2", status: "delivered" });
        hub.messageSenders.set("a".repeat(256), "alice");
        const result = await callTool(hub, "relay_reply", { ask_id: "a".repeat(256), text: "reply" });
        expect(result.isError).toBeUndefined();
    });

    test("AT3: relay_join with room exactly 64 chars passes", async () => {
        const { hub } = makeMock({ type: "room_ack", room: "r".repeat(64), members: [] });
        const result = await callTool(hub, "relay_join", { room: "r".repeat(64) });
        expect(result.isError).toBeUndefined();
    });

    test("AT4: relay_group_invite with group and peer each exactly 64 chars passes", async () => {
        const { hub } = makeMock({ type: "group_ack" });
        const result = await callTool(hub, "relay_group_invite", { group: "g".repeat(64), peer: "p".repeat(64) });
        expect(result.isError).toBeUndefined();
    });

    test("AT5: relay_group_remove with reason exactly 256 chars passes", async () => {
        const { hub } = makeMock({ type: "group_ack" });
        const result = await callTool(hub, "relay_group_remove", { group: "g", peer: "p", reason: "r".repeat(256) });
        expect(result.isError).toBeUndefined();
    });

    test("AT6: relay_group_create with exactly 20 members passes", async () => {
        const { hub } = makeMock({ type: "group_created", group: "g", members: [] });
        const members = Array.from({ length: 20 }, (_, i) => `m${i}`);
        const result = await callTool(hub, "relay_group_create", { name: "g", members });
        expect(result.isError).toBeUndefined();
    });
});

// ── AT7–AT9: Group membership edge cases ─────────────────────────

describe("Verifier: group_create edge cases", () => {
    test("AT7: 0-member group_create is valid (empty array)", async () => {
        const { hub, sends } = makeMock({ type: "group_created", group: "g", members: [] });
        const result = await callTool(hub, "relay_group_create", { name: "g", members: [] });
        expect(result.isError).toBeUndefined();
        // empty array still sent to hub
        expect(sends[0]!.members).toEqual([]);
    });

    test("AT8: mixed-type members array filters non-strings before sending", async () => {
        const { hub, sends } = makeMock({ type: "group_created", group: "g", members: ["alice"] });
        const result = await callTool(hub, "relay_group_create", {
            name: "g",
            members: ["alice", 42, null, "bob", true] as unknown as string[],
        });
        expect(result.isError).toBeUndefined();
        // Only string entries sent
        expect(sends[0]!.members).toEqual(["alice", "bob"]);
    });
});

// ── AT10: relay_send optional args ───────────────────────────────

describe("Verifier: relay_send optional args", () => {
    test("AT9: reply_to and urgent=true both forwarded in payload", async () => {
        const { hub, sends } = makeMock({ type: "send_ack", msg_id: "m3", status: "delivered" });
        await callTool(hub, "relay_send", { to: "bob", text: "hi", reply_to: "prev-msg-id", urgent: true });
        expect(sends[0]!.reply_to).toBe("prev-msg-id");
        expect(sends[0]!.urgent).toBe(true);
    });

    test("AT10: missing `to` arg returns bad_args", async () => {
        const { hub } = makeMock();
        const result = await callTool(hub, "relay_send", { text: "hello" });
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        expect(parsed.code).toBe("bad_args");
    });

    test("AT11: FIXED — relay_send enforces reply_to ≤ 256", async () => {
        const { hub } = makeMock({ type: "send_ack", msg_id: "m4", status: "delivered" });
        const longReplyTo = "x".repeat(500);
        const result = await callTool(hub, "relay_send", { to: "bob", text: "hi", reply_to: longReplyTo });
        expect(result.isError).toBe(true);
    });
});

// ── AT12–AT13: relay_broadcast ────────────────────────────────────

describe("Verifier: relay_broadcast behavior", () => {
    test("AT12: exclude_self defaults to true when omitted", async () => {
        const { hub, fires } = makeMock();
        await callTool(hub, "relay_broadcast", { question: "status?" });
        expect(fires[0]!.exclude_self).toBe(true);
    });

    test("AT13: exclude_self=false explicitly sets it false in payload", async () => {
        const { hub, fires } = makeMock();
        await callTool(hub, "relay_broadcast", { question: "status?", exclude_self: false });
        expect(fires[0]!.exclude_self).toBe(false);
    });

    test("AT14: broadcast_id starts with 'bcast-codex-' + peer name", async () => {
        const { hub, fires } = makeMock();
        const result = await callTool(hub, "relay_broadcast", { question: "ping?" });
        const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        expect(parsed.broadcast_id as string).toMatch(/^bcast-codex-test-peer-/);
        expect(fires[0]!.broadcast_id).toBe(parsed.broadcast_id);
    });
});

// ── AT15–AT16: relay_reply fallback path ─────────────────────────

describe("Verifier: relay_reply fallback", () => {
    test("AT15: unknown ask_id falls back to fireSend reply (not sendAndWait)", async () => {
        const { hub, sends, fires } = makeMock();
        const result = await callTool(hub, "relay_reply", { ask_id: "unknown-ask-999", text: "ok" });
        expect(result.isError).toBeUndefined();
        expect(sends).toHaveLength(0); // no sendAndWait called
        expect(fires[0]!.type).toBe("reply");
        expect(fires[0]!.ask_id).toBe("unknown-ask-999");
    });
});

// ── AT16: hub.sendAndWait throws ─────────────────────────────────

describe("Verifier: hub error propagation", () => {
    test("AT16: FIXED — hub.sendAndWait throws → callTool catches and returns errResult", async () => {
        const hub = makeThrowingMock();
        const result = await callTool(hub, "relay_peers", {});
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        expect(parsed.code).toBe("unexpected");
    });
});

// ── AT17–AT19: Missing required args ─────────────────────────────

describe("Verifier: missing required args", () => {
    test("AT17: relay_room missing text → bad_args", async () => {
        const { hub } = makeMock();
        const result = await callTool(hub, "relay_room", { room: "myroom" }); // no text
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        expect(parsed.code).toBe("bad_args");
    });

    test("AT18: relay_group_remove missing reason → bad_args", async () => {
        const { hub } = makeMock();
        const result = await callTool(hub, "relay_group_remove", { group: "g", peer: "p" }); // no reason
        expect(result.isError).toBe(true);
    });

    test("AT19: relay_group_invite missing peer → bad_args", async () => {
        const { hub } = makeMock();
        const result = await callTool(hub, "relay_group_invite", { group: "g" });
        expect(result.isError).toBe(true);
    });
});

// ── AT20: relay_rename boundaries ────────────────────────────────

describe("Verifier: relay_rename safeName boundaries", () => {
    test("AT20: 64-char name passes safeName and is accepted", async () => {
        const { hub } = makeMock({ type: "ack" });
        const result = await callTool(hub, "relay_rename", { new_name: "a".repeat(64) });
        expect(result.isError).toBeUndefined();
        expect(hub.name).toBe("a".repeat(64));
    });

    test("AT21: 65-char name rejected (safeName rejects > 64)", async () => {
        const { hub } = makeMock();
        const result = await callTool(hub, "relay_rename", { new_name: "a".repeat(65) });
        expect(result.isError).toBe(true);
    });

    test("AT22: special-char name '!@#$' rejected by safeName", async () => {
        const { hub } = makeMock();
        const result = await callTool(hub, "relay_rename", { new_name: "!@#$" });
        expect(result.isError).toBe(true);
    });

    test("AT23: empty string rejected by safeName", async () => {
        const { hub } = makeMock();
        const result = await callTool(hub, "relay_rename", { new_name: "" });
        expect(result.isError).toBe(true);
    });
});

// ── AT24–AT25: relay_inbox since_id boundary ──────────────────────

describe("Verifier: relay_inbox since_id boundary", () => {
    test("AT24: since_id exactly 64 chars is accepted (valid boundary)", async () => {
        const { hub } = makeMock({ type: "inbox_result", messages: [], remaining: 0 });
        const result = await callTool(hub, "relay_inbox", { since_id: "a".repeat(64) });
        expect(result.isError).toBeUndefined();
    });

    test("AT25: since_id exactly 65 chars rejected (> 64)", async () => {
        const { hub } = makeMock();
        const result = await callTool(hub, "relay_inbox", { since_id: "a".repeat(65) });
        expect(result.isError).toBe(true);
    });
});

// ── AT26–AT28: result helpers ─────────────────────────────────────

describe("Verifier: result helpers structure", () => {
    test("AT26: errResult sets isError=true and encodes code in JSON text", () => {
        const r = errResult("bad_args");
        expect(r.isError).toBe(true);
        const parsed = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
        expect(parsed.ok).toBe(false);
        expect(parsed.code).toBe("bad_args");
    });

    test("AT27: okResult has no isError and encodes payload as JSON", () => {
        const r = okResult({ foo: "bar", count: 42 });
        expect(r.isError).toBeUndefined();
        const parsed = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
        expect(parsed.foo).toBe("bar");
        expect(parsed.count).toBe(42);
    });
});

// ── AT28: instructions content ────────────────────────────────────

describe("Verifier: INSTRUCTIONS content", () => {
    test("AT28: instructions mention ask_id reply-first priority", async () => {
        const { INSTRUCTIONS } = await import("./instructions");
        expect(INSTRUCTIONS).toContain("ask_id");
        expect(INSTRUCTIONS).toContain("BEFORE");
    });

    test("AT29: instructions mention urgent message handling", async () => {
        const { INSTRUCTIONS } = await import("./instructions");
        expect(INSTRUCTIONS).toContain("urgent");
    });

    test("AT30: instructions mention rooms vs groups distinction", async () => {
        const { INSTRUCTIONS } = await import("./instructions");
        expect(INSTRUCTIONS).toContain("ephemeral");
        expect(INSTRUCTIONS).toContain("persistent");
    });
});
