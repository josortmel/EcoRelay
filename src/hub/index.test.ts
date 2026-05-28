import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { PROTOCOL_VERSION } from "../protocol";
import { startHub } from "./index";
import { rawConnect, tmpSocket } from "./test-helpers";

describe("hub lifecycle", () => {
    let sockPath: string;
    let hub: { close: () => Promise<void> };

    beforeEach(async () => {
        sockPath = tmpSocket();
        hub = await startHub({ socketPath: sockPath });
    });

    afterEach(async () => {
        await hub.close();
    });

    test("socket file mode is 0o600 after hub starts", () => {
        if (process.platform === "win32") return; // Windows doesn't support Unix file permissions
        expect(fs.statSync(sockPath).mode & 0o777).toBe(0o600);
    });

    test("idle timer fires when peer count drops to 0", async () => {
        await hub.close();
        sockPath = tmpSocket();
        let fired = false;
        hub = await startHub({
            socketPath: sockPath,
            idleExitMs: 50,
            onIdleExit: () => {
                fired = true;
            },
        });

        const a = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        a.close();

        await new Promise((r) => setTimeout(r, 150));
        expect(fired).toBe(true);
    });

    test("connecting a peer during idle timer window cancels it", async () => {
        await hub.close();
        sockPath = tmpSocket();
        let fired = false;
        hub = await startHub({
            socketPath: sockPath,
            idleExitMs: 100,
            onIdleExit: () => {
                fired = true;
            },
        });

        // Start with no peers — idle timer should be running
        await new Promise((r) => setTimeout(r, 30));
        const a = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();

        await new Promise((r) => setTimeout(r, 150));
        expect(fired).toBe(false);
        a.close();
    });

    test("broadcast churn: targets and caller disconnect, idle timer fires", async () => {
        await hub.close();
        sockPath = tmpSocket();
        let idleExitCount = 0;
        hub = await startHub({
            socketPath: sockPath,
            idleExitMs: 200,
            onIdleExit: () => {
                idleExitCount++;
            },
        });

        const caller = await rawConnect(sockPath);
        const t1 = await rawConnect(sockPath);
        const t2 = await rawConnect(sockPath);
        caller.send({
            type: "register",
            name: "caller",
            cwd: "/tmp/c",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await caller.next();
        t1.send({
            type: "register",
            name: "t1",
            cwd: "/tmp/1",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await t1.next();
        t2.send({
            type: "register",
            name: "t2",
            cwd: "/tmp/2",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await t2.next();

        const broadcastId = "bc-1";
        caller.send({ type: "broadcast", question: "anyone there?", broadcast_id: broadcastId });

        // Drain incoming_ask at each target + broadcast_ack at caller (any order).
        await t1.next();
        await t2.next();
        const ack = await caller.next();
        expect(ack.type).toBe("broadcast_ack");
        if (ack.type === "broadcast_ack") {
            expect(ack.broadcast_id).toBe(broadcastId);
            expect(ack.peer_count).toBe(2);
        }

        // Both targets disconnect before replying.
        t1.close();
        t2.close();

        // Caller disconnects too — hub is now peer-less.
        caller.close();
        await new Promise((r) => setTimeout(r, 50));

        // Wait past idleExitMs; onIdleExit fires exactly once, no crash.
        await new Promise((r) => setTimeout(r, 400));
        expect(idleExitCount).toBe(1);
    });
});
