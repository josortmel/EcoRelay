import { MAX_TEXT_LEN, type ErrCode } from "../protocol";
import type { HubClient } from "./hub-client";
import { TOOLS, type ToolSchema } from "../channel/tool-schemas/index";
import { safeName, savePeerId, resolveCwd } from "./identity";
import { makeLogger } from "../logger";

const log = makeLogger("codex-tools");

// ── Result helpers ────────────────────────────────────────────────

export type ToolResult = {
    isError?: boolean;
    content: Array<{ type: "text"; text: string }>;
};

export const errResult = (code: ErrCode | string): ToolResult => ({
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ok: false, code }) }],
});

export const okResult = (payload: unknown): ToolResult => ({
    content: [{ type: "text", text: JSON.stringify(payload) }],
});

// ── Tool schemas (re-export from channel, no additionalProperties) ─

export function getToolSchemas(): ToolSchema[] {
    return TOOLS;
}

// ── Tool dispatch ─────────────────────────────────────────────────

export async function callTool(
    hub: HubClient,
    name: string,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    try {
        switch (name) {
            case "relay_peers":
                return await toolPeers(hub);
            case "relay_send":
                return await toolSend(hub, args);
            case "relay_inbox":
                return await toolInbox(hub, args);
            case "relay_reply":
                return await toolReply(hub, args);
            case "relay_broadcast":
                return await toolBroadcast(hub, args);
            case "relay_rename":
                return await toolRename(hub, args);
            case "relay_join":
                return await toolJoin(hub, args);
            case "relay_leave":
                return await toolLeave(hub, args);
            case "relay_room":
                return await toolRoom(hub, args);
            case "relay_rooms":
                return await toolRooms(hub);
            case "relay_group_create":
                return await toolGroupCreate(hub, args);
            case "relay_group_invite":
                return await toolGroupInvite(hub, args);
            case "relay_group_remove":
                return await toolGroupRemove(hub, args);
            case "relay_group_leave":
                return await toolGroupLeave(hub, args);
            case "relay_group_send":
                return await toolGroupSend(hub, args);
            case "relay_group_history":
                return await toolGroupHistory(hub, args);
            case "relay_group_list":
                return await toolGroupList(hub);
            case "relay_group_info":
                return await toolGroupInfo(hub, args);
            case "relay_group_delete":
                return await toolGroupDelete(hub, args);
            default:
                return errResult("bad_args");
        }
    } catch (e) {
        log.error("tool_call_failed", { name, err: e instanceof Error ? e.message : String(e) });
        return errResult("unexpected");
    }
}

// ── Handlers ──────────────────────────────────────────────────────

function randomUUID(): string {
    try {
        return crypto.randomUUID();
    } catch {
        return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
}

async function toolPeers(hub: HubClient): Promise<ToolResult> {
    const reply = (await hub.sendAndWait({ type: "list_peers" })) as Record<string, unknown>;
    if (reply.type === "peers") return okResult({ me: hub.name, peers: reply.peers });
    if (reply.type === "err") return errResult(reply.code as string);
    return errResult("unexpected");
}

async function toolSend(hub: HubClient, args: Record<string, unknown>): Promise<ToolResult> {
    const to = args.to as string;
    const text = args.text as string;
    if (typeof to !== "string" || typeof text !== "string") return errResult("bad_args");
    if (to.length > 64 || text.length > MAX_TEXT_LEN) return errResult("bad_args");
    const replyTo = typeof args.reply_to === "string" ? args.reply_to : undefined;
    if (replyTo && replyTo.length > 256) return errResult("bad_args");
    const urgent = args.urgent === true ? true : undefined;

    const msg: Record<string, unknown> = { type: "send", to, text };
    if (replyTo) msg.reply_to = replyTo;
    if (urgent) msg.urgent = true;

    const reply = (await hub.sendAndWait(msg)) as Record<string, unknown>;
    if (reply.type === "send_ack") return okResult({ ok: true, msg_id: reply.msg_id, status: reply.status });
    if (reply.type === "err") return errResult(reply.code as string);
    return errResult("unexpected");
}

async function toolInbox(hub: HubClient, args: Record<string, unknown>): Promise<ToolResult> {
    const msg: Record<string, unknown> = { type: "inbox" };
    if (typeof args.limit === "number") msg.limit = args.limit;
    if (typeof args.since_id === "string") {
        if (args.since_id.length === 0 || args.since_id.length > 64) return errResult("bad_args");
        msg.since_id = args.since_id;
    }

    const reply = (await hub.sendAndWait(msg)) as Record<string, unknown>;
    if (reply.type === "inbox_result") return okResult({ messages: reply.messages, remaining: reply.remaining });
    if (reply.type === "err") return errResult(reply.code as string);
    return errResult("unexpected");
}

async function toolReply(hub: HubClient, args: Record<string, unknown>): Promise<ToolResult> {
    const askId = args.ask_id as string;
    const text = args.text as string;
    if (typeof askId !== "string" || typeof text !== "string") return errResult("bad_args");
    if (askId.length > 256 || text.length > MAX_TEXT_LEN) return errResult("bad_args");

    const sender = hub.messageSenders.get(askId);
    if (sender) {
        return toolSend(hub, { to: sender, text, reply_to: askId });
    }

    hub.fireSend({ type: "reply", ask_id: askId, text });
    return okResult({ ok: true });
}

// Fire-and-forget: returns {ok, broadcast_id} only, no peer_count (parity with OC/Copilot).
async function toolBroadcast(hub: HubClient, args: Record<string, unknown>): Promise<ToolResult> {
    const question = args.question as string;
    if (typeof question !== "string") return errResult("bad_args");
    if (question.length > MAX_TEXT_LEN) return errResult("bad_args");
    const excludeSelf = args.exclude_self !== false;
    const broadcastId = `bcast-codex-${hub.name}-${Date.now()}`;

    hub.fireSend({
        type: "broadcast",
        question,
        broadcast_id: broadcastId,
        exclude_self: excludeSelf,
    });
    return okResult({ ok: true, broadcast_id: broadcastId });
}

async function toolRename(hub: HubClient, args: Record<string, unknown>): Promise<ToolResult> {
    const newName = args.new_name as string;
    if (typeof newName !== "string") return errResult("bad_args");
    if (!safeName(newName)) return errResult("bad_args");
    const reply = (await hub.sendAndWait({ type: "rename", new_name: newName })) as Record<string, unknown>;
    if (reply.type === "ack") {
        hub._setPeerName(newName);
        savePeerId(resolveCwd(), newName);
        return okResult({ ok: true, name: newName });
    }
    if (reply.type === "err") return errResult(reply.code as string);
    return errResult("unexpected");
}

async function toolJoin(hub: HubClient, args: Record<string, unknown>): Promise<ToolResult> {
    const room = args.room as string;
    if (typeof room !== "string" || room.length > 64) return errResult("bad_args");
    const reply = (await hub.sendAndWait({ type: "join_room", room })) as Record<string, unknown>;
    if (reply.type === "room_ack") return okResult({ ok: true, room: reply.room, members: reply.members });
    if (reply.type === "err") return errResult(reply.code as string);
    return errResult("unexpected");
}

async function toolLeave(hub: HubClient, args: Record<string, unknown>): Promise<ToolResult> {
    const room = args.room as string;
    if (typeof room !== "string" || room.length > 64) return errResult("bad_args");
    const reply = (await hub.sendAndWait({ type: "leave_room", room })) as Record<string, unknown>;
    if (reply.type === "ack") return okResult({ ok: true });
    if (reply.type === "err") return errResult(reply.code as string);
    return errResult("unexpected");
}

async function toolRoom(hub: HubClient, args: Record<string, unknown>): Promise<ToolResult> {
    const room = args.room as string;
    const text = args.text as string;
    if (typeof room !== "string" || typeof text !== "string" || room.length > 64) return errResult("bad_args");
    if (text.length > MAX_TEXT_LEN) return errResult("bad_args");
    const msgId = randomUUID();
    const reply = (await hub.sendAndWait({ type: "room_msg", room, text, msg_id: msgId })) as Record<string, unknown>;
    if (reply.type === "room_send_ack") return okResult({ ok: true, room: reply.room, delivered_count: reply.delivered_count });
    if (reply.type === "err") return errResult(reply.code as string);
    return errResult("unexpected");
}

async function toolRooms(hub: HubClient): Promise<ToolResult> {
    const reply = (await hub.sendAndWait({ type: "list_rooms" })) as Record<string, unknown>;
    if (reply.type === "rooms_list") return okResult({ rooms: reply.rooms });
    if (reply.type === "err") return errResult(reply.code as string);
    return errResult("unexpected");
}

async function toolGroupCreate(hub: HubClient, args: Record<string, unknown>): Promise<ToolResult> {
    const name = args.name as string;
    const members = args.members as string[];
    if (typeof name !== "string" || !Array.isArray(members)) return errResult("bad_args");
    if (name.length > 64 || members.length > 20) return errResult("bad_args");
    const validMembers = members.filter((m) => typeof m === "string");
    if (validMembers.some((m) => m.length > 64)) return errResult("bad_args");
    const reply = (await hub.sendAndWait({
        type: "group_create", name, members: validMembers,
    })) as Record<string, unknown>;
    if (reply.type === "group_created") return okResult({ ok: true, group: reply.group, members: reply.members });
    if (reply.type === "err") return errResult(reply.code as string);
    return errResult("unexpected");
}

async function toolGroupInvite(hub: HubClient, args: Record<string, unknown>): Promise<ToolResult> {
    const group = args.group as string;
    const peer = args.peer as string;
    if (typeof group !== "string" || typeof peer !== "string") return errResult("bad_args");
    if (group.length > 64 || peer.length > 64) return errResult("bad_args");
    const reply = (await hub.sendAndWait({ type: "group_invite", group, peer })) as Record<string, unknown>;
    if (reply.type === "group_ack") return okResult({ ok: true });
    if (reply.type === "err") return errResult(reply.code as string);
    return errResult("unexpected");
}

async function toolGroupRemove(hub: HubClient, args: Record<string, unknown>): Promise<ToolResult> {
    const group = args.group as string;
    const peer = args.peer as string;
    const reason = args.reason as string;
    if (typeof group !== "string" || typeof peer !== "string" || typeof reason !== "string") return errResult("bad_args");
    if (group.length > 64 || peer.length > 64 || reason.length > 256) return errResult("bad_args");
    const reply = (await hub.sendAndWait({ type: "group_remove", group, peer, reason })) as Record<string, unknown>;
    if (reply.type === "group_ack") return okResult({ ok: true });
    if (reply.type === "err") return errResult(reply.code as string);
    return errResult("unexpected");
}

async function toolGroupLeave(hub: HubClient, args: Record<string, unknown>): Promise<ToolResult> {
    const group = args.group as string;
    if (typeof group !== "string" || group.length > 64) return errResult("bad_args");
    const reply = (await hub.sendAndWait({ type: "group_leave", group })) as Record<string, unknown>;
    if (reply.type === "group_ack") return okResult({ ok: true });
    if (reply.type === "err") return errResult(reply.code as string);
    return errResult("unexpected");
}

async function toolGroupSend(hub: HubClient, args: Record<string, unknown>): Promise<ToolResult> {
    const group = args.group as string;
    const text = args.text as string;
    if (typeof group !== "string" || typeof text !== "string") return errResult("bad_args");
    if (group.length > 64) return errResult("bad_args");
    if (text.length > MAX_TEXT_LEN) return errResult("bad_args");
    const reply = (await hub.sendAndWait({ type: "group_send", group, text })) as Record<string, unknown>;
    if (reply.type === "group_ack") return okResult({ ok: true });
    if (reply.type === "err") return errResult(reply.code as string);
    return errResult("unexpected");
}

async function toolGroupHistory(hub: HubClient, args: Record<string, unknown>): Promise<ToolResult> {
    const group = args.group as string;
    if (typeof group !== "string" || group.length > 64) return errResult("bad_args");
    const msg: Record<string, unknown> = { type: "group_history", group };
    if (typeof args.limit === "number") msg.limit = args.limit;
    const reply = (await hub.sendAndWait(msg)) as Record<string, unknown>;
    if (reply.type === "group_messages") return okResult({ ok: true, group: reply.group, messages: reply.messages, unread_remaining: reply.unread_remaining });
    if (reply.type === "err") return errResult(reply.code as string);
    return errResult("unexpected");
}

async function toolGroupList(hub: HubClient): Promise<ToolResult> {
    const reply = (await hub.sendAndWait({ type: "group_list" })) as Record<string, unknown>;
    if (reply.type === "group_list_result") return okResult({ ok: true, groups: reply.groups });
    if (reply.type === "err") return errResult(reply.code as string);
    return errResult("unexpected");
}

async function toolGroupInfo(hub: HubClient, args: Record<string, unknown>): Promise<ToolResult> {
    const group = args.group as string;
    if (typeof group !== "string" || group.length > 64) return errResult("bad_args");
    const reply = (await hub.sendAndWait({ type: "group_info", group })) as Record<string, unknown>;
    if (reply.type === "group_info_result") return okResult({ ok: true, group: reply.group, admin: reply.admin, members: reply.members, unread_count: reply.unread_count });
    if (reply.type === "err") return errResult(reply.code as string);
    return errResult("unexpected");
}

async function toolGroupDelete(hub: HubClient, args: Record<string, unknown>): Promise<ToolResult> {
    const group = args.group as string;
    if (typeof group !== "string" || group.length > 64) return errResult("bad_args");
    const reply = (await hub.sendAndWait({ type: "group_delete", group })) as Record<string, unknown>;
    if (reply.type === "group_ack") return okResult({ ok: true });
    if (reply.type === "err") return errResult(reply.code as string);
    return errResult("unexpected");
}
