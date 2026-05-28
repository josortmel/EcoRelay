import type * as net from "node:net";
import type { z } from "zod";
import { sanitizeSessionName } from "../../identity";
import { makeLogger } from "../../logger";
import type {
    JoinRoomMsg,
    LeaveRoomMsg,
    ListRoomsMsg,
    RoomMsgMsg,
    ServerMsg,
} from "../../protocol";
import { MAX_MEMBERS_PER_ROOM, MAX_ROOMS, type HubContext } from "./core";

const log = makeLogger("hub");

type Send = (m: ServerMsg) => void;

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
