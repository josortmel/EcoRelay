import * as fs from "node:fs";
import * as path from "node:path";
import { makeLogger } from "../logger";
import { probeLiveSocket } from "./socket-recovery";

const log = makeLogger("hub-daemon");

// FarOS #391 (30-sep-2026): the hub daemon is the ONLY exclusion point.
// Channels (CC), the OC plugin and the adapters all spawn a daemon when they
// cannot connect; when several sessions open in the same second they all
// spawn one. Without this lock three hubs listened on the same socket and the
// relay died for everyone. The lock holds the DAEMON's own pid, so "is the
// owner alive" means "is the hub alive". The loser exits without touching the
// socket.

/** A live pid whose hub never answered for this long is treated as stale
 *  (hung hub, or a pid reused by an unrelated process after a crash). */
const STALE_AFTER_MS = 30_000;

type LockData = { pid: number; startedAt: number };

export function daemonLockPath(socketPath: string): string {
    return path.join(path.dirname(socketPath), "hub-daemon.lock");
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM = exists but not ours to signal: still alive
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

function read(file: string): LockData | null {
    try {
        const d = JSON.parse(fs.readFileSync(file, "utf8")) as LockData;
        return typeof d.pid === "number" && typeof d.startedAt === "number" ? d : null;
    } catch {
        return null;
    }
}

function same(a: LockData | null, b: LockData | null): boolean {
    return !!a && !!b && a.pid === b.pid && a.startedAt === b.startedAt;
}

async function isStale(d: LockData | null, file: string, socketPath: string): Promise<boolean> {
    if (!d) {
        // unreadable: someone may be mid-write; stale only if it has been there a while
        try {
            return Date.now() - fs.statSync(file).mtimeMs > 5_000;
        } catch {
            return true;
        }
    }
    if (!isAlive(d.pid)) return true;
    if (Date.now() - d.startedAt < STALE_AFTER_MS) return false;
    return !(await probeLiveSocket(socketPath, 500));
}

/** Removes a stale lock atomically: rename it aside, and if what was renamed
 *  is not the lock judged stale (another daemon replaced it meanwhile), put it
 *  back with link(), which fails instead of overwriting. */
function removeStale(file: string, judged: LockData | null): void {
    const aside = `${file}.stale-${process.pid}-${Date.now()}`;
    try {
        fs.renameSync(file, aside);
    } catch {
        return; // already gone
    }
    const moved = read(aside);
    if (judged && !same(moved, judged)) {
        try {
            fs.linkSync(aside, file);
        } catch {}
    }
    try {
        fs.unlinkSync(aside);
    } catch {}
}

export type DaemonLock = { release: () => void };

export async function acquireDaemonLock(socketPath: string): Promise<DaemonLock | null> {
    const file = daemonLockPath(socketPath);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const mine: LockData = { pid: process.pid, startedAt: Date.now() };
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            fs.writeFileSync(file, JSON.stringify(mine), { flag: "wx", mode: 0o600 });
            log.info("daemon_lock_acquired", { pid: process.pid, file });
            return {
                release: () => {
                    if (same(read(file), mine)) {
                        try {
                            fs.unlinkSync(file);
                        } catch {}
                    }
                },
            };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
        const held = read(file);
        if (!(await isStale(held, file, socketPath))) {
            log.info("daemon_lock_held", { holder: held?.pid ?? null });
            return null;
        }
        log.warn("daemon_lock_stale_removed", { holder: held?.pid ?? null });
        removeStale(file, held);
    }
    return null;
}
