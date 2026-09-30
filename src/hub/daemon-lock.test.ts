import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { acquireDaemonLock, daemonLockPath } from "./daemon-lock";

// FarOS #391 (30-sep-2026): the four family sessions opened in the same second,
// each channel spawned a hub daemon, three of them listened on the same socket
// and the relay died for everyone. The daemon itself must be the exclusion point.

const DAEMON_ENTRY = path.resolve(import.meta.dir, "..", "hub-daemon.ts");

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "relay-lock-test-"));
}

function canConnect(socketPath: string): Promise<boolean> {
    return new Promise((resolve) => {
        const s = new net.Socket();
        s.on("error", () => resolve(false));
        s.once("connect", () => {
            s.destroy();
            resolve(true);
        });
        s.connect(socketPath);
    });
}

const children: ChildProcess[] = [];
afterEach(() => {
    for (const c of children.splice(0)) {
        try {
            c.kill();
        } catch {}
    }
});

describe("acquireDaemonLock", () => {
    test("first caller gets the lock, a second one does not", async () => {
        const dir = tmpDir();
        const sock = path.join(dir, "hub.sock");
        const a = await acquireDaemonLock(sock);
        expect(a).not.toBeNull();
        const b = await acquireDaemonLock(sock);
        expect(b).toBeNull();
        a!.release();
        expect(fs.existsSync(daemonLockPath(sock))).toBe(false);
        const c = await acquireDaemonLock(sock);
        expect(c).not.toBeNull();
        c!.release();
    });

    test("a lock left by a dead pid is taken over", async () => {
        const dir = tmpDir();
        const sock = path.join(dir, "hub.sock");
        fs.writeFileSync(
            daemonLockPath(sock),
            JSON.stringify({ pid: 999_999_9, startedAt: Date.now() }),
        );
        const a = await acquireDaemonLock(sock);
        expect(a).not.toBeNull();
        a!.release();
    });

    test("a live pid whose socket never answered after the grace period is stale", async () => {
        const dir = tmpDir();
        const sock = path.join(dir, "hub.sock");
        // our own pid is alive, but nothing listens on sock and the lock is old
        fs.writeFileSync(
            daemonLockPath(sock),
            JSON.stringify({ pid: process.pid, startedAt: Date.now() - 60_000 }),
        );
        const a = await acquireDaemonLock(sock);
        expect(a).not.toBeNull();
        a!.release();
    });

    test("a young lock of a live pid is respected even if the socket is not up yet", async () => {
        const dir = tmpDir();
        const sock = path.join(dir, "hub.sock");
        fs.writeFileSync(
            daemonLockPath(sock),
            JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
        );
        expect(await acquireDaemonLock(sock)).toBeNull();
    });

    test("release does not delete a lock that is no longer ours", async () => {
        const dir = tmpDir();
        const sock = path.join(dir, "hub.sock");
        const a = await acquireDaemonLock(sock);
        fs.writeFileSync(
            daemonLockPath(sock),
            JSON.stringify({ pid: 424242, startedAt: Date.now() }),
        );
        a!.release();
        expect(fs.existsSync(daemonLockPath(sock))).toBe(true);
    });
});

describe("hub-daemon under a simultaneous start", () => {
    test("four daemons started at once leave exactly one hub, and it answers", async () => {
        const dir = tmpDir();
        const sock = path.join(dir, "hub.sock");
        const exits: Array<number | null> = [];
        const env = {
            ...process.env,
            RELAY_HUB_SOCKET: sock,
            CLAUDE_PLUGIN_DATA: dir,
            ECORELAY_WS_PORT: String(20_000 + Math.floor(Math.random() * 20_000)),
            ECORELAY_IDLE_MS: "0",
        };
        for (let i = 0; i < 4; i++) {
            const c = spawn(process.execPath, ["run", DAEMON_ENTRY], { env, stdio: "ignore" });
            c.on("exit", (code) => exits.push(code));
            children.push(c);
        }
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && exits.length < 3) {
            await new Promise((r) => setTimeout(r, 100));
        }
        expect(exits.length).toBe(3);
        expect(exits.every((c) => c === 0)).toBe(true);
        expect(await canConnect(sock)).toBe(true);
        const lock = JSON.parse(fs.readFileSync(daemonLockPath(sock), "utf8")) as { pid: number };
        const alive = children.filter((c) => c.exitCode === null);
        expect(alive.length).toBe(1);
        expect(lock.pid).toBe(alive[0]!.pid!);
    }, 20_000);
});
