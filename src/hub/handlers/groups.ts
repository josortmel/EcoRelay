import type * as net from "node:net";
import type { z } from "zod";
import { sanitizeSessionName } from "../../identity";
import type {
    GroupCreateMsg,
    GroupDeleteMsg,
    GroupHistoryMsg,
    GroupInfoMsg,
    GroupInviteMsg,
    GroupLeaveMsg,
    GroupListMsg,
    GroupRemoveMsg,
    GroupSendMsg,
    ServerMsg,
} from "../../protocol";
import { MAX_GROUP_MEMBERS, MAX_GROUPS, type HubContext } from "./core";

type Send = (m: ServerMsg) => void;

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
