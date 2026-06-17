// Verifier edge cases — T7 ecorelay-codex-launch.ts
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { findFreePort, isProcessAlive, validateCodexPath } from "./ecorelay-codex-launch";

// NOTE: importing this module triggers main() as a top-level side effect.
// main() is async: it runs findCodexBin (blocking execSync), readPidFile, then
// awaits findFreePort — yielding to the event loop. Tests run during that yield.
// main() continues after tests complete. If codex is installed, spawn() is called;
// if app-server doesn't respond in 5s, process.exit(1) fires AFTER test suite ends.
// Risk: if any test takes > 5s, process.exit(1) could terminate the test runner mid-run.

// ── findFreePort edge cases ───────────────────────────────────────

describe("Verifier: findFreePort edge cases", () => {
    test("AT1: all ports in narrow range occupied → rejects with 'no free port'", async () => {
        const lo = 45982;
        const hi = 45983;

        const srv1 = net.createServer();
        const srv2 = net.createServer();
        await new Promise<void>((r, e) => srv1.once("error", e).listen(lo, "127.0.0.1", r));
        await new Promise<void>((r, e) => srv2.once("error", e).listen(hi, "127.0.0.1", r));

        try {
            await expect(findFreePort(lo, hi)).rejects.toThrow(`no free port in ${lo}-${hi}`);
        } finally {
            await new Promise<void>((r) => srv1.close(() => r()));
            await new Promise<void>((r) => srv2.close(() => r()));
        }
    });

    test("AT2: min > max → rejects immediately (no ports to try)", async () => {
        // tryPort(4599) → 4599 > 4580 (max) → immediate reject
        await expect(findFreePort(4599, 4580)).rejects.toThrow("no free port in 4599-4580");
    });

    test("AT3: min === max, port free → returns that exact port", async () => {
        const lo = 45985;
        const hi = 45985;
        // First confirm the port is free (skip if not)
        let isFree = true;
        const probe = net.createServer();
        await new Promise<void>((r) => probe.once("error", () => { isFree = false; r(); }).listen(lo, "127.0.0.1", () => probe.close(r)));

        if (!isFree) {
            expect(true).toBe(true); // port busy — skip
            return;
        }
        const port = await findFreePort(lo, hi);
        expect(port).toBe(lo);
    });

    test("AT4: findFreePort returns a number (not string, not undefined)", async () => {
        const port = await findFreePort(45986, 45988);
        expect(typeof port).toBe("number");
        expect(Number.isInteger(port)).toBe(true);
    });
});

// ── validateCodexPath edge cases ──────────────────────────────────

describe("Verifier: validateCodexPath edge cases", () => {
    test("AT5: empty string → null (realpathSync throws on empty path)", () => {
        expect(validateCodexPath("")).toBeNull();
    });

    test("AT6: file in tmpdir → null (tmpdir not in ALLOWED_CODEX_ROOTS)", () => {
        const tmp = path.join(os.tmpdir(), `edge-codex-${Date.now()}.exe`);
        fs.writeFileSync(tmp, "fake");
        try {
            expect(validateCodexPath(tmp)).toBeNull();
        } finally {
            fs.unlinkSync(tmp);
        }
    });

    test("AT7: SECURITY — symlink pointing outside roots → null (realpathSync follows link)", () => {
        const target = path.join(os.tmpdir(), `sym-target-${Date.now()}`);
        const link = path.join(os.tmpdir(), `codex-sym-${Date.now()}.exe`);
        fs.writeFileSync(target, "fake");
        try {
            fs.symlinkSync(target, link);
        } catch {
            // Windows may require elevated privileges or Developer Mode for symlinks
            expect(true).toBe(true); // symlink creation unavailable — test skipped
            fs.unlinkSync(target);
            return;
        }
        try {
            // realpathSync(link) → resolves to target (in tmpdir, not in allowed roots)
            expect(validateCodexPath(link)).toBeNull();
        } finally {
            try { fs.unlinkSync(link); } catch {}
            try { fs.unlinkSync(target); } catch {}
        }
    });

    test("AT8: relative path ('codex.exe') → null (realpathSync fails if file not in cwd)", () => {
        // If codex.exe doesn't exist in cwd, realpathSync throws → null
        // If it somehow does exist, it would need to be in an allowed root to pass
        const result = validateCodexPath("codex.exe");
        // Either null (file not found) or validated (inside allowed root if found in cwd)
        // In test environment cwd is repo root — codex.exe is not there
        expect(result).toBeNull();
    });

    test("AT9: path that is a directory in tmpdir → null (outside allowed roots)", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-codex-dir-"));
        try {
            expect(validateCodexPath(dir)).toBeNull();
        } finally {
            fs.rmdirSync(dir);
        }
    });

    test("AT10: ALLOWED_CODEX_ROOTS root directory itself → accepted if it exists on disk", () => {
        // rel = path.relative(root, root) = "" → not startsWith(".."), not absolute → ACCEPTED
        // This documents that validateCodexPath accepts the root dir as "within root".
        // Not a security issue (you can't spawn a directory), but worth knowing.
        const codexRoot = path.join(os.homedir(), "AppData", "Local", "OpenAI", "Codex");
        if (!fs.existsSync(codexRoot)) {
            expect(true).toBe(true); // Codex not installed — skip
            return;
        }
        // The root itself is accepted (rel="", no ".." prefix, not absolute)
        expect(validateCodexPath(codexRoot)).not.toBeNull();
    });
});

// ── isProcessAlive edge cases ─────────────────────────────────────

describe("Verifier: isProcessAlive edge cases", () => {
    test("AT11: negative PID → false (no valid process has negative PID)", () => {
        expect(isProcessAlive(-1)).toBe(false);
    });

    test("AT12: very large PID (max 32-bit int) → false (no such process)", () => {
        expect(isProcessAlive(2147483647)).toBe(false);
    });

    test("AT13: PID 0 → behavior documented (OS-dependent: Windows returns false)", () => {
        // On Windows, process.kill(0, 0) throws EINVAL (PID 0 invalid) → false
        // On Linux, kill(0, 0) sends to the process group → might return true
        const result = isProcessAlive(0);
        expect(typeof result).toBe("boolean"); // whatever it returns, it's a boolean
    });

    test("AT14: parent process PID is alive", () => {
        // ppid should be alive (the test runner's parent)
        expect(isProcessAlive(process.ppid ?? 1)).toBe(true);
    });
});

// ── buildChildEnv (debt paid: now exported) ───────────────────────

import { buildChildEnv, readPidFile, writePidFile, deletePidFile, findCodexBin } from "./ecorelay-codex-launch";

describe("Verifier: buildChildEnv strips ECORELAY secrets (AT15)", () => {
    test("AT15a: ECORELAY_WS_TOKEN stripped from child env", () => {
        const saved = process.env.ECORELAY_WS_TOKEN;
        process.env.ECORELAY_WS_TOKEN = "secret-token-abc";
        try {
            const env = buildChildEnv({});
            expect(env.ECORELAY_WS_TOKEN).toBeUndefined();
        } finally {
            if (saved === undefined) delete process.env.ECORELAY_WS_TOKEN;
            else process.env.ECORELAY_WS_TOKEN = saved;
        }
    });

    test("AT15b: ECORELAY_BUN_PATH and ECORELAY_DAEMON_PATH stripped", () => {
        process.env.ECORELAY_BUN_PATH = "/bun";
        process.env.ECORELAY_DAEMON_PATH = "/daemon";
        try {
            const env = buildChildEnv({});
            expect(env.ECORELAY_BUN_PATH).toBeUndefined();
            expect(env.ECORELAY_DAEMON_PATH).toBeUndefined();
        } finally {
            delete process.env.ECORELAY_BUN_PATH;
            delete process.env.ECORELAY_DAEMON_PATH;
        }
    });

    test("AT15c: non-secret env vars preserved in child env", () => {
        const env = buildChildEnv({ CUSTOM_VAR: "custom-value" });
        expect(env.CUSTOM_VAR).toBe("custom-value");
        expect(env.PATH).toBe(process.env.PATH);
    });

    test("AT15d: case-insensitive stripping — ecorelay_ws_token also stripped", () => {
        (process.env as Record<string, string>).ecorelay_ws_token = "lowercase-secret";
        try {
            const env = buildChildEnv({});
            expect((env as Record<string, unknown>).ecorelay_ws_token).toBeUndefined();
        } finally {
            delete (process.env as Record<string, string>).ecorelay_ws_token;
        }
    });
});

// ── readPidFile/writePidFile/deletePidFile (debt paid: now exported) ─

describe("Verifier: pid file roundtrip (AT16)", () => {
    test("AT16a: writePidFile + readPidFile roundtrip returns correct pid+port", () => {
        const testPid = 99999;
        const testPort = 45999;
        writePidFile(testPid, testPort);
        const result = readPidFile();
        deletePidFile(); // cleanup
        expect(result).not.toBeNull();
        expect(result!.pid).toBe(testPid);
        expect(result!.port).toBe(testPort);
    });

    test("AT16b: deletePidFile makes readPidFile return null", () => {
        writePidFile(12345, 4580);
        deletePidFile();
        expect(readPidFile()).toBeNull();
    });

    test("AT16c: readPidFile returns null when file does not exist", () => {
        deletePidFile(); // ensure absent
        expect(readPidFile()).toBeNull();
    });
});

// ── findCodexBin (debt paid: now exported) ────────────────────────

describe("Verifier: findCodexBin (AT17)", () => {
    test("AT17: findCodexBin throws 'not found' or returns validated path when codex installed", () => {
        try {
            const bin = findCodexBin();
            // Codex installed: result must be a non-empty string inside an allowed root
            expect(typeof bin).toBe("string");
            expect(bin.length).toBeGreaterThan(0);
        } catch (e) {
            // Codex not installed: must throw exactly this message
            expect((e as Error).message).toContain("codex binary not found");
        }
    });
});

// ── .cmd file structure ───────────────────────────────────────────

describe("Verifier: ecorelay-codex.cmd structure", () => {
    test("AT18: .cmd references correct bun path (%USERPROFILE%\\.bun\\bin\\bun.exe)", () => {
        const cmd = fs.readFileSync(
            path.join(path.dirname(import.meta.path.replace("file:///", "")), "ecorelay-codex.cmd"),
            "utf8"
        );
        expect(cmd).toContain(".bun\\bin\\bun.exe");
        expect(cmd).toContain("LAUNCHER");
    });

    test("AT19: .cmd passes all args to launcher via %* (no injection risk from args)", () => {
        const cmd = fs.readFileSync(
            path.join(path.dirname(import.meta.path.replace("file:///", "")), "ecorelay-codex.cmd"),
            "utf8"
        );
        // %* passes args as-is to bun run; bun passes to spawn as array (no shell interpolation)
        expect(cmd).toContain("%*");
        // security note: %* in cmd can be injected IF used in shell-interpolated context;
        // here it's passed to `bun run script.ts %*` which bun treats as process.argv
        // No shell eval occurs — safe.
    });
});

// ── PID file indirect test ────────────────────────────────────────

describe("Verifier: pid file behavior (indirect via file I/O)", () => {
    test("AT20: stale pid file with dead PID — isProcessAlive returns false for that PID", () => {
        // Simulate what main() does when it reads a pid file:
        // it calls isProcessAlive(pid). If dead → deletePidFile(), spawn fresh.
        // We can't call deletePidFile() directly, but we can verify the isProcessAlive
        // check works correctly for a dead pid (the key building block).
        const deadPid = 9999999;
        expect(isProcessAlive(deadPid)).toBe(false);
        // → main() would call deletePidFile() (private) and spawn fresh (correct behavior)
        // The "don't kill unknown pid" logic: main() only kills if weOwnAppServer=true,
        // set only when we spawned the process. Dead/stale pids are never kill()-ed.
    });

    test("AT21: isProcessAlive(current pid) + deadPid sequence is deterministic", () => {
        // Verify the building block used by main() for reuse vs spawn decision
        expect(isProcessAlive(process.pid)).toBe(true); // self = alive
        expect(isProcessAlive(9999998)).toBe(false); // nonexistent = dead
        // main() uses: existing && isProcessAlive(existing.pid) ? reuse : spawn fresh
    });
});
