// Loaded by `bun test` before any test file (bunfig.toml, [test].preload).
//
// Every test run gets a throwaway home directory. Without it, the suite read and wrote
// the real ~/.eco-relay of whoever ran it (mailboxes, groups, the hub lock and token,
// and bridge.json with its secret, which every test hub loaded) and ~/.cache/ecorelay.
// Spawned daemons inherit the same environment, so they are isolated too.
//
// It also drops relay settings inherited from a live session (port, token, socket,
// peer id), so a test never reaches the hub that is actually running on the machine.
import { afterAll, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Homes left by runs that were killed before afterAll: remove those older than a day
// (never recent ones, which may belong to a run still going).
const DAY_MS = 24 * 60 * 60 * 1000;
for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith("ecorelay-test-home-")) continue;
    const dir = path.join(os.tmpdir(), name);
    try {
        if (Date.now() - fs.statSync(dir).mtimeMs > DAY_MS) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    } catch {
        // gone already, or still in use: leave it
    }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ecorelay-test-home-"));

// Child processes (spawned daemons) read HOME / USERPROFILE when they start.
process.env.HOME = home;
process.env.USERPROFILE = home;
// This process: Bun on Linux reads HOME once at startup, so changing it here is not
// enough. Replace os.homedir for every module the tests import.
mock.module("node:os", () => ({
    ...os,
    default: { ...os, homedir: () => home },
    homedir: () => home,
}));

delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.ECORELAY_BUN_PATH;
delete process.env.ECORELAY_DAEMON_PATH;
delete process.env.ECORELAY_IDLE_MS;
delete process.env.ECORELAY_WS_PORT;
delete process.env.ECORELAY_WS_TOKEN;
delete process.env.ECORELAY_WS_URL;
delete process.env.RELAY_HUB_SOCKET;
delete process.env.RELAY_PEER_ID;

// `bun test` does not run process "exit" handlers: a global afterAll in the preload
// runs once, after the last test file.
afterAll(() => {
    try {
        fs.rmSync(home, { recursive: true, force: true });
    } catch {
        // a spawned daemon may still hold a file on Windows; the sweep above takes it later
    }
});
