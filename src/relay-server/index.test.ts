import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import { PROTOCOL_VERSION, type PeerRecord } from "../protocol";
import { startRelayServer } from "./index";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address() as net.AddressInfo;
            s.close(() => resolve(port));
        });
        s.on("error", reject);
    });
}

type WsClient = {
    send(msg: unknown): void;
    next(): Promise<unknown>;
    waitForClose(): Promise<{ code: number; reason: string }>;
    close(): void;
    opened: Promise<void>;
};

function makeWsClient(port: number): WsClient {
    const messages: unknown[] = [];
    const waiters: Array<(msg: unknown) => void> = [];
    let closeEvent: { code: number; reason: string } | null = null;
    let closeResolve: ((v: { code: number; reason: string }) => void) | null = null;
    let openResolve!: () => void;

    const opened = new Promise<void>((r) => {
        openResolve = r;
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    ws.onopen = () => openResolve();
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string);
        const waiter = waiters.shift();
        if (waiter) waiter(msg);
        else messages.push(msg);
    };
    ws.onclose = (event) => {
        closeEvent = { code: event.code, reason: event.reason };
        closeResolve?.(closeEvent);
    };

    return {
        opened,
        send(msg) {
            ws.send(JSON.stringify(msg));
        },
        next() {
            if (messages.length > 0) return Promise.resolve(messages.shift()!);
            return new Promise((r) => waiters.push(r));
        },
        waitForClose() {
            if (closeEvent) return Promise.resolve(closeEvent);
            return new Promise<{ code: number; reason: string }>((r) => {
                closeResolve = r;
            });
        },
        close() {
            ws.close();
        },
    };
}

function makePeer(name: string): PeerRecord {
    return { name, cwd: `/${name}`, git_branch: "main", last_seen: 0 };
}

function makeHello(hubId: string, secret: string, peers: PeerRecord[] = []) {
    return {
        type: "bridge_hello" as const,
        hub_id: hubId,
        secret,
        protocol_version: PROTOCOL_VERSION,
        peers,
    };
}

// ---------------------------------------------------------------------------
// Relay server tests
// ---------------------------------------------------------------------------

describe("relay server", () => {
    let relay: ReturnType<typeof startRelayServer>;
    const SECRET = "test-secret-ok";

    beforeEach(async () => {
        const port = await getFreePort();
        relay = startRelayServer({
            port,
            secret: SECRET,
            max_hubs: 50,
            handshake_timeout_ms: 5000,
        });
    });

    afterEach(() => {
        relay.stop();
    });

    // 1. Hub connects + bridge_hello → receives bridge_welcome
    test("hub connects and receives bridge_welcome", async () => {
        const hub = makeWsClient(relay.port);
        await hub.opened;
        hub.send(makeHello("hub-a", SECRET));
        const welcome = (await hub.next()) as Record<string, unknown>;
        expect(welcome.type).toBe("bridge_welcome");
        expect(welcome.hub_id).toBe("relay");
        expect(welcome.peers).toEqual([]);
        hub.close();
    });

    // 2. Bad secret → WS closed with 4003
    test("bad secret → close 4003", async () => {
        const hub = makeWsClient(relay.port);
        const closeProm = hub.waitForClose();
        await hub.opened;
        hub.send(makeHello("hub-x", "wrong-secret!"));
        const { code } = await closeProm;
        expect(code).toBe(4003);
    });

    // 3. Duplicate hub_id → WS closed with 4004
    test("duplicate hub_id → close 4004", async () => {
        const hub1 = makeWsClient(relay.port);
        await hub1.opened;
        hub1.send(makeHello("hub-dup", SECRET));
        await hub1.next(); // welcome

        const hub2 = makeWsClient(relay.port);
        const closeProm = hub2.waitForClose();
        await hub2.opened;
        hub2.send(makeHello("hub-dup", SECRET));
        const { code } = await closeProm;
        expect(code).toBe(4004);
        hub1.close();
    });

    // 4. bridge_forward routes to correct target hub
    test("bridge_forward routes message to target hub", async () => {
        const hubA = makeWsClient(relay.port);
        const hubB = makeWsClient(relay.port);
        await Promise.all([hubA.opened, hubB.opened]);

        hubA.send(makeHello("hub-a", SECRET));
        await hubA.next(); // welcome
        hubB.send(makeHello("hub-b", SECRET));
        await hubB.next(); // welcome

        hubA.send({
            type: "bridge_forward",
            target_peer: "bob@hub-b",
            origin_hub: "hub-a",
            wrapped: { type: "ask", question: "hello?" },
        });

        const forwarded = (await hubB.next()) as Record<string, unknown>;
        expect(forwarded.type).toBe("bridge_forward");
        expect(forwarded.origin_hub).toBe("hub-a");

        hubA.close();
        hubB.close();
    });

    // 5. bridge_forward to unknown hub → err hub_not_found
    test("bridge_forward to unknown hub → err hub_not_found", async () => {
        const hub = makeWsClient(relay.port);
        await hub.opened;
        hub.send(makeHello("hub-a", SECRET));
        await hub.next(); // welcome

        hub.send({
            type: "bridge_forward",
            target_peer: "bob@hub-ghost",
            origin_hub: "hub-a",
            wrapped: { type: "ask" },
        });

        const err = (await hub.next()) as Record<string, unknown>;
        expect(err.type).toBe("err");
        expect(err.code).toBe("peer_not_found"); // FIX 3: use existing ErrCodeSchema value
        hub.close();
    });

    // 6. Hub disconnect → other hubs receive peer leave updates
    test("hub disconnect → remaining hubs receive peer leave updates", async () => {
        const alice = makePeer("alice");

        const hubA = makeWsClient(relay.port);
        await hubA.opened;
        hubA.send(makeHello("hub-a", SECRET, [alice]));
        await hubA.next(); // welcome (empty)

        const hubB = makeWsClient(relay.port);
        await hubB.opened;
        hubB.send(makeHello("hub-b", SECRET));
        const bWelcome = (await hubB.next()) as Record<string, unknown>;
        // hub-b welcome must include alice@hub-a from the initial peers
        expect((bWelcome.peers as PeerRecord[]).length).toBe(1);
        expect((bWelcome.peers as PeerRecord[])[0]!.name).toBe("alice@hub-a");

        // Disconnect hub-a → hub-b should receive leave for alice
        hubA.close();
        const leave = (await hubB.next()) as Record<string, unknown>;
        expect(leave.type).toBe("bridge_peer_update");
        expect(leave.action).toBe("leave");
        expect(leave.name).toBe("alice@hub-a");

        hubB.close();
    });

    // 7. Peer update broadcast to all other hubs
    test("bridge_peer_update broadcasts to all other hubs", async () => {
        const hubA = makeWsClient(relay.port);
        const hubB = makeWsClient(relay.port);
        const hubC = makeWsClient(relay.port);
        await Promise.all([hubA.opened, hubB.opened, hubC.opened]);

        hubA.send(makeHello("hub-a", SECRET));
        await hubA.next();
        hubB.send(makeHello("hub-b", SECRET));
        await hubB.next();
        hubC.send(makeHello("hub-c", SECRET));
        await hubC.next();

        hubA.send({
            type: "bridge_peer_update",
            action: "join",
            peer: makePeer("alice"),
        });

        const [msgB, msgC] = (await Promise.all([hubB.next(), hubC.next()])) as Record<
            string,
            unknown
        >[];
        expect(msgB!.type).toBe("bridge_peer_update");
        expect((msgB!.peer as PeerRecord | undefined)?.name).toBe("alice@hub-a");
        expect(msgC!.type).toBe("bridge_peer_update");
        expect((msgC!.peer as PeerRecord | undefined)?.name).toBe("alice@hub-a");

        hubA.close();
        hubB.close();
        hubC.close();
    });

    // 8. Max hubs exceeded → WS closed with 4006
    test("max_hubs exceeded → close 4006", async () => {
        relay.stop();
        const port = await getFreePort();
        relay = startRelayServer({ port, secret: SECRET, max_hubs: 2, handshake_timeout_ms: 5000 });

        const hub1 = makeWsClient(port);
        await hub1.opened;
        hub1.send(makeHello("h1", SECRET));
        await hub1.next();

        const hub2 = makeWsClient(port);
        await hub2.opened;
        hub2.send(makeHello("h2", SECRET));
        await hub2.next();

        const hub3 = makeWsClient(port);
        const closeProm = hub3.waitForClose();
        await hub3.opened;
        hub3.send(makeHello("h3", SECRET));
        const { code } = await closeProm;
        expect(code).toBe(4006);

        hub1.close();
        hub2.close();
    });

    // 10. Invalid hub_id characters → WS closed with 4005 (FIX 2)
    test("invalid hub_id characters → close 4005", async () => {
        const hub = makeWsClient(relay.port);
        const closeProm = hub.waitForClose();
        await hub.opened;
        hub.send(makeHello("hub@inject!bad", SECRET));
        const { code } = await closeProm;
        expect(code).toBe(4005);
    });

    // 9. Handshake timeout (no bridge_hello within timeout) → WS closed with 4001
    test("handshake timeout → close 4001", async () => {
        relay.stop();
        const port = await getFreePort();
        relay = startRelayServer({ port, secret: SECRET, max_hubs: 50, handshake_timeout_ms: 100 });

        const hub = makeWsClient(port);
        const closeProm = hub.waitForClose();
        await hub.opened;
        // Intentionally send nothing — wait for timeout
        const { code } = await closeProm;
        expect(code).toBe(4001);
    }, 2000);
});
