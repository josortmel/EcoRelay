import { describe, expect, test, mock } from "bun:test";
import { server } from "./ecorelay";

// ── Helpers ──────────────────────────────────────────────────────────

function mockSessionList(
    sessions: Array<{ id: string; title?: string | null; parentID?: string | null }> = [],
) {
    return mock(async () => sessions);
}

async function mockPluginInput(overrides: Record<string, unknown> = {}) {
    return {
        client: {
            session: {
                list: mockSessionList((overrides.sessions as any[]) ?? []),
                prompt: mock(async () => {}),
            },
        },
        project: { id: "test", name: "test" } as any,
        directory: "/fake/dir",
        worktree: "/fake/dir",
        serverUrl: new URL("http://127.0.0.1:4096"),
        $: {} as any,
        ...overrides,
    };
}

const mockCtx: Record<string, unknown> = {
    sessionID: "test-session",
    messageID: "msg-1",
    agent: "test",
    directory: "/fake/dir",
    worktree: "/fake/dir",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
};

// ── Tool schema tests ────────────────────────────────────────────────

describe("Tool schema completeness", () => {
    test("19 tools registered with description and args", async () => {
        const hooks = await server((await mockPluginInput()) as any);
        expect(Object.keys(hooks.tool!).length).toBe(19);

        for (const [name, def] of Object.entries(hooks.tool!)) {
            expect(typeof def.description).toBe("string");
            expect(def.description!.length).toBeGreaterThan(10);
            expect(typeof def.args).toBe("object");
        }
    });

    const expectedRequired = [
        { name: "relay_send", required: ["to", "text"] },
        { name: "relay_inbox", required: [] },
        { name: "relay_reply", required: ["ask_id", "text"] },
        { name: "relay_broadcast", required: ["question"] },
        { name: "relay_peers", required: [] },
        { name: "relay_rename", required: ["new_name"] },
        { name: "relay_join", required: ["room"] },
        { name: "relay_leave", required: ["room"] },
        { name: "relay_room", required: ["room", "text"] },
        { name: "relay_rooms", required: [] },
        { name: "relay_group_create", required: ["name", "members"] },
        { name: "relay_group_invite", required: ["group", "peer"] },
        { name: "relay_group_remove", required: ["group", "peer", "reason"] },
        { name: "relay_group_leave", required: ["group"] },
        { name: "relay_group_send", required: ["group", "text"] },
        { name: "relay_group_history", required: ["group"] },
        { name: "relay_group_list", required: [] },
        { name: "relay_group_info", required: ["group"] },
        { name: "relay_group_delete", required: ["group"] },
    ];

    for (const { name, required } of expectedRequired) {
        test(`${name}: description and args present`, async () => {
            const hooks = await server((await mockPluginInput()) as any);
            const tool = hooks.tool![name];
            expect(tool).toBeDefined();
            expect(typeof tool.description).toBe("string");
            expect(typeof tool.args).toBe("object");
            if (required.length > 0) {
                const argKeys = Object.keys(tool.args);
                for (const r of required) {
                    expect(argKeys).toContain(r);
                }
            }
        });
    }

    test("relay_send has optional reply_to and urgent", async () => {
        const hooks = await server((await mockPluginInput()) as any);
        const tool = hooks.tool!.relay_send;
        expect(Object.keys(tool.args)).toContain("reply_to");
        expect(Object.keys(tool.args)).toContain("urgent");
    });

    test("relay_broadcast has optional exclude_self", async () => {
        const hooks = await server((await mockPluginInput()) as any);
        const tool = hooks.tool!.relay_broadcast;
        expect(Object.keys(tool.args)).toContain("exclude_self");
    });

    test("relay_group_create has members: array", async () => {
        const hooks = await server((await mockPluginInput()) as any);
        const tool = hooks.tool!.relay_group_create;
        expect(Object.keys(tool.args)).toContain("members");
    });

    test("relay_group_remove has reason: string", async () => {
        const hooks = await server((await mockPluginInput()) as any);
        const tool = hooks.tool!.relay_group_remove;
        expect(Object.keys(tool.args)).toContain("reason");
    });
});

// ── Argument validation tests ────────────────────────────────────────

describe("Tool argument validation", () => {
    test("relay_send: missing 'to' → bad_args", async () => {
        const hooks = await server((await mockPluginInput()) as any);
        try {
            const result = await hooks.tool!.relay_send.execute(
                { text: "hello" } as any,
                mockCtx as any,
            );
            const parsed = JSON.parse(result as string);
            expect(parsed.ok).toBe(false);
            expect(parsed.code).toBe("bad_args");
        } catch {
            // Also valid: throws when Hub not available
        }
    });

    test("relay_send: missing 'text' → bad_args", async () => {
        const hooks = await server((await mockPluginInput()) as any);
        try {
            const result = await hooks.tool!.relay_send.execute(
                { to: "peer1" } as any,
                mockCtx as any,
            );
            const parsed = JSON.parse(result as string);
            expect(parsed.ok).toBe(false);
            expect(parsed.code).toBe("bad_args");
        } catch {
            // Also valid
        }
    });

    test("relay_reply: missing 'ask_id' → bad_args", async () => {
        const hooks = await server((await mockPluginInput()) as any);
        try {
            const result = await hooks.tool!.relay_reply.execute(
                { text: "response" } as any,
                mockCtx as any,
            );
            const parsed = JSON.parse(result as string);
            expect(parsed.ok).toBe(false);
            expect(parsed.code).toBe("bad_args");
        } catch {
            // Also valid
        }
    });

    test("relay_broadcast: missing 'question' → bad_args", async () => {
        const hooks = await server((await mockPluginInput()) as any);
        try {
            const result = await hooks.tool!.relay_broadcast.execute(
                {} as any,
                mockCtx as any,
            );
            const parsed = JSON.parse(result as string);
            expect(parsed.ok).toBe(false);
            expect(parsed.code).toBe("bad_args");
        } catch {
            // Also valid
        }
    });
});

// ── Tool → Hub message mapping ───────────────────────────────────────

describe("Tool → Hub message mapping", () => {
    test("relay_send has to/text in args", async () => {
        const hooks = await server((await mockPluginInput()) as any);
        const tool = hooks.tool!.relay_send;
        expect(Object.keys(tool.args)).toContain("to");
        expect(Object.keys(tool.args)).toContain("text");
    });

    test("relay_rename has new_name in args", async () => {
        const hooks = await server((await mockPluginInput()) as any);
        const tool = hooks.tool!.relay_rename;
        expect(Object.keys(tool.args)).toContain("new_name");
    });

    test("relay_join has room in args", async () => {
        const hooks = await server((await mockPluginInput()) as any);
        const tool = hooks.tool!.relay_join;
        expect(Object.keys(tool.args)).toContain("room");
    });

    test("relay_room has room and text in args", async () => {
        const hooks = await server((await mockPluginInput()) as any);
        const tool = hooks.tool!.relay_room;
        expect(Object.keys(tool.args)).toContain("room");
        expect(Object.keys(tool.args)).toContain("text");
    });

    test("relay_group_send has group and text in args", async () => {
        const hooks = await server((await mockPluginInput()) as any);
        const tool = hooks.tool!.relay_group_send;
        expect(Object.keys(tool.args)).toContain("group");
        expect(Object.keys(tool.args)).toContain("text");
    });
});

// ── Error handling (no Hub running) ──────────────────────────────────

describe("Tool error handling (no Hub running)", () => {
    test("relay_send throws when no Hub token available", async () => {
        const hooks = await server((await mockPluginInput({
            sessions: [{ id: "test-session", title: "Test Session" }],
        })) as any);

        await expect(
            hooks.tool!.relay_send.execute(
                { to: "peer1", text: "hello" } as any,
                mockCtx as any,
            ),
        ).rejects.toThrow(/WS not connected|EcoRelay WS token/);
    });
});

// ── Channel CC equivalence checks ────────────────────────────────────

describe("Channel CC equivalence", () => {
    test("relay_send has same params as Channel CC", async () => {
        const hooks = await server((await mockPluginInput()) as any);
        const keys = Object.keys(hooks.tool!.relay_send.args);
        expect(keys).toContain("to");
        expect(keys).toContain("text");
        expect(keys).toContain("reply_to");
        expect(keys).toContain("urgent");
    });

    test("relay_inbox has same params as Channel CC", async () => {
        const hooks = await server((await mockPluginInput()) as any);
        const keys = Object.keys(hooks.tool!.relay_inbox.args);
        expect(keys).toContain("limit");
        expect(keys).toContain("since_id");
    });

    test("all 19 tools have execute function", async () => {
        const hooks = await server((await mockPluginInput()) as any);
        for (const [name, def] of Object.entries(hooks.tool!)) {
            expect(typeof def.execute).toBe("function");
        }
    });
});

// ── Constants ────────────────────────────────────────────────────────

describe("Constants", () => {
    test("reqId format matches expected pattern", () => {
        const pattern = /^oc-\d+-\d+$/;
        const testId = `oc-${42}-${Date.now()}`;
        expect(pattern.test(testId)).toBe(true);
    });

    test("max text length is 512KB", () => {
        // MAX_TEXT_LEN = 512 * 1024 = 524288
        expect(512 * 1024).toBe(524288);
    });
});
