import { afterEach, describe, expect, test } from "bun:test";
import { tmpSocket } from "../hub/test-helpers";
import { type HubHandle, spawnHub, waitForSocketReady } from "./hub-spawner";

describe("spawnHub", () => {
    let handle: HubHandle | undefined;

    afterEach(async () => {
        await handle?.close();
        handle = undefined;
    });

    // spawnHub used to ignore its wsPort argument: the child hub listened on
    // ECORELAY_WS_PORT or the default, while bootstrapHub wrote wsPort to the lock
    // and returned it to the caller as the port the hub listens on.
    test("the spawned hub listens for WebSocket clients on the wsPort it was given", async () => {
        const socketPath = tmpSocket();
        const wsPort = 40_000 + Math.floor(Math.random() * 9_000);
        handle = spawnHub(socketPath, wsPort);

        const sock = await waitForSocketReady(socketPath, 10_000);
        expect(sock).not.toBeNull();
        sock?.destroy();

        const opened = await new Promise<boolean>((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
            ws.onopen = () => {
                ws.close();
                resolve(true);
            };
            ws.onerror = () => resolve(false);
        });
        expect(opened).toBe(true);
    }, 20_000);
});
