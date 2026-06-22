import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { initLogger, makeLogger } from "../logger";
import { AgentApiBackend } from "./agent-api-backend";
import { ConversationDiscovery } from "./conversation-discovery";
import { HubClient } from "./hub-client";
import { getGitBranch, initialPeerName, resolveCwd, savePeerId } from "./identity";
import { INSTRUCTIONS } from "./instructions";
import { PushRouter } from "./push";
import { callTool, getToolSchemas, type ToolResult } from "./tools";

initLogger();
const log = makeLogger("antigravity-adapter");

async function main(): Promise<void> {
    const cwd = resolveCwd();
    const gitBranch = getGitBranch(cwd);
    const peerName = initialPeerName(cwd);

    log.info("starting", { cwd, gitBranch, peerName });

    // ── Push pipeline ─────────────────────────────────────────────
    // Incoming Hub message → PushRouter → AgentApiBackend → agy agentapi
    // send-message → the message appears as a turn in the live agy TUI.

    let pushRouter: PushRouter | null = null;

    const hubClient = new HubClient({
        peerName,
        cwd,
        gitBranch,
        onMessage: (msg) => {
            if (pushRouter) pushRouter.handleHubMessage(msg);
        },
    });

    const backend = new AgentApiBackend();
    const discovery = new ConversationDiscovery({
        cwd,
        onConversationAvailable: () => pushRouter?.notifyConversationAvailable(),
    });
    pushRouter = new PushRouter({ backend, discovery });

    // ── MCP server (relay tools → agy can RESPOND) ────────────────

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

    // ── Start MCP transport FIRST (register tools before background ──
    // discovery so agy's MCP startup doesn't wait on it).

    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("mcp_server_ready", { peer: hubClient.name });

    // ── Discovery (BACKGROUND) ────────────────────────────────────
    // Finds the LS HTTP port + the active conversation id (polls). Push
    // messages buffer until both are available, then flush.

    discovery.start();

    // ── Cleanup on exit ───────────────────────────────────────────

    const cleanup = (): void => {
        log.info("shutting_down");
        pushRouter?.close();
        discovery.close();
        hubClient.close();
    };

    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);

    // Parent (agy) died → our MCP stdio pipe closes. Exit cleanly so the
    // Hub gets a clean disconnect and evicts this peer (no zombie).
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
