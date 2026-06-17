// Verifier — Loop 3 fixpass-4: thread-tracker VS18 boundary test
// VS18: future-date guard changed from now+60_000 to now+5_000
import { describe, expect, test } from "bun:test";
import { ThreadTracker } from "./thread-tracker";
import type { AppServerClient, ThreadInfo } from "./app-server-client";

function makeThread(overrides: Partial<ThreadInfo> & { id: string }): ThreadInfo {
    return { preview: "some content", status: { type: "idle" }, updatedAt: 1000, createdAt: 1000, ...overrides };
}

// ── VS18: future-date guard window = 5s (was 60s) ────────────────

describe("VS18: future-date guard — now+5_000 threshold (was now+60_000)", () => {
    test("thread at now+4999 is SELECTABLE (within 5s tolerance)", async () => {
        const nearFuture = Date.now() + 4_999;
        const mock: AppServerClient = {
            threadLoadedList: async () => ({ data: ["near-future", "old"], nextCursor: null }),
            threadRead: async (id: string) => {
                if (id === "near-future") return makeThread({ id: "near-future", updatedAt: nearFuture, preview: "x" });
                if (id === "old") return makeThread({ id: "old", updatedAt: 1000, preview: "x" });
                return null;
            },
            threadResume: async () => true,
        } as unknown as AppServerClient;

        const tracker = new ThreadTracker({ appServer: mock });
        const found = await tracker.discover();
        tracker.close();

        // near-future (now+4999) is NOT filtered → has higher updatedAt → selected
        expect(found).toBe("near-future");
    });

    test("thread at now+6000 is REJECTED (exceeds 5s tolerance)", async () => {
        const farFuture = Date.now() + 6_000;
        const mock: AppServerClient = {
            threadLoadedList: async () => ({ data: ["far-future", "old"], nextCursor: null }),
            threadRead: async (id: string) => {
                if (id === "far-future") return makeThread({ id: "far-future", updatedAt: farFuture, preview: "x" });
                if (id === "old") return makeThread({ id: "old", updatedAt: 1000, preview: "x" });
                return null;
            },
            threadResume: async () => true,
        } as unknown as AppServerClient;

        const tracker = new ThreadTracker({ appServer: mock });
        const found = await tracker.discover();
        tracker.close();

        // far-future (now+6000) filtered by VS18 guard → only "old" remains → selected
        expect(found).toBe("old");
    });

    test("thread at now+5500 is REJECTED (clearly above 5s threshold, timing-safe buffer)", async () => {
        // Guard: `info.updatedAt > now + 5_000`. Use +5500 instead of +5001 to survive
        // the async yields (threadLoadedList + threadRead) that elapse between Date.now()
        // here and Date.now() inside trySelectThread. 500ms buffer avoids flakiness.
        const boundary = Date.now() + 5_500;
        const mock: AppServerClient = {
            threadLoadedList: async () => ({ data: ["boundary", "old"], nextCursor: null }),
            threadRead: async (id: string) => {
                if (id === "boundary") return makeThread({ id: "boundary", updatedAt: boundary, preview: "x" });
                if (id === "old") return makeThread({ id: "old", updatedAt: 1000, preview: "x" });
                return null;
            },
            threadResume: async () => true,
        } as unknown as AppServerClient;

        const tracker = new ThreadTracker({ appServer: mock });
        const found = await tracker.discover();
        tracker.close();

        // boundary (now+5500 > now+5000) → filtered → "old" wins
        expect(found).toBe("old");
    });

    test("poll cycle also uses now+5_000 guard (regression: pollCycle line 173)", async () => {
        // VS18 also applies in pollCycle (line 173). Verify pollCycle rejects now+6000 thread.
        const farFuture = Date.now() + 6_000;
        let readCount = 0;
        const mock: AppServerClient = {
            threadLoadedList: async () => ({ data: ["t1", "far-future"], nextCursor: null }),
            threadRead: async (id: string) => {
                readCount++;
                if (id === "t1") return makeThread({ id: "t1", updatedAt: 100, preview: "current" });
                if (id === "far-future") return makeThread({ id: "far-future", updatedAt: farFuture, preview: "x" });
                return null;
            },
            threadResume: async () => true,
        } as unknown as AppServerClient;

        const tracker = new ThreadTracker({ appServer: mock });

        // Manually set tracked to t1
        (tracker as unknown as Record<string, unknown>).trackedThreadId = "t1";
        (tracker as unknown as Record<string, unknown>).trackedStatus = "idle";
        (tracker as unknown as Record<string, unknown>).closed = false;

        // pollCycle should NOT switch to far-future (filtered by VS18 guard)
        await (tracker as unknown as { pollCycle(): Promise<void> }).pollCycle();
        tracker.close();

        // Still tracking t1 — far-future was rejected
        expect(tracker.getThreadId()).toBe("t1");
    });
});
