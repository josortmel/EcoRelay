import type * as net from "node:net";
import type { z } from "zod";
import { sanitizeSessionName } from "../identity";
import { makeLogger } from "../logger";
import {
    PROTOCOL_VERSION,
    type AskMsg,
    type BroadcastMsg,
    type GroupCreateMsg,
    type GroupDeleteMsg,
    type GroupHistoryMsg,
    type GroupInfoMsg,
    type GroupInviteMsg,
    type GroupLeaveMsg,
    type GroupListMsg,
    type GroupRemoveMsg,
    type GroupSendMsg,
    type InboxMsg,
    type JoinRoomMsg,
    type LeaveRoomMsg,
    type ListPeersMsg,
    type ListRoomsMsg,
    type RegisterMsg,
    type RenameMsg,
    type ReplyMsg,
    type RoomMsgMsg,
    type SendMsg,
    type ServerMsg,
} from "../protocol";
import type { GroupStore } from "./groups";
import type { MailboxStore } from "./mailbox";
import type { PendingAsks } from "./pending-asks";
import type { PeerRegistry } from "./registry";

const log = makeLogger("hub");

export const MAX_ROOMS = 50;
export const MAX_MEMBERS_PER_ROOM = 20;
export const MAX_GROUPS = 200;
export const MAX_GROUP_MEMBERS = 20;

export type HubContext = {
    registry: PeerRegistry;
    pendingAsks: PendingAsks;
    defaultAskTimeoutMs: number;
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
    const current = ctx.registry.getName(socket);
    const result = ctx.registry.rename(socket, sanitizedName);
    if (result === "not_registered") return send({ type: "err", code: "not_registered", ...tail });
    if (result === "name_taken") return send({ type: "err", code: "name_taken", ...tail });
    if (result === "ok" && current) ctx.pendingAsks.updateNameOnRename(current, sanitizedName);
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

export function handleAsk(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof AskMsg>,
    send: Send,
): void {
    const caller = ctx.registry.getName(socket);
    if (!caller) {
        log.warn("ask_undeliverable", {
            from: "?",
            to: msg.to,
            ask_id: msg.ask_id,
            code: "not_registered",
        });
        return send({ type: "err", code: "not_registered" });
    }
    log.debug("ask_received", { from: caller, to: msg.to, ask_id: msg.ask_id });
    if (!ctx.registry.hasName(msg.to)) {
        log.warn("ask_undeliverable", {
            from: caller,
            to: msg.to,
            ask_id: msg.ask_id,
            code: "peer_not_found",
        });
        return send({ type: "err", code: "peer_not_found", ask_id: msg.ask_id });
    }
    const timeoutMs = msg.timeout_ms ?? ctx.defaultAskTimeoutMs;
    const threadId = msg.thread_id ?? crypto.randomUUID();
    ctx.pendingAsks.create(
        msg.ask_id,
        { caller, target: msg.to, thread_id: threadId },
        timeoutMs,
        () => {
            log.warn("pending_ask_timeout", { ask_id: msg.ask_id, caller, target: msg.to });
            ctx.sendTo(caller, { type: "err", code: "timeout", ask_id: msg.ask_id });
        },
    );
    const delivered = ctx.sendTo(msg.to, {
        type: "incoming_ask",
        from: caller,
        question: msg.question,
        ask_id: msg.ask_id,
        thread_id: threadId,
    });
    if (delivered) {
        log.debug("ask_delivered", { from: caller, to: msg.to, ask_id: msg.ask_id });
    } else {
        log.warn("ask_undeliverable", {
            from: caller,
            to: msg.to,
            ask_id: msg.ask_id,
            reason: "send_failed",
        });
    }
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
    const peeked = ctx.pendingAsks.peek(msg.ask_id);
    if (!peeked) {
        log.warn("reply_err", { code: "unknown_ask", ask_id: msg.ask_id });
        return send({ type: "err", code: "unknown_ask" });
    }
    if (peeked.target !== replier) {
        log.warn("reply_err", {
            code: "unknown_ask",
            ask_id: msg.ask_id,
            replier,
            expected_target: peeked.target,
            reason: "replier_not_target",
        });
        return send({ type: "err", code: "unknown_ask" });
    }
    ctx.pendingAsks.resolve(msg.ask_id);
    log.debug("reply_received", {
        from: replier,
        ask_id: msg.ask_id,
        original_caller: peeked.caller,
    });
    ctx.sendTo(peeked.caller, {
        type: "incoming_reply",
        from: replier,
        text: msg.text,
        ask_id: msg.ask_id,
        ...(peeked.broadcast_id ? { broadcast_id: peeked.broadcast_id } : {}),
        ...(peeked.thread_id ? { thread_id: peeked.thread_id } : {}),
    });
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
    const threadId = msg.broadcast_id;
    let peerCount = 0;
    for (const name of ctx.registry.names()) {
        if (excludeSelf && name === caller) continue;
        peerCount++;
        const askId = `${msg.broadcast_id}:${name}`;
        ctx.pendingAsks.create(
            askId,
            { caller, target: name, broadcast_id: msg.broadcast_id, thread_id: threadId },
            ctx.defaultAskTimeoutMs,
            () => {},
        );
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

export function handleJoinRoom(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof JoinRoomMsg>,
    send: Send,
): void {
    const name = ctx.registry.getName(socket);
    if (!name) {
        log.warn("join_room_err", { code: "not_registered", room: msg.room });
        return send({ type: "err", code: "not_registered" });
    }
    const sanitized = sanitizeSessionName(msg.room);
    if (sanitized === null) {
        log.warn("join_room_err", {
            code: "bad_args",
            reason: "invalid_room_name",
            room: msg.room,
        });
        return send({
            type: "err",
            code: "bad_args",
            message: "invalid room name",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    }
    const existingMembers = ctx.registry.getRoomMembers(sanitized);
    const isExistingRoom = existingMembers.length > 0;
    if (!isExistingRoom && ctx.registry.listRooms().length >= MAX_ROOMS) {
        log.warn("join_room_err", { code: "bad_args", reason: "room_limit", room: sanitized });
        return send({
            type: "err",
            code: "bad_args",
            message: `room_limit_reached (max ${MAX_ROOMS})`,
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    }
    if (!existingMembers.includes(name) && existingMembers.length >= MAX_MEMBERS_PER_ROOM) {
        log.warn("join_room_err", { code: "bad_args", reason: "member_limit", room: sanitized });
        return send({
            type: "err",
            code: "bad_args",
            message: `member_limit_reached (max ${MAX_MEMBERS_PER_ROOM})`,
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    }
    const members = ctx.registry.joinRoom(name, sanitized);
    log.info("join_room", { peer: name, room: sanitized, members: members.length });
    send({
        type: "room_ack",
        room: sanitized,
        members,
        ...(msg.req_id ? { req_id: msg.req_id } : {}),
    });
}

export function handleLeaveRoom(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof LeaveRoomMsg>,
    send: Send,
): void {
    const name = ctx.registry.getName(socket);
    if (!name) {
        log.warn("leave_room_err", { code: "not_registered", room: msg.room });
        return send({ type: "err", code: "not_registered" });
    }
    const sanitized = sanitizeSessionName(msg.room);
    if (sanitized === null) {
        log.warn("leave_room_err", {
            code: "bad_args",
            reason: "invalid_room_name",
            room: msg.room,
        });
        return send({
            type: "err",
            code: "bad_args",
            message: "invalid room name",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    }
    ctx.registry.leaveRoom(name, sanitized);
    log.info("leave_room", { peer: name, room: sanitized });
    send({ type: "ack", ...(msg.req_id ? { req_id: msg.req_id } : {}) });
}

export function handleRoomMsg(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof RoomMsgMsg>,
    send: Send,
): void {
    const sender = ctx.registry.getName(socket);
    if (!sender) {
        log.warn("room_msg_err", { code: "not_registered", room: msg.room });
        return send({ type: "err", code: "not_registered" });
    }
    const sanitized = sanitizeSessionName(msg.room);
    if (sanitized === null) {
        log.warn("room_msg_err", { code: "bad_args", reason: "invalid_room_name", room: msg.room });
        return send({
            type: "err",
            code: "bad_args",
            message: "invalid room name",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    }
    const members = ctx.registry.getRoomMembers(sanitized);
    let deliveredCount = 0;
    for (const member of members) {
        if (member === sender) continue;
        const delivered = ctx.sendTo(member, {
            type: "incoming_room_msg",
            room: sanitized,
            from: sender,
            text: msg.text,
            msg_id: msg.msg_id,
        });
        if (delivered) deliveredCount++;
    }
    log.info("room_msg", {
        from: sender,
        room: sanitized,
        msg_id: msg.msg_id,
        delivered_count: deliveredCount,
    });
    send({
        type: "room_send_ack",
        room: sanitized,
        delivered_count: deliveredCount,
        ...(msg.req_id ? { req_id: msg.req_id } : {}),
    });
}

export function handleListRooms(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof ListRoomsMsg>,
    send: Send,
): void {
    const caller = ctx.registry.getName(socket);
    const roomsList = ctx.registry.listRooms();
    log.debug("list_rooms", { caller, count: roomsList.length });
    send({
        type: "rooms_list",
        rooms: roomsList,
        ...(msg.req_id ? { req_id: msg.req_id } : {}),
    });
}

export function handleGroupCreate(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof GroupCreateMsg>,
    send: Send,
): void {
    const caller = ctx.registry.getName(socket);
    if (!caller)
        return send({
            type: "err",
            code: "not_registered",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    const sanitized = sanitizeSessionName(msg.name);
    if (sanitized === null)
        return send({
            type: "err",
            code: "bad_args",
            message: "invalid group name",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    if (ctx.groups.exists(sanitized))
        return send({
            type: "err",
            code: "bad_args",
            message: "group_exists",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    if (ctx.groups.totalGroupCount() >= MAX_GROUPS)
        return send({
            type: "err",
            code: "bad_args",
            message: `group_limit_reached (max ${MAX_GROUPS})`,
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    const sanitizedMembers = msg.members
        .map((m) => sanitizeSessionName(m))
        .filter((m): m is string => m !== null);
    const data = ctx.groups.create(sanitized, caller, sanitizedMembers);
    send({
        type: "group_created",
        group: sanitized,
        members: Object.keys(data.members),
        ...(msg.req_id ? { req_id: msg.req_id } : {}),
    });
}

export function handleGroupInvite(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof GroupInviteMsg>,
    send: Send,
): void {
    const caller = ctx.registry.getName(socket);
    if (!caller)
        return send({
            type: "err",
            code: "not_registered",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    const sanitized = sanitizeSessionName(msg.group);
    if (sanitized === null)
        return send({
            type: "err",
            code: "bad_args",
            message: "invalid group name",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    if (!ctx.groups.exists(sanitized))
        return send({
            type: "err",
            code: "group_not_found",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    if (!ctx.groups.isAdmin(sanitized, caller))
        return send({
            type: "err",
            code: "not_admin",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    const peerSanitized = sanitizeSessionName(msg.peer);
    if (peerSanitized === null)
        return send({
            type: "err",
            code: "bad_args",
            message: "invalid peer name",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    if (ctx.groups.isMember(sanitized, peerSanitized))
        return send({
            type: "err",
            code: "bad_args",
            message: "already_member",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    const data = ctx.groups.load(sanitized);
    if (data && Object.keys(data.members).length >= MAX_GROUP_MEMBERS)
        return send({
            type: "err",
            code: "bad_args",
            message: `member_limit_reached (max ${MAX_GROUP_MEMBERS})`,
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    ctx.groups.addMember(sanitized, peerSanitized);
    send({ type: "group_ack", ...(msg.req_id ? { req_id: msg.req_id } : {}) });
}

export function handleGroupRemove(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof GroupRemoveMsg>,
    send: Send,
): void {
    const caller = ctx.registry.getName(socket);
    if (!caller)
        return send({
            type: "err",
            code: "not_registered",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    const sanitized = sanitizeSessionName(msg.group);
    if (sanitized === null)
        return send({
            type: "err",
            code: "bad_args",
            message: "invalid group name",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    if (!ctx.groups.exists(sanitized))
        return send({
            type: "err",
            code: "group_not_found",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    if (!ctx.groups.isAdmin(sanitized, caller))
        return send({
            type: "err",
            code: "not_admin",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    const peerSanitized = sanitizeSessionName(msg.peer);
    if (peerSanitized === null)
        return send({
            type: "err",
            code: "bad_args",
            message: "invalid peer name",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    if (peerSanitized === caller)
        return send({
            type: "err",
            code: "bad_args",
            message: "admin_cannot_remove_self",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    if (!ctx.groups.isMember(sanitized, peerSanitized))
        return send({
            type: "err",
            code: "not_member",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    const data = ctx.groups.load(sanitized);
    if (!data)
        return send({
            type: "err",
            code: "group_not_found",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    ctx.sendTo(peerSanitized, {
        type: "incoming_group_msg",
        group: sanitized,
        from: caller,
        text: `${caller} removed ${peerSanitized} from ${sanitized}: ${msg.reason}`,
        msg_id: String(data.next_id),
        ts: new Date().toISOString(),
    });
    ctx.groups.removeMember(sanitized, peerSanitized, msg.reason, caller);
    send({ type: "group_ack", ...(msg.req_id ? { req_id: msg.req_id } : {}) });
}

export function handleGroupLeave(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof GroupLeaveMsg>,
    send: Send,
): void {
    const caller = ctx.registry.getName(socket);
    if (!caller)
        return send({
            type: "err",
            code: "not_registered",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    const sanitized = sanitizeSessionName(msg.group);
    if (sanitized === null)
        return send({
            type: "err",
            code: "bad_args",
            message: "invalid group name",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    if (!ctx.groups.isMember(sanitized, caller))
        return send({
            type: "err",
            code: "not_member",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    if (ctx.groups.isAdmin(sanitized, caller))
        return send({
            type: "err",
            code: "bad_args",
            message: "admin cannot leave (use group_delete)",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    ctx.groups.leaveMember(sanitized, caller);
    send({ type: "group_ack", ...(msg.req_id ? { req_id: msg.req_id } : {}) });
}

export function handleGroupSend(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof GroupSendMsg>,
    send: Send,
): void {
    const caller = ctx.registry.getName(socket);
    if (!caller)
        return send({
            type: "err",
            code: "not_registered",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    const sanitized = sanitizeSessionName(msg.group);
    if (sanitized === null)
        return send({
            type: "err",
            code: "bad_args",
            message: "invalid group name",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    if (!ctx.groups.isMember(sanitized, caller))
        return send({
            type: "err",
            code: "not_member",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    const { data, message } = ctx.groups.addMessage(sanitized, caller, msg.text);
    for (const memberName of Object.keys(data.members)) {
        if (memberName === caller) continue;
        ctx.sendTo(memberName, {
            type: "incoming_group_msg",
            group: sanitized,
            from: caller,
            text: message.text,
            msg_id: String(message.id),
            ts: message.ts,
        });
    }
    send({ type: "group_ack", ...(msg.req_id ? { req_id: msg.req_id } : {}) });
}

export function handleGroupHistory(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof GroupHistoryMsg>,
    send: Send,
): void {
    const caller = ctx.registry.getName(socket);
    if (!caller)
        return send({
            type: "err",
            code: "not_registered",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    const sanitized = sanitizeSessionName(msg.group);
    if (sanitized === null)
        return send({
            type: "err",
            code: "bad_args",
            message: "invalid group name",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    if (!ctx.groups.isMember(sanitized, caller))
        return send({
            type: "err",
            code: "not_member",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    const { messages, remaining } = ctx.groups.getUnread(sanitized, caller, msg.limit);
    send({
        type: "group_messages",
        group: sanitized,
        messages,
        unread_remaining: remaining,
        ...(msg.req_id ? { req_id: msg.req_id } : {}),
    });
}

export function handleGroupList(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof GroupListMsg>,
    send: Send,
): void {
    const caller = ctx.registry.getName(socket);
    if (!caller)
        return send({
            type: "err",
            code: "not_registered",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    const groupList = ctx.groups.listForPeer(caller);
    send({
        type: "group_list_result",
        groups: groupList,
        ...(msg.req_id ? { req_id: msg.req_id } : {}),
    });
}

export function handleGroupInfo(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof GroupInfoMsg>,
    send: Send,
): void {
    const caller = ctx.registry.getName(socket);
    if (!caller)
        return send({
            type: "err",
            code: "not_registered",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    const sanitized = sanitizeSessionName(msg.group);
    if (sanitized === null)
        return send({
            type: "err",
            code: "bad_args",
            message: "invalid group name",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    if (!ctx.groups.isMember(sanitized, caller))
        return send({
            type: "err",
            code: "not_member",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    const data = ctx.groups.getInfo(sanitized);
    if (!data)
        return send({
            type: "err",
            code: "group_not_found",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    const memberData = data.members[caller];
    const lastRead = memberData?.last_read ?? 0;
    const unread_count = data.messages.filter((m) => m.id > lastRead).length;
    const members = Object.entries(data.members).map(([name, m]) => ({
        name,
        ...(name === caller ? { last_read: m.last_read } : {}),
        online: ctx.registry.hasName(name),
    }));
    send({
        type: "group_info_result",
        group: sanitized,
        admin: data.admin,
        members,
        unread_count,
        ...(msg.req_id ? { req_id: msg.req_id } : {}),
    });
}

export function handleGroupDelete(
    ctx: HubContext,
    socket: net.Socket,
    msg: z.infer<typeof GroupDeleteMsg>,
    send: Send,
): void {
    const caller = ctx.registry.getName(socket);
    if (!caller)
        return send({
            type: "err",
            code: "not_registered",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    const sanitized = sanitizeSessionName(msg.group);
    if (sanitized === null)
        return send({
            type: "err",
            code: "bad_args",
            message: "invalid group name",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    if (!ctx.groups.exists(sanitized))
        return send({
            type: "err",
            code: "group_not_found",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    if (!ctx.groups.isAdmin(sanitized, caller))
        return send({
            type: "err",
            code: "not_admin",
            ...(msg.req_id ? { req_id: msg.req_id } : {}),
        });
    const groupData = ctx.groups.load(sanitized);
    if (groupData) {
        for (const memberName of Object.keys(groupData.members)) {
            if (memberName === caller) continue;
            ctx.sendTo(memberName, {
                type: "incoming_group_msg",
                group: sanitized,
                from: caller,
                text: `${caller} deleted group ${sanitized}`,
                msg_id: String(groupData.next_id),
                ts: new Date().toISOString(),
            });
        }
    }
    ctx.groups.deleteGroup(sanitized);
    send({ type: "group_ack", ...(msg.req_id ? { req_id: msg.req_id } : {}) });
}

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
