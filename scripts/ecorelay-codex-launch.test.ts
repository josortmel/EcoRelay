import { describe, expect, test, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    findFreePort,
    isProcessAlive,
    validateCodexPath,
    buildChildEnv,
    readPidFile,
    writePidFile,
    deletePidFile,
} from "./ecorelay-codex-launch";

// ── findFreePort ──────────────────────────────────────────────────

describe("findFreePort", () => {
    test("finds a port in range", async () => {
        const port = await findFreePort(4580, 4599);
        expect(port).toBeGreaterThanOrEqual(4580);
        expect(port).toBeLessThanOrEqual(4599);
    });

    test("returned port is actually free", async () => {
        const port = await findFreePort(4580, 4599);
        const net = await import("node:net");
        const srv = net.createServer();
        await new Promise<void>((resolve, reject) => {
            srv.once("error", reject);
            srv.once("listening", () => srv.close(() => resolve()));
            srv.listen(port, "127.0.0.1");
        });
    });
});

// ── isProcessAlive ────────────────────────────────────────────────

describe("isProcessAlive", () => {
    test("returns true for own PID", () => {
        expect(isProcessAlive(process.pid)).toBe(true);
    });

    test("returns false for nonexistent PID", () => {
        expect(isProcessAlive(99999999)).toBe(false);
    });
});

// ── validateCodexPath (VS34) ──────────────────────────────────────

describe("validateCodexPath", () => {
    test("accepts real codex binary under AppData\\Local\\OpenAI\\Codex", () => {
        const local = path.join(os.homedir(), "AppData", "Local", "OpenAI", "Codex", "bin");
        if (!fs.existsSync(local)) return;
        for (const entry of fs.readdirSync(local)) {
            const candidate = path.join(local, entry, "codex.exe");
            if (fs.existsSync(candidate)) {
                expect(validateCodexPath(candidate)).not.toBeNull();
                return;
            }
        }
    });

    test("rejects binary outside allowed roots", () => {
        const tmp = path.join(os.tmpdir(), `evil-codex-${Date.now()}.exe`);
        fs.writeFileSync(tmp, "fake");
        expect(validateCodexPath(tmp)).toBeNull();
        fs.unlinkSync(tmp);
    });

    test("rejects nonexistent path", () => {
        expect(validateCodexPath("/nonexistent/codex.exe")).toBeNull();
    });
});

// ── buildChildEnv (VS37/VS49) ─────────────────────────────────────

describe("buildChildEnv", () => {
    test("strips ECORELAY_WS_TOKEN (uppercase)", () => {
        process.env.ECORELAY_WS_TOKEN = "secret";
        const env = buildChildEnv({});
        expect(env.ECORELAY_WS_TOKEN).toBeUndefined();
        delete process.env.ECORELAY_WS_TOKEN;
    });

    test("strips ecorelay_ws_token (lowercase)", () => {
        process.env.ecorelay_ws_token = "secret-lower";
        const env = buildChildEnv({});
        expect(env.ecorelay_ws_token).toBeUndefined();
        delete process.env.ecorelay_ws_token;
    });

    test("strips ECORELAY_BUN_PATH and ECORELAY_DAEMON_PATH", () => {
        process.env.ECORELAY_BUN_PATH = "/evil/bun";
        process.env.ECORELAY_DAEMON_PATH = "/evil/daemon";
        const env = buildChildEnv({});
        expect(env.ECORELAY_BUN_PATH).toBeUndefined();
        expect(env.ECORELAY_DAEMON_PATH).toBeUndefined();
        delete process.env.ECORELAY_BUN_PATH;
        delete process.env.ECORELAY_DAEMON_PATH;
    });

    test("includes ECORELAY_CODEX_APP_SERVER from extra", () => {
        const env = buildChildEnv({ ECORELAY_CODEX_APP_SERVER: "ws://127.0.0.1:4580" });
        expect(env.ECORELAY_CODEX_APP_SERVER).toBe("ws://127.0.0.1:4580");
    });

    test("preserves PATH and other env vars", () => {
        const env = buildChildEnv({});
        expect(env.PATH).toBeDefined();
    });
});

// ── PID file ──────────────────────────────────────────────────────

describe("pid file", () => {
    afterEach(() => {
        deletePidFile();
    });

    test("write + read roundtrip", () => {
        writePidFile(12345, 4580);
        const data = readPidFile();
        expect(data).not.toBeNull();
        expect(data!.pid).toBe(12345);
        expect(data!.port).toBe(4580);
    });

    test("read returns null when file missing", () => {
        deletePidFile();
        expect(readPidFile()).toBeNull();
    });

    test("delete removes the file", () => {
        writePidFile(99, 99);
        deletePidFile();
        expect(readPidFile()).toBeNull();
    });

    test("delete is idempotent", () => {
        deletePidFile();
        deletePidFile();
    });
});
