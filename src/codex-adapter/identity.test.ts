import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    resolveCwd,
    updateCwdFromThread,
    getGitBranch,
    safeName,
    suffixedName,
    loadPeerId,
    savePeerId,
    initialPeerName,
    _resetForTest,
} from "./identity";

beforeEach(() => {
    _resetForTest();
    delete process.env.ECORELAY_CWD;
    delete process.env.RELAY_PEER_ID;
});

afterEach(() => {
    _resetForTest();
    delete process.env.ECORELAY_CWD;
    delete process.env.RELAY_PEER_ID;
});

// ── resolveCwd ────────────────────────────────────────────────────

describe("resolveCwd", () => {
    test("returns ECORELAY_CWD if set", () => {
        process.env.ECORELAY_CWD = "/some/project";
        expect(resolveCwd()).toBe("/some/project");
    });

    test("falls back to process.cwd() if no env var", () => {
        expect(resolveCwd()).toBe(process.cwd());
    });

    test("caches the result", () => {
        process.env.ECORELAY_CWD = "/first";
        const first = resolveCwd();
        process.env.ECORELAY_CWD = "/second";
        expect(resolveCwd()).toBe(first);
    });

    test("updateCwdFromThread overrides process.cwd()-derived value with real dir", () => {
        resolveCwd(); // caches process.cwd()
        const realDir = os.tmpdir();
        updateCwdFromThread(realDir);
        expect(resolveCwd()).toBe(path.resolve(realDir));
    });

    test("updateCwdFromThread does NOT override ECORELAY_CWD", () => {
        process.env.ECORELAY_CWD = "/env-wins";
        resolveCwd();
        updateCwdFromThread("/from-thread");
        expect(resolveCwd()).toBe("/env-wins");
    });

    test("updateCwdFromThread ignores empty string", () => {
        const original = resolveCwd();
        updateCwdFromThread("");
        expect(resolveCwd()).toBe(original);
    });

    test("updateCwdFromThread rejects traversal paths", () => {
        const original = resolveCwd();
        updateCwdFromThread("/../../../etc/passwd");
        expect(resolveCwd()).toBe(original);
    });

    test("updateCwdFromThread rejects non-existent path", () => {
        const original = resolveCwd();
        updateCwdFromThread("/this/path/does/not/exist/at/all");
        expect(resolveCwd()).toBe(original);
    });

    test("updateCwdFromThread rejects file (not directory)", () => {
        const tmp = path.join(os.tmpdir(), `ecorelay-file-test-${Date.now()}`);
        fs.writeFileSync(tmp, "not a dir");
        const original = resolveCwd();
        updateCwdFromThread(tmp);
        expect(resolveCwd()).toBe(original);
        fs.unlinkSync(tmp);
    });
});

// ── getGitBranch ──────────────────────────────────────────────────

describe("getGitBranch", () => {
    test("reads branch from .git/HEAD ref", () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ecorelay-test-"));
        const gitDir = path.join(tmp, ".git");
        fs.mkdirSync(gitDir);
        fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feature/my-branch\n");
        expect(getGitBranch(tmp)).toBe("feature/my-branch");
        fs.rmSync(tmp, { recursive: true });
    });

    test("returns short hash for detached HEAD", () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ecorelay-test-"));
        const gitDir = path.join(tmp, ".git");
        fs.mkdirSync(gitDir);
        fs.writeFileSync(path.join(gitDir, "HEAD"), "abc1234567890\n");
        expect(getGitBranch(tmp)).toBe("abc1234");
        fs.rmSync(tmp, { recursive: true });
    });

    test("returns 'unknown' if no .git dir", () => {
        expect(getGitBranch("/nonexistent-path-xyz")).toBe("unknown");
    });

    test("returns 'unknown' for empty/whitespace HEAD", () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ecorelay-test-"));
        const gitDir = path.join(tmp, ".git");
        fs.mkdirSync(gitDir);
        fs.writeFileSync(path.join(gitDir, "HEAD"), "   \n");
        expect(getGitBranch(tmp)).toBe("unknown");
        fs.rmSync(tmp, { recursive: true });
    });
});

// ── safeName ──────────────────────────────────────────────────────

describe("safeName", () => {
    test("accepts valid names", () => {
        expect(safeName("my-session")).toBe("my-session");
        expect(safeName("codex-backend.v2")).toBe("codex-backend.v2");
        expect(safeName("A_B_C")).toBe("A_B_C");
    });

    test("rejects empty", () => {
        expect(safeName("")).toBeNull();
        expect(safeName("   ")).toBeNull();
    });

    test("rejects names over 64 chars", () => {
        expect(safeName("a".repeat(65))).toBeNull();
    });

    test("accepts exactly 64 chars", () => {
        const name = "a".repeat(64);
        expect(safeName(name)).toBe(name);
    });

    test("rejects special characters", () => {
        expect(safeName("hello world")).toBeNull();
        expect(safeName("foo@bar")).toBeNull();
        expect(safeName("path/name")).toBeNull();
    });

    test("trims whitespace before validating", () => {
        expect(safeName("  valid  ")).toBe("valid");
    });
});

// ── suffixedName ──────────────────────────────────────────────────

describe("suffixedName", () => {
    test("appends suffix for first collision", () => {
        expect(suffixedName("codex-myproject", 1)).toBe("codex-myproject-2");
    });

    test("replaces existing numeric suffix", () => {
        expect(suffixedName("codex-myproject-2", 2)).toBe("codex-myproject-3");
    });

    test("handles base name without suffix", () => {
        expect(suffixedName("session", 0)).toBe("session-1");
    });
});

// ── Peer ID cache ─────────────────────────────────────────────────

describe("peer ID cache", () => {
    const tmpDir = path.join(os.tmpdir(), `ecorelay-cache-test-${Date.now()}`);
    const origCache = process.env.HOME;

    test("loadPeerId returns null for unknown cwd", () => {
        expect(loadPeerId("/nonexistent")).toBeNull();
    });

    test("savePeerId + loadPeerId roundtrip", () => {
        const cwd = `/test-roundtrip-${Date.now()}`;
        savePeerId(cwd, "codex-myrepo");
        _resetForTest();
        expect(loadPeerId(cwd)).toBe("codex-myrepo");
    });

    test("loadPeerId returns null for empty cwd", () => {
        expect(loadPeerId("")).toBeNull();
    });

    test("savePeerId no-ops for empty cwd", () => {
        savePeerId("", "name");
        expect(loadPeerId("")).toBeNull();
    });
});

// ── initialPeerName ───────────────────────────────────────────────

describe("initialPeerName", () => {
    test("uses RELAY_PEER_ID if set and valid", () => {
        process.env.RELAY_PEER_ID = "fixed-name";
        expect(initialPeerName("/some/dir")).toBe("fixed-name");
    });

    test("ignores RELAY_PEER_ID if invalid", () => {
        process.env.RELAY_PEER_ID = "invalid name with spaces";
        const name = initialPeerName("/some/my-project");
        expect(name).not.toBe("invalid name with spaces");
        expect(name).toContain("codex-");
    });

    test("derives codex-{basename} from cwd", () => {
        expect(initialPeerName("/Users/dev/my-project")).toBe("codex-my-project");
    });

    test("uses cached name if available", () => {
        const cwd = `/test-cached-${Date.now()}`;
        savePeerId(cwd, "codex-cached-name");
        _resetForTest();
        expect(initialPeerName(cwd)).toBe("codex-cached-name");
    });

    test("handles empty cwd", () => {
        const name = initialPeerName("");
        expect(name).toBe("codex-session");
    });

    test("sanitizes special chars in basename", () => {
        expect(initialPeerName("/path/my project (v2)")).toBe("codex-my-project--v2-");
    });

    test("truncates long basenames to 50 chars", () => {
        const longName = "a".repeat(100);
        const name = initialPeerName(`/path/${longName}`);
        expect(name.length).toBeLessThanOrEqual(57); // "codex-" (6) + 50 + safety
    });
});
