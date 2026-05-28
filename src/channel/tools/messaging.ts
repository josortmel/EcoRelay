import { MAX_TEXT_LEN, type ErrCode } from "../../protocol";
import { errResult, okResult, type ChannelContext, type ToolResult } from "./core";

export async function relaySend(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const to = args.to;
    const text = args.text;
    if (typeof to !== "string" || typeof text !== "string") return errResult("bad_args");
    if (to.length > 64) return errResult("bad_args");
    if (text.length > MAX_TEXT_LEN) return errResult("bad_args");
    const replyTo = typeof args.reply_to === "string" ? args.reply_to : undefined;
    if (replyTo && replyTo.length > 256) return errResult("bad_args");
    const urgent = typeof args.urgent === "boolean" ? args.urgent : undefined;
    const reply = await ctx.getHub().sendRequest(
        {
            type: "send",
            to,
            text,
            ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
            ...(urgent ? { urgent: true } : {}),
        },
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
        return errResult("bad_args");
    const reply = await ctx.getHub().sendRequest(
        {
            type: "inbox",
            ...(limit !== undefined ? { limit } : {}),
            ...(sinceId !== undefined ? { since_id: sinceId } : {}),
        },
        ctx.requestTimeoutMs,
    );
    if (reply.type === "inbox_result") {
        return okResult({ messages: reply.messages, remaining: reply.remaining });
    }
    return errResult((reply as { code?: ErrCode }).code ?? "unexpected");
}
