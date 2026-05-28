import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startHub, type HubHandle } from "../hub/index";
import { startCh, tmpSocket, type ChannelH } from "./test-helpers";

async function waitForReconnect(ch: ChannelH, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let result = await ch.callTool("relay_peers", {});
    while (result.isError && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        result = await ch.callTool("relay_peers", {});
    }
    return result;
}

describe("channel auto-reconnect", () => {
    let sockPath: string;
    const closers: Array<() => Promise<void>> = [];

    beforeEach(() => {
        sockPath = tmpSocket();
    });

    afterEach(async () => {
        while (closers.length) {
            const c = closers.pop()!;
            try {
                await c();
            } catch {}
        }
    });

    test("rename survives hub restart", async () => {
        const hub1: HubHandle = await startHub({ socketPath: sockPath });

        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());

        const renamed = await ch.callTool("relay_rename", { new_name: "bespoke-name" });
        expect(renamed.isError).toBeFalsy();
        expect(ch.getName()).toBe("bespoke-name");

        await hub1.close();

        const hub2 = await startHub({ socketPath: sockPath });
        closers.push(() => hub2.close());

        const post = await waitForReconnect(ch);
        expect(post.isError).toBeFalsy();
        expect(ch.getName()).toBe("bespoke-name");
        const payload = JSON.parse(post.content[0]!.text);
        expect(payload.me).toBe("bespoke-name");
    });
});
