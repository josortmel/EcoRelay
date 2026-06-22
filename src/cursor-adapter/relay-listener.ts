/**
 * EcoRelay Cursor — relay listener (the PUSH channel)
 *
 * Cursor CLI has no live-TUI text injection. But a background shell whose
 * output is monitored WAKES the idle session (the same mechanism Cursor uses
 * for background-task supervision / the `/loop` skill). So: the cursor-adapter
 * (MCP server, connected to the Hub) appends incoming relay messages to
 * ~/.cursor/ecorelay-inbox.jsonl; the agent runs THIS script as a background
 * monitored shell; it tails that file and prints one sentinel line per new
 * message → Cursor wakes the session → the agent reads it and responds via
 * the relay_send tool.
 *
 * Arm it (the agent does this at session start, instructed via MCP
 * instructions / a Cursor rule):
 *   bun run <repo>/src/cursor-adapter/relay-listener.ts    (as a background task)
 *
 * Each emitted line:
 *   ECORELAY_MSG {"from":"...","text":"...","urgent":false,"ask_id":null}
 * The agent is told to treat ECORELAY_MSG lines as incoming relay messages.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const INBOX_FILE = path.join(os.homedir(), ".cursor", "ecorelay-inbox.jsonl");
const SENTINEL = "ECORELAY_MSG";
const POLL_MS = 1000;

function ensureFile(): void {
    try {
        fs.mkdirSync(path.dirname(INBOX_FILE), { recursive: true });
        if (!fs.existsSync(INBOX_FILE)) fs.writeFileSync(INBOX_FILE, "");
    } catch {
        /* ignore */
    }
}

function main(): void {
    ensureFile();
    // Start at end-of-file: only emit messages that arrive AFTER the listener
    // is armed (past messages are read via relay_inbox on demand).
    let offset = 0;
    try {
        offset = fs.statSync(INBOX_FILE).size;
    } catch {
        offset = 0;
    }

    process.stdout.write(`ECORELAY_LISTENER_READY watching ${INBOX_FILE}\n`);

    const tick = (): void => {
        let size: number;
        try {
            size = fs.statSync(INBOX_FILE).size;
        } catch {
            return;
        }
        if (size < offset) offset = 0; // file truncated/rotated
        if (size === offset) return;
        try {
            const fd = fs.openSync(INBOX_FILE, "r");
            const buf = Buffer.alloc(size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            fs.closeSync(fd);
            offset = size;
            const lines = buf
                .toString("utf8")
                .split("\n")
                .filter((l) => l.trim().length > 0);
            for (const line of lines) {
                // Re-emit each stored message with the sentinel prefix so the
                // monitored shell wakes the session with a recognizable line.
                process.stdout.write(`${SENTINEL} ${line}\n`);
            }
        } catch {
            /* ignore transient read errors */
        }
    };

    setInterval(tick, POLL_MS);
}

main();
