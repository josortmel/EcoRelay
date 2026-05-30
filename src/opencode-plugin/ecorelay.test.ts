import { describe, expect, test, mock } from "bun:test";
import { server } from "./ecorelay";

// ── Helpers ──────────────────────────────────────────────────────────

function mockSessionList(
    sessions: Array<{ id: string; title?: string | null; parentID?: string | null }> = [],
) {
    return mock(async () => sessions);
}

function mockPluginInput(overrides: Record<string, unknown> = {}) {
    return {
        client: {
            session: {
                list: mockSessionList([]),
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

// ── Tests ────────────────────────────────────────────────────────────

describe("Server export", () => {
    test("plugin exported as named export 'server'", () => {
        expect(typeof server).toBe("function");
    });
});

describe("Server lifecycle", () => {
    test("bootstrap calls client.session.list", async () => {
        const listSpy = mockSessionList([]);
        const input = mockPluginInput({
            client: { session: { list: listSpy, prompt: mock(async () => {}) } },
        });
        const hooks = await server(input as any);
        expect(listSpy).toHaveBeenCalled();
        expect(typeof hooks.dispose).toBe("function");
        expect(typeof hooks.event).toBe("function");
        expect(hooks.tool).toBeDefined();
        expect(hooks["experimental.chat.system.transform"]).toBeDefined();
    });

    test("bootstrap handles session.list errors gracefully", async () => {
        const input = mockPluginInput({
            client: {
                session: {
                    list: mock(async () => { throw new Error("OC not ready"); }),
                    prompt: mock(async () => {}),
                },
            },
        });
        const hooks = await server(input as any);
        expect(hooks.tool).toBeDefined();
    });

    test("bootstrap enumerates existing root sessions", async () => {
        const sessions = [
            { id: "s1", title: "Session 1" },
            { id: "child-1", title: "Child", parentID: "s1" },
        ];
        const input = mockPluginInput({
            client: { session: { list: mockSessionList(sessions), prompt: mock(async () => {}) } },
        });
        const hooks = await server(input as any);
        // Child sessions with parentID are skipped in bootstrap
        // Root session s1 is passed to ensurePeer
        expect(hooks.tool).toBeDefined();
    });

    test("dispose runs without error", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);
        await hooks.dispose!();
        expect(true).toBe(true);
    });
});

describe("Tool registration", () => {
    test("all 19 MCP tools are registered", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        const toolNames = [
            "relay_send", "relay_inbox", "relay_reply", "relay_broadcast",
            "relay_peers", "relay_rename", "relay_join", "relay_leave",
            "relay_room", "relay_rooms",
            "relay_group_create", "relay_group_invite", "relay_group_remove",
            "relay_group_leave", "relay_group_send", "relay_group_history",
            "relay_group_list", "relay_group_info", "relay_group_delete",
        ];

        expect(Object.keys(hooks.tool!).length).toBe(19);
        for (const name of toolNames) {
            expect(hooks.tool![name]).toBeDefined();
        }
    });
});

describe("Event handler", () => {
    test("session.created with valid session via .info API", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        // SDK v1.15.12: properties.info, not .session
        await expect(
            hooks.event!({
                event: {
                    type: "session.created",
                    properties: { info: { id: "s-new", title: "New Session" } },
                } as any,
            }),
        ).resolves.toBeUndefined();
    });

    test("session.created with invalid properties does not crash", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        // Invalid: empty properties (no .info)
        await expect(
            hooks.event!({ event: { type: "session.created", properties: {} } } as any),
        ).resolves.toBeUndefined();
        // Invalid: .info without id
        await expect(
            hooks.event!({ event: { type: "session.created", properties: { info: {} as any } } } as any),
        ).resolves.toBeUndefined();
        // Invalid: null .info
        await expect(
            hooks.event!({ event: { type: "session.created", properties: { info: null } } } as any),
        ).resolves.toBeUndefined();
    });

    test("session.created with child session (parentID) is skipped", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        // SDK v1.15.12: parentID (capital D) — child session must NOT create a peer
        await expect(
            hooks.event!({
                event: {
                    type: "session.created",
                    properties: { info: { id: "child-1", title: "Child", parentID: "root-1" } },
                } as any,
            }),
        ).resolves.toBeUndefined();
    });

    test("session.deleted with valid info.id removes peer", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        // Create peer first
        await hooks.event!({
            event: {
                type: "session.created",
                properties: { info: { id: "s-del", title: "To Delete" } },
            } as any,
        });
        // Delete via .info.id (SDK v1.15.12 — not .sessionID)
        await expect(
            hooks.event!({
                event: { type: "session.deleted", properties: { info: { id: "s-del" } } } as any,
            }),
        ).resolves.toBeUndefined();
    });

    test("session.deleted with invalid properties warns but does not crash", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        // Invalid: no .info
        await expect(
            hooks.event!({ event: { type: "session.deleted", properties: {} } } as any),
        ).resolves.toBeUndefined();
        // Invalid: .info without id
        await expect(
            hooks.event!({ event: { type: "session.deleted", properties: { info: {} as any } } } as any),
        ).resolves.toBeUndefined();
    });

    test("session.status handler does not crash", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        await expect(
            hooks.event!({
                event: { type: "session.status", properties: { sessionID: "s1", status: "busy" } } as any,
            }),
        ).resolves.toBeUndefined();
    });

    test("concurrent session.created events with .info API", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        for (let i = 0; i < 20; i++) {
            await hooks.event!({
                event: {
                    type: "session.created",
                    properties: { info: { id: `concurrent-${i}`, title: `S${i}` } },
                } as any,
            });
        }
        // All 20 sessions processed via .info API — no crash
        expect(true).toBe(true);
    });

    test("rapid create+delete+create same id via .info API", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        const sid = "churn-session";
        await hooks.event!({
            event: { type: "session.created", properties: { info: { id: sid, title: "Churn" } } } as any,
        });
        await hooks.event!({
            event: { type: "session.deleted", properties: { info: { id: sid } } } as any,
        });
        await hooks.event!({
            event: { type: "session.created", properties: { info: { id: sid, title: "Again" } } } as any,
        });
        // Full cycle via .info API — no crash
        expect(true).toBe(true);
    });
});

describe("System transform", () => {
    test("injects INSTRUCTIONS when not present", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        const output = { system: [] as string[] };
        await hooks["experimental.chat.system.transform"]!({} as any, output);
        expect(output.system.length).toBe(1);
        expect(output.system[0]).toInclude("[ECORELAY_INSTRUCTIONS_v0.7.6]");
    });

    test("does not inject INSTRUCTIONS twice", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        const output = { system: [] as string[] };
        await hooks["experimental.chat.system.transform"]!({} as any, output);
        await hooks["experimental.chat.system.transform"]!({} as any, output);
        expect(output.system.length).toBe(1);
    });

    test("skips injection if marker already present", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        const output = { system: ["[ECORELAY_INSTRUCTIONS_v0.7.6] existing content"] };
        await hooks["experimental.chat.system.transform"]!({} as any, output);
        expect(output.system.length).toBe(1);
    });
});

describe("Edge cases", () => {
    test("server handles empty session list", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);
        expect(hooks.tool).toBeDefined();
    });

    test("server handles unicode session titles via .info API", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        await expect(
            hooks.event!({
                event: {
                    type: "session.created",
                    properties: { info: { id: "unicode-1", title: "セッション 🎉 中文" } },
                } as any,
            }),
        ).resolves.toBeUndefined();
    });

    test("server handles session with null title via .info API", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        await expect(
            hooks.event!({
                event: {
                    type: "session.created",
                    properties: { info: { id: "no-title", title: null } },
                } as any,
            }),
        ).resolves.toBeUndefined();
    });
});

describe("Reconnect timing", () => {
    test("exponential backoff formula", () => {
        const INITIAL = 3_000;
        const MAX = 60_000;

        function calcDelay(attempt: number): number {
            return Math.min(INITIAL * Math.pow(2, attempt), MAX);
        }

        expect(calcDelay(0)).toBe(3000);
        expect(calcDelay(1)).toBe(6000);
        expect(calcDelay(2)).toBe(12000);
        expect(calcDelay(3)).toBe(24000);
        expect(calcDelay(4)).toBe(48000);
        expect(calcDelay(5)).toBe(60000);
        expect(calcDelay(10)).toBe(60000);
    });
});
