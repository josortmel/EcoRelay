import * as fs from "node:fs";
import * as path from "node:path";
import { claudeSessionName } from "../identity";
import { makeLogger } from "../logger";

const log = makeLogger("channel.session-watcher");

export type SessionWatcherOptions = {
    sessionPath: string;
    onName: (name: string) => Promise<void>;
    initialName?: string | null;
    readName?: (path: string) => string | null;
    logError?: (err: unknown) => void;
};

export type SessionWatcher = {
    close: () => void;
};

export function startSessionWatcher(opts: SessionWatcherOptions): SessionWatcher {
    const dir = path.dirname(opts.sessionPath);
    const base = path.basename(opts.sessionPath);
    const readName = opts.readName ?? ((p: string) => claudeSessionName({ path: p }));
    const logError =
        opts.logError ??
        ((err: unknown) => {
            log.warn("session_watcher_error", {
                err: err instanceof Error ? err.message : String(err),
            });
        });

    let lastDispatched: string | null = opts.initialName ?? null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let inFlight = false;
    let pending = false;

    const dispatch = async (): Promise<void> => {
        timer = null;
        if (closed) return;
        if (inFlight) {
            pending = true;
            return;
        }
        let name: string | null;
        try {
            name = readName(opts.sessionPath);
        } catch (err) {
            logError(err);
            return;
        }
        if (name === null || name === lastDispatched) return;
        lastDispatched = name;
        inFlight = true;
        try {
            await opts.onName(name);
        } catch (err) {
            logError(err);
        } finally {
            inFlight = false;
            if (pending && !closed) {
                pending = false;
                if (timer !== null) {
                    clearTimeout(timer);
                    timer = null;
                }
                void dispatch();
            }
        }
    };

    const schedule = (): void => {
        if (closed) return;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
            void dispatch();
        }, 50);
    };

    let watcher: fs.FSWatcher | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    try {
        watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
            if (filename !== null && filename !== base) return;
            schedule();
        });
        watcher.on("error", (err) => {
            logError(err);
        });
    } catch (err) {
        logError(err);
        // Fall back to polling when fs.watch is unavailable (network drives, etc.)
        pollTimer = setInterval(() => {
            schedule();
        }, 2000);
    }

    return {
        close: (): void => {
            if (closed) return;
            closed = true;
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            if (pollTimer !== null) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
            if (watcher !== null) {
                try {
                    watcher.close();
                } catch (err) {
                    logError(err);
                }
            }
        },
    };
}
