import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PROTOCOL_VERSION } from "../protocol";
import { handleSend, type HubContext } from "./handlers";
import { startHub } from "./index";
import { createMailboxStore } from "./mailbox";
import type { PeerRegistry } from "./registry";
import { rawConnect, tmpSocket } from "./test-helpers";

describe("hub handlers", () => {
    let sockPath: string;
    let hub: { close: () => Promise<void> };

    beforeEach(async () => {
        sockPath = tmpSocket();
        hub = await startHub({ socketPath: sockPath });
    });

    afterEach(async () => {
        await hub.close();
    });

    test("register with mismatched protocol_version returns err protocol_mismatch", async () => {
        const c = await rawConnect(sockPath);
        c.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: "999-bogus",
        });
        const reply = await c.next();
        expect(reply.type).toBe("err");
        if (reply.type === "err") expect(reply.code).toBe("protocol_mismatch");
        c.close();
    });

    test("register with mismatched protocol_version does not add peer to registry", async () => {
        const a = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: "nope",
        });
        const err = await a.next();
        expect(err.type).toBe("err");

        // Another peer registers with correct version; should not see alice.
        const b = await rawConnect(sockPath);
        b.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "dev",
            protocol_version: PROTOCOL_VERSION,
        });
        await b.next();
        b.send({ type: "list_peers" });
        const peers = await b.next();
        expect(peers.type).toBe("peers");
        if (peers.type === "peers") {
            const names = peers.peers.map((p) => p.name);
            expect(names).not.toContain("alice");
        }
        a.close();
        b.close();
    });

    test("malformed JSON returns err bad_msg", async () => {
        const c = await rawConnect(sockPath);
        c.socket.write("not json\n");
        const reply = await c.next();
        expect(reply.type).toBe("err");
        if (reply.type === "err") expect(reply.code).toBe("bad_msg");
        c.close();
    });

    test("schema-invalid message returns err bad_msg", async () => {
        const c = await rawConnect(sockPath);
        c.send({ type: "register", name: "only-name" });
        const reply = await c.next();
        expect(reply.type).toBe("err");
        if (reply.type === "err") expect(reply.code).toBe("bad_msg");
        c.close();
    });

    test("broadcast before register errs not_registered", async () => {
        const a = await rawConnect(sockPath);
        a.send({ type: "broadcast", question: "hi?", broadcast_id: "b1" });
        const reply = await a.next();
        expect(reply.type).toBe("err");
        if (reply.type === "err") expect(reply.code).toBe("not_registered");
        a.close();
    });

    test("broadcast fans out incoming_ask to other peers with broadcast_id and replies route back", async () => {
        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        const c = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        b.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "dev",
            protocol_version: PROTOCOL_VERSION,
        });
        await b.next();
        c.send({
            type: "register",
            name: "carol",
            cwd: "/tmp/c",
            git_branch: "x",
            protocol_version: PROTOCOL_VERSION,
        });
        await c.next();

        a.send({ type: "broadcast", question: "ping?", broadcast_id: "bid1" });

        const ack = await a.next();
        expect(ack.type).toBe("broadcast_ack");
        if (ack.type === "broadcast_ack") {
            expect(ack.broadcast_id).toBe("bid1");
            expect(ack.peer_count).toBe(2);
        }

        const bIncoming = await b.next();
        const cIncoming = await c.next();
        expect(bIncoming.type).toBe("incoming_ask");
        expect(cIncoming.type).toBe("incoming_ask");
        if (bIncoming.type === "incoming_ask") {
            expect(bIncoming.from).toBe("alice");
            expect(bIncoming.question).toBe("ping?");
            expect(bIncoming.broadcast_id).toBe("bid1");
        }
        if (cIncoming.type === "incoming_ask") {
            expect(cIncoming.broadcast_id).toBe("bid1");
        }

        const bAskId = bIncoming.type === "incoming_ask" ? bIncoming.ask_id : "";
        const cAskId = cIncoming.type === "incoming_ask" ? cIncoming.ask_id : "";
        expect(bAskId).not.toBe(cAskId);

        b.send({ type: "reply", ask_id: bAskId, text: "from-bob" });
        c.send({ type: "reply", ask_id: cAskId, text: "from-carol" });

        const r1 = await a.next();
        const r2 = await a.next();
        const replies = [r1, r2];
        for (const r of replies) {
            expect(r.type).toBe("incoming_reply");
            if (r.type === "incoming_reply") {
                expect(r.broadcast_id).toBe("bid1");
            }
        }
        const texts = replies.map((r) => (r.type === "incoming_reply" ? r.text : "")).sort();
        expect(texts).toEqual(["from-bob", "from-carol"]);

        a.close();
        b.close();
        c.close();
    });

    test("broadcast with exclude_self=false includes the sender", async () => {
        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        b.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "dev",
            protocol_version: PROTOCOL_VERSION,
        });
        await b.next();

        a.send({
            type: "broadcast",
            question: "q?",
            broadcast_id: "bid2",
            exclude_self: false,
        });

        // alice will receive either the ack first or her own incoming_ask first; read 2 msgs
        const m1 = await a.next();
        const m2 = await a.next();
        const types = [m1.type, m2.type].sort();
        expect(types).toEqual(["broadcast_ack", "incoming_ask"]);
        const ack = m1.type === "broadcast_ack" ? m1 : m2;
        if (ack.type === "broadcast_ack") {
            expect(ack.peer_count).toBe(2);
            expect(ack.broadcast_id).toBe("bid2");
        }

        const bIncoming = await b.next();
        expect(bIncoming.type).toBe("incoming_ask");

        a.close();
        b.close();
    });

    test("ask to unknown peer returns err peer_not_found", async () => {
        const a = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        a.send({ type: "ask", to: "ghost", question: "?", ask_id: "a1" });
        const reply = await a.next();
        expect(reply.type).toBe("err");
        if (reply.type === "err") expect(reply.code).toBe("peer_not_found");
        a.close();
    });

    test("reply from non-target peer is rejected and does not poison the pending ask", async () => {
        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        const c = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        b.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "dev",
            protocol_version: PROTOCOL_VERSION,
        });
        await b.next();
        c.send({
            type: "register",
            name: "carol",
            cwd: "/tmp/c",
            git_branch: "x",
            protocol_version: PROTOCOL_VERSION,
        });
        await c.next();

        a.send({ type: "ask", to: "bob", question: "hi?", ask_id: "a1" });
        await b.next(); // incoming_ask on b

        // Carol spoofs a reply using bob's ask_id.
        c.send({ type: "reply", ask_id: "a1", text: "from-carol" });
        const cErr = await c.next();
        expect(cErr.type).toBe("err");
        if (cErr.type === "err") {
            expect(cErr.code).toBe("unknown_ask");
        }

        // Give the hub a tick to process any (incorrect) outbound routing.
        await new Promise((r) => setTimeout(r, 20));

        // Legitimate target bob replies. Alice's first inbound message must be bob's,
        // not carol's — if carol's spoof had poisoned the pending ask, alice would
        // have received carol's text instead.
        b.send({ type: "reply", ask_id: "a1", text: "from-bob" });
        const aReply = await a.next();
        expect(aReply.type).toBe("incoming_reply");
        if (aReply.type === "incoming_reply") {
            expect(aReply.from).toBe("bob");
            expect(aReply.text).toBe("from-bob");
            expect(aReply.ask_id).toBe("a1");
        }

        a.close();
        b.close();
        c.close();
    });

    test("sendTo to a destroyed socket does not crash hub", async () => {
        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        b.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "dev",
            protocol_version: PROTOCOL_VERSION,
        });
        await b.next();

        // Forcibly destroy b's socket without sending a close frame.
        b.socket.destroy();
        // Give hub a moment to notice close, or not.
        await new Promise((r) => setTimeout(r, 20));

        // Send an ask that may race with the close event; hub must not throw.
        a.send({ type: "ask", to: "bob", question: "hi?", ask_id: "x1" });
        // Either peer_gone (if close seen) or peer_not_found works; must get something and hub stays up.
        const reply = await a.next();
        expect(["err"].includes(reply.type)).toBe(true);

        // Hub still responsive
        a.send({ type: "list_peers" });
        const peers = await a.next();
        expect(peers.type).toBe("peers");
        a.close();
    });

    test("ask carries thread_id through to incoming_ask and reply echoes it on incoming_reply", async () => {
        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        b.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "dev",
            protocol_version: PROTOCOL_VERSION,
        });
        await b.next();

        a.send({
            type: "ask",
            to: "bob",
            question: "hi?",
            ask_id: "a1",
            thread_id: "thread-xyz",
        });
        const incoming = await b.next();
        expect(incoming.type).toBe("incoming_ask");
        if (incoming.type === "incoming_ask") {
            expect(incoming.thread_id).toBe("thread-xyz");
        }

        // Reply without explicitly supplying thread_id — hub pulls it from pending entry.
        b.send({ type: "reply", ask_id: "a1", text: "yo" });
        const reply = await a.next();
        expect(reply.type).toBe("incoming_reply");
        if (reply.type === "incoming_reply") {
            expect(reply.thread_id).toBe("thread-xyz");
        }
        a.close();
        b.close();
    });

    test("ask without thread_id auto-generates one on incoming_ask", async () => {
        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        b.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "dev",
            protocol_version: PROTOCOL_VERSION,
        });
        await b.next();

        a.send({ type: "ask", to: "bob", question: "hi?", ask_id: "a1" });
        const incoming = await b.next();
        expect(incoming.type).toBe("incoming_ask");
        if (incoming.type === "incoming_ask") {
            expect(typeof incoming.thread_id).toBe("string");
            expect(incoming.thread_id!.length).toBeGreaterThan(0);
        }
        a.close();
        b.close();
    });

    test("broadcast shares a single thread_id across per-recipient asks and replies", async () => {
        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        const c = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        b.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "dev",
            protocol_version: PROTOCOL_VERSION,
        });
        await b.next();
        c.send({
            type: "register",
            name: "carol",
            cwd: "/tmp/c",
            git_branch: "x",
            protocol_version: PROTOCOL_VERSION,
        });
        await c.next();

        a.send({ type: "broadcast", question: "ping?", broadcast_id: "bid-thread" });
        await a.next(); // broadcast_ack

        const bIncoming = await b.next();
        const cIncoming = await c.next();
        if (bIncoming.type === "incoming_ask" && cIncoming.type === "incoming_ask") {
            // Broadcasts reuse broadcast_id verbatim as the thread_id.
            expect(bIncoming.thread_id).toBe("bid-thread");
            expect(cIncoming.thread_id).toBe("bid-thread");
        }

        const bAskId = bIncoming.type === "incoming_ask" ? bIncoming.ask_id : "";
        b.send({ type: "reply", ask_id: bAskId, text: "from-bob" });
        const bReply = await a.next();
        expect(bReply.type).toBe("incoming_reply");
        if (bReply.type === "incoming_reply") {
            expect(bReply.thread_id).toBe("bid-thread");
        }

        a.close();
        b.close();
        c.close();
    });

    test("join_room without registering errs not_registered", async () => {
        const a = await rawConnect(sockPath);
        a.send({ type: "join_room", room: "x" });
        const reply = await a.next();
        expect(reply.type).toBe("err");
        if (reply.type === "err") expect(reply.code).toBe("not_registered");
        a.close();
    });

    test("join_room with invalid room name returns bad_args", async () => {
        const a = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        a.send({ type: "join_room", room: "bad room with spaces" });
        const reply = await a.next();
        expect(reply.type).toBe("err");
        if (reply.type === "err") {
            expect(reply.code).toBe("bad_args");
            expect(reply.message).toContain("invalid room name");
        }
        a.close();
    });

    test("join_room creates room and returns members in room_ack", async () => {
        const a = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        a.send({ type: "join_room", room: "diseno" });
        const reply = await a.next();
        expect(reply.type).toBe("room_ack");
        if (reply.type === "room_ack") {
            expect(reply.room).toBe("diseno");
            expect(reply.members).toEqual(["alice"]);
        }
        a.close();
    });

    test("two peers join same room and the second sees both", async () => {
        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        b.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        await b.next();
        a.send({ type: "join_room", room: "team" });
        await a.next();
        b.send({ type: "join_room", room: "team" });
        const r = await b.next();
        expect(r.type).toBe("room_ack");
        if (r.type === "room_ack") {
            expect(r.members.sort()).toEqual(["alice", "bob"]);
        }
        a.close();
        b.close();
    });

    test("leave_room is idempotent (ack even if room does not exist)", async () => {
        const a = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        a.send({ type: "leave_room", room: "ghost-room" });
        const r = await a.next();
        expect(r.type).toBe("ack");
        a.close();
    });

    test("room_msg fans out to members excluding sender; room_send_ack carries delivered_count", async () => {
        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        const c = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        b.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        await b.next();
        c.send({
            type: "register",
            name: "carol",
            cwd: "/tmp/c",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        await c.next();
        for (const peer of [a, b, c]) {
            peer.send({ type: "join_room", room: "team" });
            await peer.next();
        }
        a.send({ type: "room_msg", room: "team", text: "hi all", msg_id: "m1" });
        const ack = await a.next();
        expect(ack.type).toBe("room_send_ack");
        if (ack.type === "room_send_ack") {
            expect(ack.delivered_count).toBe(2);
            expect(ack.room).toBe("team");
        }
        const bIncoming = await b.next();
        const cIncoming = await c.next();
        expect(bIncoming.type).toBe("incoming_room_msg");
        expect(cIncoming.type).toBe("incoming_room_msg");
        if (bIncoming.type === "incoming_room_msg") {
            expect(bIncoming.from).toBe("alice");
            expect(bIncoming.text).toBe("hi all");
            expect(bIncoming.msg_id).toBe("m1");
            expect(bIncoming.room).toBe("team");
        }
        a.close();
        b.close();
        c.close();
    });

    test("room_msg with sender NOT a member still delivers (open walkie-talkie)", async () => {
        const sender = await rawConnect(sockPath);
        const member = await rawConnect(sockPath);
        sender.send({
            type: "register",
            name: "outsider",
            cwd: "/tmp/o",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        await sender.next();
        member.send({
            type: "register",
            name: "insider",
            cwd: "/tmp/i",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        await member.next();
        member.send({ type: "join_room", room: "club" });
        await member.next();
        sender.send({ type: "room_msg", room: "club", text: "ping", msg_id: "m9" });
        const ack = await sender.next();
        expect(ack.type).toBe("room_send_ack");
        if (ack.type === "room_send_ack") expect(ack.delivered_count).toBe(1);
        const incoming = await member.next();
        expect(incoming.type).toBe("incoming_room_msg");
        if (incoming.type === "incoming_room_msg") {
            expect(incoming.from).toBe("outsider");
        }
        sender.close();
        member.close();
    });

    test("list_rooms returns active rooms with members", async () => {
        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        b.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        await b.next();
        a.send({ type: "join_room", room: "diseno" });
        await a.next();
        a.send({ type: "join_room", room: "code" });
        await a.next();
        b.send({ type: "join_room", room: "diseno" });
        await b.next();
        b.send({ type: "list_rooms" });
        const r = await b.next();
        expect(r.type).toBe("rooms_list");
        if (r.type === "rooms_list") {
            const sorted = r.rooms.slice().sort((x, y) => x.name.localeCompare(y.name));
            expect(sorted).toHaveLength(2);
            expect(sorted[0]!.name).toBe("code");
            expect(sorted[0]!.members).toEqual(["alice"]);
            expect(sorted[1]!.name).toBe("diseno");
            expect(sorted[1]!.members.sort()).toEqual(["alice", "bob"]);
        }
        a.close();
        b.close();
    });

    test("removeBySocket on disconnect cleans peer from rooms (room_msg delivered_count drops)", async () => {
        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        const c = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();
        b.send({
            type: "register",
            name: "bob",
            cwd: "/tmp/b",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        await b.next();
        c.send({
            type: "register",
            name: "carol",
            cwd: "/tmp/c",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        await c.next();
        for (const peer of [a, b, c]) {
            peer.send({ type: "join_room", room: "team" });
            await peer.next();
        }
        // Bob disconnects abruptly
        b.close();
        await new Promise((r) => setTimeout(r, 50));
        a.send({ type: "room_msg", room: "team", text: "ping", msg_id: "m2" });
        const ack = await a.next();
        if (ack.type === "room_send_ack") {
            expect(ack.delivered_count).toBe(1); // only carol
        }
        a.close();
        c.close();
    });

    async function reg(c: Awaited<ReturnType<typeof rawConnect>>, name: string) {
        c.send({
            type: "register",
            name,
            cwd: `/tmp/${name}`,
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await c.next();
    }

    test("send before register errs not_registered", async () => {
        const a = await rawConnect(sockPath);
        a.send({ type: "send", to: "bob", text: "hi" });
        const reply = await a.next();
        expect(reply.type).toBe("err");
        if (reply.type === "err") expect(reply.code).toBe("not_registered");
        a.close();
    });

    test("send to online target: persists + incoming_message + ack delivered", async () => {
        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        await reg(a, "alice");
        await reg(b, "bob");

        a.send({ type: "send", to: "bob", text: "hello bob" });
        const ack = await a.next();
        expect(ack.type).toBe("send_ack");
        if (ack.type === "send_ack") {
            expect(ack.status).toBe("delivered");
            expect(typeof ack.msg_id).toBe("string");
        }
        const incoming = await b.next();
        expect(incoming.type).toBe("incoming_message");
        if (incoming.type === "incoming_message") {
            expect(incoming.from).toBe("alice");
            expect(incoming.text).toBe("hello bob");
            expect(incoming.reply_to).toBeNull();
        }
        a.close();
        b.close();
    });

    test("send to offline target: persists + ack queued (no push)", async () => {
        const a = await rawConnect(sockPath);
        await reg(a, "alice");

        a.send({ type: "send", to: "ghost", text: "are you there?" });
        const ack = await a.next();
        expect(ack.type).toBe("send_ack");
        if (ack.type === "send_ack") {
            expect(ack.status).toBe("queued");
            expect(typeof ack.msg_id).toBe("string");
        }
        a.close();
    });

    test("send with reply_to: incoming_message carries reply_to", async () => {
        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        await reg(a, "alice");
        await reg(b, "bob");

        a.send({ type: "send", to: "bob", text: "first message" });
        const ack1 = await a.next();
        const firstMsgId = ack1.type === "send_ack" ? ack1.msg_id : "";
        await b.next(); // incoming_message

        b.send({ type: "send", to: "alice", text: "reply here", reply_to: firstMsgId });
        const ack2 = await b.next();
        expect(ack2.type).toBe("send_ack");
        const incoming = await a.next();
        expect(incoming.type).toBe("incoming_message");
        if (incoming.type === "incoming_message") {
            expect(incoming.reply_to).toBe(firstMsgId);
        }
        a.close();
        b.close();
    });

    test("send with bad target name errs bad_args", async () => {
        const a = await rawConnect(sockPath);
        await reg(a, "alice");

        a.send({ type: "send", to: "bad name with spaces", text: "hi" });
        const reply = await a.next();
        expect(reply.type).toBe("err");
        if (reply.type === "err") expect(reply.code).toBe("bad_args");
        a.close();
    });

    test("inbox: returns unread messages", async () => {
        const a = await rawConnect(sockPath);
        const b = await rawConnect(sockPath);
        await reg(a, "alice");
        await reg(b, "bob");

        // alice sends two messages to bob while bob is online (they go to mailbox too)
        a.send({ type: "send", to: "bob", text: "msg1" });
        await a.next(); // send_ack
        await b.next(); // incoming_message
        a.send({ type: "send", to: "bob", text: "msg2" });
        await a.next(); // send_ack
        await b.next(); // incoming_message

        // bob's last_read is null before first inbox call — but messages were already marked
        // via incoming_message delivery. Use a fresh offline peer instead.
        // Disconnect bob, reconnect as bob2 to simulate fresh session reading queued messages.
        b.close();
        await new Promise((r) => setTimeout(r, 20));

        // alice sends offline
        a.send({ type: "send", to: "carol", text: "offline1" });
        await a.next();
        a.send({ type: "send", to: "carol", text: "offline2" });
        await a.next();

        const carol = await rawConnect(sockPath);
        await reg(carol, "carol");
        carol.send({ type: "inbox" });
        const result = await carol.next();
        expect(result.type).toBe("inbox_result");
        if (result.type === "inbox_result") {
            expect(result.messages.length).toBe(2);
            expect(result.messages[0]!.text).toBe("offline1");
            expect(result.messages[1]!.text).toBe("offline2");
            expect(result.remaining).toBe(0);
        }
        a.close();
        carol.close();
    });

    test("inbox with since_id: returns only newer messages", async () => {
        const a = await rawConnect(sockPath);
        await reg(a, "alice");

        // Use a peer that receives messages while offline
        const dave = await rawConnect(sockPath);
        await reg(dave, "dave");
        dave.close();
        await new Promise((r) => setTimeout(r, 20));

        a.send({ type: "send", to: "dave", text: "first" });
        const ack1 = await a.next();
        const firstId = ack1.type === "send_ack" ? ack1.msg_id : "";
        a.send({ type: "send", to: "dave", text: "second" });
        await a.next();

        const dave2 = await rawConnect(sockPath);
        await reg(dave2, "dave");

        dave2.send({ type: "inbox", since_id: firstId });
        const result = await dave2.next();
        expect(result.type).toBe("inbox_result");
        if (result.type === "inbox_result") {
            expect(result.messages.length).toBe(1);
            expect(result.messages[0]!.text).toBe("second");
        }
        a.close();
        dave2.close();
    });

    test("inbox before register errs not_registered", async () => {
        const a = await rawConnect(sockPath);
        a.send({ type: "inbox" });
        const reply = await a.next();
        expect(reply.type).toBe("err");
        if (reply.type === "err") expect(reply.code).toBe("not_registered");
        a.close();
    });

    test("broadcast with exclude_self=false and one peer round-trips to self", async () => {
        const a = await rawConnect(sockPath);
        a.send({
            type: "register",
            name: "alice",
            cwd: "/tmp/a",
            git_branch: "main",
            protocol_version: PROTOCOL_VERSION,
        });
        await a.next();

        a.send({
            type: "broadcast",
            question: "ping-self",
            broadcast_id: "bid-self",
            exclude_self: false,
        });

        // alice receives both the ack and her own incoming_ask; order not guaranteed
        const m1 = await a.next();
        const m2 = await a.next();
        const types = [m1.type, m2.type].sort();
        expect(types).toEqual(["broadcast_ack", "incoming_ask"]);

        const ack = m1.type === "broadcast_ack" ? m1 : m2;
        const incoming = m1.type === "incoming_ask" ? m1 : m2;

        if (ack.type === "broadcast_ack") {
            expect(ack.broadcast_id).toBe("bid-self");
            expect(ack.peer_count).toBe(1);
        }

        let selfAskId = "";
        if (incoming.type === "incoming_ask") {
            expect(incoming.from).toBe("alice");
            expect(incoming.question).toBe("ping-self");
            expect(incoming.broadcast_id).toBe("bid-self");
            selfAskId = incoming.ask_id;
        }
        expect(selfAskId).not.toBe("");

        a.send({ type: "reply", ask_id: selfAskId, text: "self-reply" });

        const reply = await a.next();
        expect(reply.type).toBe("incoming_reply");
        if (reply.type === "incoming_reply") {
            expect(reply.from).toBe("alice");
            expect(reply.text).toBe("self-reply");
            expect(reply.ask_id).toBe(selfAskId);
            expect(reply.broadcast_id).toBe("bid-self");
        }

        a.close();
    });
});

// ─── Verifier unit tests ───────────────────────────────────────────────────────

describe("handleSend unit — Verifier", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-handler-unit-"));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // [VT5] handleSend: peer is online but sendTo returns false → status must be "queued"
    test("[VT5] handleSend with online peer but failed sendTo → status queued not delivered", () => {
        const mailboxes = createMailboxStore(dir);
        let sentResult: Record<string, unknown> | null = null;

        const ctx: HubContext = {
            registry: {
                getName: (_socket: net.Socket) => "alice",
                hasName: (name: string) => name === "bob",
            } as unknown as PeerRegistry,
            pendingAsks: {} as HubContext["pendingAsks"],
            defaultAskTimeoutMs: 5000,
            sendTo: () => false, // peer "online" but push fails
            groups: {} as HubContext["groups"],
            mailboxes,
        };

        const mockSocket = {} as net.Socket;
        handleSend(ctx, mockSocket, { type: "send", to: "bob", text: "hi" }, (m) => {
            sentResult = m as Record<string, unknown>;
        });

        expect(sentResult).not.toBeNull();
        expect(sentResult!["type"]).toBe("send_ack");
        expect(sentResult!["status"]).toBe("queued");
        // message was still persisted to mailbox despite failed push
        const data = mailboxes.load("bob")!;
        expect(data.messages.length).toBe(1);
        expect(data.messages[0]!.text).toBe("hi");
    });

    // [VT6] handleSend: peer is online and sendTo returns true → status "delivered"
    test("[VT6] handleSend with online peer and successful sendTo → status delivered", () => {
        const mailboxes = createMailboxStore(dir);
        let sentResult: Record<string, unknown> | null = null;

        const ctx: HubContext = {
            registry: {
                getName: (_socket: net.Socket) => "alice",
                hasName: (name: string) => name === "bob",
            } as unknown as PeerRegistry,
            pendingAsks: {} as HubContext["pendingAsks"],
            defaultAskTimeoutMs: 5000,
            sendTo: () => true, // push succeeds
            groups: {} as HubContext["groups"],
            mailboxes,
        };

        const mockSocket = {} as net.Socket;
        handleSend(ctx, mockSocket, { type: "send", to: "bob", text: "hi" }, (m) => {
            sentResult = m as Record<string, unknown>;
        });

        expect(sentResult!["type"]).toBe("send_ack");
        expect(sentResult!["status"]).toBe("delivered");
    });

    // [VT7] handleSend: urgent=true → incoming_message carries urgent=true
    test("[VT7] handleSend with urgent=true → incoming_message has urgent=true", () => {
        const mailboxes = createMailboxStore(dir);
        let pushed: Record<string, unknown> | null = null;

        const ctx: HubContext = {
            registry: {
                getName: (_socket: net.Socket) => "alice",
                hasName: (name: string) => name === "bob",
            } as unknown as PeerRegistry,
            pendingAsks: {} as HubContext["pendingAsks"],
            defaultAskTimeoutMs: 5000,
            sendTo: (_name: string, msg: unknown) => {
                pushed = msg as Record<string, unknown>;
                return true;
            },
            groups: {} as HubContext["groups"],
            mailboxes,
        };

        const mockSocket = {} as net.Socket;
        handleSend(ctx, mockSocket, { type: "send", to: "bob", text: "NOW", urgent: true }, (m) => {
            void m;
        });

        expect(pushed).not.toBeNull();
        expect(pushed!["type"]).toBe("incoming_message");
        expect(pushed!["urgent"]).toBe(true);
        const data = mailboxes.load("bob")!;
        expect(data.messages[0]!.urgent).toBe(true);
    });

    // [VT8] handleSend: urgent absent → incoming_message has no urgent field
    test("[VT8] handleSend without urgent → incoming_message has no urgent field", () => {
        const mailboxes = createMailboxStore(dir);
        let pushed: Record<string, unknown> | null = null;

        const ctx: HubContext = {
            registry: {
                getName: (_socket: net.Socket) => "alice",
                hasName: (name: string) => name === "bob",
            } as unknown as PeerRegistry,
            pendingAsks: {} as HubContext["pendingAsks"],
            defaultAskTimeoutMs: 5000,
            sendTo: (_name: string, msg: unknown) => {
                pushed = msg as Record<string, unknown>;
                return true;
            },
            groups: {} as HubContext["groups"],
            mailboxes,
        };

        const mockSocket = {} as net.Socket;
        handleSend(ctx, mockSocket, { type: "send", to: "bob", text: "normal" }, (_m) => {});

        expect(pushed!["urgent"]).toBeUndefined();
    });
});
