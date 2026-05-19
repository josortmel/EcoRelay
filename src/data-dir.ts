import * as os from "node:os";
import * as path from "node:path";

/**
 * Resolve the relay data directory.
 *
 * Precedence:
 * 1. `CLAUDE_PLUGIN_DATA` — set by Claude Code when launched as a plugin.
 * 2. `~/.eco-relay/` — fallback for manual installs.
 */
export function dataDir(): string {
    return process.env.CLAUDE_PLUGIN_DATA ?? path.join(os.homedir(), ".eco-relay");
}

export function hubSocketPath(): string {
    return process.env.RELAY_HUB_SOCKET ?? path.join(dataDir(), "hub.sock");
}

export function logsDir(): string {
    return path.join(dataDir(), "logs");
}

export function groupsDir(): string {
    return path.join(dataDir(), "groups");
}
