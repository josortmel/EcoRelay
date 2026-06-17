import { describe, expect, test, beforeEach } from "bun:test";
import { ThreadTracker } from "./thread-tracker";
import type { AppServerClient, ThreadInfo } from "./app-server-client";

// ── Mock AppServerClient ──────────────────────────────────────────

type MockThreadData = {
    loaded: string[];
    threads: Map<string, ThreadInfo>;
    resumeResults: Map<string, boolean>;
};

function createMockAppServer(data: MockThreadData): AppServerClient {
    return {
        threadLoadedList: async () => ({ data: data.loaded, nextCursor: null }),
        threadRead: async (id: string) => data.threads.get(id) ?? null,
        threadResume: async (id: string) => data.resumeResults.get(id) ?? true,
    } as unknown as AppServerClient;
}

function makeThread(overrides: Partial<ThreadInfo> & { id: string }): ThreadInfo {
    return {
        preview: "some content",
        status: { type: "idle" },
        updatedAt: 1000,
        createdAt: 1000,
        ...overrides,
    };
}

// ── Discovery ─────────────────────────────────────────────────────

describe("discover", () => {
    test("finds thread on first attempt", async () => {
        const data: MockThreadData = {
            loaded: ["t1"],
            threads: new Map([["t1", makeThread({ id: "t1", updatedAt: 100 })]]),
            resumeResults: new Map([["t1", true]]),
        };
        const tracker = new ThreadTracker({ appServer: createMockAppServer(data) });
        const found = await tracker.discover();
        expect(found).toBe("t1");
        expect(tracker.getThreadId()).toBe("t1");
        tracker.close();
    });

    test("retries until thread appears", async () => {
        let calls = 0;
        const mock = {
            threadLoadedList: async () => {
                calls++;
                if (calls < 3) return { data: [], nextCursor: null };
                return { data: ["t1"], nextCursor: null };
            },
            threadRead: async () => makeThread({ id: "t1" }),
            threadResume: async () => true,
        } as unknown as AppServerClient;

        const tracker = new ThreadTracker({ appServer: mock });
        const found = await tracker.discover();
        expect(found).toBe("t1");
        expect(calls).toBeGreaterThanOrEqual(3);
        tracker.close();
    });

    test("returns null after exhausting attempts on empty list", async () => {
        const mock = {
            threadLoadedList: async () => ({ data: [], nextCursor: null }),
            threadRead: async () => null,
            threadResume: async () => true,
        } as unknown as AppServerClient;

        // Override retry timing for test speed
        const tracker = new ThreadTracker({ appServer: mock });
        // We can't easily override the constants, so we test the logic
        // by using close() to abort early
        setTimeout(() => tracker.close(), 100);
        const found = await tracker.discover();
        expect(found).toBeNull();
    });

    test("selects by updatedAt descending", async () => {
        const data: MockThreadData = {
            loaded: ["old", "new"],
            threads: new Map([
                ["old", makeThread({ id: "old", updatedAt: 100, preview: "old content" })],
                ["new", makeThread({ id: "new", updatedAt: 999, preview: "new content" })],
            ]),
            resumeResults: new Map([["old", true], ["new", true]]),
        };
        const tracker = new ThreadTracker({ appServer: createMockAppServer(data) });
        const found = await tracker.discover();
        expect(found).toBe("new");
        tracker.close();
    });

    test("skips archived threads", async () => {
        const data: MockThreadData = {
            loaded: ["archived", "live"],
            threads: new Map([
                ["archived", makeThread({ id: "archived", updatedAt: 999, status: { type: "archived" }, preview: "old" })],
                ["live", makeThread({ id: "live", updatedAt: 100, preview: "active content" })],
            ]),
            resumeResults: new Map([["archived", true], ["live", true]]),
        };
        const tracker = new ThreadTracker({ appServer: createMockAppServer(data) });
        const found = await tracker.discover();
        expect(found).toBe("live");
        tracker.close();
    });

    test("skips empty-preview threads, falls back if all empty", async () => {
        const data: MockThreadData = {
            loaded: ["empty", "also-empty"],
            threads: new Map([
                ["empty", makeThread({ id: "empty", updatedAt: 200, preview: "" })],
                ["also-empty", makeThread({ id: "also-empty", updatedAt: 100, preview: "" })],
            ]),
            resumeResults: new Map([["empty", true], ["also-empty", true]]),
        };
        const tracker = new ThreadTracker({ appServer: createMockAppServer(data) });
        const found = await tracker.discover();
        // Falls back to all non-archived, picks by updatedAt
        expect(found).toBe("empty");
        tracker.close();
    });

    test("skips thread where resume returns false, picks next", async () => {
        const data: MockThreadData = {
            loaded: ["stale", "good"],
            threads: new Map([
                ["stale", makeThread({ id: "stale", updatedAt: 999, preview: "stale" })],
                ["good", makeThread({ id: "good", updatedAt: 100, preview: "good" })],
            ]),
            resumeResults: new Map([["stale", false], ["good", true]]),
        };
        const tracker = new ThreadTracker({ appServer: createMockAppServer(data) });
        const found = await tracker.discover();
        expect(found).toBe("good");
        tracker.close();
    });

    test("returns null if all candidates fail resume", async () => {
        const data: MockThreadData = {
            loaded: ["bad1", "bad2"],
            threads: new Map([
                ["bad1", makeThread({ id: "bad1", preview: "a" })],
                ["bad2", makeThread({ id: "bad2", preview: "b" })],
            ]),
            resumeResults: new Map([["bad1", false], ["bad2", false]]),
        };
        const tracker = new ThreadTracker({ appServer: createMockAppServer(data) });
        setTimeout(() => tracker.close(), 100);
        const found = await tracker.discover();
        expect(found).toBeNull();
        tracker.close();
    });
});

// ── Status tracking ───────────────────────────────────────────────

describe("handleThreadStatusChanged", () => {
    test("tracks idle status", async () => {
        const data: MockThreadData = {
            loaded: ["t1"],
            threads: new Map([["t1", makeThread({ id: "t1" })]]),
            resumeResults: new Map([["t1", true]]),
        };
        const tracker = new ThreadTracker({ appServer: createMockAppServer(data) });
        await tracker.discover();
        expect(tracker.getStatus()).toBe("unknown");

        tracker.handleThreadStatusChanged({ threadId: "t1", status: { type: "idle" } });
        expect(tracker.getStatus()).toBe("idle");
        tracker.close();
    });

    test("tracks active status", async () => {
        const data: MockThreadData = {
            loaded: ["t1"],
            threads: new Map([["t1", makeThread({ id: "t1" })]]),
            resumeResults: new Map([["t1", true]]),
        };
        const tracker = new ThreadTracker({ appServer: createMockAppServer(data) });
        await tracker.discover();
        tracker.handleThreadStatusChanged({ threadId: "t1", status: { type: "active" } });
        expect(tracker.getStatus()).toBe("active");
        tracker.close();
    });

    test("ignores status for non-tracked thread", async () => {
        const data: MockThreadData = {
            loaded: ["t1"],
            threads: new Map([["t1", makeThread({ id: "t1" })]]),
            resumeResults: new Map([["t1", true]]),
        };
        const tracker = new ThreadTracker({ appServer: createMockAppServer(data) });
        await tracker.discover();
        tracker.handleThreadStatusChanged({ threadId: "other", status: { type: "active" } });
        expect(tracker.getStatus()).toBe("unknown");
        tracker.close();
    });

    test("fires onIdle callback on transition to idle", async () => {
        const idleEvents: string[] = [];
        const data: MockThreadData = {
            loaded: ["t1"],
            threads: new Map([["t1", makeThread({ id: "t1" })]]),
            resumeResults: new Map([["t1", true]]),
        };
        const tracker = new ThreadTracker({
            appServer: createMockAppServer(data),
            onIdle: (id) => idleEvents.push(id),
        });
        await tracker.discover();
        tracker.handleThreadStatusChanged({ threadId: "t1", status: { type: "active" } });
        tracker.handleThreadStatusChanged({ threadId: "t1", status: { type: "idle" } });
        expect(idleEvents).toEqual(["t1"]);
        tracker.close();
    });

    test("fires onActive callback on transition to active", async () => {
        const activeEvents: string[] = [];
        const data: MockThreadData = {
            loaded: ["t1"],
            threads: new Map([["t1", makeThread({ id: "t1" })]]),
            resumeResults: new Map([["t1", true]]),
        };
        const tracker = new ThreadTracker({
            appServer: createMockAppServer(data),
            onActive: (id) => activeEvents.push(id),
        });
        await tracker.discover();
        tracker.handleThreadStatusChanged({ threadId: "t1", status: { type: "active" } });
        expect(activeEvents).toEqual(["t1"]);
        tracker.close();
    });

    test("does not fire onIdle if already idle", async () => {
        const idleEvents: string[] = [];
        const data: MockThreadData = {
            loaded: ["t1"],
            threads: new Map([["t1", makeThread({ id: "t1" })]]),
            resumeResults: new Map([["t1", true]]),
        };
        const tracker = new ThreadTracker({
            appServer: createMockAppServer(data),
            onIdle: (id) => idleEvents.push(id),
        });
        await tracker.discover();
        tracker.handleThreadStatusChanged({ threadId: "t1", status: { type: "idle" } });
        tracker.handleThreadStatusChanged({ threadId: "t1", status: { type: "idle" } });
        expect(idleEvents).toEqual(["t1"]);
        tracker.close();
    });
});

// ── getThreadId / getStatus ───────────────────────────────────────

describe("getters", () => {
    test("getThreadId returns null before discovery", () => {
        const mock = createMockAppServer({
            loaded: [],
            threads: new Map(),
            resumeResults: new Map(),
        });
        const tracker = new ThreadTracker({ appServer: mock });
        expect(tracker.getThreadId()).toBeNull();
        expect(tracker.getStatus()).toBe("unknown");
        tracker.close();
    });
});

// ── close ─────────────────────────────────────────────────────────

// ── VS18: future-dated + unsafe id ────────────────────────────────

describe("VS18 guards", () => {
    test("skips future-dated thread (updatedAt > now+5s)", async () => {
        const data: MockThreadData = {
            loaded: ["future", "normal"],
            threads: new Map([
                ["future", makeThread({ id: "future", updatedAt: Date.now() + 10_000, preview: "future" })],
                ["normal", makeThread({ id: "normal", updatedAt: 100, preview: "ok" })],
            ]),
            resumeResults: new Map([["future", true], ["normal", true]]),
        };
        const tracker = new ThreadTracker({ appServer: createMockAppServer(data) });
        const found = await tracker.discover();
        expect(found).toBe("normal");
        tracker.close();
    });

    test("VS47: skips thread with id > 256 chars", async () => {
        const longId = "a".repeat(257);
        const data: MockThreadData = {
            loaded: [longId, "ok"],
            threads: new Map([
                [longId, makeThread({ id: longId, updatedAt: 999, preview: "long" })],
                ["ok", makeThread({ id: "ok", updatedAt: 100, preview: "ok" })],
            ]),
            resumeResults: new Map([[longId, true], ["ok", true]]),
        };
        const tracker = new ThreadTracker({ appServer: createMockAppServer(data) });
        const found = await tracker.discover();
        expect(found).toBe("ok");
        tracker.close();
    });

    test("skips thread with unsafe id characters", async () => {
        const data: MockThreadData = {
            loaded: ["../evil", "safe-id"],
            threads: new Map([
                ["../evil", makeThread({ id: "../evil", updatedAt: 999, preview: "evil" })],
                ["safe-id", makeThread({ id: "safe-id", updatedAt: 100, preview: "ok" })],
            ]),
            resumeResults: new Map([["../evil", true], ["safe-id", true]]),
        };
        const tracker = new ThreadTracker({ appServer: createMockAppServer(data) });
        const found = await tracker.discover();
        expect(found).toBe("safe-id");
        tracker.close();
    });
});

// ── pollCycle behavior ────────────────────────────────────────────

describe("pollCycle (via discover+tracking)", () => {
    test("returns null when all resume fail, does not throw", async () => {
        const data: MockThreadData = {
            loaded: ["a", "b"],
            threads: new Map([
                ["a", makeThread({ id: "a", preview: "x" })],
                ["b", makeThread({ id: "b", preview: "y" })],
            ]),
            resumeResults: new Map([["a", false], ["b", false]]),
        };
        const tracker = new ThreadTracker({ appServer: createMockAppServer(data) });
        setTimeout(() => tracker.close(), 100);
        const found = await tracker.discover();
        expect(found).toBeNull();
        tracker.close();
    });

    test("discovery picks resumed thread even with mixed results", async () => {
        const data: MockThreadData = {
            loaded: ["stale", "ok"],
            threads: new Map([
                ["stale", makeThread({ id: "stale", updatedAt: 999, preview: "s" })],
                ["ok", makeThread({ id: "ok", updatedAt: 100, preview: "o" })],
            ]),
            resumeResults: new Map([["stale", false], ["ok", true]]),
        };
        const tracker = new ThreadTracker({ appServer: createMockAppServer(data) });
        const found = await tracker.discover();
        expect(found).toBe("ok");
        tracker.close();
    });
});

// ── IC1: onThreadChanged ──────────────────────────────────────────

describe("onThreadChanged", () => {
    test("fires on initial discovery", async () => {
        const changes: Array<{ id: string; cwd?: string }> = [];
        const data: MockThreadData = {
            loaded: ["t1"],
            threads: new Map([["t1", makeThread({ id: "t1", cwd: "/project" })]]),
            resumeResults: new Map([["t1", true]]),
        };
        const tracker = new ThreadTracker({
            appServer: createMockAppServer(data),
            onThreadChanged: (id, cwd) => changes.push({ id, cwd }),
        });
        await tracker.discover();
        expect(changes).toHaveLength(1);
        expect(changes[0]!.id).toBe("t1");
        tracker.close();
    });
});

describe("close", () => {
    test("close stops polling and is idempotent", async () => {
        const data: MockThreadData = {
            loaded: ["t1"],
            threads: new Map([["t1", makeThread({ id: "t1" })]]),
            resumeResults: new Map([["t1", true]]),
        };
        const tracker = new ThreadTracker({ appServer: createMockAppServer(data) });
        await tracker.discover();
        tracker.close();
        tracker.close();
        expect(tracker.getThreadId()).toBe("t1");
    });
});
