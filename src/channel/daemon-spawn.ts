import { spawn } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import { makeLogger } from "../logger";

const log = makeLogger("daemon");

const DAEMON_ENTRY = path.resolve(import.meta.dir, "..", "hub-daemon.ts");

export function tryConnect(socketPath: string): Promise<net.Socket | null> {
    const sock = new net.Socket();
    return new Promise((resolve) => {
        const onConnect = () => {
            sock.removeListener("error", onError);
            sock.on("error", () => {});
            resolve(sock);
        };
        const onError = (err: Error & { code?: string }) => {
            sock.removeListener("connect", onConnect);
            try {
                sock.destroy();
            } catch {}
            const code = (err as { code?: string }).code;
            if (code === "EADDRINUSE") {
                log.warn("socket_busy", {
                    socketPath,
                    hint: "Another hub instance may already be running on this socket.",
                });
            } else if (code === "ECONNREFUSED") {
                log.warn("socket_stale", {
                    socketPath,
                    hint: "A stale socket file exists but nothing is listening. The daemon may have crashed.",
                });
            } else if (code !== "ENOENT") {
                log.debug("socket_connect_error", { socketPath, code });
            }
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

export async function spawnDetachedDaemon(
    socketPath: string,
): Promise<{ close: () => Promise<void> }> {
    const env = Object.fromEntries(
        Object.entries({
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            USERPROFILE: process.env.USERPROFILE,
            SystemRoot: process.env.SystemRoot,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            TMPDIR: process.env.TMPDIR,
            RELAY_HUB_SOCKET: socketPath,
            CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA,
        }).filter(([, v]) => v !== undefined),
    );
    if (process.platform === "win32") {
        const child = spawn("cmd.exe", ["/c", "start", '""', "/b", "bun", "run", DAEMON_ENTRY], {
            env,
            stdio: "ignore",
            detached: true,
            cwd: path.dirname(DAEMON_ENTRY),
        });
        child.on("error", (err) => {
            log.error("daemon_spawn_failed", {
                err: err.message,
                hint: "Ensure bun is installed and in PATH.",
            });
        });
        child.unref();
    } else {
        const child = spawn("bun", ["run", DAEMON_ENTRY], {
            env,
            detached: true,
            stdio: ["ignore", "ignore", "ignore"],
        });
        child.on("error", (err) => {
            log.error("daemon_spawn_failed", {
                err: err.message,
                hint: "Ensure bun is installed and in PATH.",
            });
        });
        child.unref();
    }
    return {
        close: async () => {
            // Daemon is independent; do not kill on channel close.
        },
    };
}
