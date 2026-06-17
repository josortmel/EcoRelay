import type { AppServerClient, ThreadInfo, ThreadStatusChangedEvent } from "./app-server-client";
import { makeLogger } from "../logger";

const log = makeLogger("codex-thread-tracker");

const DISCOVERY_INTERVAL_MS = 2_000;
const DISCOVERY_MAX_ATTEMPTS = 15;
const POLL_INTERVAL_MS = 60_000;
const MAX_THREADS_TO_SCAN = 50;
const SAFE_ID_RE = /^[0-9a-zA-Z._-]+$/;

export type ThreadTrackerOptions = {
    appServer: AppServerClient;
    onIdle?: (threadId: string) => void;
    onActive?: (threadId: string) => void;
    onThreadChanged?: (threadId: string, cwd?: string) => void;
};

export class ThreadTracker {
    private readonly appServer: AppServerClient;
    private trackedThreadId: string | null = null;
    private trackedStatus: "active" | "idle" | "unknown" = "unknown";
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private closed = false;
    private readonly onIdle: ((threadId: string) => void) | undefined;
    private readonly onActive: ((threadId: string) => void) | undefined;
    private readonly onThreadChanged: ((threadId: string, cwd?: string) => void) | undefined;

    constructor(opts: ThreadTrackerOptions) {
        this.appServer = opts.appServer;
        this.onIdle = opts.onIdle;
        this.onActive = opts.onActive;
        this.onThreadChanged = opts.onThreadChanged;
    }

    getThreadId(): string | null {
        return this.trackedThreadId;
    }

    getStatus(): "active" | "idle" | "unknown" {
        return this.trackedStatus;
    }

    // ── Startup discovery ─────────────────────────────────────────

    async discover(): Promise<string | null> {
        for (let attempt = 0; attempt < DISCOVERY_MAX_ATTEMPTS; attempt++) {
            if (this.closed) return null;

            const selected = await this.trySelectThread();
            if (selected) {
                this.setTrackedThread(selected.id, selected.cwd);
                log.info("thread_discovered", { threadId: selected.id, attempt });
                this.startPolling();
                return selected.id;
            }

            if (attempt < DISCOVERY_MAX_ATTEMPTS - 1) {
                await sleep(DISCOVERY_INTERVAL_MS);
            }
        }

        log.warn("thread_discovery_exhausted", { attempts: DISCOVERY_MAX_ATTEMPTS });
        this.startPolling();
        return null;
    }

    // ── Thread selection (single-pass, no re-read) ────────────────

    private async trySelectThread(): Promise<{ id: string; cwd?: string } | null> {
        let ids: string[];
        try {
            const loaded = await this.appServer.threadLoadedList();
            ids = loaded.data.slice(0, MAX_THREADS_TO_SCAN);
        } catch {
            return null;
        }
        if (ids.length === 0) return null;

        const now = Date.now();
        const all: ThreadInfo[] = [];

        for (const id of ids) {
            if (!SAFE_ID_RE.test(id) || id.length > 256) continue;
            const info = await this.appServer.threadRead(id);
            if (!info) continue;
            if (info.status?.type === "archived") continue;
            if (info.updatedAt && info.updatedAt > now + 5_000) continue;
            all.push(info);
        }

        if (all.length === 0) return null;

        const withPreview = all.filter((t) => t.preview && t.preview.length > 0);
        const candidates = withPreview.length > 0 ? withPreview : all;

        candidates.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

        for (const candidate of candidates) {
            const resumed = await this.appServer.threadResume(candidate.id);
            if (resumed) return { id: candidate.id, cwd: candidate.cwd };
            log.info("thread_resume_skip", { threadId: candidate.id });
        }

        return null;
    }

    // ── Track thread changes ──────────────────────────────────────

    private setTrackedThread(threadId: string, cwd?: string): void {
        const changed = this.trackedThreadId !== threadId;
        this.trackedThreadId = threadId;
        this.trackedStatus = "unknown";
        if (changed && this.onThreadChanged) {
            this.onThreadChanged(threadId, cwd);
        }
    }

    // ── Status tracking (from app-server notifications) ───────────

    handleThreadStatusChanged(event: ThreadStatusChangedEvent): void {
        if (event.threadId !== this.trackedThreadId) return;

        const newStatus = event.status.type === "active" ? "active"
            : event.status.type === "idle" ? "idle"
            : "unknown";

        const prev = this.trackedStatus;
        this.trackedStatus = newStatus;

        if (newStatus === "idle" && prev !== "idle" && this.onIdle) {
            this.onIdle(event.threadId);
        }
        if (newStatus === "active" && prev !== "active" && this.onActive) {
            this.onActive(event.threadId);
        }
    }

    // ── Periodic polling ──────────────────────────────────────────

    private startPolling(): void {
        if (this.closed) return;
        this.pollTimer = setTimeout(() => this.pollCycle(), POLL_INTERVAL_MS);
    }

    private async pollCycle(): Promise<void> {
        if (this.closed) return;

        try {
            const loaded = await this.appServer.threadLoadedList();
            const ids = loaded.data.slice(0, MAX_THREADS_TO_SCAN);

            if (this.trackedThreadId && !ids.includes(this.trackedThreadId)) {
                log.info("tracked_thread_disappeared", { threadId: this.trackedThreadId });
                this.trackedThreadId = null;
                this.trackedStatus = "unknown";
                const found = await this.trySelectThread();
                if (found) {
                    this.setTrackedThread(found.id, found.cwd);
                    log.info("thread_switched_after_disappearance", { threadId: found.id });
                }
            } else if (this.trackedThreadId) {
                const current = await this.appServer.threadRead(this.trackedThreadId);
                if (!current) {
                    // stale tracked thread
                } else {
                    for (const id of ids) {
                        if (id === this.trackedThreadId) continue;
                        if (!SAFE_ID_RE.test(id) || id.length > 256) continue;
                        const info = await this.appServer.threadRead(id);
                        if (!info) continue;
                        if (info.status?.type === "archived") continue;
                        if (info.updatedAt && info.updatedAt > Date.now() + 5_000) continue;

                        if (info.updatedAt && current.updatedAt && info.updatedAt > current.updatedAt) {
                            const resumed = await this.appServer.threadResume(id);
                            if (resumed) {
                                log.info("thread_switched_newer", {
                                    from: this.trackedThreadId,
                                    to: id,
                                });
                                this.setTrackedThread(id, info.cwd);
                                break;
                            }
                        }
                    }
                }
            } else {
                const found = await this.trySelectThread();
                if (found) {
                    this.setTrackedThread(found.id, found.cwd);
                    log.info("thread_discovered_via_poll", { threadId: found.id });
                }
            }
        } catch (e) {
            log.warn("poll_failed", { err: e instanceof Error ? e.message : String(e) });
        }

        if (!this.closed) {
            this.pollTimer = setTimeout(() => this.pollCycle(), POLL_INTERVAL_MS);
        }
    }

    // ── Cleanup ───────────────────────────────────────────────────

    close(): void {
        this.closed = true;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
