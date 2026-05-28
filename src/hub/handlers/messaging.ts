import type * as net from "node:net";
import type { z } from "zod";
import { sanitizeSessionName } from "../../identity";
import { makeLogger } from "../../logger";
import type { InboxMsg, SendMsg, ServerMsg } from "../../protocol";
import type { HubContext } from "./core";

const log = makeLogger("hub");

type Send = (m: ServerMsg) => void;

export function handleSend(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof SendMsg>,
    send: Send,
): void {
    const caller = ctx.registry.getName(socket);
    if (!caller) {
        return send({
            type: "err",
            code: "not_registered",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    }
    const to = sanitizeSessionName(msg.to);
    if (!to) {
        return send({
            type: "err",
            code: "bad_args",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    }

    let result;
    try {
        result = ctx.mailboxes.addMessage(
            to,
            caller,
            msg.text,
            msg.reply_to ?? null,
            msg.urgent ?? false,
        );
    } catch (e) {
        log.error("mailbox_write_error", { to, err: e instanceof Error ? e.message : String(e) });
        return send({
            type: "err",
            code: "mailbox_error",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    }
    if (!result) {
        return send({
            type: "err",
            code: "mailbox_error",
            message: "mailbox limit exceeded",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    }
    const { message } = result;

    let status: "delivered" | "queued" = "queued";
    const isOnline = ctx.registry.hasName(to);
    if (isOnline) {
        const pushed = ctx.sendTo(to, {
            type: "incoming_message",
            msg_id: message.msg_id,
            from: caller,
            text: msg.text,
            reply_to: message.reply_to,
            ts: message.ts,
            ...(msg.urgent ? { urgent: true } : {}),
        });
        if (pushed) status = "delivered";
    }

    send({
        type: "send_ack",
        msg_id: message.msg_id,
        status,
        ...(msg.req_id ? { req_id: msg.req_id } : {}),
    });
    log.debug("send_processed", {
        from: caller,
        to,
        msg_id: message.msg_id,
        status,
        urgent: msg.urgent ?? false,
    });
}

export function handleInbox(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof InboxMsg>,
    send: Send,
): void {
    const caller = ctx.registry.getName(socket);
    if (!caller) {
        return send({
            type: "err",
            code: "not_registered",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    }

    const limit = msg.limit ?? 20;
    let messages: ReturnType<typeof ctx.mailboxes.getMessages>["messages"];
    let remaining: number;
    try {
        ({ messages, remaining } = ctx.mailboxes.getMessages(caller, msg.since_id, limit));
    } catch (e) {
        log.error("mailbox_read_error", {
            caller,
            err: e instanceof Error ? e.message : String(e),
        });
        return send({
            type: "err",
            code: "mailbox_error",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    }

    send({
        type: "inbox_result",
        messages,
        remaining,
        ...(msg.req_id ? { req_id: msg.req_id } : {}),
    });
    log.debug("inbox_polled", { caller, returned: messages.length, remaining }); // FIX 11
}
