import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { makeLogger } from "../logger";

const log = makeLogger("hub-spawner");

const LOCK_PATH = path.join(os.homedir(), ".eco-relay", "hub.lock");
const DAEMON_ENTRY = path.resolve(import.meta.dir, "..", "hub-daemon.ts");

// VS2: resolve bun to absolute path at module load
function resolveBunPath(): string {
    // On Windows, process.execPath is the bun.exe path
    if (process.execPath) return process.execPath;
    return "bun";
}
const BUN_PATH = resolveBunPath();

type LockData = {
    pid: number;
    port: number;
    socketPath: string;
    bootId: string;
};

// ── Protocol handshake ─────────────────────────────────────────────

// VS3: tryConnect performs protocol handshake to verify it's actually Hub
const BOOTSTRAP_PING = { type: "ping", req_id: "bootstrap" };
const BOOTSTRAP_PONG = JSON.stringify({ type: "pong", req_id: "bootstrap" });

export function tryConnect(socketPath: string): Promise<net.Socket | null> {
    const sock = new net.Socket();
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            try {
                sock.destroy();
            } catch {
                // ignore
            }
            resolve(null);
        }, 500);

        const onConnect = (): void => {
            sock.removeListener("error", onError);
            sock.write(JSON.stringify(BOOTSTRAP_PING) + "\n");
            let buf = "";
            sock.on("data", (chunk: Buffer) => {
                buf += chunk.toString("utf8");
                if (buf.includes("\n")) {
                    clearTimeout(timer);
                    const line = buf.split("\n")[0] ?? "";
                    if (line.trim() === BOOTSTRAP_PONG.trim()) {
                        sock.removeAllListeners("data");
                        sock.on("error", () => {});
                        resolve(sock);
                    } else {
                        try {
                            sock.destroy();
                        } catch {
                            // ignore
                        }
                        resolve(null);
                    }
                }
            });
        };
        const onError = (err: Error & { code?: string }): void => {
            clearTimeout(timer);
            sock.removeListener("connect", onConnect);
            try {
                sock.destroy();
            } catch {
                // ignore
            }
            log.debug("socket_connect_error", {
                socketPath,
                code: err.code ?? "unknown",
            });
            resolve(null);
        };
        sock.once("connect", onConnect);
        sock.once("error", onError);
        sock.connect(socketPath);
    });
}

export async function waitForSocketReady(
    socketPath: string,
    timeoutMs: number,
): Promise<net.Socket | null> {
    const deadline = Date.now() + timeoutMs;
    let delay = 25;
    while (Date.now() < deadline) {
        const sock = await tryConnect(socketPath);
        if (sock) return sock;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 500);
    }
    return null;
}

// ── Lock file ──────────────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function readLock(): LockData | null {
    try {
        const raw = fs.readFileSync(LOCK_PATH, "utf8");
        const data = JSON.parse(raw) as LockData;
        if (
            typeof data.pid !== "number" ||
            typeof data.port !== "number" ||
            typeof data.socketPath !== "string" ||
            typeof data.bootId !== "string"
        ) {
            return null;
        }
        return data;
    } catch {
        return null;
    }
}

function writeLock(data: LockData): void {
    const dir = path.dirname(LOCK_PATH);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(LOCK_PATH, JSON.stringify(data), {
        flag: "wx",
        mode: 0o600,
    });
}

export function deleteLock(): void {
    try {
        fs.unlinkSync(LOCK_PATH);
    } catch {
        // already gone
    }
}

export function acquireLock(
    socketPath: string,
    wsPort: number,
): { owned: boolean; socketPath: string; wsPort: number } {
    const bootId = crypto.randomUUID();

    try {
        writeLock({
            pid: process.pid,
            port: wsPort,
            socketPath,
            bootId,
        });
        log.info("lock_acquired", {
            pid: process.pid,
            port: wsPort,
            socketPath,
        });
        return { owned: true, socketPath, wsPort };
    } catch {
        const existing = readLock();
        if (!existing) {
            deleteLock();
            return acquireLock(socketPath, wsPort);
        }
        if (isProcessAlive(existing.pid)) {
            log.info("lock_held_by_live_process", {
                pid: existing.pid,
                port: existing.port,
            });
            return {
                owned: false,
                socketPath: existing.socketPath,
                wsPort: existing.port,
            };
        }
        log.info("lock_stale_removed", { stale_pid: existing.pid });
        deleteLock();
        return acquireLock(socketPath, wsPort);
    }
}

// ── Spawn ──────────────────────────────────────────────────────────

export type HubHandle = {
    close: () => Promise<void>;
    child: ChildProcess;
};

export function spawnHub(
    socketPath: string,
    wsPort: number,
): HubHandle {
    const env = { ...process.env, RELAY_HUB_SOCKET: socketPath };

    const child = spawn("bun", ["run", DAEMON_ENTRY], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });

    const errLog = path.join(os.tmpdir(), `ecorelay-spawn-err-${Date.now()}.log`);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
        if (stderr || (code !== 0 && code !== null)) {
            try {
                fs.writeFileSync(errLog, `exit=${code}\n${stderr}`);
            } catch {
                // ignore
            }
        }
    });

    child.on("error", (err) => {
        log.error("daemon_spawn_failed", {
            err: err.message,
            hint: "Ensure bun is installed and in PATH.",
        });
    });
    child.unref();

    return {
        close: async (): Promise<void> => {
            // Daemon is independent; do not kill on normal close.
        },
        child,
    };
}

// ── Bootstrap ──────────────────────────────────────────────────────

export type HubInfo = {
    socketPath: string;
    wsPort: number;
};

export async function bootstrapHub(
    socketPath: string,
    wsPort: number,
): Promise<HubInfo> {
    const lock = acquireLock(socketPath, wsPort);

    if (lock.owned) {
        log.info("hub_spawn", {
            socketPath: lock.socketPath,
            wsPort: lock.wsPort,
        });
        const handle = spawnHub(lock.socketPath, lock.wsPort);

        const sock = await waitForSocketReady(
            lock.socketPath,
            process.platform === "win32" ? 5_000 : 2_000,
        );
        if (!sock) {
            // BC1: kill daemon on timeout before throwing
            try {
                handle.child.kill("SIGTERM");
            } catch {
                // ignore
            }
            deleteLock();
            throw new Error(
                `Hub did not become ready at ${lock.socketPath} within timeout`,
            );
        }
        sock.destroy();
        return { socketPath: lock.socketPath, wsPort: lock.wsPort };
    }

    // Hub already running — verify it's reachable
    const sock = await tryConnect(lock.socketPath);
    if (!sock) {
        log.warn("lock_owner_unreachable", {
            socketPath: lock.socketPath,
        });
        deleteLock();
        return bootstrapHub(socketPath, wsPort);
    }
    sock.destroy();
    log.info("hub_reuse", {
        socketPath: lock.socketPath,
        wsPort: lock.wsPort,
    });
    return { socketPath: lock.socketPath, wsPort: lock.wsPort };
}

// Backward-compat for daemon-spawn.ts delegation
export async function spawnDetachedDaemon(
    socketPath: string,
): Promise<{ close: () => Promise<void> }> {
    const rawPort = Number(process.env.ECORELAY_WS_PORT || "9376");
    const defaultWsPort = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535
        ? rawPort
        : 9376;
    const handle = spawnHub(socketPath, defaultWsPort);
    return { close: () => handle.close() };
}
