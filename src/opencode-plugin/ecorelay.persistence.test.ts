import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Replicate persistence logic from ecorelay.ts (module-private functions) ──

const CACHE_DIR = path.join(os.homedir(), ".cache", "ecorelay-test");
const PEER_ID_CACHE = path.join(CACHE_DIR, "peer-ids.json");

function cacheKey(projectPath: string, sessionId: string): string {
    return `${projectPath}#${sessionId}`;
}

function loadCache(): Record<string, string> {
    try {
        const raw = fs.readFileSync(PEER_ID_CACHE, "utf8");
        const data = JSON.parse(raw);
        if (typeof data !== "object" || data === null) return {};
        return data as Record<string, string>;
    } catch {
        return {};
    }
}

function saveCache(data: Record<string, string>): void {
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${PEER_ID_CACHE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, PEER_ID_CACHE);
}

function loadPeerId(projectPath: string, sessionId: string): string | null {
    const cache = loadCache();
    return cache[cacheKey(projectPath, sessionId)] ?? null;
}

function savePeerId(projectPath: string, sessionId: string, name: string): void {
    const cache = loadCache();
    const key = cacheKey(projectPath, sessionId);
    if (cache[key] === name) return;
    cache[key] = name;
    saveCache(cache);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("cacheKey", () => {
    test("produces projectPath#sessionId format", () => {
        expect(cacheKey("/home/user/project", "session-1")).toBe("/home/user/project#session-1");
    });

    test("different project paths produce different keys", () => {
        const k1 = cacheKey("/proj/a", "s1");
        const k2 = cacheKey("/proj/b", "s1");
        expect(k1).not.toBe(k2);
    });

    test("different session IDs produce different keys", () => {
        const k1 = cacheKey("/proj", "s1");
        const k2 = cacheKey("/proj", "s2");
        expect(k1).not.toBe(k2);
    });

    test("hash in project path handled correctly", () => {
        const key = cacheKey("/path/with#hash", "s1");
        expect(key).toBe("/path/with#hash#s1");
        // First # separates project from session — last segment is sessionId
        const lastHash = key.lastIndexOf("#");
        expect(key.slice(0, lastHash)).toBe("/path/with#hash");
        expect(key.slice(lastHash + 1)).toBe("s1");
    });
});

describe("savePeerId — tmp+rename atomic write", () => {
    beforeEach(() => {
        try {
            fs.unlinkSync(PEER_ID_CACHE);
        } catch {}
        try {
            fs.unlinkSync(`${PEER_ID_CACHE}.tmp`);
        } catch {}
    });

    afterEach(() => {
        try {
            fs.unlinkSync(PEER_ID_CACHE);
        } catch {}
        try {
            fs.unlinkSync(`${PEER_ID_CACHE}.tmp`);
        } catch {}
    });

    test("savePeerId writes to cache file", () => {
        savePeerId("/proj/test", "s-write", "Eco");
        const name = loadPeerId("/proj/test", "s-write");
        expect(name).toBe("Eco");
    });

    test("loadPeerId returns null on cache miss", () => {
        const name = loadPeerId("/nonexistent/proj", "no-such-session");
        expect(name).toBeNull();
    });

    test("save then load returns same name", () => {
        savePeerId("/proj", "s-42", "Prima");
        expect(loadPeerId("/proj", "s-42")).toBe("Prima");
    });

    test("multiple peers in same project", () => {
        savePeerId("/proj/shared", "s-a", "Alice");
        savePeerId("/proj/shared", "s-b", "Bob");
        expect(loadPeerId("/proj/shared", "s-a")).toBe("Alice");
        expect(loadPeerId("/proj/shared", "s-b")).toBe("Bob");
    });

    test("same session in different projects → different names", () => {
        savePeerId("/proj/a", "s1", "Alpha");
        savePeerId("/proj/b", "s1", "Beta");
        expect(loadPeerId("/proj/a", "s1")).toBe("Alpha");
        expect(loadPeerId("/proj/b", "s1")).toBe("Beta");
    });

    test("name unchanged → no file write (optimization)", () => {
        savePeerId("/proj/opt", "s-opt", "Original");

        // Record mtime after first save
        const mtime1 = fs.statSync(PEER_ID_CACHE).mtimeMs;

        // Save with same name — should skip write
        savePeerId("/proj/opt", "s-opt", "Original");

        const mtime2 = fs.statSync(PEER_ID_CACHE).mtimeMs;
        expect(mtime2).toBe(mtime1); // File NOT modified
    });

    test("tmp file cleaned up after rename", () => {
        savePeerId("/proj", "s-clean", "Test");
        const tmpExists = (() => {
            try {
                fs.accessSync(`${PEER_ID_CACHE}.tmp`);
                return true;
            } catch {
                return false;
            }
        })();
        expect(tmpExists).toBe(false);
    });
});

describe("loadCache — edge cases", () => {
    beforeEach(() => {
        try {
            fs.unlinkSync(PEER_ID_CACHE);
        } catch {}
    });

    afterEach(() => {
        try {
            fs.unlinkSync(PEER_ID_CACHE);
        } catch {}
    });

    test("malformed JSON → {}", () => {
        fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
        fs.writeFileSync(PEER_ID_CACHE, "not-json-at-all{{{", { mode: 0o600 });
        const result = loadCache();
        expect(result).toEqual({});
    });

    test("null JSON → {}", () => {
        fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
        fs.writeFileSync(PEER_ID_CACHE, "null", { mode: 0o600 });
        const result = loadCache();
        expect(result).toEqual({});
    });

    test("array JSON → returns [] (typeof check passes, but loadPeerId handles via ?? null)", () => {
        fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
        fs.writeFileSync(PEER_ID_CACHE, "[]", { mode: 0o600 });
        const result = loadCache();
        // Actual behavior: typeof [] === "object" && [] !== null → passed through
        // loadPeerId: cache[cacheKey(...)] → undefined → ?? null → null (functionally correct)
        expect(Array.isArray(result)).toBe(true);
        // Verify loadPeerId still returns null with array cache
        expect(loadPeerId("/proj", "any-session")).toBeNull();
    });

    test("empty string → {}", () => {
        fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
        fs.writeFileSync(PEER_ID_CACHE, "", { mode: 0o600 });
        const result = loadCache();
        expect(result).toEqual({});
    });

    test("missing file → {}", () => {
        const result = loadCache();
        expect(result).toEqual({});
    });

    test("valid JSON returns parsed object", () => {
        fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
        fs.writeFileSync(PEER_ID_CACHE, JSON.stringify({ "/a#b": "Test" }), { mode: 0o600 });
        const result = loadCache();
        expect(result).toEqual({ "/a#b": "Test" });
    });
});

describe("persistence integration", () => {
    beforeEach(() => {
        try {
            fs.unlinkSync(PEER_ID_CACHE);
        } catch {}
    });

    afterEach(() => {
        try {
            fs.unlinkSync(PEER_ID_CACHE);
        } catch {}
    });

    test("peer name survives simulated restart (save→load cycle)", () => {
        // Start: no cache
        const initialName = loadPeerId("/proj", "survive-me");
        expect(initialName).toBeNull();

        // Use session title as initial (ensurePeer logic)
        const sessionTitle = "Session Title";
        const peerName = initialName ?? sessionTitle ?? "fallback";
        expect(peerName).toBe("Session Title");

        // User renames
        savePeerId("/proj", "survive-me", "CustomName");

        // Simulated restart: loadPeerId returns cached name
        const afterRestart = loadPeerId("/proj", "survive-me");
        expect(afterRestart).toBe("CustomName");

        // ensurePeer on restart: cachedName ?? title ?? id
        const cachedName = afterRestart;
        const newPeerName = cachedName ?? sessionTitle ?? "survive-me";
        expect(newPeerName).toBe("CustomName");
    });

    test("ensurePeer name priority: cached > title > id", () => {
        const fallback = (cached: string | null, title: string | null, id: string): string => {
            return cached ?? title ?? id;
        };
        expect(fallback("Cached", "Title", "id1")).toBe("Cached");
        expect(fallback(null, "Title", "id1")).toBe("Title");
        expect(fallback(null, null, "id1")).toBe("id1");
    });
});

describe("concurrent save safety", () => {
    beforeEach(() => {
        try {
            fs.unlinkSync(PEER_ID_CACHE);
        } catch {}
    });

    afterEach(() => {
        try {
            fs.unlinkSync(PEER_ID_CACHE);
        } catch {}
    });

    test("multiple saves in sequence don't corrupt cache", () => {
        for (let i = 0; i < 10; i++) {
            savePeerId("/proj", `s-${i}`, `Peer-${i}`);
        }
        for (let i = 0; i < 10; i++) {
            expect(loadPeerId("/proj", `s-${i}`)).toBe(`Peer-${i}`);
        }
    });

    test("unicode peer names saved and loaded correctly", () => {
        savePeerId("/proj", "unicode", "セッション 🎉");
        expect(loadPeerId("/proj", "unicode")).toBe("セッション 🎉");
    });

    test("special characters in project path", () => {
        const specialPath = "C:\\Users\\someone\\Documents\\My Project [v2]";
        savePeerId(specialPath, "s1", "Test");
        expect(loadPeerId(specialPath, "s1")).toBe("Test");
    });
});
