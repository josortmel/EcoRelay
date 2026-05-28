import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MAX_TEXT_LEN } from "../protocol";
import { startCh, tmpSocket } from "./test-helpers";

describe("channel tool schemas", () => {
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

    test("ListTools exposes JSON Schema for each tool's inputSchema with required fields", async () => {
        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        const schemas = ch.getToolSchemas();
        const byName = new Map(schemas.map((s) => [s.name, s] as const));

        const reply = byName.get("relay_reply")!;
        expect(reply.inputSchema.required?.sort()).toEqual(["ask_id", "text"]);

        const peers = byName.get("relay_peers")!;
        expect(peers.inputSchema.type).toBe("object");
        expect(peers.inputSchema.properties).toEqual({});

        const bcast = byName.get("relay_broadcast")!;
        expect(bcast.inputSchema.properties).toHaveProperty("question");
        expect(bcast.inputSchema.properties).toHaveProperty("exclude_self");
        expect(bcast.inputSchema.required).toEqual(["question"]);

        const rename = byName.get("relay_rename")!;
        expect(rename.inputSchema.required).toEqual(["new_name"]);
    });

    test("relay_peers descriptions guide collision-aware disambiguation", async () => {
        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        const schemas = ch.getToolSchemas();
        const peers = schemas.find((s) => s.name === "relay_peers")!;
        expect(peers.description).toContain("cwd");
        expect(peers.description).toContain("git_branch");
        expect(peers.description).toContain("disambiguat");
    });

    test("relay_reply does not expose thread_id", async () => {
        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        const schemas = ch.getToolSchemas();
        const reply = schemas.find((s) => s.name === "relay_reply")!;
        expect(reply.inputSchema.properties).not.toHaveProperty("thread_id");
    });

    test("relay_reply description documents plain-text one-shot semantics", async () => {
        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        const schemas = ch.getToolSchemas();
        const reply = schemas.find((s) => s.name === "relay_reply")!;
        expect(reply.description).toMatch(/one-shot|plain/);
    });

    test("relay_reply.text and relay_broadcast.question declare maxLength MAX_TEXT_LEN", async () => {
        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        const schemas = ch.getToolSchemas();
        const reply = schemas.find((s) => s.name === "relay_reply")!;
        const bcast = schemas.find((s) => s.name === "relay_broadcast")!;

        expect(reply.inputSchema.properties.text!.maxLength).toBe(MAX_TEXT_LEN);
        expect(bcast.inputSchema.properties.question!.maxLength).toBe(MAX_TEXT_LEN);
    });

    test("relay_broadcast description warns against unrelated-project blast radius", async () => {
        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        const schemas = ch.getToolSchemas();
        const bcast = schemas.find((s) => s.name === "relay_broadcast")!;
        expect(bcast.description).toMatch(/all (other )?peers|every (other )?peer/i);
        expect(bcast.description).toMatch(/unrelated|every session/i);
        expect(bcast.description).toMatch(/use only/i);
    });
});
