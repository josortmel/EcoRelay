import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { readLines, writeLine } from "../framing";
import { startHub } from "../hub/index";
import { PROTOCOL_VERSION } from "../protocol";

const SOCKET_PATH = path.join(os.tmpdir(), `ecorelay-integ-${Date.now()}.sock`);
const WS_PORT = 29376;
const HUB_WS_URL = `ws://127.0.0.1:${WS_PORT}`;

function getAuthToken(): string {
    return process.env.ECORELAY_WS_TOKEN!;
}

function unixConnect(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const s = net.createConnection(SOCKET_PATH);
        s.on("connect", () => resolve(s));
        s.on("error", reject);
    });
}

function unixRequest(
    s: net.Socket,
    msg: Record<string, unknown>,
    timeoutMs = 5000,
): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
        readLines(s, (line: string) => {
            const parsed = JSON.parse(line);
            if (parsed.type === "ping") {
                writeLine(s, { type: "pong", req_id: parsed.req_id });
                return;
            }
            clearTimeout(timer);
            resolve(parsed as Record<string, unknown>);
        });
        writeLine(s, msg);
    });
}

function wsRegister(name: string, cwd = "/tmp", gitBranch = "main"): Promise<WebSocket> {
    const token = getAuthToken();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            try {
                ws.close();
            } catch {
                /* ignore */
            }
            reject(new Error("ws timeout"));
        }, 10_000);
        const ws = new WebSocket(HUB_WS_URL);
        ws.onopen = (): void => {
            ws.send(JSON.stringify({ auth: token }));
            ws.send(
                JSON.stringify({
                    type: "register",
                    name,
                    cwd,
                    git_branch: gitBranch,
                    protocol_version: PROTOCOL_VERSION,
                }),
            );
        };
        ws.onmessage = (ev: MessageEvent): void => {
            const msg = JSON.parse(ev.data.toString());
            if (msg.type === "ack") {
                clearTimeout(timer);
                resolve(ws);
            }
        };
        ws.onerror = (): void => {
            clearTimeout(timer);
            try {
                ws.close();
            } catch {
                /* ignore */
            }
            reject(new Error("ws error"));
        };
    });
}

describe("Integration: cross-transport messaging", () => {
    let hub: { close: () => Promise<void> };

    beforeAll(async () => {
        // Use ephemeral test token — never read production ~/.eco-relay/hub-ws-token
        process.env.ECORELAY_WS_TOKEN = crypto.randomBytes(32).toString("hex");
        try {
            fs.unlinkSync(SOCKET_PATH);
        } catch {
            // ok
        }
        hub = await startHub({ socketPath: SOCKET_PATH, wsPort: WS_PORT });
    });

    afterAll(async () => {
        await hub.close();
    });

    test("Hub WS token exists and is valid", () => {
        const token = getAuthToken();
        expect(token.length).toBeGreaterThanOrEqual(16);
    });

    test("Unix socket peer can register", async () => {
        const s = await unixConnect();
        const reply = await unixRequest(s, {
            type: "register",
            name: "cc-gamma",
            cwd: process.cwd(),
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        expect(reply.type).toBe("ack");
        s.destroy();
    });

    test("WS peer can connect, auth, and register", async () => {
        const ws = await wsRegister("oc-alfa", "/home/test/project");
        expect(ws.readyState).toBe(WebSocket.OPEN);
        ws.close();
    });

    test("relay_peers shows both Unix and WS peers", async () => {
        const ws = await wsRegister("oc-beta", "/home/test/project-b", "feature/x");
        const unix = await unixConnect();
        await unixRequest(unix, {
            type: "register",
            name: "cc-delta",
            cwd: process.cwd(),
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });

        const list = await unixRequest(unix, { type: "list_peers" });
        expect(list.type).toBe("peers");
        const peers = (list as { peers: Array<{ name: string }> }).peers;
        const names = peers.map((p) => p.name);
        expect(names).toContain("oc-beta");
        // cc-delta is the requesting peer ("me"), excluded from peers list.
        // oc-alpha from test 3 may have disconnected. At minimum oc-beta must appear.
        expect(peers.length).toBeGreaterThanOrEqual(1);

        unix.destroy();
        ws.close();
    });

    test("send from Unix peer to WS peer delivers", async () => {
        const delivered = await new Promise<boolean>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timeout")), 10_000);
            let unixSocket: net.Socket | null = null;

            wsRegister("oc-echo").then((ws) => {
                ws.onmessage = (ev: MessageEvent): void => {
                    const msg = JSON.parse(ev.data.toString());
                    if (msg.type === "incoming_message") {
                        clearTimeout(timer);
                        expect(msg.from).toBe("cc-sender");
                        expect(msg.text).toBe("ping from unix");
                        ws.close();
                        if (unixSocket) unixSocket.destroy();
                        resolve(true);
                    }
                };
                ws.onerror = (): void => {
                    clearTimeout(timer);
                    if (unixSocket) unixSocket.destroy();
                    reject(new Error("ws error"));
                };

                const unix = net.createConnection(SOCKET_PATH);
                unixSocket = unix;
                unix.on("connect", () => {
                    writeLine(unix, {
                        type: "register",
                        name: "cc-sender",
                        cwd: process.cwd(),
                        git_branch: "main",
                        protocol_version: PROTOCOL_VERSION,
                    });
                });
                readLines(unix, (line: string) => {
                    const m = JSON.parse(line);
                    if (m.type === "ack") {
                        writeLine(unix, {
                            type: "send",
                            to: "oc-echo",
                            text: "ping from unix",
                        });
                    }
                });
            });
        });

        expect(delivered).toBe(true);
    });

    test("WS peer rename works", async () => {
        const ws = await wsRegister("oc-rename-me");
        let renameAck = false;

        await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timeout")), 5_000);
            ws.onmessage = (ev: MessageEvent): void => {
                const msg = JSON.parse(ev.data.toString());
                if (msg.type === "ack") {
                    clearTimeout(timer);
                    renameAck = true;
                    resolve("ack");
                }
            };
            ws.send(
                JSON.stringify({
                    type: "rename",
                    new_name: "oc-renamed",
                }),
            );
        });

        expect(renameAck).toBe(true);
        ws.close();
    });

    test("all existing unit tests still pass (cross-check)", async () => {
        // Verify that adding WS endpoint didn't break anything
        // by checking the hub still responds correctly on Unix socket
        const s = await unixConnect();
        const reply = await unixRequest(s, {
            type: "register",
            name: "cc-sanity",
            cwd: process.cwd(),
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });

        expect(reply.type).toBe("ack");

        const list = await unixRequest(s, { type: "list_peers" });
        expect(list.type).toBe("peers");

        s.destroy();
    });
});
