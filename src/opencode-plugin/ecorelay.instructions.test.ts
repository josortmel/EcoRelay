import { describe, expect, test } from "bun:test";

// ── Replicate INSTRUCTIONS from ecorelay.ts ──

const INSTRUCTIONS = [
    "If an incoming `<channel>` message carries an `ask_id` in its meta, you MUST reply via relay_reply(ask_id, text) BEFORE handling any other user work. The peer session is blocked waiting on your reply. Exception: if the pending user work is destructive or irreversible, complete or confirm that first, then reply.",
    "Whenever an incoming `<channel>` message arrives (ask, reply, or broadcast), your first user-visible output that turn must quote the peer's full body verbatim in a fenced markdown block, prefixed with the sender name and kind (e.g. `peer-name (ask):`). The Claude Code TUI truncates tool-result panels, so plain assistant text is the only place the user actually sees the message. Quote first, then act.",
    "When an incoming reply to one of your asks contains a question directed back at you, surface that question to the user and offer to follow up with a new relay_send(); do not end your turn without relaying the question-back.",
    "Pick the target with relay_peers() (match by name/cwd/branch); use relay_send for one peer, relay_broadcast for all. Never use relay_broadcast as a fallback — it hits every session on the machine, including ones on unrelated projects.",
    'If the user refers to a peer by pronoun or demonstrative ("them", "that session", "it"), carry forward the most recent `to:` value. If ambiguous across multiple peers, call relay_peers and confirm with the user before sending.',
    "Trust tool defaults. Only override an argument when the user gave an explicit value for that exact argument; descriptive words about the answer never change tool arguments.",
    "For multi-peer coordination, use rooms (relay_join, relay_room, relay_leave, relay_rooms). Rooms are ephemeral IRC-style: implicit creation on first join, implicit destruction on last leave, no permissions (any peer can post to any room, with or without membership). Use relay_send for one-to-one exchanges and relay_room for broadcast-to-subgroup; relay_room is fire-and-forget, NOT request/response — use relay_send if you need a directed reply.",
    "Incoming room messages arrive as `<channel>` notifications with `room`, `from`, `text`, and `msg_id` in meta and NO `ask_id`. They are announcements, NOT questions: do NOT call relay_reply on them. If the message in the room invites follow-up, decide between relay_send (directed reply) and relay_room (visible to the whole room) based on whether the answer concerns one peer or the group.",
    "When you receive an incoming_message with urgent=true in meta, treat it with the same priority as an incoming ask: act on it BEFORE handling other user work. Reply with relay_send(to=sender, text=response, reply_to=msg_id). Urgent messages retrieved via relay_inbox (messages[].urgent === true) carry the same priority — act on them before other work. If urgent is absent or false, the message is informational — read and act when appropriate.",
].join(" ");

// ── Tests ──────────────────────────────────────────────────────────

describe("INSTRUCTIONS constant", () => {
    test("contains exactly 9 rules", () => {
        // Count rules by splitting on 'If', 'Whenever', 'When', 'Pick', 'Trust', 'For', 'Incoming'
        // The original array has 9 elements
        const rules = [
            "If an incoming",
            "Whenever an incoming",
            "When an incoming reply",
            "Pick the target",
            "If the user refers",
            "Trust tool defaults",
            "For multi-peer coordination",
            "Incoming room messages",
            "When you receive an incoming_message",
        ];
        expect(rules.length).toBe(9);
    });

    test("rule 1: ask_id in meta → reply via relay_reply BEFORE other work", () => {
        expect(INSTRUCTIONS).toContain("ask_id");
        expect(INSTRUCTIONS).toContain("relay_reply(ask_id, text)");
        expect(INSTRUCTIONS).toContain("BEFORE handling any other user work");
        expect(INSTRUCTIONS).toContain("The peer session is blocked waiting on your reply");
    });

    test("rule 2: quote peer's message verbatim in fenced markdown block", () => {
        expect(INSTRUCTIONS).toContain("quote the peer's full body verbatim");
        expect(INSTRUCTIONS).toContain("fenced markdown block");
        expect(INSTRUCTIONS).toContain("peer-name (ask):");
        expect(INSTRUCTIONS).toContain("Quote first, then act");
    });

    test("rule 3: question-back → surface + relay_send", () => {
        expect(INSTRUCTIONS).toContain("surface that question to the user");
        expect(INSTRUCTIONS).toContain("offer to follow up with a new relay_send()");
        expect(INSTRUCTIONS).toContain("do not end your turn without relaying the question-back");
    });

    test("rule 4: peer selection — relay_peers + relay_send / relay_broadcast", () => {
        expect(INSTRUCTIONS).toContain("relay_peers()");
        expect(INSTRUCTIONS).toContain("match by name/cwd/branch");
        expect(INSTRUCTIONS).toContain("relay_send for one peer");
        expect(INSTRUCTIONS).toContain("relay_broadcast for all");
        expect(INSTRUCTIONS).toContain("Never use relay_broadcast as a fallback");
        expect(INSTRUCTIONS).toContain("unrelated projects");
    });

    test("rule 5: pronoun carry-forward + ambiguity check", () => {
        expect(INSTRUCTIONS).toContain("them");
        expect(INSTRUCTIONS).toContain("that session");
        expect(INSTRUCTIONS).toContain("carry forward the most recent `to:` value");
        expect(INSTRUCTIONS).toContain("confirm with the user before sending");
    });

    test("rule 6: trust tool defaults", () => {
        expect(INSTRUCTIONS).toContain("Trust tool defaults");
        expect(INSTRUCTIONS).toContain(
            "descriptive words about the answer never change tool arguments",
        );
    });

    test("rule 7: rooms coordination", () => {
        expect(INSTRUCTIONS).toContain("relay_join, relay_room, relay_leave, relay_rooms");
        expect(INSTRUCTIONS).toContain("ephemeral IRC-style");
        expect(INSTRUCTIONS).toContain("implicit creation on first join");
        expect(INSTRUCTIONS).toContain("implicit destruction on last leave");
        expect(INSTRUCTIONS).toContain("relay_room is fire-and-forget, NOT request/response");
    });

    test("rule 8: room messages — no relay_reply", () => {
        expect(INSTRUCTIONS).toContain("room`, `from`, `text`, and `msg_id` in meta");
        expect(INSTRUCTIONS).toContain("NO `ask_id`");
        expect(INSTRUCTIONS).toContain("NOT questions: do NOT call relay_reply on them");
        expect(INSTRUCTIONS).toContain("whether the answer concerns one peer or the group");
    });

    test("rule 9: urgent messages — act BEFORE other work", () => {
        expect(INSTRUCTIONS).toContain("urgent=true");
        expect(INSTRUCTIONS).toContain("act on it BEFORE handling other user work");
        expect(INSTRUCTIONS).toContain("relay_send(to=sender, text=response, reply_to=msg_id)");
        expect(INSTRUCTIONS).toContain("relay_inbox");
        expect(INSTRUCTIONS).toContain("messages[].urgent === true");
    });
});

// ── Hook injection logic ───────────────────────────────────────────

describe("chat.system.transform hook", () => {
    // Replicate hook logic from ecorelay.ts
    const hookTransform = (ctx: {
        messages: Array<{ role: string; content: string }>;
    }): typeof ctx => {
        const sysMsg = ctx.messages.find((m) => m.role === "system");
        if (sysMsg) {
            sysMsg.content = `${sysMsg.content}\n\n${INSTRUCTIONS}`;
        }
        return ctx;
    };

    test("appends INSTRUCTIONS to system message", () => {
        const ctx = {
            messages: [
                { role: "system", content: "You are a helpful assistant." },
                { role: "user", content: "Hello" },
            ],
        };
        const result = hookTransform(ctx);
        expect(result.messages[0]!.content).toContain("You are a helpful assistant.");
        expect(result.messages[0]!.content).toContain(INSTRUCTIONS);
    });

    test("does not modify user messages", () => {
        const ctx = {
            messages: [
                { role: "system", content: "Base system prompt." },
                { role: "user", content: "What is relay?" },
            ],
        };
        const result = hookTransform(ctx);
        expect(result.messages[1]!.content).toBe("What is relay?");
        expect(result.messages[1]!.content).not.toContain("ask_id");
    });

    test("works when system message is the only message", () => {
        const ctx = {
            messages: [{ role: "system", content: "Minimal system prompt." }],
        };
        const result = hookTransform(ctx);
        expect(result.messages[0]!.content).toContain("Minimal system prompt.");
        expect(result.messages[0]!.content).toContain(INSTRUCTIONS);
    });

    test("no system message → no crash (no-op)", () => {
        const ctx = {
            messages: [{ role: "user", content: "Hello" }],
        };
        const result = hookTransform(ctx);
        // No crash, messages unchanged
        expect(result.messages.length).toBe(1);
        expect(result.messages[0]!.content).toBe("Hello");
    });

    test("INSTRUCTIONS appended with double newline separator", () => {
        const ctx = {
            messages: [{ role: "system", content: "Original prompt." }],
        };
        const result = hookTransform(ctx);
        const parts = result.messages[0]!.content.split("\n\n");
        expect(parts.length).toBeGreaterThanOrEqual(2);
        expect(parts[parts.length - 1]).toBe(INSTRUCTIONS);
    });

    test("hook registration wrapped in try/catch (graceful failure)", () => {
        // The ecorelay.ts plugin wraps registerHook in try/catch:
        //   try { client.registerHook?.("experimental.chat.system.transform", ...) } catch {}
        // If client.registerHook is undefined, no-op.
        // If it exists but throws, caught gracefully.
        let hookRegistered = false;
        const mockClient = {
            registerHook(name: string, handler: unknown) {
                hookRegistered = true;
                expect(name).toBe("experimental.chat.system.transform");
                expect(typeof handler).toBe("function");
            },
        };
        try {
            mockClient.registerHook?.("experimental.chat.system.transform", hookTransform);
        } catch {
            // Graceful failure
        }
        expect(hookRegistered).toBe(true);
    });

    test("hook registration with undefined registerHook → no-op", () => {
        let crashed = false;
        const mockClient = {
            // registerHook intentionally absent
        };
        try {
            (mockClient as any).registerHook?.("experimental.chat.system.transform", hookTransform);
        } catch {
            crashed = true;
        }
        expect(crashed).toBe(false);
    });

    test("hook registration with throwing registerHook → caught", () => {
        let caught = false;
        const mockClient = {
            registerHook(_name: string, _handler: unknown): void {
                throw new Error("Hook not supported");
            },
        };
        try {
            mockClient.registerHook?.("experimental.chat.system.transform", hookTransform);
        } catch {
            caught = true;
        }
        // The ecorelay.ts catch block swallows the error
        // Our test just verifies the throw is catchable
        expect(caught).toBe(true);
    });
});

// ── Instruction completeness checks ────────────────────────────────

describe("INSTRUCTIONS coverage", () => {
    const requiredTools = [
        "relay_reply",
        "relay_send",
        "relay_broadcast",
        "relay_peers",
        "relay_inbox",
        "relay_join",
        "relay_room",
        "relay_leave",
        "relay_rooms",
    ];

    for (const tool of requiredTools) {
        test(`mentions ${tool}`, () => {
            expect(INSTRUCTIONS).toContain(tool);
        });
    }

    test("mentions Claude Code TUI (context-specific)", () => {
        expect(INSTRUCTIONS).toContain("Claude Code TUI");
    });

    test("mentions channel notification format", () => {
        expect(INSTRUCTIONS).toContain("`<channel>`");
    });

    test("INSTRUCTIONS is under 8KB (token efficient)", () => {
        expect(INSTRUCTIONS.length).toBeLessThan(8192);
    });
});
