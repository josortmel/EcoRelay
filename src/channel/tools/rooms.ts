import { MAX_TEXT_LEN } from "../../protocol";
import { errResult, okResult, type ChannelContext, type ToolResult } from "./core";

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
