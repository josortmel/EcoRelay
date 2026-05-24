import { MAX_TEXT_LEN, type ErrCode } from "../protocol";
import type { HubConnection } from "./hub-connection";
import type { BroadcastAckResult, PendingBroadcasts } from "./pending-broadcasts";

export type ToolResult = {
    isError?: boolean;
    content: Array<{ type: "text"; text: string }>;
};

export type ChannelContext = {
    getHub: () => HubConnection;
    pendingBroadcasts: PendingBroadcasts;
    getName: () => string;
    setName: (n: string) => void;
    nowFn: () => number;
    counters: { broadcast: number };
    broadcastTimeoutMs: number;
    requestTimeoutMs: number;
};

const errResult = (code: ErrCode): ToolResult => ({
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ok: false, code }) }],
});

const okResult = (payload: unknown): ToolResult => ({
    content: [{ type: "text", text: JSON.stringify(payload) }],
});

const broadcastResultToTool = (r: BroadcastAckResult): ToolResult => {
    if (r.ok) return okResult({ ok: true, broadcast_id: r.broadcast_id, peer_count: r.peer_count });
    return errResult(r.code);
};

export async function relayPeers(ctx: ChannelContext): Promise<ToolResult> {
    const reply = await ctx.getHub().sendRequest({ type: "list_peers" }, ctx.requestTimeoutMs);
    if (reply.type !== "peers") {
        return errResult((reply as { code?: ErrCode }).code ?? "unexpected");
    }
    return okResult({ me: ctx.getName(), peers: reply.peers });
}

export type RenameResult = { ok: true } | { ok: false; code: ErrCode };

export async function renameWithHub(ctx: ChannelContext, newName: string): Promise<RenameResult> {
    const reply = await ctx
        .getHub()
        .sendRequest({ type: "rename", new_name: newName }, ctx.requestTimeoutMs);
    if (reply.type === "ack") {
        ctx.setName(newName);
        return { ok: true };
    }
    if (reply.type === "err") return { ok: false, code: reply.code };
    return { ok: false, code: "unexpected" };
}

export async function relayRename(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const newName = args.new_name;
    if (typeof newName !== "string") return errResult("bad_args");
    const result = await renameWithHub(ctx, newName);
    if (result.ok) return okResult({ ok: true, name: newName });
    return errResult(result.code);
}

export async function relayAsk(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const to = args.to;
    const question = args.question;
    if (typeof to !== "string" || typeof question !== "string") return errResult("bad_args");
    if (question.length > MAX_TEXT_LEN) return errResult("bad_args");
    const threadId = typeof args.thread_id === "string" ? args.thread_id : undefined;
    const askId = crypto.randomUUID();
    ctx.getHub().send({
        type: "ask",
        to,
        question,
        ask_id: askId,
        ...(threadId ? { thread_id: threadId } : {}),
    });
    return okResult({ ok: true, ask_id: askId });
}

export async function relayReply(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const askId = args.ask_id;
    const text = args.text;
    if (typeof askId !== "string" || typeof text !== "string") return errResult("bad_args");
    if (text.length > MAX_TEXT_LEN) return errResult("bad_args");
    ctx.getHub().send({ type: "reply", ask_id: askId, text });
    return okResult({ ok: true });
}

export async function relayBroadcast(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const question = args.question;
    if (typeof question !== "string") return errResult("bad_args");
    if (question.length > MAX_TEXT_LEN) return errResult("bad_args");
    const excludeSelf = typeof args.exclude_self === "boolean" ? args.exclude_self : true;
    const broadcastId = `bcast-${ctx.getName()}-${++ctx.counters.broadcast}-${ctx.nowFn()}`;
    const pending = ctx.pendingBroadcasts.create(broadcastId, ctx.broadcastTimeoutMs);
    ctx.getHub().send({
        type: "broadcast",
        question,
        broadcast_id: broadcastId,
        exclude_self: excludeSelf,
    });
    return broadcastResultToTool(await pending);
}

export async function relayJoin(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const room = args.room;
    if (typeof room !== "string") return errResult("bad_args");
    const reply = await ctx.getHub().sendRequest({ type: "join_room", room }, ctx.requestTimeoutMs);
    if (reply.type === "room_ack") {
        return okResult({ ok: true, room: reply.room, members: reply.members });
    }
    if (reply.type === "err") return errResult(reply.code);
    return errResult("unexpected");
}

export async function relayLeave(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const room = args.room;
    if (typeof room !== "string") return errResult("bad_args");
    const reply = await ctx
        .getHub()
        .sendRequest({ type: "leave_room", room }, ctx.requestTimeoutMs);
    if (reply.type === "ack") return okResult({ ok: true });
    if (reply.type === "err") return errResult(reply.code);
    return errResult("unexpected");
}

export async function relayRoomMsg(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const room = args.room;
    const text = args.text;
    if (typeof room !== "string" || typeof text !== "string") return errResult("bad_args");
    if (text.length > MAX_TEXT_LEN) return errResult("bad_args");
    const msgId = crypto.randomUUID();
    const reply = await ctx
        .getHub()
        .sendRequest({ type: "room_msg", room, text, msg_id: msgId }, ctx.requestTimeoutMs);
    if (reply.type === "room_send_ack") {
        return okResult({ ok: true, room: reply.room, delivered_count: reply.delivered_count });
    }
    if (reply.type === "err") return errResult(reply.code);
    return errResult("unexpected");
}

export async function relayListRooms(ctx: ChannelContext): Promise<ToolResult> {
    const reply = await ctx.getHub().sendRequest({ type: "list_rooms" }, ctx.requestTimeoutMs);
    if (reply.type === "rooms_list") return okResult({ rooms: reply.rooms });
    if (reply.type === "err") return errResult(reply.code);
    return errResult("unexpected");
}

export async function relayGroupCreate(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const name = args.name;
    const members = args.members;
    if (typeof name !== "string" || !Array.isArray(members)) return errResult("bad_args");
    const reply = await ctx.getHub().sendRequest(
        {
            type: "group_create",
            name,
            members: members.filter((m): m is string => typeof m === "string"),
        },
        ctx.requestTimeoutMs,
    );
    if (reply.type === "group_created")
        return okResult({ ok: true, group: reply.group, members: reply.members });
    if (reply.type === "err") return errResult(reply.code);
    return errResult("unexpected");
}

export async function relayGroupInvite(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const group = args.group;
    const peer = args.peer;
    if (typeof group !== "string" || typeof peer !== "string") return errResult("bad_args");
    const reply = await ctx
        .getHub()
        .sendRequest({ type: "group_invite", group, peer }, ctx.requestTimeoutMs);
    if (reply.type === "group_ack") return okResult({ ok: true });
    if (reply.type === "err") return errResult(reply.code);
    return errResult("unexpected");
}

export async function relayGroupRemove(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const group = args.group;
    const peer = args.peer;
    const reason = args.reason;
    if (typeof group !== "string" || typeof peer !== "string" || typeof reason !== "string")
        return errResult("bad_args");
    if (reason.length > 256) return errResult("bad_args");
    const reply = await ctx
        .getHub()
        .sendRequest({ type: "group_remove", group, peer, reason }, ctx.requestTimeoutMs);
    if (reply.type === "group_ack") return okResult({ ok: true });
    if (reply.type === "err") return errResult(reply.code);
    return errResult("unexpected");
}

export async function relayGroupLeave(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const group = args.group;
    if (typeof group !== "string") return errResult("bad_args");
    const reply = await ctx
        .getHub()
        .sendRequest({ type: "group_leave", group }, ctx.requestTimeoutMs);
    if (reply.type === "group_ack") return okResult({ ok: true });
    if (reply.type === "err") return errResult(reply.code);
    return errResult("unexpected");
}

export async function relayGroupSend(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const group = args.group;
    const text = args.text;
    if (typeof group !== "string" || typeof text !== "string") return errResult("bad_args");
    if (text.length > MAX_TEXT_LEN) return errResult("bad_args");
    const reply = await ctx
        .getHub()
        .sendRequest({ type: "group_send", group, text }, ctx.requestTimeoutMs);
    if (reply.type === "group_ack") return okResult({ ok: true });
    if (reply.type === "err") return errResult(reply.code);
    return errResult("unexpected");
}

export async function relayGroupHistory(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const group = args.group;
    if (typeof group !== "string") return errResult("bad_args");
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const reply = await ctx
        .getHub()
        .sendRequest(
            { type: "group_history", group, ...(limit !== undefined ? { limit } : {}) },
            ctx.requestTimeoutMs,
        );
    if (reply.type === "group_messages")
        return okResult({
            ok: true,
            group: reply.group,
            messages: reply.messages,
            unread_remaining: reply.unread_remaining,
        });
    if (reply.type === "err") return errResult(reply.code);
    return errResult("unexpected");
}

export async function relayGroupList(ctx: ChannelContext): Promise<ToolResult> {
    const reply = await ctx.getHub().sendRequest({ type: "group_list" }, ctx.requestTimeoutMs);
    if (reply.type === "group_list_result") return okResult({ ok: true, groups: reply.groups });
    if (reply.type === "err") return errResult(reply.code);
    return errResult("unexpected");
}

export async function relayGroupInfo(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const group = args.group;
    if (typeof group !== "string") return errResult("bad_args");
    const reply = await ctx
        .getHub()
        .sendRequest({ type: "group_info", group }, ctx.requestTimeoutMs);
    if (reply.type === "group_info_result")
        return okResult({
            ok: true,
            group: reply.group,
            admin: reply.admin,
            members: reply.members,
            unread_count: reply.unread_count,
        });
    if (reply.type === "err") return errResult(reply.code);
    return errResult("unexpected");
}

export async function relayGroupDelete(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const group = args.group;
    if (typeof group !== "string") return errResult("bad_args");
    const reply = await ctx
        .getHub()
        .sendRequest({ type: "group_delete", group }, ctx.requestTimeoutMs);
    if (reply.type === "group_ack") return okResult({ ok: true });
    if (reply.type === "err") return errResult(reply.code);
    return errResult("unexpected");
}

export async function relaySend(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const to = args.to;
    const text = args.text;
    if (typeof to !== "string" || typeof text !== "string") return errResult("bad_args");
    if (text.length > MAX_TEXT_LEN) return errResult("bad_args");
    const replyTo = typeof args.reply_to === "string" ? args.reply_to : undefined;
    if (replyTo && replyTo.length > 256) return errResult("bad_args"); // FIX 7
    const urgent = typeof args.urgent === "boolean" ? args.urgent : undefined;
    const reply = await ctx.getHub().sendRequest(
        {
            type: "send",
            to,
            text,
            ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
            ...(urgent ? { urgent: true } : {}),
        }, // FIX 10
        ctx.requestTimeoutMs,
    );
    if (reply.type === "send_ack") {
        return okResult({ ok: true, msg_id: reply.msg_id, status: reply.status });
    }
    return errResult((reply as { code?: ErrCode }).code ?? "unexpected");
}

export async function relayInbox(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const sinceId = typeof args.since_id === "string" ? args.since_id : undefined;
    if (sinceId !== undefined && (sinceId.length === 0 || sinceId.length > 64))
        return errResult("bad_args"); // FIX 8
    const reply = await ctx.getHub().sendRequest(
        {
            type: "inbox",
            ...(limit !== undefined ? { limit } : {}),
            ...(sinceId !== undefined ? { since_id: sinceId } : {}),
        }, // FIX 10
        ctx.requestTimeoutMs,
    );
    if (reply.type === "inbox_result") {
        return okResult({ messages: reply.messages, remaining: reply.remaining });
    }
    return errResult((reply as { code?: ErrCode }).code ?? "unexpected");
}

export async function callTool(
    ctx: ChannelContext,
    name: string,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    switch (name) {
        case "relay_peers":
            return relayPeers(ctx);
        case "relay_rename":
            return relayRename(ctx, args);
        case "relay_ask":
            return relayAsk(ctx, args);
        case "relay_reply":
            return relayReply(ctx, args);
        case "relay_broadcast":
            return relayBroadcast(ctx, args);
        case "relay_join":
            return relayJoin(ctx, args);
        case "relay_leave":
            return relayLeave(ctx, args);
        case "relay_room":
            return relayRoomMsg(ctx, args);
        case "relay_rooms":
            return relayListRooms(ctx);
        case "relay_group_create":
            return relayGroupCreate(ctx, args);
        case "relay_group_invite":
            return relayGroupInvite(ctx, args);
        case "relay_group_remove":
            return relayGroupRemove(ctx, args);
        case "relay_group_leave":
            return relayGroupLeave(ctx, args);
        case "relay_group_send":
            return relayGroupSend(ctx, args);
        case "relay_group_history":
            return relayGroupHistory(ctx, args);
        case "relay_group_list":
            return relayGroupList(ctx);
        case "relay_group_info":
            return relayGroupInfo(ctx, args);
        case "relay_group_delete":
            return relayGroupDelete(ctx, args);
        case "relay_send":
            return relaySend(ctx, args);
        case "relay_inbox":
            return relayInbox(ctx, args);
        default:
            return { isError: true, content: [{ type: "text", text: "not_implemented" }] };
    }
}
