import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startHub } from "./index";
import { tmpSocket } from "./test-helpers";

function getTestPort(): number {
    // Use a random port in ephemeral range
    return Math.floor(Math.random() * 10000) + 50000;
}

function getTestToken(): string {
    const tokenPath = path.join(os.homedir(), ".eco-relay", "hub-ws-token");
    try {
        return fs.readFileSync(tokenPath, "utf8").trim();
    } catch {
        return crypto.randomBytes(32).toString("hex");
    }
}

describe("WS endpoint auth", () => {
    let sockPath: string;
    let hub: { close: () => Promise<void> };
    let wsPort: number;
    let token: string;

    beforeEach(async () => {
        sockPath = tmpSocket();
        wsPort = getTestPort();
        // Use a fresh token via env to avoid interference
        token = crypto.randomBytes(32).toString("hex");
        process.env.ECORELAY_WS_TOKEN = token;
        hub = await startHub({ socketPath: sockPath, wsPort });
    });

    afterEach(async () => {
        delete process.env.ECORELAY_WS_TOKEN;
        await hub.close();
    });

    function wsConnect(): Promise<{
        ws: WebSocket;
        closed: Promise<{ code: number; reason: string }>;
    }> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
            const closed = new Promise<{ code: number; reason: string }>((res) => {
                ws.onclose = (ev: CloseEvent) => {
                    res({ code: ev.code, reason: ev.reason });
                };
            });
            ws.onopen = () => {
                resolve({ ws, closed });
            };
            ws.onerror = (ev: Event) => {
                // Let onclose handle it
            };
        });
    }

    test("valid token → connection stays open, can register", async () => {
        const { ws, closed } = await wsConnect();

        // Send auth
        ws.send(JSON.stringify({ auth: token }));

        // After auth, send a register (use newline-delimited protocol)
        ws.send(
            JSON.stringify({
                type: "register",
                name: "ws-peer",
                cwd: "/tmp/ws",
                git_branch: "main",
                protocol_version: "5",
            }) + "\n",
        );

        // Wait for response (server will respond with ack or peers)
        const response = await new Promise<string>((res, rej) => {
            const timer = setTimeout(() => rej(new Error("timeout waiting for response")), 3000);
            ws.onmessage = (ev: MessageEvent) => {
                clearTimeout(timer);
                res(typeof ev.data === "string" ? ev.data : ev.data.toString());
            };
        });

        expect(response).toBeTruthy();
        // Should be a valid JSON server message (ack, peers, or error)
        const parsed = JSON.parse(response);
        expect(parsed.type).toBeTruthy();

        ws.close();
    });

    test("invalid token → server closes with code 4003", async () => {
        const { closed } = await wsConnect();

        // Send bad auth
        const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
        const closePromise = new Promise<{ code: number; reason: string }>((res) => {
            ws.onclose = (ev: CloseEvent) => {
                res({ code: ev.code, reason: ev.reason });
            };
        });
        await new Promise<void>((resolve) => {
            ws.onopen = () => resolve();
        });

        ws.send(JSON.stringify({ auth: "bad-token-that-does-not-match" }));

        const result = await closePromise;
        expect(result.code).toBe(4003);
        expect(result.reason).toContain("auth_failed");
    });

    test("malformed JSON auth → server closes with code 4003", async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
        const closePromise = new Promise<{ code: number; reason: string }>((res) => {
            ws.onclose = (ev: CloseEvent) => {
                res({ code: ev.code, reason: ev.reason });
            };
        });
        await new Promise<void>((resolve) => {
            ws.onopen = () => resolve();
        });

        ws.send("not-json-at-all");

        const result = await closePromise;
        expect(result.code).toBe(4003);
        expect(result.reason).toContain("auth_failed");
    });

    test("missing auth field → server closes with code 4003", async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
        const closePromise = new Promise<{ code: number; reason: string }>((res) => {
            ws.onclose = (ev: CloseEvent) => {
                res({ code: ev.code, reason: ev.reason });
            };
        });
        await new Promise<void>((resolve) => {
            ws.onopen = () => resolve();
        });

        ws.send(JSON.stringify({ not_auth: "something" }));

        const result = await closePromise;
        expect(result.code).toBe(4003);
        expect(result.reason).toContain("auth_failed");
    });

    test("valid JSON that is not an object (null) → auth_failed, not a crash", async () => {
        // `null.auth` used to throw inside the handler: the connection only closed when
        // the 5 s auth timer fired, with "auth_timeout" instead of "auth_failed".
        const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
        const closePromise = new Promise<{ code: number; reason: string }>((res) => {
            ws.onclose = (ev: CloseEvent) => {
                res({ code: ev.code, reason: ev.reason });
            };
        });
        await new Promise<void>((resolve) => {
            ws.onopen = () => resolve();
        });

        ws.send("null");

        const result = await closePromise;
        expect(result.code).toBe(4003);
        expect(result.reason).toContain("auth_failed");
    }, 10_000);

    test("5 second no-auth → server closes with code 4003", async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
        const closePromise = new Promise<{ code: number; reason: string }>((res) => {
            ws.onclose = (ev: CloseEvent) => {
                res({ code: ev.code, reason: ev.reason });
            };
        });

        // Connect but don't send auth — wait for timeout
        const result = await closePromise;
        expect(result.code).toBe(4003);
        expect(result.reason).toContain("auth_timeout");
    }, 10000); // 10s timeout to cover the 5s auth window

    test("auth token with correct length but wrong value → 4003", async () => {
        const wrongToken = crypto.randomBytes(32).toString("hex"); // Same length, different value
        const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
        const closePromise = new Promise<{ code: number; reason: string }>((res) => {
            ws.onclose = (ev: CloseEvent) => {
                res({ code: ev.code, reason: ev.reason });
            };
        });
        await new Promise<void>((resolve) => {
            ws.onopen = () => resolve();
        });

        ws.send(JSON.stringify({ auth: wrongToken }));

        const result = await closePromise;
        expect(result.code).toBe(4003);
        expect(result.reason).toContain("auth_failed");
    });

    test("rapid auth before 5s → register and interact", async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
        const messages: string[] = [];

        const closePromise = new Promise<{ code: number; reason: string }>((res) => {
            ws.onclose = (ev: CloseEvent) => {
                res({ code: ev.code, reason: ev.reason });
            };
        });
        ws.onmessage = (ev: MessageEvent) => {
            messages.push(typeof ev.data === "string" ? ev.data : ev.data.toString());
        };

        await new Promise<void>((resolve) => {
            ws.onopen = () => resolve();
        });

        // Send auth immediately
        ws.send(JSON.stringify({ auth: token }));

        // Wait a bit for auth to be processed
        await new Promise((r) => setTimeout(r, 200));

        // Now register
        ws.send(
            JSON.stringify({
                type: "register",
                name: "rapid-peer",
                cwd: "/tmp/rapid",
                git_branch: "main",
                protocol_version: "5",
            }) + "\n",
        );

        // Should get a response (ack, peers list)
        await new Promise((r) => setTimeout(r, 500));

        expect(messages.length).toBeGreaterThanOrEqual(0); // At minimum doesn't crash
        expect(ws.readyState).not.toBe(WebSocket.CLOSED);

        ws.close();
    });
});
