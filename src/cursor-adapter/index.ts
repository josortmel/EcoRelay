import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initLogger, makeLogger } from "../logger";
import { HubClient, type HubIncomingMessage } from "./hub-client";
import { getGitBranch, initialPeerName, resolveCwd, savePeerId } from "./identity";
import { INSTRUCTIONS } from "./instructions";
import { callTool, getToolSchemas, type ToolResult } from "./tools";

// Incoming relay messages are appended here as JSONL. A background "relay
// listener" shell (armed by the agent, monitored by Cursor) tails this file
// and emits a sentinel line per message → wakes the idle Cursor session →
// the agent reads & responds. This is the push channel (Cursor has no live
// TUI injection; it wakes the session via monitored background-shell output).
const INBOX_FILE = path.join(os.homedir(), ".cursor", "ecorelay-inbox.jsonl");

function appendInbox(msg: HubIncomingMessage): void {
    const text = msg.text ?? msg.question;
    if (!msg.from || !text) return;
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        from: msg.from,
        kind: msg.type,
        urgent: msg.urgent === true,
        ask_id: msg.ask_id,
        msg_id: msg.msg_id,
        text,
    });
    try {
        fs.mkdirSync(path.dirname(INBOX_FILE), { recursive: true });
        fs.appendFileSync(INBOX_FILE, line + "\n");
    } catch {
        /* best-effort */
    }
}

initLogger();
const log = makeLogger("cursor-adapter");

async function main(): Promise<void> {
    const cwd = resolveCwd();
    const gitBranch = getGitBranch(cwd);
    const peerName = initialPeerName(cwd);

    log.info("starting", { cwd, gitBranch, peerName });

    // ── Hub client (connect-only: never spawns the Hub) ────────────
    // Push (delivering incoming messages INTO the live Cursor agent) is not
    // wired yet — that's the cursor-backend work. For now incoming messages
    // are logged; Cursor can still SEND/respond via the relay tools, and the
    // session shows up in `relay_peers`.

    const hubClient = new HubClient({
        peerName,
        cwd,
        gitBranch,
        onMessage: (msg: HubIncomingMessage) => {
            log.info("hub_message_received", {
                type: msg.type,
                from: msg.from,
                msg_id: msg.msg_id,
            });
            // Native idle push path: append to inbox JSONL. A background shell
            // armed with output_notification(pattern="ECORELAY_MSG") +
            // long_running_jobs flag wakes the idle session when relay-listener
            // emits the sentinel. (Confirmed: MCP server-initiated elicitation
            // is silently declined outside a tool call, so it can't push.)
            appendInbox(msg);
        },
    });

    // ── MCP server (relay tools → Cursor can RESPOND) ──────────────

    const server = new Server(
        { name: "ecorelay", version: "1.0.0" },
        {
            capabilities: { tools: {} },
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
        return { content: result.content, isError: result.isError };
    });

    // ── Start MCP transport FIRST ──────────────────────────────────
    // Register tools immediately so Cursor's MCP init doesn't block on the
    // (potentially slow, up to 10s) Hub connect — otherwise Cursor's TUI
    // stalls waiting for the MCP server to come up. Hub connect runs in the
    // background; the relay tools degrade gracefully until it's ready.

    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("mcp_server_ready", { peer: hubClient.name, mode: "tools-only" });

    // ── Connect Hub (BACKGROUND, non-blocking) ─────────────────────

    void (async () => {
        try {
            await hubClient.connect();
            log.info("hub_connected", { name: hubClient.name });
            savePeerId(cwd, hubClient.name);
        } catch (e) {
            log.warn("hub_connect_failed", { err: e instanceof Error ? e.message : String(e) });
            hubClient.startReconnect();
        }
    })();

    // ── Cleanup on exit ────────────────────────────────────────────

    const cleanup = (): void => {
        log.info("shutting_down");
        hubClient.close();
    };

    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);

    // Parent (Cursor) died → MCP stdio pipe closes. Exit cleanly so the Hub
    // evicts this peer (no zombie).
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
