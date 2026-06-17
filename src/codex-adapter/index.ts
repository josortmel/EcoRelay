import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { initLogger, makeLogger } from "../logger";
import { resolveCwd, getGitBranch, initialPeerName, updateCwdFromThread, savePeerId } from "./identity";
import { HubClient } from "./hub-client";
import { AppServerClient } from "./app-server-client";
import { ThreadTracker } from "./thread-tracker";
import { PushRouter } from "./push";
import { getToolSchemas, callTool, type ToolResult } from "./tools";
import { INSTRUCTIONS } from "./instructions";

initLogger();
const log = makeLogger("codex-adapter");

async function main(): Promise<void> {
    const cwd = resolveCwd();
    const gitBranch = getGitBranch(cwd);
    const peerName = initialPeerName(cwd);

    log.info("starting", { cwd, gitBranch, peerName });

    // ── Hub client ────────────────────────────────────────────────

    let pushRouter: PushRouter | null = null;

    const hubClient = new HubClient({
        peerName,
        cwd,
        gitBranch,
        onMessage: (msg) => {
            if (pushRouter) pushRouter.handleHubMessage(msg);
        },
    });

    // ── App-server client (optional — D7 degradation) ─────────────

    // Codex does NOT forward the app-server process env to MCP children, so
    // ECORELAY_CODEX_APP_SERVER is usually unset here. Fall back to the port the
    // launcher recorded in its pid file (written before codex starts).
    let appServerUrl: string | undefined = process.env.ECORELAY_CODEX_APP_SERVER;
    if (!appServerUrl) {
        const pidFile = path.join(os.homedir(), ".eco-relay", "codex-appserver.pid");
        for (let i = 0; i < 6 && !appServerUrl; i++) {
            try {
                const data = JSON.parse(fs.readFileSync(pidFile, "utf8")) as { port?: number };
                if (typeof data.port === "number") {
                    appServerUrl = `ws://127.0.0.1:${data.port}`;
                    log.info("app_server_from_pidfile", { url: appServerUrl, attempt: i });
                }
            } catch {
                /* pid file not ready yet */
            }
            if (!appServerUrl) await new Promise((r) => setTimeout(r, 500));
        }
    }
    let appServer: AppServerClient | null = null;
    let tracker: ThreadTracker | null = null;

    if (appServerUrl) {
        appServer = new AppServerClient({
            url: appServerUrl,
            onThreadStatusChanged: (event) => {
                tracker?.handleThreadStatusChanged(event);
            },
        });

        tracker = new ThreadTracker({
            appServer,
            onIdle: () => {
                pushRouter?.notifyIdle();
            },
            onActive: () => {
                // push.ts checks status via tracker.getStatus()
            },
            onThreadChanged: (_threadId, threadCwd) => {
                if (threadCwd) updateCwdFromThread(threadCwd);
                // A thread appeared/changed (incl. via the 60s poll on a cold session)
                // → flush any push messages held while there was no active thread.
                pushRouter?.notifyThreadAvailable();
            },
        });

        pushRouter = new PushRouter({
            appServer,
            threadTracker: tracker,
        });
    } else {
        log.warn("no_app_server_url", {
            hint: "Set ECORELAY_CODEX_APP_SERVER=ws://127.0.0.1:PORT for push. Running in tools-only mode.",
        });
    }

    // ── MCP server ────────────────────────────────────────────────

    const server = new Server(
        { name: "ecorelay", version: "0.9.0" },
        {
            capabilities: {
                tools: {},
            },
            instructions: INSTRUCTIONS,
        },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: getToolSchemas().map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = request.params.name;
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        const result: ToolResult = await callTool(hubClient, toolName, args);
        return {
            content: result.content,
            isError: result.isError,
        };
    });

    // ── Lifecycle: connect Hub (fast) ─────────────────────────────

    try {
        await hubClient.connect();
        log.info("hub_connected", { name: hubClient.name });
        savePeerId(cwd, hubClient.name);
    } catch (e) {
        log.warn("hub_connect_failed", {
            err: e instanceof Error ? e.message : String(e),
        });
        hubClient.startReconnect();
    }

    // ── Start MCP transport FIRST (register tools before the slow ──
    // app-server connect + thread discovery, or codex's MCP startup
    // timeout (startup_timeout_sec) fires while discover() retries).

    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("mcp_server_ready", {
        mode: appServer ? "full" : "tools-only",
        peer: hubClient.name,
    });

    // ── App-server connect + thread discovery (BACKGROUND) ────────
    // Must not block MCP startup: discover() retries up to ~30s.

    if (appServer) {
        void (async () => {
            try {
                await appServer!.connect();
                await appServer!.initialize();
                log.info("app_server_connected", { url: appServerUrl });

                const threadId = await tracker!.discover();
                if (threadId) {
                    log.info("thread_discovered", { threadId });
                    pushRouter!.notifyThreadAvailable();
                } else {
                    log.warn("no_thread_found", {
                        hint: "Push will activate when a thread appears (polling every 60s).",
                    });
                }
            } catch (e) {
                log.warn("app_server_connect_failed", {
                    err: e instanceof Error ? e.message : String(e),
                    hint: "Running in tools-only mode. Push disabled.",
                });
                appServer?.close();
                tracker?.close();
                pushRouter?.close();
                appServer = null;
                tracker = null;
                pushRouter = null;
            }
        })();
    }

    // ── Cleanup on exit ───────────────────────────────────────────

    const cleanup = (): void => {
        log.info("shutting_down");
        pushRouter?.close();
        tracker?.close();
        appServer?.close();
        hubClient.close();
    };

    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);

    // Parent (codex app-server) died → our MCP stdio pipe closes. Exit cleanly so
    // the Hub gets a clean disconnect and evicts this peer. Without this the adapter
    // is orphaned, stays connected to the Hub, and shows up as a zombie peer.
    let exiting = false;
    const exitOnParentDeath = (reason: string): void => {
        if (exiting) return;
        exiting = true;
        log.info("parent_gone_exiting", { reason });
        cleanup();
        process.exit(0);
    };
    server.onclose = () => exitOnParentDeath("mcp_server_closed");
    process.stdin.on("close", () => exitOnParentDeath("stdin_close"));
    process.stdin.on("end", () => exitOnParentDeath("stdin_end"));
}

main().catch((e) => {
    log.error("fatal", { err: e instanceof Error ? e.message : String(e) });
    process.exit(1);
});
