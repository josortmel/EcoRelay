import type { ErrCode, ServerMsg } from "../protocol";

const METHOD = "notifications/claude/channel";

export type ChannelNotification = {
    method: typeof METHOD;
    params: { content: string; meta: Record<string, unknown> };
};

export function buildAskNotification(
    msg: Extract<ServerMsg, { type: "incoming_ask" }>,
): ChannelNotification {
    const meta: Record<string, unknown> = {
        from: msg.from,
        ask_id: msg.ask_id,
    };
    if (msg.broadcast_id) meta.broadcast_id = msg.broadcast_id;
    if (msg.thread_id) meta.thread_id = msg.thread_id;
    return { method: METHOD, params: { content: msg.question, meta } };
}

export function buildReplyNotification(
    msg: Extract<ServerMsg, { type: "incoming_reply" }>,
): ChannelNotification {
    const meta: Record<string, unknown> = {
        from: msg.from,
        ask_id: msg.ask_id,
    };
    if (msg.broadcast_id) meta.broadcast_id = msg.broadcast_id;
    if (msg.thread_id) meta.thread_id = msg.thread_id;
    return { method: METHOD, params: { content: msg.text, meta } };
}

export function buildAskErrorNotification(askId: string, code: ErrCode): ChannelNotification {
    const prefixes: Partial<Record<ErrCode, string>> = {
        peer_not_found: "ask failed: target peer is not registered.",
        peer_gone: "ask failed: target peer disconnected before replying.",
        timeout:
            "ask timed out: target peer did not reply within the timeout. The peer may still respond later.",
    };
    const prefix = prefixes[code] ?? `ask failed: ${code}.`;
    const content = `${prefix} Surface this to the user; do not broadcast as a fallback.`;
    return {
        method: METHOD,
        params: { content, meta: { ask_id: askId, code } },
    };
}

export function buildRoomMsgNotification(
    msg: Extract<ServerMsg, { type: "incoming_room_msg" }>,
): ChannelNotification {
    return {
        method: METHOD,
        params: {
            content: msg.text,
            meta: {
                from: msg.from,
                room: msg.room,
                msg_id: msg.msg_id,
            },
        },
    };
}

export function buildGroupMsgNotification(
    msg: Extract<ServerMsg, { type: "incoming_group_msg" }>,
): ChannelNotification {
    return {
        method: METHOD,
        params: {
            content: msg.text,
            meta: { from: msg.from, group: msg.group, msg_id: msg.msg_id, ts: msg.ts },
        },
    };
}
