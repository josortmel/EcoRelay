// Verifier edge cases — not in plan
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

const CACHE_FILE = path.join(os.homedir(), ".cache", "ecorelay", "peer-ids.json");

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

describe("Verifier edge: safeName boundaries", () => {
    test("AT1: exactly 64-char name passes", () => {
        expect(safeName("a".repeat(64))).toBe("a".repeat(64));
    });

    test("AT2: 65-char name fails", () => {
        expect(safeName("a".repeat(65))).toBeNull();
    });

    test("AT3: RELAY_PEER_ID with surrounding whitespace is trimmed and accepted", () => {
        process.env.RELAY_PEER_ID = "  valid-name  ";
        expect(initialPeerName("/any/dir")).toBe("valid-name");
    });

    test("AT4: underscore is valid in safeName", () => {
        expect(safeName("A_B_C")).toBe("A_B_C");
    });
});

describe("Verifier edge: suffixedName ending in -3", () => {
    test("AT5: name-3 with retries=2 → name-3 (same suffix replaced)", () => {
        // suffixedName strips trailing -N, then appends retries+1
        // "codex-proj-3" → base="codex-proj", retries=2 → "codex-proj-3"
        expect(suffixedName("codex-proj-3", 2)).toBe("codex-proj-3");
    });

    test("AT6: name-3 with retries=3 → name-4", () => {
        expect(suffixedName("codex-proj-3", 3)).toBe("codex-proj-4");
    });
});

describe("Verifier edge: corrupted cache JSON", () => {
    test("AT7: corrupted cache returns null for any cwd", () => {
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        fs.writeFileSync(CACHE_FILE, "{corrupted JSON!!!", "utf8");
        _resetForTest();
        expect(loadPeerId("/some/cwd")).toBeNull();
        // restore: write empty cache
        fs.writeFileSync(CACHE_FILE, "{}", "utf8");
    });

    test("AT8: cache containing array (not object) falls back gracefully", () => {
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        fs.writeFileSync(CACHE_FILE, '["not","an","object"]', "utf8");
        _resetForTest();
        expect(loadPeerId("/some/cwd")).toBeNull();
        fs.writeFileSync(CACHE_FILE, "{}", "utf8");
    });
});

describe("Verifier edge: ECORELAY_CWD then thread update", () => {
    test("AT9: ECORELAY_CWD set → updateCwdFromThread does NOT override (ECORELAY_CWD wins)", () => {
        // After fix: updateCwdFromThread returns early when ECORELAY_CWD is set
        process.env.ECORELAY_CWD = "/env-cwd";
        resolveCwd(); // caches /env-cwd
        updateCwdFromThread("/thread-cwd");
        expect(resolveCwd()).toBe("/env-cwd"); // ECORELAY_CWD takes priority
    });

    test("AT10: thread update ignored when empty string after ECORELAY_CWD", () => {
        process.env.ECORELAY_CWD = "/env-cwd";
        resolveCwd();
        updateCwdFromThread("");
        expect(resolveCwd()).toBe("/env-cwd");
    });
});

describe("Verifier edge: getGitBranch corner cases", () => {
    test("AT11: empty HEAD file returns 'unknown' (OBS1 fixed: was empty string)", () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vtest-"));
        const gitDir = path.join(tmp, ".git");
        fs.mkdirSync(gitDir);
        fs.writeFileSync(path.join(gitDir, "HEAD"), "");
        // After fix: if (!head) return "unknown" — empty file correctly returns "unknown"
        const result = getGitBranch(tmp);
        expect(result).toBe("unknown");
        fs.rmSync(tmp, { recursive: true });
    });

    test("AT12: HEAD with whitespace-only returns 'unknown' (fixed)", () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vtest-"));
        const gitDir = path.join(tmp, ".git");
        fs.mkdirSync(gitDir);
        fs.writeFileSync(path.join(gitDir, "HEAD"), "   \n");
        // trim() → "" → if (!head) return "unknown"
        const result = getGitBranch(tmp);
        expect(result).toBe("unknown");
        fs.rmSync(tmp, { recursive: true });
    });
});

describe("Verifier edge: initialPeerName basename edge cases", () => {
    test("AT13: cwd with only special chars produces valid name", () => {
        // basename "!!!" → cleaned to "---" → "codex----"
        const name = initialPeerName("/path/!!!");
        expect(name).toBeTruthy();
        // should be a valid codex- name (hyphens are valid)
        expect(safeName(name)).not.toBeNull();
    });

    test("AT14: RELAY_PEER_ID invalid → falls through to cached name", () => {
        const cwd = `/edge-test-cached-${Date.now()}`;
        savePeerId(cwd, "codex-from-cache");
        _resetForTest();
        process.env.RELAY_PEER_ID = "invalid name!";
        expect(initialPeerName(cwd)).toBe("codex-from-cache");
    });

    test("AT15: 100-char basename truncated to safe length", () => {
        const longPath = `/path/${"x".repeat(100)}`;
        const name = initialPeerName(longPath);
        expect(name.length).toBeLessThanOrEqual(64);
        expect(safeName(name)).not.toBeNull();
    });
});
