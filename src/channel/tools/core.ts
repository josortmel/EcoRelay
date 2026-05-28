import { MAX_TEXT_LEN, type ErrCode } from "../../protocol";
import type { HubConnection } from "../hub-connection";
import type { BroadcastAckResult, PendingBroadcasts } from "../pending-broadcasts";
import { messageSenders } from "../routing";
import { relaySend } from "./messaging";

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

export const errResult = (code: ErrCode): ToolResult => ({
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ok: false, code }) }],
});

export const okResult = (payload: unknown): ToolResult => ({
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

export async function relayReply(
    ctx: ChannelContext,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const askId = args.ask_id;
    const text = args.text;
    if (typeof askId !== "string" || typeof text !== "string") return errResult("bad_args");
    if (text.length > MAX_TEXT_LEN) return errResult("bad_args");

    const sender = messageSenders.get(askId);
    if (sender) {
        return relaySend(ctx, { to: sender, text, reply_to: askId });
    }

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
