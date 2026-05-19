#!/usr/bin/env bun
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

const dataDir =
    process.env.CLAUDE_PLUGIN_DATA ?? path.join(require("node:os").homedir(), ".eco-relay");
const configPath = path.join(dataDir, "bridge.json");

function fail(msg: string): never {
    console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
    process.exit(1);
}

function ok(msg: string): void {
    console.log(`\x1b[32m✓ ${msg}\x1b[0m`);
}

function info(msg: string): void {
    console.log(`  ${msg}`);
}

// Step 1: Read config
if (!fs.existsSync(configPath)) {
    fail(`bridge.json not found at ${configPath}\n  Create it with: hub_id, listen, secret, peers`);
}

let config: {
    hub_id: string;
    listen: number;
    bind?: string;
    secret: string;
    peers: Array<{ hub_id: string; host: string; port: number }>;
};
try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (e) {
    fail(`bridge.json is not valid JSON: ${e instanceof Error ? e.message : e}`);
}

ok(`bridge.json loaded from ${configPath}`);
info(`hub_id: ${config.hub_id}`);
info(`listen: ${config.listen}`);
info(`bind: ${config.bind ?? "0.0.0.0"}`);
info(`secret: ${config.secret.slice(0, 4)}...(${config.secret.length} chars)`);
info(`peers: ${config.peers.length}`);

if (!config.hub_id || config.hub_id.length === 0) fail("hub_id is empty");
if (!config.secret || config.secret.length < 8) fail("secret must be at least 8 characters");
ok("Config validates");

// Step 2: Check listen port
if (config.listen > 0) {
    info(`\nChecking listen port ${config.listen}...`);
    try {
        const srv = net.createServer();
        await new Promise<void>((resolve, reject) => {
            srv.on("error", reject);
            srv.listen(config.listen, config.bind ?? "0.0.0.0", () => {
                srv.close();
                resolve();
            });
        });
        ok(`Port ${config.listen} is available`);
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("EADDRINUSE")) {
            info(`Port ${config.listen} in use (hub may already be running — that's OK)`);
        } else {
            fail(`Cannot bind to port ${config.listen}: ${msg}`);
        }
    }
}

// Step 3: Test connectivity to each peer
for (const peer of config.peers) {
    info(`\nTesting connection to ${peer.hub_id} (${peer.host}:${peer.port})...`);

    try {
        const socket = await new Promise<net.Socket>((resolve, reject) => {
            const s = net.createConnection({ host: peer.host, port: peer.port }, () => resolve(s));
            s.on("error", reject);
            setTimeout(() => {
                s.destroy();
                reject(new Error("connection timeout (3s)"));
            }, 3000);
        });

        ok(`TCP connected to ${peer.host}:${peer.port}`);

        // Try bridge handshake
        const hello =
            JSON.stringify({
                type: "bridge_hello",
                hub_id: config.hub_id,
                secret: config.secret,
                protocol_version: "4",
                peers: [],
            }) + "\n";

        socket.write(hello);

        const response = await new Promise<string>((resolve, reject) => {
            let buf = "";
            socket.on("data", (chunk) => {
                buf += chunk.toString("utf8");
                const idx = buf.indexOf("\n");
                if (idx >= 0) resolve(buf.slice(0, idx));
            });
            setTimeout(() => reject(new Error("handshake timeout (5s)")), 5000);
        });

        const msg = JSON.parse(response);
        if (msg.type === "bridge_welcome") {
            ok(
                `Handshake OK — remote hub_id: ${msg.hub_id}, remote peers: ${msg.peers?.length ?? 0}`,
            );
            for (const p of msg.peers ?? []) {
                info(`  remote peer: ${p.name} (${p.cwd})`);
            }
        } else {
            fail(`Unexpected response: ${JSON.stringify(msg).slice(0, 200)}`);
        }

        socket.destroy();
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("ECONNREFUSED")) {
            fail(`Connection refused — is the remote hub running? Is port ${peer.port} open?`);
        } else if (msg.includes("ETIMEDOUT") || msg.includes("connection timeout")) {
            fail(`Connection timed out — check: same LAN? firewall? correct IP?`);
        } else if (msg.includes("handshake timeout")) {
            fail(
                `TCP connected but handshake failed — remote hub may not have bridge enabled, or secret mismatch`,
            );
        } else {
            fail(`Connection failed: ${msg}`);
        }
    }
}

console.log("\n\x1b[32m✓ All checks passed. Bridge is ready.\x1b[0m");
