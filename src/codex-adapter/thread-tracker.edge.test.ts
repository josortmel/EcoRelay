// Verifier edge cases — T4 thread-tracker.ts
import { describe, expect, test } from "bun:test";
import { ThreadTracker } from "./thread-tracker";
import type { AppServerClient, ThreadInfo } from "./app-server-client";

// ── Helpers ───────────────────────────────────────────────────────

type MockData = {
    loaded: string[];
    threads: Map<string, ThreadInfo>;
    resumeResults: Map<string, boolean>;
};

function makeMock(data: MockData): AppServerClient {
    return {
        threadLoadedList: async () => ({ data: data.loaded, nextCursor: null }),
        threadRead: async (id: string) => data.threads.get(id) ?? null,
        threadResume: async (id: string) => data.resumeResults.get(id) ?? true,
    } as unknown as AppServerClient;
}

function makeThread(overrides: Partial<ThreadInfo> & { id: string }): ThreadInfo {
    return { preview: "some content", status: { type: "idle" }, updatedAt: 1000, createdAt: 1000, ...overrides };
}

// ── PLAN GAP: poll behavior ───────────────────────────────────────

describe("Verifier: pollCycle (plan gap)", () => {
    test("AT1: poll switches to newer thread (updatedAt higher)", async () => {
        let readCalls = 0;
        const mock: AppServerClient = {
            threadLoadedList: async () => ({ data: ["t1", "t2"], nextCursor: null }),
            threadRead: async (id: string) => {
                readCalls++;
                if (id === "t1") return makeThread({ id: "t1", updatedAt: 100, preview: "old" });
                if (id === "t2") return makeThread({ id: "t2", updatedAt: 999, preview: "newer" });
                return null;
            },
            threadResume: async () => true,
        } as unknown as AppServerClient;

        const tracker = new ThreadTracker({ appServer: mock });
        // Manually set tracked to t1
        (tracker as unknown as Record<string, unknown>).trackedThreadId = "t1";
        (tracker as unknown as Record<string, unknown>).trackedStatus = "idle";
        (tracker as unknown as Record<string, unknown>).closed = false;

        // Call pollCycle directly (TS private, JS accessible)
        await (tracker as unknown as { pollCycle(): Promise<void> }).pollCycle();
        tracker.close();

        // t2 is newer (updatedAt 999 > 100), resumed → should switch
        expect(tracker.getThreadId()).toBe("t2");
    });

    test("AT2: poll re-discovers when tracked thread disappears from loaded list", async () => {
        let loadCalls = 0;
        const mock: AppServerClient = {
            threadLoadedList: async () => {
                loadCalls++;
                // First call (from pollCycle): t1 no longer in list
                if (loadCalls === 1) return { data: ["t2"], nextCursor: null };
                // Second call (from trySelectThread inside pollCycle): also ["t2"]
                return { data: ["t2"], nextCursor: null };
            },
            threadRead: async (id: string) => {
                if (id === "t2") return makeThread({ id: "t2", updatedAt: 500, preview: "new thread" });
                return null;
            },
            threadResume: async () => true,
        } as unknown as AppServerClient;

        const tracker = new ThreadTracker({ appServer: mock });
        (tracker as unknown as Record<string, unknown>).trackedThreadId = "t1";
        (tracker as unknown as Record<string, unknown>).trackedStatus = "idle";
        (tracker as unknown as Record<string, unknown>).closed = false;

        await (tracker as unknown as { pollCycle(): Promise<void> }).pollCycle();
        tracker.close();

        // t1 disappeared → re-discovered t2
        expect(tracker.getThreadId()).toBe("t2");
    });

    test("AT3: poll with no tracked thread discovers one", async () => {
        const mock: AppServerClient = {
            threadLoadedList: async () => ({ data: ["t1"], nextCursor: null }),
            threadRead: async () => makeThread({ id: "t1", updatedAt: 200 }),
            threadResume: async () => true,
        } as unknown as AppServerClient;

        const tracker = new ThreadTracker({ appServer: mock });
        // No tracked thread set
        (tracker as unknown as Record<string, unknown>).closed = false;

        await (tracker as unknown as { pollCycle(): Promise<void> }).pollCycle();
        tracker.close();

        expect(tracker.getThreadId()).toBe("t1");
    });

    test("AT4: poll does NOT switch when candidate updatedAt is older", async () => {
        const mock: AppServerClient = {
            threadLoadedList: async () => ({ data: ["t1", "t2"], nextCursor: null }),
            threadRead: async (id: string) => {
                if (id === "t1") return makeThread({ id: "t1", updatedAt: 999, preview: "current" });
                if (id === "t2") return makeThread({ id: "t2", updatedAt: 100, preview: "older" });
                return null;
            },
            threadResume: async () => true,
        } as unknown as AppServerClient;

        const tracker = new ThreadTracker({ appServer: mock });
        (tracker as unknown as Record<string, unknown>).trackedThreadId = "t1";
        (tracker as unknown as Record<string, unknown>).closed = false;

        await (tracker as unknown as { pollCycle(): Promise<void> }).pollCycle();
        tracker.close();

        expect(tracker.getThreadId()).toBe("t1"); // stays on t1
    });
});

// ── All threads archived ──────────────────────────────────────────

describe("Verifier: all threads archived", () => {
    test("AT5: all archived → discover returns null without crash", async () => {
        const data: MockData = {
            loaded: ["a1", "a2", "a3"],
            threads: new Map([
                ["a1", makeThread({ id: "a1", status: { type: "archived" }, preview: "old" })],
                ["a2", makeThread({ id: "a2", status: { type: "archived" }, preview: "old2" })],
                ["a3", makeThread({ id: "a3", status: { type: "archived" }, preview: "" })],
            ]),
            resumeResults: new Map(),
        };
        const tracker = new ThreadTracker({ appServer: makeMock(data) });
        // Abort quickly to avoid 2s×15 real sleeps
        setTimeout(() => tracker.close(), 50);
        const found = await tracker.discover();
        expect(found).toBeNull();
    });
});

// ── resume-false for all candidates ──────────────────────────────

describe("Verifier: resume-false for all", () => {
    test("AT6: all candidates resume=false → discover returns null", async () => {
        const data: MockData = {
            loaded: ["t1", "t2"],
            threads: new Map([
                ["t1", makeThread({ id: "t1", updatedAt: 200 })],
                ["t2", makeThread({ id: "t2", updatedAt: 100 })],
            ]),
            resumeResults: new Map([["t1", false], ["t2", false]]),
        };
        const tracker = new ThreadTracker({ appServer: makeMock(data) });
        setTimeout(() => tracker.close(), 50);
        const found = await tracker.discover();
        expect(found).toBeNull();
    });
});

// ── close() mid-discovery ─────────────────────────────────────────

describe("Verifier: close() mid-discovery", () => {
    test("AT7: close() during discovery returns null immediately", async () => {
        let callCount = 0;
        const mock: AppServerClient = {
            threadLoadedList: async () => {
                callCount++;
                return { data: [], nextCursor: null };
            },
            threadRead: async () => null,
            threadResume: async () => true,
        } as unknown as AppServerClient;

        const tracker = new ThreadTracker({ appServer: mock });
        // Close immediately
        tracker.close();
        const found = await tracker.discover();
        expect(found).toBeNull();
        // Should not have looped at all (closed flag stops first iteration)
        expect(callCount).toBe(0);
    });
});

// ── Huge thread list (DoS) ────────────────────────────────────────

describe("Verifier: huge thread list", () => {
    test("AT8: 1000 threads → only first 50 scanned (MAX_THREADS_TO_SCAN=50), winner in slot 0", async () => {
        // MAX_THREADS_TO_SCAN = 50 — trySelectThread slices ids to 50 before reading.
        // If the winning thread is at index 999, it is NEVER read → discover returns null.
        // This test verifies: 1000 threads, winner at index 0 → found correctly, no crash.
        const ids = Array.from({ length: 1000 }, (_, i) => `t${i}`);
        const threads = new Map(ids.map((id, i) => [id, makeThread({ id, updatedAt: i === 0 ? 9999 : i, preview: "x" })]));
        const mock: AppServerClient = {
            threadLoadedList: async () => ({ data: ids, nextCursor: null }),
            threadRead: async (id: string) => threads.get(id) ?? null,
            threadResume: async (id: string) => id === "t0", // winner is at index 0
        } as unknown as AppServerClient;

        const tracker = new ThreadTracker({ appServer: mock });
        const found = await tracker.discover();
        tracker.close();
        // t0 has highest updatedAt=9999, is within first 50, resume=true → discovered
        expect(found).toBe("t0");
    });
});

// ── updatedAt=MAX_SAFE_INTEGER (future-date hijack) ───────────────

describe("Verifier: updatedAt edge values", () => {
    test("AT9: MAX_SAFE_INTEGER updatedAt filtered by future-date guard (VS18: now + 5_000)", async () => {
        // trySelectThread: if (info.updatedAt > now + 5_000) continue  [VS18 changed from 60_000 to 5_000]
        // MAX_SAFE_INTEGER >> Date.now() + 5_000 → "future" thread REJECTED.
        // "normal" (updatedAt=1000) passes the guard → selected. Prevents timestamp hijacking.
        const data: MockData = {
            loaded: ["normal", "future"],
            threads: new Map([
                ["normal", makeThread({ id: "normal", updatedAt: 1000, preview: "normal" })],
                ["future", makeThread({ id: "future", updatedAt: Number.MAX_SAFE_INTEGER, preview: "future" })],
            ]),
            resumeResults: new Map([["normal", true], ["future", true]]),
        };
        const tracker = new ThreadTracker({ appServer: makeMock(data) });
        const found = await tracker.discover();
        tracker.close();
        // "future" rejected by guard → only "normal" remains → selected
        expect(found).toBe("normal");
    });

    test("AT10: updatedAt=undefined treated as 0 in sort", async () => {
        const data: MockData = {
            loaded: ["no-ts", "has-ts"],
            threads: new Map([
                ["no-ts", makeThread({ id: "no-ts", updatedAt: undefined, preview: "a" })],
                ["has-ts", makeThread({ id: "has-ts", updatedAt: 100, preview: "b" })],
            ]),
            resumeResults: new Map([["no-ts", true], ["has-ts", true]]),
        };
        const tracker = new ThreadTracker({ appServer: makeMock(data) });
        const found = await tracker.discover();
        tracker.close();
        expect(found).toBe("has-ts"); // 100 > 0 (undefined → 0)
    });

    test("AT11: negative updatedAt treated as negative in sort (valid JS)", async () => {
        const data: MockData = {
            loaded: ["past", "now"],
            threads: new Map([
                ["past", makeThread({ id: "past", updatedAt: -9999, preview: "a" })],
                ["now", makeThread({ id: "now", updatedAt: 1, preview: "b" })],
            ]),
            resumeResults: new Map([["past", true], ["now", true]]),
        };
        const tracker = new ThreadTracker({ appServer: makeMock(data) });
        const found = await tracker.discover();
        tracker.close();
        expect(found).toBe("now"); // 1 > -9999
    });
});

// ── Status change for non-tracked thread ─────────────────────────

describe("Verifier: status change isolation", () => {
    test("AT12: status change for non-tracked does not fire onIdle/onActive", async () => {
        const idleEvents: string[] = [];
        const activeEvents: string[] = [];
        const data: MockData = {
            loaded: ["t1"],
            threads: new Map([["t1", makeThread({ id: "t1" })]]),
            resumeResults: new Map([["t1", true]]),
        };
        const tracker = new ThreadTracker({
            appServer: makeMock(data),
            onIdle: (id) => idleEvents.push(id),
            onActive: (id) => activeEvents.push(id),
        });
        await tracker.discover();

        // Status change for wrong thread
        tracker.handleThreadStatusChanged({ threadId: "unrelated", status: { type: "active" } });
        tracker.handleThreadStatusChanged({ threadId: "unrelated", status: { type: "idle" } });

        expect(idleEvents).toHaveLength(0);
        expect(activeEvents).toHaveLength(0);
        tracker.close();
    });

    test("AT13: status 'unknown' type → trackedStatus becomes 'unknown', no callback fires", async () => {
        const idleEvents: string[] = [];
        const data: MockData = {
            loaded: ["t1"],
            threads: new Map([["t1", makeThread({ id: "t1" })]]),
            resumeResults: new Map([["t1", true]]),
        };
        const tracker = new ThreadTracker({
            appServer: makeMock(data),
            onIdle: (id) => idleEvents.push(id),
        });
        await tracker.discover();

        tracker.handleThreadStatusChanged({ threadId: "t1", status: { type: "active" } });
        tracker.handleThreadStatusChanged({ threadId: "t1", status: { type: "some-other-type" } });

        expect(tracker.getStatus()).toBe("unknown");
        expect(idleEvents).toHaveLength(0);
        tracker.close();
    });
});

// ── onThreadChanged fires with cwd on discovery ───────────────────

describe("Verifier: cwd propagation via onThreadChanged on discover()", () => {
    test("AT14: onThreadChanged fires with threadId + cwd when thread discovered", async () => {
        const cwdEvents: Array<{ threadId: string; cwd: string | undefined }> = [];
        const data: MockData = {
            loaded: ["t1"],
            threads: new Map([["t1", { ...makeThread({ id: "t1" }), cwd: "/home/user/project" }]]),
            resumeResults: new Map([["t1", true]]),
        };
        const tracker = new ThreadTracker({
            appServer: makeMock(data),
            onThreadChanged: (threadId, cwd) => cwdEvents.push({ threadId, cwd }),
        });
        const found = await tracker.discover();
        tracker.close();

        expect(found).toBe("t1");
        expect(cwdEvents).toHaveLength(1);
        expect(cwdEvents[0]!.threadId).toBe("t1");
        expect(cwdEvents[0]!.cwd).toBe("/home/user/project");
    });

    test("AT15: onThreadChanged fires with undefined cwd when thread has no cwd", async () => {
        const cwdEvents: Array<{ threadId: string; cwd: string | undefined }> = [];
        const data: MockData = {
            loaded: ["t1"],
            threads: new Map([["t1", makeThread({ id: "t1" })]]), // no cwd field
            resumeResults: new Map([["t1", true]]),
        };
        const tracker = new ThreadTracker({
            appServer: makeMock(data),
            onThreadChanged: (threadId, cwd) => cwdEvents.push({ threadId, cwd }),
        });
        const found = await tracker.discover();
        tracker.close();

        expect(found).toBe("t1");
        expect(cwdEvents).toHaveLength(1);
        expect(cwdEvents[0]!.cwd).toBeUndefined();
    });

    test("AT16: onThreadChanged fires again when poll switches to a different thread with new cwd", async () => {
        const cwdEvents: Array<{ threadId: string; cwd: string | undefined }> = [];
        const mock: AppServerClient = {
            threadLoadedList: async () => ({ data: ["t1", "t2"], nextCursor: null }),
            threadRead: async (id: string) => {
                if (id === "t1") return { ...makeThread({ id: "t1", updatedAt: 100 }), cwd: "/cwd-t1" };
                if (id === "t2") return { ...makeThread({ id: "t2", updatedAt: 999 }), cwd: "/cwd-t2" };
                return null;
            },
            threadResume: async () => true,
        } as unknown as AppServerClient;

        const tracker = new ThreadTracker({
            appServer: mock,
            onThreadChanged: (threadId, cwd) => cwdEvents.push({ threadId, cwd }),
        });
        (tracker as unknown as Record<string, unknown>).trackedThreadId = "t1";
        (tracker as unknown as Record<string, unknown>).trackedStatus = "idle";
        (tracker as unknown as Record<string, unknown>).closed = false;

        await (tracker as unknown as { pollCycle(): Promise<void> }).pollCycle();
        tracker.close();

        // pollCycle switched to t2 (newer updatedAt) → onThreadChanged fired for t2
        expect(cwdEvents).toHaveLength(1);
        expect(cwdEvents[0]!.threadId).toBe("t2");
        expect(cwdEvents[0]!.cwd).toBe("/cwd-t2");
    });
});
