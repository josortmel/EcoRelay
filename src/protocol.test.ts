import { describe, expect, test } from "bun:test";
import {
    AckMsg,
    BroadcastMsg,
    ClientMsgSchema,
    ErrCodeSchema,
    ErrMsg,
    InboxMsg,
    InboxResultMsg,
    IncomingAskMsg,
    IncomingMessageMsg,
    IncomingReplyMsg,
    IncomingRoomMsgMsg,
    JoinRoomMsg,
    LeaveRoomMsg,
    ListPeersMsg,
    ListRoomsMsg,
    PeersMsg,
    PingMsg,
    PongMsg,
    PROTOCOL_VERSION,
    RegisterMsg,
    RenameMsg,
    ReplyMsg,
    RoomAckMsg,
    RoomMsgMsg,
    RoomSendAckMsg,
    RoomsListMsg,
    SendAckMsg,
    SendMsg,
    ServerMsgSchema,
} from "./protocol";

describe("protocol client messages", () => {
    test("register round-trips", () => {
        const m = {
            type: "register" as const,
            name: "alice",
            cwd: "/tmp",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        };
        expect(RegisterMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.parse(m)).toEqual(m);
    });

    test("register rejects payload without protocol_version", () => {
        expect(() =>
            RegisterMsg.parse({
                type: "register",
                name: "alice",
                cwd: "/tmp",
                git_branch: "main",
            }),
        ).toThrow();
    });

    test("PROTOCOL_VERSION is defined as a string", () => {
        expect(typeof PROTOCOL_VERSION).toBe("string");
        expect(PROTOCOL_VERSION.length).toBeGreaterThan(0);
    });

    test("PROTOCOL_VERSION is '5'", () => {
        expect(PROTOCOL_VERSION).toBe("5");
    });

    test("ErrCodeSchema accepts protocol_mismatch", () => {
        expect(ErrCodeSchema.parse("protocol_mismatch")).toBe("protocol_mismatch");
    });

    test("rename round-trips", () => {
        const m = { type: "rename" as const, new_name: "bob" };
        expect(RenameMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.parse(m)).toEqual(m);
    });

    test("rename accepts optional req_id", () => {
        const m = { type: "rename" as const, new_name: "bob", req_id: "r1" };
        expect(RenameMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.parse(m)).toEqual(m);
    });

    test("list_peers round-trips", () => {
        const m = { type: "list_peers" as const };
        expect(ListPeersMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.parse(m)).toEqual(m);
    });

    test("list_peers accepts optional req_id", () => {
        const m = { type: "list_peers" as const, req_id: "r7" };
        expect(ListPeersMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.parse(m)).toEqual(m);
    });

    test("reply round-trips", () => {
        const m = { type: "reply" as const, ask_id: "a1", text: "yes" };
        expect(ReplyMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.parse(m)).toEqual(m);
    });

    test("broadcast round-trips (with and without exclude_self)", () => {
        const m1 = { type: "broadcast" as const, question: "?", broadcast_id: "b1" };
        expect(BroadcastMsg.parse(m1)).toEqual(m1);
        const m2 = {
            type: "broadcast" as const,
            question: "?",
            broadcast_id: "b1",
            exclude_self: true,
        };
        expect(BroadcastMsg.parse(m2)).toEqual(m2);
    });

    test("rejects malformed register", () => {
        expect(() => ClientMsgSchema.parse({ type: "register", name: "x" })).toThrow();
        expect(() =>
            ClientMsgSchema.parse({ type: "register", name: 1, cwd: "/", git_branch: "m" }),
        ).toThrow();
    });

    test("rejects unknown type", () => {
        expect(() => ClientMsgSchema.parse({ type: "nope" })).toThrow();
    });

    test("pong round-trips and is in ClientMsgSchema", () => {
        const m = { type: "pong" as const, req_id: "p1" };
        expect(PongMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.parse(m)).toEqual(m);
    });

    test("pong rejects payload without req_id", () => {
        expect(() => PongMsg.parse({ type: "pong" })).toThrow();
    });

    test("join_room round-trips with optional req_id", () => {
        const m1 = { type: "join_room" as const, room: "diseno" };
        expect(JoinRoomMsg.parse(m1)).toEqual(m1);
        expect(ClientMsgSchema.parse(m1)).toEqual(m1);
        const m2 = { type: "join_room" as const, room: "diseno", req_id: "r1" };
        expect(JoinRoomMsg.parse(m2)).toEqual(m2);
        expect(ClientMsgSchema.parse(m2)).toEqual(m2);
    });

    test("leave_room round-trips with optional req_id", () => {
        const m = { type: "leave_room" as const, room: "diseno", req_id: "r2" };
        expect(LeaveRoomMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.parse(m)).toEqual(m);
    });

    test("room_msg round-trips with msg_id and optional req_id", () => {
        const m1 = {
            type: "room_msg" as const,
            room: "diseno",
            text: "hola",
            msg_id: "m1",
        };
        expect(RoomMsgMsg.parse(m1)).toEqual(m1);
        expect(ClientMsgSchema.parse(m1)).toEqual(m1);
        const m2 = { ...m1, req_id: "r3" };
        expect(RoomMsgMsg.parse(m2)).toEqual(m2);
    });

    test("list_rooms round-trips with optional req_id", () => {
        const m = { type: "list_rooms" as const };
        expect(ListRoomsMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.parse(m)).toEqual(m);
        const m2 = { type: "list_rooms" as const, req_id: "r4" };
        expect(ListRoomsMsg.parse(m2)).toEqual(m2);
    });

    test("ReplyMsg.text accepts 100 KB and rejects 600 KB", () => {
        const small = "x".repeat(100 * 1024);
        const big = "x".repeat(600 * 1024);
        expect(ReplyMsg.parse({ type: "reply", ask_id: "a1", text: small }).text.length).toBe(
            small.length,
        );
        expect(() => ReplyMsg.parse({ type: "reply", ask_id: "a1", text: big })).toThrow();
    });

    test("BroadcastMsg.question accepts 100 KB and rejects 600 KB", () => {
        const small = "q".repeat(100 * 1024);
        const big = "q".repeat(600 * 1024);
        expect(
            BroadcastMsg.parse({ type: "broadcast", question: small, broadcast_id: "b1" }).question
                .length,
        ).toBe(small.length);
        expect(() =>
            BroadcastMsg.parse({ type: "broadcast", question: big, broadcast_id: "b1" }),
        ).toThrow();
    });

    test("RoomMsgMsg.text accepts 100 KB and rejects 600 KB", () => {
        const small = "r".repeat(100 * 1024);
        const big = "r".repeat(600 * 1024);
        expect(
            RoomMsgMsg.parse({ type: "room_msg", room: "x", text: small, msg_id: "m1" }).text
                .length,
        ).toBe(small.length);
        expect(() =>
            RoomMsgMsg.parse({ type: "room_msg", room: "x", text: big, msg_id: "m1" }),
        ).toThrow();
    });
});

describe("protocol server messages", () => {
    test("ack round-trips", () => {
        expect(AckMsg.parse({ type: "ack" })).toEqual({ type: "ack" });
        expect(AckMsg.parse({ type: "ack", req_id: "r1" })).toEqual({ type: "ack", req_id: "r1" });
    });

    test("err round-trips", () => {
        const m = { type: "err" as const, code: "bad_msg" as const, message: "x", req_id: "r1" };
        expect(ErrMsg.parse(m)).toEqual(m);
        expect(ServerMsgSchema.parse({ type: "err", code: "bad_msg" })).toBeTruthy();
    });

    test("peers round-trips", () => {
        const m = {
            type: "peers" as const,
            peers: [{ name: "a", cwd: "/", git_branch: "m", last_seen: 1 }],
        };
        expect(PeersMsg.parse(m)).toEqual(m);
        expect(ServerMsgSchema.parse(m)).toEqual(m);
    });

    test("incoming_ask round-trips", () => {
        const m = { type: "incoming_ask" as const, from: "a", question: "?", ask_id: "a1" };
        expect(IncomingAskMsg.parse(m)).toEqual(m);
    });

    test("IncomingAskMsg.question rejects 600 KB", () => {
        const big = "a".repeat(600 * 1024);
        expect(() =>
            IncomingAskMsg.parse({ type: "incoming_ask", from: "a", question: big, ask_id: "a1" }),
        ).toThrow();
    });

    test("IncomingReplyMsg.text rejects 600 KB", () => {
        const big = "x".repeat(600 * 1024);
        expect(() =>
            IncomingReplyMsg.parse({ type: "incoming_reply", from: "a", text: big, ask_id: "a1" }),
        ).toThrow();
    });

    test("IncomingRoomMsgMsg.text rejects 600 KB", () => {
        const big = "r".repeat(600 * 1024);
        expect(() =>
            IncomingRoomMsgMsg.parse({
                type: "incoming_room_msg",
                room: "x",
                from: "a",
                text: big,
                msg_id: "m1",
            }),
        ).toThrow();
    });

    test("incoming_reply round-trips", () => {
        const m = {
            type: "incoming_reply" as const,
            from: "a",
            text: "x",
            ask_id: "a1",
            broadcast_id: "b1",
        };
        expect(IncomingReplyMsg.parse(m)).toEqual(m);
    });

    test("ping round-trips and is in ServerMsgSchema", () => {
        const m = { type: "ping" as const, req_id: "p1" };
        expect(PingMsg.parse(m)).toEqual(m);
        expect(ServerMsgSchema.parse(m)).toEqual(m);
    });

    test("ping rejects payload without req_id", () => {
        expect(() => PingMsg.parse({ type: "ping" })).toThrow();
    });

    test("room_ack round-trips with members", () => {
        const m = {
            type: "room_ack" as const,
            room: "diseno",
            members: ["alice", "bob"],
        };
        expect(RoomAckMsg.parse(m)).toEqual(m);
        expect(ServerMsgSchema.parse(m)).toEqual(m);
        const m2 = { ...m, req_id: "r1" };
        expect(RoomAckMsg.parse(m2)).toEqual(m2);
    });

    test("room_send_ack round-trips with delivered_count", () => {
        const m = {
            type: "room_send_ack" as const,
            room: "diseno",
            delivered_count: 3,
        };
        expect(RoomSendAckMsg.parse(m)).toEqual(m);
        expect(ServerMsgSchema.parse(m)).toEqual(m);
    });

    test("incoming_room_msg round-trips with from/text/msg_id", () => {
        const m = {
            type: "incoming_room_msg" as const,
            room: "diseno",
            from: "alice",
            text: "hola",
            msg_id: "m1",
        };
        expect(IncomingRoomMsgMsg.parse(m)).toEqual(m);
        expect(ServerMsgSchema.parse(m)).toEqual(m);
    });

    test("rooms_list round-trips with rooms array", () => {
        const m = {
            type: "rooms_list" as const,
            rooms: [
                { name: "a", members: ["x"] },
                { name: "b", members: ["y", "z"] },
            ],
        };
        expect(RoomsListMsg.parse(m)).toEqual(m);
        expect(ServerMsgSchema.parse(m)).toEqual(m);
    });

    test("room_ack and room_send_ack are distinct types in ServerMsgSchema (no collision)", () => {
        const ack = { type: "room_ack" as const, room: "x", members: ["a"] };
        const sendAck = { type: "room_send_ack" as const, room: "x", delivered_count: 1 };
        const parsedAck = ServerMsgSchema.parse(ack);
        const parsedSendAck = ServerMsgSchema.parse(sendAck);
        expect(parsedAck.type).toBe("room_ack");
        expect(parsedSendAck.type).toBe("room_send_ack");
    });

    test("ErrCodeSchema accepts mailbox_error", () => {
        expect(ErrCodeSchema.parse("mailbox_error")).toBe("mailbox_error");
    });

    test("incoming_ask/incoming_reply accept optional thread_id; reply does not carry one", () => {
        const reply = { type: "reply" as const, ask_id: "a1", text: "y" };
        expect(ReplyMsg.parse(reply)).toEqual(reply);
        const replyWithZombie = { ...reply, thread_id: "t1" };
        expect(ReplyMsg.parse(replyWithZombie)).toEqual(reply);

        const incomingAsk = {
            type: "incoming_ask" as const,
            from: "a",
            question: "?",
            ask_id: "a1",
            thread_id: "t1",
        };
        expect(IncomingAskMsg.parse(incomingAsk)).toEqual(incomingAsk);

        const incomingReply = {
            type: "incoming_reply" as const,
            from: "a",
            text: "x",
            ask_id: "a1",
            thread_id: "t1",
        };
        expect(IncomingReplyMsg.parse(incomingReply)).toEqual(incomingReply);
    });
});

describe("mailbox protocol messages", () => {
    test("ClientMsgSchema accepts valid send message", () => {
        const m = { type: "send" as const, to: "alice", text: "hello" };
        expect(SendMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.safeParse(m).success).toBe(true);
    });

    test("ClientMsgSchema accepts valid inbox message", () => {
        const m = { type: "inbox" as const };
        expect(InboxMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.safeParse(m).success).toBe(true);
        const m2 = { type: "inbox" as const, limit: 10, since_id: "m-123-abc", req_id: "r1" };
        expect(ClientMsgSchema.safeParse(m2).success).toBe(true);
    });

    test("ServerMsgSchema accepts valid send_ack", () => {
        const m = { type: "send_ack" as const, msg_id: "m-1-abcd", status: "delivered" as const };
        expect(SendAckMsg.parse(m)).toEqual(m);
        expect(ServerMsgSchema.safeParse(m).success).toBe(true);
    });

    test("ServerMsgSchema accepts valid inbox_result", () => {
        const m = {
            type: "inbox_result" as const,
            messages: [
                {
                    msg_id: "m-1-abcd",
                    from: "bob",
                    text: "hi",
                    reply_to: null,
                    ts: "2026-01-01T00:00:00.000Z",
                },
            ],
            remaining: 0,
        };
        expect(InboxResultMsg.parse(m)).toEqual(m);
        expect(ServerMsgSchema.safeParse(m).success).toBe(true);
    });

    test("ServerMsgSchema accepts valid incoming_message", () => {
        const m = {
            type: "incoming_message" as const,
            msg_id: "m-1-abcd",
            from: "carol",
            text: "hey",
            reply_to: null,
            ts: "2026-01-01T00:00:00.000Z",
        };
        expect(IncomingMessageMsg.parse(m)).toEqual(m);
        expect(ServerMsgSchema.safeParse(m).success).toBe(true);
    });

    test("SendMsg accepts urgent=true", () => {
        const m = { type: "send" as const, to: "bob", text: "hi", urgent: true };
        expect(SendMsg.parse(m)).toEqual(m);
        expect(ClientMsgSchema.safeParse(m).success).toBe(true);
    });

    test("IncomingMessageMsg accepts urgent=true", () => {
        const m = {
            type: "incoming_message" as const,
            msg_id: "m-u1",
            from: "alice",
            text: "NOW",
            reply_to: null,
            ts: "2026-01-01T00:00:00.000Z",
            urgent: true,
        };
        expect(IncomingMessageMsg.parse(m)).toEqual(m);
        expect(ServerMsgSchema.safeParse(m).success).toBe(true);
    });

    test("InboxResultMsg accepts urgent=true on a message entry", () => {
        const m = {
            type: "inbox_result" as const,
            messages: [
                {
                    msg_id: "m-u2",
                    from: "bob",
                    text: "urgent!",
                    reply_to: null,
                    ts: "2026-01-01T00:00:00.000Z",
                    urgent: true,
                },
            ],
            remaining: 0,
        };
        expect(InboxResultMsg.parse(m)).toEqual(m);
        expect(ServerMsgSchema.safeParse(m).success).toBe(true);
    });
});
