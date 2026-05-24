import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PROTOCOL_VERSION } from "../protocol";
import { createBridge } from "./bridge";
import { loadBridgeConfig, type BridgeConfig } from "./bridge-config";
import { startHub } from "./index";
import { createPeerRegistry } from "./registry";
import { rawConnect } from "./test-helpers";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 2000, intervalMs = 20): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) return;
        await sleep(intervalMs);
    }
    throw new Error("waitFor timed out");
}

function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as net.AddressInfo;
            server.close(() => resolve(addr.port));
        });
        server.on("error", reject);
    });
}

function register(client: Awaited<ReturnType<typeof rawConnect>>, name: string): Promise<unknown> {
    client.send({
        type: "register",
        name,
        cwd: "/tmp/" + name,
        git_branch: "main",
        protocol_version: PROTOCOL_VERSION,
    });
    return client.next();
}

// ---------------------------------------------------------------------------
// 1. loadBridgeConfig
// ---------------------------------------------------------------------------

describe("loadBridgeConfig", () => {
    let tmpDir: string;
    let savedEnv: string | undefined;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bridge-cfg-"));
        savedEnv = process.env.CLAUDE_PLUGIN_DATA;
        process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    });

    afterEach(() => {
        if (savedEnv !== undefined) process.env.CLAUDE_PLUGIN_DATA = savedEnv;
        else delete process.env.CLAUDE_PLUGIN_DATA;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("returns null when bridge.json does not exist", () => {
        expect(loadBridgeConfig()).toBeNull();
    });

    test("parses valid config with all fields", () => {
        fs.writeFileSync(
            path.join(tmpDir, "bridge.json"),
            JSON.stringify({
                hub_id: "test-hub",
                listen: 9111,
                secret: "supersecret1",
                peers: [{ hub_id: "other", host: "localhost", port: 9112 }],
            }),
        );
        const result = loadBridgeConfig();
        expect(result).not.toBeNull();
        expect(result!.hub_id).toBe("test-hub");
        expect(result!.listen).toBe(9111);
        expect(result!.peers).toHaveLength(1);
        expect(result!.peers[0]!.host).toBe("localhost");
    });

    test("returns null on invalid JSON", () => {
        fs.writeFileSync(path.join(tmpDir, "bridge.json"), "{ not json ]");
        expect(loadBridgeConfig()).toBeNull();
    });

    test("applies defaults: listen=0, peers=[]", () => {
        fs.writeFileSync(
            path.join(tmpDir, "bridge.json"),
            JSON.stringify({ hub_id: "my-hub", secret: "atleasteight" }),
        );
        const result = loadBridgeConfig();
        expect(result).not.toBeNull();
        expect(result!.listen).toBe(0);
        expect(result!.peers).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 2. PeerRegistry remote peers
// ---------------------------------------------------------------------------

describe("PeerRegistry remote peers", () => {
    test("addRemotePeer → hasRemotePeer returns true", () => {
        const reg = createPeerRegistry();
        reg.addRemotePeer("hub-b", { name: "alice", cwd: "/a", git_branch: "main", last_seen: 0 });
        expect(reg.hasRemotePeer("alice@hub-b")).toBe(true);
        expect(reg.hasRemotePeer("bob@hub-b")).toBe(false);
    });

    test("getRemotePeer returns hub_id and localName", () => {
        const reg = createPeerRegistry();
        reg.addRemotePeer("hub-b", { name: "alice", cwd: "/a", git_branch: "main", last_seen: 0 });
        const remote = reg.getRemotePeer("alice@hub-b");
        expect(remote).toBeDefined();
        expect(remote!.hub_id).toBe("hub-b");
        expect(remote!.localName).toBe("alice");
    });

    test("removeRemotePeer removes specific peer, leaves others", () => {
        const reg = createPeerRegistry();
        reg.addRemotePeer("hub-b", { name: "alice", cwd: "/a", git_branch: "main", last_seen: 0 });
        reg.addRemotePeer("hub-b", { name: "bob", cwd: "/b", git_branch: "dev", last_seen: 0 });
        reg.removeRemotePeer("hub-b", "alice");
        expect(reg.hasRemotePeer("alice@hub-b")).toBe(false);
        expect(reg.hasRemotePeer("bob@hub-b")).toBe(true);
    });

    test("removeAllRemotePeersForHub removes all peers for that hub only", () => {
        const reg = createPeerRegistry();
        reg.addRemotePeer("hub-b", { name: "alice", cwd: "/a", git_branch: "main", last_seen: 0 });
        reg.addRemotePeer("hub-b", { name: "bob", cwd: "/b", git_branch: "dev", last_seen: 0 });
        reg.addRemotePeer("hub-c", { name: "carol", cwd: "/c", git_branch: "main", last_seen: 0 });
        reg.removeAllRemotePeersForHub("hub-b");
        expect(reg.hasRemotePeer("alice@hub-b")).toBe(false);
        expect(reg.hasRemotePeer("bob@hub-b")).toBe(false);
        expect(reg.hasRemotePeer("carol@hub-c")).toBe(true);
    });

    test("list() includes remote peers with @hub_id suffix", () => {
        const reg = createPeerRegistry();
        reg.addRemotePeer("hub-b", {
            name: "alice",
            cwd: "/a",
            git_branch: "main",
            last_seen: 100,
        });
        const list = reg.list();
        const entry = list.find((p) => p.name === "alice@hub-b");
        expect(entry).toBeDefined();
        expect(entry!.cwd).toBe("/a");
    });

    test("hasName() returns true for qualified remote peer names", () => {
        const reg = createPeerRegistry();
        reg.addRemotePeer("hub-b", { name: "alice", cwd: "/a", git_branch: "main", last_seen: 0 });
        expect(reg.hasName("alice@hub-b")).toBe(true);
        expect(reg.hasName("alice")).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 3. bridge core (TCP)
// ---------------------------------------------------------------------------

describe("bridge core", () => {
    const bridges: Array<ReturnType<typeof createBridge>> = [];

    afterEach(async () => {
        for (const b of bridges) await b.close();
        bridges.length = 0;
    });

    test("two bridges connect and establish bidirectional connections", async () => {
        const portA = await getFreePort();
        const portB = await getFreePort();
        const regA = createPeerRegistry();
        const regB = createPeerRegistry();

        const configA: BridgeConfig = {
            hub_id: "hub-a",
            listen: portA,
            secret: "shared-xyz",
            peers: [{ hub_id: "hub-b", host: "127.0.0.1", port: portB }],
        };
        const configB: BridgeConfig = {
            hub_id: "hub-b",
            listen: portB,
            secret: "shared-xyz",
            peers: [],
        };

        const bridgeA = createBridge(configA, regA);
        const bridgeB = createBridge(configB, regB);
        bridges.push(bridgeA, bridgeB);

        bridgeB.listen();
        bridgeA.listen();
        bridgeA.connectToAllPeers();

        await waitFor(() => bridgeA.connections.has("hub-b") && bridgeB.connections.has("hub-a"));
        expect(bridgeA.connections.has("hub-b")).toBe(true);
        expect(bridgeB.connections.has("hub-a")).toBe(true);
    });

    test("bridge rejects connection with wrong secret", async () => {
        const portB = await getFreePort();
        const regB = createPeerRegistry();
        const bridgeB = createBridge(
            { hub_id: "hub-b", listen: portB, secret: "correct-secret", peers: [] },
            regB,
        );
        bridges.push(bridgeB);
        bridgeB.listen();

        const regA = createPeerRegistry();
        const bridgeA = createBridge(
            {
                hub_id: "hub-a",
                listen: 0,
                secret: "wrong-secret!",
                peers: [{ hub_id: "hub-b", host: "127.0.0.1", port: portB }],
            },
            regA,
        );
        bridges.push(bridgeA);
        bridgeA.connectToAllPeers();

        await sleep(200);
        expect(bridgeA.connections.has("hub-b")).toBe(false);
        expect(bridgeB.connections.has("hub-a")).toBe(false);
    });

    test("bridge rejects duplicate hub_id connection", async () => {
        const portB = await getFreePort();
        const regB = createPeerRegistry();
        const bridgeB = createBridge(
            { hub_id: "hub-b", listen: portB, secret: "sec-dup-test", peers: [] },
            regB,
        );
        bridges.push(bridgeB);
        bridgeB.listen();

        // First connection from hub-a
        const regA = createPeerRegistry();
        const bridgeA = createBridge(
            {
                hub_id: "hub-a",
                listen: 0,
                secret: "sec-dup-test",
                peers: [{ hub_id: "hub-b", host: "127.0.0.1", port: portB }],
            },
            regA,
        );
        bridges.push(bridgeA);
        bridgeA.connectToAllPeers();
        await waitFor(() => bridgeB.connections.has("hub-a"));

        // Second connection with same hub_id
        const regA2 = createPeerRegistry();
        const bridgeA2 = createBridge(
            {
                hub_id: "hub-a",
                listen: 0,
                secret: "sec-dup-test",
                peers: [{ hub_id: "hub-b", host: "127.0.0.1", port: portB }],
            },
            regA2,
        );
        bridges.push(bridgeA2);
        bridgeA2.connectToAllPeers();

        await sleep(200);
        expect(bridgeB.connections.size).toBe(1);
        expect(bridgeA2.connections.has("hub-b")).toBe(false);
    });

    test("bridge_peer_update propagates remote peer join/leave", async () => {
        const portA = await getFreePort();
        const portB = await getFreePort();
        const regA = createPeerRegistry();
        const regB = createPeerRegistry();

        const bridgeA = createBridge(
            {
                hub_id: "hub-a",
                listen: portA,
                secret: "peer-upd-sec",
                peers: [{ hub_id: "hub-b", host: "127.0.0.1", port: portB }],
            },
            regA,
        );
        const bridgeB = createBridge(
            { hub_id: "hub-b", listen: portB, secret: "peer-upd-sec", peers: [] },
            regB,
        );
        bridges.push(bridgeA, bridgeB);

        bridgeB.listen();
        bridgeA.listen();
        bridgeA.connectToAllPeers();
        await waitFor(() => bridgeA.connections.has("hub-b"));

        // Send peer join from B → A
        bridgeB.sendBridgeMsg("hub-a", {
            type: "bridge_peer_update",
            hub_id: "hub-b",
            action: "join",
            peer: { name: "charlie", cwd: "/c", git_branch: "main", last_seen: Date.now() },
        });
        await waitFor(() => regA.hasRemotePeer("charlie@hub-b"));
        expect(regA.hasRemotePeer("charlie@hub-b")).toBe(true);

        // Send peer leave from B → A
        bridgeB.sendBridgeMsg("hub-a", {
            type: "bridge_peer_update",
            hub_id: "hub-b",
            action: "leave",
            name: "charlie",
        });
        await waitFor(() => !regA.hasRemotePeer("charlie@hub-b"));
        expect(regA.hasRemotePeer("charlie@hub-b")).toBe(false);
    });

    test("bridge disconnect cleans up remote peers", async () => {
        const portA = await getFreePort();
        const portB = await getFreePort();
        const regA = createPeerRegistry();
        const regB = createPeerRegistry();

        const bridgeA = createBridge(
            {
                hub_id: "hub-a",
                listen: portA,
                secret: "disc-sec",
                peers: [{ hub_id: "hub-b", host: "127.0.0.1", port: portB }],
            },
            regA,
        );
        const bridgeB = createBridge(
            { hub_id: "hub-b", listen: portB, secret: "disc-sec", peers: [] },
            regB,
        );
        bridges.push(bridgeA, bridgeB);

        bridgeB.listen();
        bridgeA.listen();
        bridgeA.connectToAllPeers();
        await waitFor(() => bridgeA.connections.has("hub-b"));

        bridgeB.sendBridgeMsg("hub-a", {
            type: "bridge_peer_update",
            hub_id: "hub-b",
            action: "join",
            peer: { name: "dave", cwd: "/d", git_branch: "main", last_seen: Date.now() },
        });
        await waitFor(() => regA.hasRemotePeer("dave@hub-b"));

        await bridgeB.close();

        await waitFor(() => !regA.hasRemotePeer("dave@hub-b"));
        expect(regA.hasRemotePeer("dave@hub-b")).toBe(false);
        expect(bridgeA.connections.has("hub-b")).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 4. Full hub integration (startHub with bridge)
// ---------------------------------------------------------------------------

describe("bridge integration — full hub", () => {
    let dirA: string;
    let dirB: string;
    let hubA: { close: () => Promise<void> };
    let hubB: { close: () => Promise<void> };
    let sockA: string;
    let sockB: string;
    let savedEnv: string | undefined;

    beforeEach(async () => {
        savedEnv = process.env.CLAUDE_PLUGIN_DATA;
        dirA = fs.mkdtempSync(path.join(os.tmpdir(), "relay-hub-a-"));
        dirB = fs.mkdtempSync(path.join(os.tmpdir(), "relay-hub-b-"));
        sockA = path.join(dirA, "hub.sock");
        sockB = path.join(dirB, "hub.sock");

        const portA = await getFreePort();
        const portB = await getFreePort();

        fs.writeFileSync(
            path.join(dirA, "bridge.json"),
            JSON.stringify({
                hub_id: "hub-a",
                listen: portA,
                secret: "integ-secret",
                peers: [{ hub_id: "hub-b", host: "127.0.0.1", port: portB }],
            }),
        );
        fs.writeFileSync(
            path.join(dirB, "bridge.json"),
            JSON.stringify({ hub_id: "hub-b", listen: portB, secret: "integ-secret", peers: [] }),
        );

        // Start hub-B first so its bridge TCP server is listening before hub-A tries to connect
        process.env.CLAUDE_PLUGIN_DATA = dirB;
        hubB = await startHub({ socketPath: sockB, idleExitMs: 999999 });
        await sleep(100); // wait for bridge TCP server to bind

        // Start hub-A which connects outbound to hub-B
        process.env.CLAUDE_PLUGIN_DATA = dirA;
        hubA = await startHub({ socketPath: sockA, idleExitMs: 999999 });

        // Restore env
        if (savedEnv !== undefined) process.env.CLAUDE_PLUGIN_DATA = savedEnv;
        else delete process.env.CLAUDE_PLUGIN_DATA;

        // Wait for bridge handshake to complete
        await sleep(300);
    });

    afterEach(async () => {
        await hubA.close();
        await hubB.close();
        fs.rmSync(dirA, { recursive: true, force: true });
        fs.rmSync(dirB, { recursive: true, force: true });
    });

    test("list_peers on hub-A shows hub-B peer with @hub-b suffix after peer sync", async () => {
        const alice = await rawConnect(sockA);
        const bob = await rawConnect(sockB);
        await register(alice, "alice");
        await register(bob, "bob");

        // Wait for peer sync
        await sleep(100);

        alice.send({ type: "list_peers", req_id: "lp1" });
        const peersMsg = await alice.next();
        expect(peersMsg.type).toBe("peers");
        if (peersMsg.type === "peers") {
            const names = peersMsg.peers.map((p) => p.name);
            expect(names).toContain("bob@hub-b");
        }

        alice.close();
        bob.close();
    });

    test("ask/reply cross-hub round-trip succeeds", async () => {
        const alice = await rawConnect(sockA);
        const bob = await rawConnect(sockB);
        await register(alice, "alice");
        await register(bob, "bob");
        await sleep(100);

        const askId = "test-ask-001";
        alice.send({ type: "ask", to: "bob@hub-b", question: "hello from hub-a", ask_id: askId });

        // bob receives incoming_ask
        const incoming = await bob.next();
        expect(incoming.type).toBe("incoming_ask");
        if (incoming.type === "incoming_ask") {
            expect(incoming.from).toContain("alice");
            expect(incoming.question).toBe("hello from hub-a");

            // bob replies
            bob.send({ type: "reply", ask_id: incoming.ask_id, text: "pong from hub-b" });
        }

        // alice receives incoming_reply
        const reply = await alice.next();
        expect(reply.type).toBe("incoming_reply");
        if (reply.type === "incoming_reply") {
            expect(reply.text).toBe("pong from hub-b");
            expect(reply.ask_id).toBe(askId);
        }

        alice.close();
        bob.close();
    });

    test("new peer on hub-B appears in hub-A's peer list", async () => {
        const alice = await rawConnect(sockA);
        await register(alice, "alice");

        // bob joins AFTER bridge is connected
        const bob = await rawConnect(sockB);
        await register(bob, "bob");
        await sleep(100);

        alice.send({ type: "list_peers" });
        const peersMsg = await alice.next();
        expect(peersMsg.type).toBe("peers");
        if (peersMsg.type === "peers") {
            expect(peersMsg.peers.map((p) => p.name)).toContain("bob@hub-b");
        }

        alice.close();
        bob.close();
    });

    test("peer disconnect on hub-B removes it from hub-A's peer list", async () => {
        const alice = await rawConnect(sockA);
        const bob = await rawConnect(sockB);
        await register(alice, "alice");
        await register(bob, "bob");
        await sleep(100);

        // Verify bob@hub-b is visible
        alice.send({ type: "list_peers" });
        const before = await alice.next();
        expect(before.type).toBe("peers");
        if (before.type === "peers") {
            expect(before.peers.map((p) => p.name)).toContain("bob@hub-b");
        }

        // Bob disconnects
        bob.close();
        await sleep(150);

        // bob@hub-b should be gone
        alice.send({ type: "list_peers" });
        const after = await alice.next();
        expect(after.type).toBe("peers");
        if (after.type === "peers") {
            expect(after.peers.map((p) => p.name)).not.toContain("bob@hub-b");
        }

        alice.close();
    });
});

// ---------------------------------------------------------------------------
// 5. bridge integration — edge cases (beta tester functional tests)
// ---------------------------------------------------------------------------

describe("bridge integration — edge cases", () => {
    let dirA: string;
    let dirB: string;
    let hubA: { close: () => Promise<void> };
    let hubB: { close: () => Promise<void> };
    let sockA: string;
    let sockB: string;
    let savedEnv: string | undefined;
    let hubBClosed: boolean;

    beforeEach(async () => {
        hubBClosed = false;
        savedEnv = process.env.CLAUDE_PLUGIN_DATA;
        dirA = fs.mkdtempSync(path.join(os.tmpdir(), "relay-edge-a-"));
        dirB = fs.mkdtempSync(path.join(os.tmpdir(), "relay-edge-b-"));
        sockA = path.join(dirA, "hub.sock");
        sockB = path.join(dirB, "hub.sock");

        const portA = await getFreePort();
        const portB = await getFreePort();

        fs.writeFileSync(
            path.join(dirA, "bridge.json"),
            JSON.stringify({
                hub_id: "hub-a",
                listen: portA,
                secret: "edge-secret",
                peers: [{ hub_id: "hub-b", host: "127.0.0.1", port: portB }],
            }),
        );
        fs.writeFileSync(
            path.join(dirB, "bridge.json"),
            JSON.stringify({
                hub_id: "hub-b",
                listen: portB,
                secret: "edge-secret",
                peers: [],
            }),
        );

        process.env.CLAUDE_PLUGIN_DATA = dirB;
        hubB = await startHub({ socketPath: sockB, idleExitMs: 999999, sweepIntervalMs: 0 });
        await sleep(100);

        process.env.CLAUDE_PLUGIN_DATA = dirA;
        hubA = await startHub({ socketPath: sockA, idleExitMs: 999999, sweepIntervalMs: 0 });

        if (savedEnv !== undefined) process.env.CLAUDE_PLUGIN_DATA = savedEnv;
        else delete process.env.CLAUDE_PLUGIN_DATA;

        await sleep(300);
    });

    afterEach(async () => {
        await hubA.close();
        if (!hubBClosed) await hubB.close();
        fs.rmSync(dirA, { recursive: true, force: true });
        fs.rmSync(dirB, { recursive: true, force: true });
    });

    test("ask non-existent remote peer returns peer_not_found immediately", async () => {
        const alice = await rawConnect(sockA);
        await register(alice, "alice");

        const askId = "ask-ghost-001";
        alice.send({ type: "ask", to: "ghost@hub-b", question: "is anyone there?", ask_id: askId });

        const errMsg = await alice.next();
        expect(errMsg.type).toBe("err");
        if (errMsg.type === "err") {
            expect(errMsg.code).toBe("peer_not_found");
            expect((errMsg as Record<string, unknown>).ask_id).toBe(askId);
        }

        alice.close();
    });

    test("bridge disconnect cleans registry — subsequent ask returns peer_not_found, not timeout", async () => {
        const alice = await rawConnect(sockA);
        const bob = await rawConnect(sockB);
        await register(alice, "alice");
        await register(bob, "bob");
        await sleep(100);

        alice.send({ type: "list_peers" });
        const peersBefore = await alice.next();
        expect(peersBefore.type).toBe("peers");
        if (peersBefore.type === "peers") {
            expect(peersBefore.peers.map((p) => p.name)).toContain("bob@hub-b");
        }

        // Kill hub-B — bridge TCP closes, hub-A must clean up registry
        bob.close();
        hubBClosed = true;
        await hubB.close();
        await sleep(250);

        alice.send({ type: "list_peers" });
        const peersAfter = await alice.next();
        expect(peersAfter.type).toBe("peers");
        if (peersAfter.type === "peers") {
            expect(peersAfter.peers.map((p) => p.name)).not.toContain("bob@hub-b");
        }

        // New ask to the now-dead peer must fail fast, not hang on timeout
        const askId = "ask-post-disc-001";
        alice.send({ type: "ask", to: "bob@hub-b", question: "hello?", ask_id: askId });
        const errMsg = await alice.next();
        expect(errMsg.type).toBe("err");
        if (errMsg.type === "err") {
            expect(errMsg.code).toBe("peer_not_found");
        }

        alice.close();
    });

    test("same name on different hubs: local alice and alice@hub-b coexist and communicate", async () => {
        const aliceA = await rawConnect(sockA);
        const aliceB = await rawConnect(sockB);
        await register(aliceA, "alice");
        await register(aliceB, "alice"); // same bare name on a different hub
        await sleep(100);

        aliceA.send({ type: "list_peers" });
        const peersMsg = await aliceA.next();
        expect(peersMsg.type).toBe("peers");
        if (peersMsg.type === "peers") {
            const names = peersMsg.peers.map((p) => p.name);
            expect(names).toContain("alice@hub-b"); // remote alice visible
            expect(names).not.toContain("alice"); // self excluded from list
        }

        // Cross-hub ask succeeds even with identical bare names
        const askId = "ask-collision-001";
        aliceA.send({
            type: "ask",
            to: "alice@hub-b",
            question: "are you the other alice?",
            ask_id: askId,
        });

        const incoming = await aliceB.next();
        expect(incoming.type).toBe("incoming_ask");
        if (incoming.type === "incoming_ask") {
            expect(incoming.question).toBe("are you the other alice?");
            aliceB.send({ type: "reply", ask_id: incoming.ask_id, text: "yes, alice on hub-b" });
        }

        const reply = await aliceA.next();
        expect(reply.type).toBe("incoming_reply");
        if (reply.type === "incoming_reply") {
            expect(reply.text).toBe("yes, alice on hub-b");
            expect(reply.ask_id).toBe(askId);
        }

        aliceA.close();
        aliceB.close();
    });

    test("list_peers preserves cwd and git_branch for remote peers", async () => {
        const alice = await rawConnect(sockA);
        const bob = await rawConnect(sockB);
        await register(alice, "alice");
        bob.send({
            type: "register",
            name: "bob",
            cwd: "/home/bob/myproject",
            git_branch: "feature-bridge",
            protocol_version: PROTOCOL_VERSION,
        });
        await bob.next(); // ack
        await sleep(150);

        alice.send({ type: "list_peers" });
        const peersMsg = await alice.next();
        expect(peersMsg.type).toBe("peers");
        if (peersMsg.type === "peers") {
            const bobEntry = peersMsg.peers.find((p) => p.name === "bob@hub-b");
            expect(bobEntry).toBeDefined();
            expect(bobEntry!.cwd).toBe("/home/bob/myproject");
            expect(bobEntry!.git_branch).toBe("feature-bridge");
        }

        alice.close();
        bob.close();
    });
});

// ---------------------------------------------------------------------------
// 6. bridge integration — mid-ask timeout
// NEW_FINDING: bridge drop does NOT send peer_gone for in-flight asks.
// Caller waits for full timeout (400ms here, 600s default in prod).
// ---------------------------------------------------------------------------

describe("bridge integration — mid-ask timeout", () => {
    let dirA: string;
    let dirB: string;
    let hubA: { close: () => Promise<void> };
    let hubB: { close: () => Promise<void> };
    let sockA: string;
    let sockB: string;
    let savedEnv: string | undefined;

    beforeEach(async () => {
        savedEnv = process.env.CLAUDE_PLUGIN_DATA;
        dirA = fs.mkdtempSync(path.join(os.tmpdir(), "relay-tout-a-"));
        dirB = fs.mkdtempSync(path.join(os.tmpdir(), "relay-tout-b-"));
        sockA = path.join(dirA, "hub.sock");
        sockB = path.join(dirB, "hub.sock");

        const portA = await getFreePort();
        const portB = await getFreePort();

        fs.writeFileSync(
            path.join(dirA, "bridge.json"),
            JSON.stringify({
                hub_id: "hub-a",
                listen: portA,
                secret: "tout-secret",
                peers: [{ hub_id: "hub-b", host: "127.0.0.1", port: portB }],
            }),
        );
        fs.writeFileSync(
            path.join(dirB, "bridge.json"),
            JSON.stringify({
                hub_id: "hub-b",
                listen: portB,
                secret: "tout-secret",
                peers: [],
            }),
        );

        process.env.CLAUDE_PLUGIN_DATA = dirB;
        hubB = await startHub({ socketPath: sockB, idleExitMs: 999999, sweepIntervalMs: 0 });
        await sleep(100);

        process.env.CLAUDE_PLUGIN_DATA = dirA;
        hubA = await startHub({
            socketPath: sockA,
            idleExitMs: 999999,
            sweepIntervalMs: 0,
            defaultAskTimeoutMs: 400,
        });

        if (savedEnv !== undefined) process.env.CLAUDE_PLUGIN_DATA = savedEnv;
        else delete process.env.CLAUDE_PLUGIN_DATA;

        await sleep(300);
    });

    afterEach(async () => {
        await hubA.close();
        await hubB.close();
        fs.rmSync(dirA, { recursive: true, force: true });
        fs.rmSync(dirB, { recursive: true, force: true });
    });

    test("cross-hub ask with no reply times out — caller receives timeout error, not peer_gone", async () => {
        const alice = await rawConnect(sockA);
        const bob = await rawConnect(sockB);
        await register(alice, "alice");
        await register(bob, "bob");
        await sleep(100);

        const askId = "ask-timeout-001";
        alice.send({ type: "ask", to: "bob@hub-b", question: "will you reply?", ask_id: askId });

        // Confirm delivery to bob
        const incoming = await bob.next();
        expect(incoming.type).toBe("incoming_ask");

        // Bob stays silent — alice must eventually receive timeout (not peer_gone)
        const errMsg = await alice.next();
        expect(errMsg.type).toBe("err");
        if (errMsg.type === "err") {
            expect(errMsg.code).toBe("timeout");
            expect((errMsg as Record<string, unknown>).ask_id).toBe(askId);
        }

        alice.close();
        bob.close();
    }, 3000);
});

// ---------------------------------------------------------------------------
// 7. WS relay bridge
// ---------------------------------------------------------------------------

import { startRelayServer } from "../relay-server/index";

describe("bridge WS relay", () => {
    const bridges: Array<ReturnType<typeof createBridge>> = [];
    let relayServer: ReturnType<typeof startRelayServer> | null = null;
    const RELAY_TOKEN = "relay-token-ok";

    afterEach(async () => {
        for (const b of bridges) await b.close();
        bridges.length = 0;
        relayServer?.stop();
        relayServer = null;
    });

    async function startRelay(): Promise<ReturnType<typeof startRelayServer>> {
        const port = await getFreePort();
        const r = startRelayServer({
            port,
            secret: RELAY_TOKEN,
            max_hubs: 50,
            handshake_timeout_ms: 5000,
        });
        relayServer = r;
        return r;
    }

    function makeRelayBridge(hubId: string, relayUrl: string, reg = createPeerRegistry()) {
        const b = createBridge(
            {
                hub_id: hubId,
                listen: 0,
                secret: "local-secret",
                peers: [],
                relay: { url: relayUrl, token: RELAY_TOKEN },
            },
            reg,
        );
        bridges.push(b);
        return { bridge: b, registry: reg };
    }

    // 1. WS relay connection + handshake
    test("relay handshake: remote peers appear in registry", async () => {
        const relay = await startRelay();
        const regA = createPeerRegistry();
        const regB = createPeerRegistry();

        // Give bridge-b a local peer before connecting
        const peerEntry = { name: "bob", cwd: "/bob", git_branch: "main", last_seen: 0 };
        regB.addRemotePeer("__local__", peerEntry); // just to set up state
        // Use a hub with an initial peer by connecting with peers in bridge_hello
        // Actually create the bridges and connect
        const url = `ws://127.0.0.1:${relay.port}`;
        const { bridge: bridgeA } = makeRelayBridge("hub-a", url, regA);
        const { bridge: bridgeB } = makeRelayBridge("hub-b", url, regB);

        bridgeA.connectToAllPeers();
        bridgeB.connectToAllPeers();

        await waitFor(() => bridgeA.relayConnected && bridgeB.relayConnected);
        expect(bridgeA.relayConnected).toBe(true);
        expect(bridgeB.relayConnected).toBe(true);
    });

    // 2. bridge_forward routing via WS relay
    test("bridge_forward routes through relay to correct hub", async () => {
        const relay = await startRelay();
        const url = `ws://127.0.0.1:${relay.port}`;
        const regA = createPeerRegistry();
        const regB = createPeerRegistry();

        const { bridge: bridgeA } = makeRelayBridge("hub-a", url, regA);
        const { bridge: bridgeB } = makeRelayBridge("hub-b", url, regB);

        const received: Array<{ target_peer: string; origin_hub: string }> = [];
        bridgeB.setForwardHandler((fwd) =>
            received.push({ target_peer: fwd.target_peer, origin_hub: fwd.origin_hub }),
        );

        bridgeA.connectToAllPeers();
        bridgeB.connectToAllPeers();

        // Wait for relay handshakes and peer sync (hub-b registers "alice")
        await waitFor(() => bridgeA.relayConnected && bridgeB.relayConnected);

        // Manually add alice as a remote peer known to hub-a (simulates prior peer update)
        regA.addRemotePeer("hub-b", {
            name: "alice",
            cwd: "/alice",
            git_branch: "main",
            last_seen: 0,
        });

        // hub-a sends forward to alice@hub-b via relay
        const ok = bridgeA.sendForward("alice@hub-b", {
            type: "incoming_ask",
            from: "bob@hub-a",
            question: "hello?",
            ask_id: "ask-1",
        });
        expect(ok).toBe(true);

        await waitFor(() => received.length > 0);
        expect(received[0]!.target_peer).toBe("alice");
        expect(received[0]!.origin_hub).toBe("hub-a");
    });

    // 3. Peer update via WS relay
    test("peer update via relay: new peer appears in remote registry", async () => {
        const relay = await startRelay();
        const url = `ws://127.0.0.1:${relay.port}`;
        const regA = createPeerRegistry();
        const regB = createPeerRegistry();

        const { bridge: bridgeA } = makeRelayBridge("hub-a", url, regA);
        const { bridge: bridgeB } = makeRelayBridge("hub-b", url, regB);

        bridgeA.connectToAllPeers();
        bridgeB.connectToAllPeers();
        await waitFor(() => bridgeA.relayConnected && bridgeB.relayConnected);

        // hub-b broadcasts that "carol" joined
        bridgeB.broadcastPeerUpdate({
            type: "bridge_peer_update",
            action: "join",
            peer: { name: "carol", cwd: "/carol", git_branch: "main", last_seen: 0 },
        });

        // hub-a should eventually see carol@hub-b in its registry
        await waitFor(() => regA.hasRemotePeer("carol@hub-b"));
        expect(regA.hasRemotePeer("carol@hub-b")).toBe(true);
    });

    // 4. WS reconnection on close with backoff + peer cleanup
    test("relay disconnect: remote peers cleaned up, onBridgeDisconnect fires", async () => {
        const relay = await startRelay();
        const url = `ws://127.0.0.1:${relay.port}`;
        const regA = createPeerRegistry();
        const regB = createPeerRegistry();

        const { bridge: bridgeA } = makeRelayBridge("hub-a", url, regA);
        const { bridge: bridgeB } = makeRelayBridge("hub-b", url, regB);

        const disconnectedHubs: string[] = [];
        bridgeA.setOnBridgeDisconnect((hubId) => disconnectedHubs.push(hubId));

        bridgeA.connectToAllPeers();
        bridgeB.connectToAllPeers();
        await waitFor(() => bridgeA.relayConnected && bridgeB.relayConnected);

        // hub-b announces a peer so hub-a has something in its registry
        bridgeB.broadcastPeerUpdate({
            type: "bridge_peer_update",
            action: "join",
            peer: { name: "dave", cwd: "/dave", git_branch: "main", last_seen: 0 },
        });
        await waitFor(() => regA.hasRemotePeer("dave@hub-b"));

        // Stop the relay — hub-a loses its relay connection
        relay.stop();
        relayServer = null;

        await waitFor(() => !bridgeA.relayConnected);
        expect(regA.hasRemotePeer("dave@hub-b")).toBe(false);
        expect(disconnectedHubs).toContain("hub-b");
    });

    // 5. TCP + WS coexistence
    test("TCP direct and WS relay coexist: peers visible via both paths", async () => {
        const relay = await startRelay();
        const url = `ws://127.0.0.1:${relay.port}`;

        // hub-c connects via relay only (no TCP)
        const portB = await getFreePort();
        const regA = createPeerRegistry();
        const regB = createPeerRegistry();
        const regC = createPeerRegistry();

        // hub-b: listens on TCP, also connects to relay
        const bridgeB = createBridge(
            {
                hub_id: "hub-b",
                listen: portB,
                secret: "tcp-secret",
                peers: [],
                relay: { url, token: RELAY_TOKEN },
            },
            regB,
        );
        bridges.push(bridgeB);

        // hub-a: connects to hub-b via TCP, also connects to relay
        const bridgeA = createBridge(
            {
                hub_id: "hub-a",
                listen: 0,
                secret: "tcp-secret",
                peers: [{ hub_id: "hub-b", host: "127.0.0.1", port: portB }],
                relay: { url, token: RELAY_TOKEN },
            },
            regA,
        );
        bridges.push(bridgeA);

        // hub-c: relay only
        const { bridge: bridgeC } = makeRelayBridge("hub-c", url, regC);

        bridgeB.listen();
        bridgeA.connectToAllPeers();
        bridgeB.connectToAllPeers();
        bridgeC.connectToAllPeers();

        await waitFor(
            () =>
                bridgeA.connections.has("hub-b") &&
                bridgeA.relayConnected &&
                bridgeC.relayConnected,
        );

        // Simulate hub-c broadcasting a peer so hub-a sees it via relay
        bridgeC.broadcastPeerUpdate({
            type: "bridge_peer_update",
            action: "join",
            peer: { name: "eve", cwd: "/eve", git_branch: "main", last_seen: 0 },
        });

        // hub-b broadcasts a peer so hub-a sees it via TCP
        bridgeB.broadcastPeerUpdate({
            type: "bridge_peer_update",
            action: "join",
            peer: { name: "frank", cwd: "/frank", git_branch: "main", last_seen: 0 },
        });

        await waitFor(() => regA.hasRemotePeer("eve@hub-c") && regA.hasRemotePeer("frank@hub-b"));
        expect(regA.hasRemotePeer("eve@hub-c")).toBe(true);
        expect(regA.hasRemotePeer("frank@hub-b")).toBe(true);
    });
});
