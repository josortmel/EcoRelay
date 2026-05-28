import type * as net from "node:net";
import type { z } from "zod";
import { sanitizeSessionName } from "../../identity";
import { makeLogger } from "../../logger";
import {
    PROTOCOL_VERSION,
    type BroadcastMsg,
    type ListPeersMsg,
    type RegisterMsg,
    type RenameMsg,
    type ReplyMsg,
    type ServerMsg,
} from "../../protocol";
import type { GroupStore } from "../groups";
import type { MailboxStore } from "../mailbox";
import type { PeerRegistry } from "../registry";

const log = makeLogger("hub");

export const MAX_ROOMS = 50;
export const MAX_MEMBERS_PER_ROOM = 20;
export const MAX_GROUPS = 200;
export const MAX_GROUP_MEMBERS = 20;

export type HubContext = {
    registry: PeerRegistry;
    sendTo: (name: string, msg: ServerMsg) => boolean;
    groups: GroupStore;
    mailboxes: MailboxStore;
    onLocalPeerJoin?: (name: string) => void;
};

type Send = (m: ServerMsg) => void;

export async function handleRegister(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof RegisterMsg>,
    send: Send,
): Promise<void> {
    if (msg.protocol_version !== PROTOCOL_VERSION) {
        log.warn("register_protocol_mismatch", {
            name: msg.name,
            client_version: msg.protocol_version,
            hub_version: PROTOCOL_VERSION,
        });
        return send({ type: "err", code: "protocol_mismatch" });
    }
    const name = sanitizeSessionName(msg.name); // FIX 1
    if (!name) {
        send({ type: "err", code: "bad_args" });
        return;
    }
    const result = await ctx.registry.register(socket, { ...msg, name });
    if (result === "already_registered") return send({ type: "err", code: "already_registered" });
    if (result === "name_taken") return send({ type: "err", code: "name_taken" });
    send({ type: "ack" });
    ctx.onLocalPeerJoin?.(name);
}

export function handleRename(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof RenameMsg>,
    send: Send,
): void {
    const reqId = msg.req_id;
    const tail = reqId ? { req_id: reqId } : {};
    const sanitizedName = sanitizeSessionName(msg.new_name);
    if (sanitizedName === null)
        return send({ type: "err", code: "bad_args", message: "invalid name", ...tail });
    const result = ctx.registry.rename(socket, sanitizedName);
    if (result === "not_registered") return send({ type: "err", code: "not_registered", ...tail });
    if (result === "name_taken") return send({ type: "err", code: "name_taken", ...tail });
    send({ type: "ack", ...tail });
}

export function handleListPeers(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof ListPeersMsg>,
    send: Send,
): void {
    const selfName = ctx.registry.getName(socket);
    const list = ctx.registry.list(selfName);
    log.debug("list_peers", { caller: selfName, peer_count: list.length });
    send({ type: "peers", peers: list, ...(msg.req_id ? { req_id: msg.req_id } : {}) });
}

export function handleReply(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof ReplyMsg>,
    send: Send,
): void {
    const replier = ctx.registry.getName(socket);
    if (!replier) {
        log.warn("reply_err", { code: "not_registered", ask_id: msg.ask_id });
        return send({ type: "err", code: "not_registered" });
    }
    log.debug("reply_received", { from: replier, ask_id: msg.ask_id });
    // Reply is forwarded without pending-asks tracking (relay_ask removed).
    // Broadcast replies arrive here but caller routing is disabled.
}

export function handleBroadcast(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof BroadcastMsg>,
    send: Send,
): void {
    const caller = ctx.registry.getName(socket);
    if (!caller) {
        log.warn("broadcast_err", { code: "not_registered", broadcast_id: msg.broadcast_id });
        return send({ type: "err", code: "not_registered" });
    }
    const excludeSelf = msg.exclude_self ?? true;
    let peerCount = 0;
    for (const name of ctx.registry.names()) {
        if (excludeSelf && name === caller) continue;
        peerCount++;
        const threadId = msg.broadcast_id;
        const askId = `${msg.broadcast_id}:${name}`;
        ctx.sendTo(name, {
            type: "incoming_ask",
            from: caller,
            question: msg.question,
            ask_id: askId,
            broadcast_id: msg.broadcast_id,
            thread_id: threadId,
        });
    }
    log.info("broadcast", { from: caller, broadcast_id: msg.broadcast_id, peer_count: peerCount });
    send({ type: "broadcast_ack", broadcast_id: msg.broadcast_id, peer_count: peerCount });
}
