import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CACHE_DIR = path.join(os.homedir(), ".cache", "ecorelay");
const PEER_ID_CACHE = path.join(CACHE_DIR, "peer-ids.json");

// ── CWD resolution ────────────────────────────────────────────────

let _resolvedCwd: string | null = null;

export function resolveCwd(): string {
    if (_resolvedCwd) return _resolvedCwd;
    const envCwd = process.env.ECORELAY_CWD;
    if (envCwd && envCwd.length > 0) {
        _resolvedCwd = envCwd;
        return _resolvedCwd;
    }
    _resolvedCwd = process.cwd();
    return _resolvedCwd;
}

export function updateCwdFromThread(threadCwd: string): void {
    if (!threadCwd || threadCwd.length === 0) return;
    if (process.env.ECORELAY_CWD && process.env.ECORELAY_CWD.length > 0) return;
    if (threadCwd.includes("..")) return;
    const normalized = path.resolve(threadCwd);
    try {
        if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) return;
    } catch {
        return;
    }
    _resolvedCwd = normalized;
}

// ── Git branch ────────────────────────────────────────────────────

export function getGitBranch(cwd: string): string {
    try {
        const head = fs.readFileSync(path.join(cwd, ".git", "HEAD"), "utf8").trim();
        if (!head) return "unknown";
        const match = head.match(/^ref: refs\/heads\/(.+)$/);
        return match?.[1] ?? (head.slice(0, 7) || "unknown");
    } catch {
        return "unknown";
    }
}

// ── Name sanitization ─────────────────────────────────────────────

export function safeName(raw: string): string | null {
    const t = raw.trim();
    if (t === "" || t.length > 64) return null;
    return /^[A-Za-z0-9._-]+$/.test(t) ? t : null;
}

export function suffixedName(name: string, retries: number): string {
    const base = name.replace(/-[0-9]+$/, "");
    return `${base}-${retries + 1}`;
}

// ── Peer ID cache (per-cwd → stable name across restarts) ─────────

type PeerCache = Record<string, string>;
const _memCache = new Map<string, string | null>();

function loadCacheFile(): PeerCache {
    try {
        const raw = fs.readFileSync(PEER_ID_CACHE, "utf8");
        const data: unknown = JSON.parse(raw);
        if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
        return data as PeerCache;
    } catch {
        return {};
    }
}

function saveCacheFile(data: PeerCache): void {
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${PEER_ID_CACHE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, PEER_ID_CACHE);
}

export function loadPeerId(cwd: string): string | null {
    if (!cwd) return null;
    if (_memCache.has(cwd)) return _memCache.get(cwd) ?? null;
    const v = loadCacheFile()[cwd];
    const result = typeof v === "string" ? v : null;
    _memCache.set(cwd, result);
    return result;
}

export function savePeerId(cwd: string, name: string): void {
    if (!cwd) return;
    _memCache.set(cwd, name);
    const cache = loadCacheFile();
    if (cache[cwd] === name) return;
    cache[cwd] = name;
    try {
        saveCacheFile(cache);
    } catch {
        // best-effort
    }
}

// ── Peer name resolution ──────────────────────────────────────────

export function initialPeerName(cwd: string): string {
    const envName = process.env.RELAY_PEER_ID;
    if (envName !== undefined) {
        const sanitized = safeName(envName);
        if (sanitized !== null) return sanitized;
    }

    const cached = loadPeerId(cwd);
    if (cached) {
        const sanitized = safeName(cached);
        if (sanitized) return sanitized;
    }

    const base = path.basename(cwd || "") || "session";
    const cleanBase = base.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 50);
    return safeName(`codex-${cleanBase}`) ?? "codex-session";
}

// ── Reset (for tests) ─────────────────────────────────────────────

export function _resetForTest(): void {
    _resolvedCwd = null;
    _memCache.clear();
}
