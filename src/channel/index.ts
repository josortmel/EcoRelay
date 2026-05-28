import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFileSync } from "node:child_process";
import { hubSocketPath } from "../data-dir";
import {
    claudeSessionName,
    claudeSessionPath,
    hasFixedRelayPeerIdentity,
    resolveSessionName,
    sanitizeSessionName,
} from "../identity";
import { makeLogger } from "../logger";
import { type ServerMsg } from "../protocol";
import { bootstrapHub, type HubRole } from "./bootstrap";
import { createMcpServer, wireToolHandlers } from "./mcp-server";
import { createPendingBroadcasts } from "./pending-broadcasts";
import { createReconnector } from "./reconnect";
import { registerWithRetries } from "./register";
import { buildEmitNotification, wireHubRouting } from "./routing";
import { startSessionWatcher } from "./session-watcher";
import { TOOLS, type ToolSchema } from "./tool-schemas/index";
import {
    callTool as dispatchTool,
    renameWithHub,
    type ChannelContext,
    type ToolResult,
} from "./tools/index";

const log = makeLogger("channel");

const INSTRUCTIONS = [
    "If an incoming `<channel>` message carries an `ask_id` in its meta, you MUST reply via relay_reply(ask_id, text) BEFORE handling any other user work. The peer session is blocked waiting on your reply. Exception: if the pending user work is destructive or irreversible, complete or confirm that first, then reply.",
    "Whenever an incoming `<channel>` message arrives (ask, reply, or broadcast), your first user-visible output that turn must quote the peer's full body verbatim in a fenced markdown block, prefixed with the sender name and kind (e.g. `peer-name (ask):`). The Claude Code TUI truncates tool-result panels, so plain assistant text is the only place the user actually sees the message. Quote first, then act.",
    "When an incoming reply to one of your asks contains a question directed back at you, surface that question to the user and offer to follow up with a new relay_send(); do not end your turn without relaying the question-back.",
    "Pick the target with relay_peers() (match by name/cwd/branch); use relay_send for one peer, relay_broadcast for all. Never use relay_broadcast as a fallback — it hits every session on the machine, including ones on unrelated projects.",
    'If the user refers to a peer by pronoun or demonstrative ("them", "that session", "it"), carry forward the most recent `to:` value. If ambiguous across multiple peers, call relay_peers and confirm with the user before sending.',
    "Trust tool defaults. Only override an argument when the user gave an explicit value for that exact argument; descriptive words about the answer never change tool arguments.",
    "For multi-peer coordination, use rooms (relay_join, relay_room, relay_leave, relay_rooms). Rooms are ephemeral IRC-style: implicit creation on first join, implicit destruction on last leave, no permissions (any peer can post to any room, with or without membership). Use relay_send for one-to-one exchanges and relay_room for broadcast-to-subgroup; relay_room is fire-and-forget, NOT request/response — use relay_send if you need a directed reply.",
    "Incoming room messages arrive as `<channel>` notifications with `room`, `from`, `text`, and `msg_id` in meta and NO `ask_id`. They are announcements, NOT questions: do NOT call relay_reply on them. If the message in the room invites follow-up, decide between relay_send (directed reply) and relay_room (visible to the whole room) based on whether the answer concerns one peer or the group.",
    "When you receive an incoming_message with urgent=true in meta, treat it with the same priority as an incoming ask: act on it BEFORE handling other user work. Reply with relay_send(to=sender, text=response, reply_to=msg_id). Urgent messages retrieved via relay_inbox (messages[].urgent === true) carry the same priority — act on them before other work. If urgent is absent or false, the message is informational — read and act when appropriate.",
].join(" ");

const CAPABILITIES = {
    tools: {},
    experimental: { "claude/channel": {} },
} as const;

function detectGitBranch(): string {
    try {
        return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
        }).trim();
    } catch {
        return "";
    }
}

export type StartChannelOptions = {
    socketPath?: string;
    hubSpawner?: (socketPath: string) => Promise<{ close: () => Promise<void> }>;
    onIncoming?: (msg: ServerMsg) => void;
    onNotification?: (n: { method: string; params: Record<string, unknown> }) => void;
    now?: () => number;
    transport?: { connect: (server: Server) => Promise<void>; close?: () => Promise<void> };
    requestTimeoutMs?: number;
    broadcastTimeoutMs?: number;
    skipRegister?: boolean;
    /**
     * Interval in ms for checking whether the parent process is still alive.
     * When the parent dies (e.g. the Claude Code session window is closed),
     * the channel auto-shuts down to avoid lingering as an orphan process.
     * Set to 0 to disable (useful for tests). Default: 2000.
     */
    parentWatchIntervalMs?: number;
};

export type ChannelHandle = {
    close: () => Promise<void>;
    getName: () => string;
    getHubRole: () => HubRole;
    getCapabilities: () => Record<string, unknown>;
    getInstructions: () => string;
    getToolNames: () => string[];
    getToolSchemas: () => ToolSchema[];
    callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
};

export async function startChannel(opts: StartChannelOptions = {}): Promise<ChannelHandle> {
    const socketPath = opts.socketPath ?? hubSocketPath();
    let bootstrap = await bootstrapHub(socketPath, opts.hubSpawner);

    const onIncoming = opts.onIncoming;
    const wireIncoming = (h: typeof bootstrap.hub) => {
        if (!onIncoming) return;
        h.onMessage((m) => {
            if (
                m.type === "incoming_ask" ||
                m.type === "incoming_reply" ||
                m.type === "broadcast_ack" ||
                m.type === "incoming_room_msg"
            ) {
                onIncoming(m);
            }
        });
    };
    wireIncoming(bootstrap.hub);

    const gitBranch = detectGitBranch();
    const candidate = resolveSessionName(process.cwd());
    let name = opts.skipRegister
        ? candidate
        : await registerWithRetries(
              bootstrap.hub,
              { cwd: process.cwd(), git_branch: gitBranch },
              candidate,
          );

    log.info("channel_start", {
        socketPath,
        name,
        cwd: process.cwd(),
        pid: process.pid,
        git_branch: gitBranch,
        hubRole: bootstrap.hubRole,
    });

    const pendingBroadcasts = createPendingBroadcasts();
    const joinedRooms = new Set<string>();
    const nowFn = opts.now ?? Date.now;

    const { server, toolSchemas } = createMcpServer(
        CAPABILITIES as Record<string, unknown>,
        INSTRUCTIONS,
    );

    const emitNotification = buildEmitNotification({
        onNotification: opts.onNotification,
        transport: opts.transport,
        server,
    });

    let closed = false;
    let parentWatcher: ReturnType<typeof setInterval> | null = null;

    const reconnector = createReconnector({
        socketPath,
        hubSpawner: opts.hubSpawner,
        getCwd: () => process.cwd(),
        getGitBranch: () => gitBranch,
        skipRegister: opts.skipRegister,
        getName: () => name,
        setName: (n) => {
            name = n;
        },
        onReconnect: async (next) => {
            const prev = bootstrap;
            bootstrap = next;
            wireIncoming(next.hub);
            wireHubRouting(next.hub, pendingBroadcasts, emitNotification);
            reconnector.wire(next.hub);
            for (const room of [...joinedRooms]) {
                const reply = await next.hub
                    .sendRequest({ type: "join_room", room }, 5000)
                    .catch(() => null);
                if (!reply || reply.type === "err") {
                    joinedRooms.delete(room);
                    log.warn("rejoin_room_failed", { room, reply });
                }
            }
            prev.hub.close();
            if (prev.hubHandle) {
                void prev.hubHandle.close().catch((e: unknown) => {
                    log.warn("prev_hub_handle_close_failed", {
                        err: e instanceof Error ? e.message : String(e),
                    });
                });
            }
        },
    });

    wireHubRouting(bootstrap.hub, pendingBroadcasts, emitNotification);
    reconnector.wire(bootstrap.hub);

    const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    const broadcastTimeoutMs = opts.broadcastTimeoutMs ?? 600_000;

    const ctx: ChannelContext = {
        getHub: () => bootstrap.hub,
        pendingBroadcasts,
        getName: () => name,
        setName: (n: string) => {
            name = n;
        },
        nowFn,
        counters: { broadcast: 0 },
        broadcastTimeoutMs,
        requestTimeoutMs,
    };

    // Track joined rooms locally so we can auto-rejoin after a hub reconnect.
    // We mirror the sanitized name (matching hub's storage key) instead of the raw
    // user input, so the rejoin send uses the same key the hub indexed under.
    const callTool = wireToolHandlers(server, toolSchemas, async (toolName, args) => {
        const result = await dispatchTool(ctx, toolName, args);
        if (!result.isError) {
            if (toolName === "relay_join" && typeof args.room === "string") {
                const sanitized = sanitizeSessionName(args.room);
                if (sanitized !== null) joinedRooms.add(sanitized);
            } else if (toolName === "relay_leave" && typeof args.room === "string") {
                const sanitized = sanitizeSessionName(args.room);
                if (sanitized !== null) joinedRooms.delete(sanitized);
            }
        }
        return result;
    });

    const sessionWatcher =
        opts.skipRegister || hasFixedRelayPeerIdentity()
            ? null
            : startSessionWatcher({
                  sessionPath: claudeSessionPath(),
                  initialName: claudeSessionName(),
                  onName: async (newName) => {
                      if (newName === name) return;
                      const result = await renameWithHub(ctx, newName);
                      if (!result.ok) {
                          log.warn("session_watcher_rename_failed", {
                              attempted: newName,
                              code: result.code,
                          });
                      }
                  },
              });

    const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        log.info("channel_close");
        if (parentWatcher !== null) {
            clearInterval(parentWatcher);
            parentWatcher = null;
        }
        if (sessionWatcher !== null) sessionWatcher.close();
        reconnector.close();
        pendingBroadcasts.clear();
        try {
            bootstrap.hub.close();
        } catch {}
        try {
            await server.close();
        } catch {}
        if (opts.transport?.close) {
            try {
                await opts.transport.close();
            } catch {}
        }
        if (bootstrap.hubHandle) {
            try {
                await bootstrap.hubHandle.close();
            } catch {}
        }
    };

    const parentWatchIntervalMs = opts.parentWatchIntervalMs ?? 2000;
    if (parentWatchIntervalMs > 0 && process.ppid && process.ppid > 1) {
        const bootPpid = process.ppid;
        parentWatcher = setInterval(() => {
            // Cross-platform parent-death detection:
            // - Linux/Mac: when parent dies, child is re-parented to init/systemd → ppid changes.
            // - Windows: no re-parenting; rely on stdin closure when parent's stdio handles drop.
            // Combining all three signals catches the death across platforms.
            const stdin = process.stdin as NodeJS.ReadStream & {
                destroyed?: boolean;
                readableEnded?: boolean;
            };
            const ppidChanged = process.ppid !== bootPpid;
            const stdinDestroyed = stdin.destroyed === true;
            const stdinEnded = stdin.readableEnded === true;
            if (ppidChanged || stdinDestroyed || stdinEnded) {
                log.info("parent_died", {
                    bootPpid,
                    currentPpid: process.ppid,
                    ppidChanged,
                    stdinDestroyed,
                    stdinEnded,
                });
                void close();
            }
        }, parentWatchIntervalMs).unref();
    }

    // If the MCP transport closes (e.g. parent Claude Code died -> stdin EOF),
    // tear down the hub connection so the hub reaps this peer immediately.
    server.onclose = () => {
        log.info("mcp_transport_closed");
        void close();
    };

    if (opts.transport) {
        await opts.transport.connect(server);
    }

    return {
        close,
        getName: () => name,
        getHubRole: () => bootstrap.hubRole,
        getCapabilities: () => ({ ...CAPABILITIES }),
        getInstructions: () => INSTRUCTIONS,
        getToolNames: () => TOOLS.map((t) => t.name),
        getToolSchemas: () => toolSchemas.map((s) => ({ ...s, inputSchema: { ...s.inputSchema } })),
        callTool,
    };
}

export async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await startChannel({
        transport: {
            connect: (server) => server.connect(transport),
            close: () => transport.close(),
        },
    });
}
