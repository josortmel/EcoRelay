import { z } from "zod";
export const PROTOCOL_VERSION = "5";

// 512 KiB body cap leaves headroom under the 1 MiB framing.MAX_LINE_LEN for JSON envelope and escapes.
export const MAX_TEXT_LEN = 512 * 1024;

export const RegisterMsg = z.object({
    type: z.literal("register"),
    name: z.string().max(64),
    cwd: z.string().max(1024),
    git_branch: z.string().max(256),
    protocol_version: z.string(),
});

export const RenameMsg = z.object({
    type: z.literal("rename"),
    new_name: z.string(),
    req_id: z.string().optional(),
});

export const ListPeersMsg = z.object({
    type: z.literal("list_peers"),
    req_id: z.string().optional(),
});

export const ReplyMsg = z.object({
    type: z.literal("reply"),
    ask_id: z.string(),
    text: z.string().max(MAX_TEXT_LEN),
});

export const BroadcastMsg = z.object({
    type: z.literal("broadcast"),
    question: z.string().max(MAX_TEXT_LEN),
    broadcast_id: z.string(),
    exclude_self: z.boolean().optional(),
});

export const PongMsg = z.object({
    type: z.literal("pong"),
    req_id: z.string(),
});

export const JoinRoomMsg = z.object({
    type: z.literal("join_room"),
    room: z.string(),
    req_id: z.string().optional(),
});

export const LeaveRoomMsg = z.object({
    type: z.literal("leave_room"),
    room: z.string(),
    req_id: z.string().optional(),
});

export const RoomMsgMsg = z.object({
    type: z.literal("room_msg"),
    room: z.string(),
    text: z.string().max(MAX_TEXT_LEN),
    msg_id: z.string(),
    req_id: z.string().optional(),
});

export const ListRoomsMsg = z.object({
    type: z.literal("list_rooms"),
    req_id: z.string().optional(),
});

export const GroupCreateMsg = z.object({
    type: z.literal("group_create"),
    name: z.string().min(1).max(64),
    members: z.array(z.string()).max(20),
    req_id: z.string().optional(),
});
export const GroupInviteMsg = z.object({
    type: z.literal("group_invite"),
    group: z.string().min(1).max(64),
    peer: z.string(),
    req_id: z.string().optional(),
});
export const GroupRemoveMsg = z.object({
    type: z.literal("group_remove"),
    group: z.string().min(1).max(64),
    peer: z.string(),
    reason: z.string().min(1).max(256),
    req_id: z.string().optional(),
});
export const GroupLeaveMsg = z.object({
    type: z.literal("group_leave"),
    group: z.string().min(1).max(64),
    req_id: z.string().optional(),
});
export const GroupSendMsg = z.object({
    type: z.literal("group_send"),
    group: z.string().min(1).max(64),
    text: z.string().max(MAX_TEXT_LEN),
    req_id: z.string().optional(),
});
export const GroupHistoryMsg = z.object({
    type: z.literal("group_history"),
    group: z.string().min(1).max(64),
    limit: z.number().min(1).max(500).optional(),
    req_id: z.string().optional(),
});
export const GroupListMsg = z.object({
    type: z.literal("group_list"),
    req_id: z.string().optional(),
});
export const GroupInfoMsg = z.object({
    type: z.literal("group_info"),
    group: z.string().min(1).max(64),
    req_id: z.string().optional(),
});
export const GroupDeleteMsg = z.object({
    type: z.literal("group_delete"),
    group: z.string().min(1).max(64),
    req_id: z.string().optional(),
});

export const SendMsg = z.object({
    type: z.literal("send"),
    to: z.string().max(64),
    text: z.string().max(MAX_TEXT_LEN),
    reply_to: z.string().max(256).optional(), // FIX 7
    req_id: z.string().max(64).optional(), // FIX 8
    urgent: z.boolean().optional(),
});

export const InboxMsg = z.object({
    type: z.literal("inbox"),
    limit: z.number().min(1).max(100).optional(),
    since_id: z.string().max(64).optional(), // FIX 8
    req_id: z.string().max(64).optional(), // FIX 8
});

export const ClientMsgSchema = z.discriminatedUnion("type", [
    RegisterMsg,
    RenameMsg,
    ListPeersMsg,
    ReplyMsg,
    BroadcastMsg,
    PongMsg,
    JoinRoomMsg,
    LeaveRoomMsg,
    RoomMsgMsg,
    ListRoomsMsg,
    GroupCreateMsg,
    GroupInviteMsg,
    GroupRemoveMsg,
    GroupLeaveMsg,
    GroupSendMsg,
    GroupHistoryMsg,
    GroupListMsg,
    GroupInfoMsg,
    GroupDeleteMsg,
    SendMsg,
    InboxMsg,
]);

export const AckMsg = z.object({
    type: z.literal("ack"),
    req_id: z.string().optional(),
});

export const ErrCodeSchema = z.enum([
    "peer_not_found",
    "peer_gone",
    "timeout",
    "name_taken",
    "not_registered",
    "already_registered",
    "unknown_ask",
    "bad_msg",
    "hub_unreachable",
    "bad_args",
    "protocol_mismatch",
    "unexpected",
    "not_member",
    "not_admin",
    "group_not_found",
    "mailbox_error",
]);

export type ErrCode = z.infer<typeof ErrCodeSchema>;

export const ErrMsg = z.object({
    type: z.literal("err"),
    code: ErrCodeSchema,
    message: z.string().optional(),
    req_id: z.string().optional(),
    ask_id: z.string().optional(),
});

export const PeerRecordSchema = z.object({
    name: z.string(),
    cwd: z.string(),
    git_branch: z.string(),
    last_seen: z.number(),
});

export const PeersMsg = z.object({
    type: z.literal("peers"),
    peers: z.array(PeerRecordSchema),
    req_id: z.string().optional(),
});

export const IncomingAskMsg = z.object({
    type: z.literal("incoming_ask"),
    from: z.string(),
    question: z.string().max(MAX_TEXT_LEN),
    ask_id: z.string(),
    broadcast_id: z.string().optional(),
    thread_id: z.string().optional(),
});

export const IncomingReplyMsg = z.object({
    type: z.literal("incoming_reply"),
    from: z.string(),
    text: z.string().max(MAX_TEXT_LEN),
    ask_id: z.string(),
    broadcast_id: z.string().optional(),
    thread_id: z.string().optional(),
});

export const BroadcastAckMsg = z.object({
    type: z.literal("broadcast_ack"),
    broadcast_id: z.string(),
    peer_count: z.number(),
});

export const PingMsg = z.object({
    type: z.literal("ping"),
    req_id: z.string(),
});

export const RoomAckMsg = z.object({
    type: z.literal("room_ack"),
    room: z.string(),
    members: z.array(z.string()),
    req_id: z.string().optional(),
});

export const RoomSendAckMsg = z.object({
    type: z.literal("room_send_ack"),
    room: z.string(),
    delivered_count: z.number(),
    req_id: z.string().optional(),
});

export const IncomingRoomMsgMsg = z.object({
    type: z.literal("incoming_room_msg"),
    room: z.string(),
    from: z.string(),
    text: z.string().max(MAX_TEXT_LEN),
    msg_id: z.string(),
});

export const RoomsListMsg = z.object({
    type: z.literal("rooms_list"),
    rooms: z.array(
        z.object({
            name: z.string(),
            members: z.array(z.string()),
        }),
    ),
    req_id: z.string().optional(),
});

export const GroupCreatedMsg = z.object({
    type: z.literal("group_created"),
    group: z.string(),
    members: z.array(z.string()),
    req_id: z.string().optional(),
});
export const GroupAckMsg = z.object({
    type: z.literal("group_ack"),
    req_id: z.string().optional(),
});
export const GroupMessageEntry = z.object({
    id: z.number(),
    from: z.string(),
    text: z.string(),
    ts: z.string(),
    type: z.enum(["message", "system"]),
});
export const GroupMessagesMsg = z.object({
    type: z.literal("group_messages"),
    group: z.string(),
    messages: z.array(GroupMessageEntry),
    unread_remaining: z.number(),
    req_id: z.string().optional(),
});
export const GroupListResultMsg = z.object({
    type: z.literal("group_list_result"),
    groups: z.array(z.object({ name: z.string(), unread_count: z.number() })),
    req_id: z.string().optional(),
});
export const GroupInfoResultMsg = z.object({
    type: z.literal("group_info_result"),
    group: z.string(),
    admin: z.string(),
    members: z.array(
        z.object({ name: z.string(), last_read: z.number().optional(), online: z.boolean() }),
    ),
    unread_count: z.number(),
    req_id: z.string().optional(),
});
export const IncomingGroupMsgMsg = z.object({
    type: z.literal("incoming_group_msg"),
    group: z.string(),
    from: z.string(),
    text: z.string(),
    msg_id: z.string(),
    ts: z.string(),
});

export const SendAckMsg = z.object({
    type: z.literal("send_ack"),
    msg_id: z.string(),
    status: z.enum(["delivered", "queued"]),
    req_id: z.string().optional(),
});

export const InboxResultMsg = z.object({
    type: z.literal("inbox_result"),
    messages: z.array(
        z.object({
            msg_id: z.string(),
            from: z.string(),
            text: z.string(),
            reply_to: z.string().max(256).nullable(), // FIX 7
            ts: z.string(),
            urgent: z.boolean().optional(),
        }),
    ),
    remaining: z.number(),
    req_id: z.string().optional(),
});

export const IncomingMessageMsg = z.object({
    type: z.literal("incoming_message"),
    msg_id: z.string(),
    from: z.string(),
    text: z.string().max(MAX_TEXT_LEN),
    reply_to: z.string().max(256).nullable(), // FIX 7
    ts: z.string(),
    urgent: z.boolean().optional(),
});

// --- Bridge (hub-to-hub) messages ---

export const BridgeHelloMsg = z.object({
    type: z.literal("bridge_hello"),
    hub_id: z.string().min(1).max(64),
    secret: z.string(),
    protocol_version: z.string(),
    peers: z.array(PeerRecordSchema).max(500),
});

export const BridgeWelcomeMsg = z.object({
    type: z.literal("bridge_welcome"),
    hub_id: z.string().min(1).max(64),
    peers: z.array(PeerRecordSchema).max(500),
});

export const BridgePeerUpdateMsg = z.object({
    type: z.literal("bridge_peer_update"),
    action: z.enum(["join", "leave"]),
    peer: PeerRecordSchema.optional(),
    name: z.string().optional(),
});

export const BridgeForwardMsg = z.object({
    type: z.literal("bridge_forward"),
    target_peer: z.string(),
    origin_hub: z.string(),
    wrapped: z.record(z.unknown()),
});

export const BridgeMsgSchema = z.discriminatedUnion("type", [
    BridgeHelloMsg,
    BridgeWelcomeMsg,
    BridgePeerUpdateMsg,
    BridgeForwardMsg,
]);

export type BridgeMsg = z.infer<typeof BridgeMsgSchema>;

export const ServerMsgSchema = z.discriminatedUnion("type", [
    AckMsg,
    ErrMsg,
    PeersMsg,
    IncomingAskMsg,
    IncomingReplyMsg,
    BroadcastAckMsg,
    PingMsg,
    RoomAckMsg,
    RoomSendAckMsg,
    IncomingRoomMsgMsg,
    RoomsListMsg,
    GroupCreatedMsg,
    GroupAckMsg,
    GroupMessagesMsg,
    GroupListResultMsg,
    GroupInfoResultMsg,
    IncomingGroupMsgMsg,
    SendAckMsg,
    InboxResultMsg,
    IncomingMessageMsg,
]);

export type ClientMsg = z.infer<typeof ClientMsgSchema>;
export type ServerMsg = z.infer<typeof ServerMsgSchema>;
export type PeerRecord = z.infer<typeof PeerRecordSchema>;
