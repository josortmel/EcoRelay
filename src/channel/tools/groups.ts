import { MAX_TEXT_LEN } from "../../protocol";
import { errResult, okResult, type ChannelContext, type ToolResult } from "./core";

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
