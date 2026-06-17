/**
 * EcoRelay Codex launcher helper — invoked by ecorelay-codex.cmd.
 * Finds free port, starts app-server hidden, waits ready, launches codex --remote,
 * kills app-server on exit. PID file for reuse.
 *
 * Security: userArgs are passed as array elements to spawn() (no shell interpolation).
 * Port-race window between bind-close and spawn is minimal and loopback-only.
 */

import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const ECO_RELAY_DIR = path.join(os.homedir(), ".eco-relay");
const PID_FILE = path.join(ECO_RELAY_DIR, "codex-appserver.pid");
const PORT_MIN = 4580;
const PORT_MAX = 4599;
const READINESS_ATTEMPTS = 10;
const READINESS_INTERVAL_MS = 500;

const ALLOWED_CODEX_ROOTS = [
    path.join(os.homedir(), "AppData", "Local", "OpenAI", "Codex"),
    "C:\\Program Files\\WindowsApps",
    "C:\\Program Files\\OpenAI",
    "C:\\Program Files (x86)\\WindowsApps",
    "C:\\Program Files (x86)\\OpenAI",
];

const ECORELAY_SECRET_KEYS = ["ECORELAY_WS_TOKEN", "ECORELAY_BUN_PATH", "ECORELAY_DAEMON_PATH"];

// ── Port scanning ─────────────────────────────────────────────────

export function findFreePort(min: number, max: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const tryPort = (port: number): void => {
            if (port > max) {
                reject(new Error(`no free port in ${min}-${max}`));
                return;
            }
            const srv = net.createServer();
            srv.once("error", () => tryPort(port + 1));
            srv.once("listening", () => {
                srv.close(() => resolve(port));
            });
            srv.listen(port, "127.0.0.1");
        };
        tryPort(min);
    });
}

// ── PID file ──────────────────────────────────────────────────────

export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export function readPidFile(): { pid: number; port: number } | null {
    try {
        const raw = fs.readFileSync(PID_FILE, "utf8");
        const data = JSON.parse(raw) as { pid?: number; port?: number };
        if (typeof data.pid === "number" && typeof data.port === "number") return data as { pid: number; port: number };
        return null;
    } catch {
        return null;
    }
}

export function writePidFile(pid: number, port: number): void {
    fs.mkdirSync(ECO_RELAY_DIR, { recursive: true });
    const tmp = `${PID_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ pid, port }));
    fs.renameSync(tmp, PID_FILE);
}

export function deletePidFile(): void {
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

// ── WS readiness check ───────────────────────────────────────────

export async function waitForReady(port: number): Promise<boolean> {
    for (let i = 0; i < READINESS_ATTEMPTS; i++) {
        try {
            const ws = new WebSocket(`ws://127.0.0.1:${port}`);
            const ok = await new Promise<boolean>((resolve) => {
                const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 400);
                ws.onopen = () => { clearTimeout(timer); try { ws.close(); } catch {} resolve(true); };
                ws.onerror = () => { clearTimeout(timer); resolve(false); };
            });
            if (ok) return true;
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, READINESS_INTERVAL_MS));
    }
    return false;
}

// ── Codex binary resolution (VS34: validated containment) ─────────

export function validateCodexPath(candidate: string): string | null {
    let resolved: string;
    try {
        resolved = fs.realpathSync(candidate);
    } catch {
        return null;
    }
    for (const root of ALLOWED_CODEX_ROOTS) {
        const rel = path.relative(root, resolved);
        if (!rel.startsWith("..") && !path.isAbsolute(rel)) return resolved;
    }
    return null;
}

export function findCodexBin(): string {
    try {
        const where = execSync("where.exe codex", { encoding: "utf8", timeout: 5_000 }).trim();
        for (const line of where.split("\n")) {
            const candidate = line.trim();
            if (!candidate || !fs.existsSync(candidate)) continue;
            const validated = validateCodexPath(candidate);
            if (validated) return validated;
        }
    } catch { /* fallback */ }

    const local = path.join(os.homedir(), "AppData", "Local", "OpenAI", "Codex", "bin");
    const SEMVER_DIR_RE = /^\d+\.\d+(\.\d+)?/;
    if (fs.existsSync(local)) {
        const entries = fs.readdirSync(local).sort();
        for (const entry of entries) {
            if (entry.startsWith(".")) continue;
            if (!SEMVER_DIR_RE.test(entry)) continue;
            const candidate = path.join(local, entry, "codex.exe");
            if (!fs.existsSync(candidate)) continue;
            const validated = validateCodexPath(candidate);
            if (validated) return validated;
        }
    }

    throw new Error("codex binary not found in expected install directory");
}

// ── Env scrub (VS37) ──────────────────────────────────────────────

export function buildChildEnv(extra: Record<string, string>): Record<string, string | undefined> {
    const env = { ...process.env, ...extra };
    const secretsLower = ECORELAY_SECRET_KEYS.map((k) => k.toLowerCase());
    for (const key of Object.keys(env)) {
        if (secretsLower.includes(key.toLowerCase())) {
            delete env[key];
        }
    }
    return env;
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const userArgs = process.argv.slice(2);
    const codexBin = findCodexBin();

    let port: number;
    let appServerPid: number | null = null;
    let weOwnAppServer = false;

    const existing = readPidFile();
    if (existing && isProcessAlive(existing.pid)) {
        const ready = await waitForReady(existing.port);
        if (ready) {
            console.log(`Reusing existing app-server (PID ${existing.pid}, port ${existing.port})`);
            port = existing.port;
            appServerPid = existing.pid;
        } else {
            // VS36: Cannot prove identity of the alive pid on Windows.
            // Don't kill it — it may not be ours. Spawn fresh on a new port.
            console.log(`PID ${existing.pid} alive but not responding as app-server. Spawning fresh.`);
            deletePidFile();
            port = await findFreePort(PORT_MIN, PORT_MAX);
            weOwnAppServer = true;
        }
    } else {
        if (existing) deletePidFile();
        port = await findFreePort(PORT_MIN, PORT_MAX);
        weOwnAppServer = true;
    }

    const wsUrl = `ws://127.0.0.1:${port}`;

    if (weOwnAppServer) {
        console.log(`Starting Codex app-server on ${wsUrl}...`);
        const appServer = spawn(codexBin, ["app-server", "--listen", wsUrl], {
            detached: false,
            windowsHide: true,
            stdio: "ignore",
            env: buildChildEnv({ ECORELAY_CODEX_APP_SERVER: wsUrl }),
        });

        appServerPid = appServer.pid ?? null;
        if (!appServerPid) {
            console.error("Failed to start app-server.");
            process.exit(1);
        }

        writePidFile(appServerPid, port);

        appServer.on("error", (err) => {
            console.error(`App-server error: ${err.message}`);
        });

        const ready = await waitForReady(port);
        if (!ready) {
            console.error("App-server did not become ready in time.");
            try { appServer.kill(); } catch { /* ignore */ }
            deletePidFile();
            process.exit(1);
        }

        console.log(`App-server ready (PID ${appServerPid}, port ${port}).`);
    }

    console.log(`Launching Codex TUI connected to ${wsUrl}...`);

    const codex = spawn(codexBin, ["--remote", wsUrl, ...userArgs], {
        env: buildChildEnv({ ECORELAY_CODEX_APP_SERVER: wsUrl }),
        stdio: "inherit",
        detached: false,
    });

    const cleanup = (): void => {
        if (weOwnAppServer && appServerPid) {
            try { process.kill(appServerPid); } catch { /* ignore */ }
            deletePidFile();
        }
    };

    codex.on("close", (code) => {
        cleanup();
        process.exit(code ?? 0);
    });

    process.on("SIGTERM", () => { codex.kill(); cleanup(); process.exit(130); });
    process.on("SIGINT", () => { codex.kill(); cleanup(); process.exit(130); });
    process.on("exit", cleanup);
    process.on("uncaughtException", (err) => {
        console.error(`Uncaught: ${err.message}`);
        cleanup();
        process.exit(1);
    });
}

if (import.meta.main) {
    main().catch((e) => {
        console.error(`Launcher fatal: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    });
}
