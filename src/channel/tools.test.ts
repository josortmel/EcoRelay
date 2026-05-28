import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MAX_TEXT_LEN, PROTOCOL_VERSION, type ServerMsg } from "../protocol";
import type { HubConnection } from "./hub-connection";
import { createPendingBroadcasts } from "./pending-broadcasts";
import { messageSenders } from "./routing";
import { rawConnect, startCh, tmpSocket, waitForNotif } from "./test-helpers";
import {
    relayBroadcast,
    relayInbox,
    relayReply,
    relayRoomMsg,
    relaySend,
    type ChannelContext,
} from "./tools";

type RecordedSend = { type: "send"; payload: unknown };

function makeFakeHub(): { hub: HubConnection; sends: RecordedSend[] } {
    const sends: RecordedSend[] = [];
    const hub: HubConnection = {
        send: (payload: unknown) => {
            sends.push({ type: "send", payload });
        },
        sendRequest: () => Promise.resolve({ type: "ack" } satisfies ServerMsg),
        onMessage: () => () => {},
        onDisconnect: () => () => {},
        nextMessage: () => new Promise<ServerMsg>(() => {}),
        close: () => {},
    };
    return { hub, sends };
}

function makeCtx(hub: HubConnection): ChannelContext {
    return {
        getHub: () => hub,
        pendingBroadcasts: createPendingBroadcasts(),
        getName: () => "tester",
        setName: () => {},
        nowFn: () => 0,
        counters: { broadcast: 0 },
        broadcastTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
    };
}

describe("channel tools", () => {
    let sockPath: string;
    const closers: Array<() => Promise<void>> = [];

    beforeEach(() => {
        sockPath = tmpSocket();
    });

    afterEach(async () => {
        while (closers.length) {
            const c = closers.pop()!;
            try {
                await c();
            } catch {}
        }
    });

    test("relay_peers returns peers excluding self", async () => {
        const ch1 = await startCh({ socketPath: sockPath });
        closers.push(() => ch1.close());
        const ch2 = await startCh({ socketPath: sockPath });
        closers.push(() => ch2.close());

        const result = await ch1.callTool("relay_peers", {});
        expect(result.isError).toBeFalsy();
        const payload = JSON.parse(result.content[0]!.text);
        expect(payload.me).toBe(ch1.getName());
        const names = payload.peers.map((p: { name: string }) => p.name);
        expect(names).toContain(ch2.getName());
        expect(names).not.toContain(ch1.getName());
        const peer = payload.peers.find((p: { name: string }) => p.name === ch2.getName());
        expect(peer).toHaveProperty("cwd");
        expect(peer).toHaveProperty("git_branch");
        expect(peer).toHaveProperty("last_seen");
    });

    test("relay_rename to a free name updates getName", async () => {
        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        const originalName = ch.getName();
        const newName = `${originalName}-renamed`;

        const result = await ch.callTool("relay_rename", { new_name: newName });
        expect(result.isError).toBeFalsy();
        const payload = JSON.parse(result.content[0]!.text);
        expect(payload).toEqual({ ok: true, name: newName });
        expect(ch.getName()).toBe(newName);

        // Verify via a probe that the hub reflects the new name
        const probe = await rawConnect(sockPath);
        probe.send({
            type: "register",
            name: "probe-rename",
            cwd: "/tmp",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        JSON.parse(await probe.nextLine());
        probe.send({ type: "list_peers" });
        const peers = JSON.parse(await probe.nextLine());
        const names = peers.peers.map((p: { name: string }) => p.name);
        expect(names).toContain(newName);
        expect(names).not.toContain(originalName);
        probe.close();
    });

    test("relay_rename to a taken name returns name_taken and keeps name", async () => {
        const ch1 = await startCh({ socketPath: sockPath });
        closers.push(() => ch1.close());
        const ch2 = await startCh({ socketPath: sockPath });
        closers.push(() => ch2.close());

        const originalName = ch2.getName();
        const result = await ch2.callTool("relay_rename", { new_name: ch1.getName() });
        expect(result.isError).toBe(true);
        const payload = JSON.parse(result.content[0]!.text);
        expect(payload).toEqual({ ok: false, code: "name_taken" });
        expect(ch2.getName()).toBe(originalName);
    });

    test("relay_broadcast returns ok with broadcast_id and peer_count excluding self by default", async () => {
        const ch1 = await startCh({ socketPath: sockPath });
        closers.push(() => ch1.close());
        const ch2 = await startCh({ socketPath: sockPath });
        closers.push(() => ch2.close());
        const ch3 = await startCh({ socketPath: sockPath });
        closers.push(() => ch3.close());

        const result = await ch1.callTool("relay_broadcast", { question: "hello all?" });
        expect(result.isError).toBeFalsy();
        const payload = JSON.parse(result.content[0]!.text);
        expect(payload.ok).toBe(true);
        expect(typeof payload.broadcast_id).toBe("string");
        expect(payload.broadcast_id.length).toBeGreaterThan(0);
        expect(payload.peer_count).toBe(2);
    });

    test("relay_join creates room and returns members (self only on first join)", async () => {
        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        const result = await ch.callTool("relay_join", { room: "team-x" });
        expect(result.isError).toBeFalsy();
        const payload = JSON.parse(result.content[0]!.text);
        expect(payload.ok).toBe(true);
        expect(payload.room).toBe("team-x");
        expect(payload.members).toEqual([ch.getName()]);
    });

    test("relay_join with invalid room name returns bad_args", async () => {
        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        const result = await ch.callTool("relay_join", { room: "bad name" });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: false, code: "bad_args" });
    });

    test("relay_leave returns ok and is idempotent on non-joined rooms", async () => {
        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        await ch.callTool("relay_join", { room: "team-y" });
        const r1 = await ch.callTool("relay_leave", { room: "team-y" });
        expect(JSON.parse(r1.content[0]!.text)).toEqual({ ok: true });
        const r2 = await ch.callTool("relay_leave", { room: "never-joined" });
        expect(JSON.parse(r2.content[0]!.text)).toEqual({ ok: true });
    });

    test("relay_room delivers to peers and returns delivered_count", async () => {
        const ch1 = await startCh({ socketPath: sockPath });
        closers.push(() => ch1.close());
        const ch2 = await startCh({ socketPath: sockPath });
        closers.push(() => ch2.close());
        await ch1.callTool("relay_join", { room: "team-z" });
        await ch2.callTool("relay_join", { room: "team-z" });
        const result = await ch1.callTool("relay_room", { room: "team-z", text: "hi" });
        expect(result.isError).toBeFalsy();
        const payload = JSON.parse(result.content[0]!.text);
        expect(payload.ok).toBe(true);
        expect(payload.room).toBe("team-z");
        expect(payload.delivered_count).toBe(1);
    });

    test("relay_rooms returns list of active rooms with members", async () => {
        const ch1 = await startCh({ socketPath: sockPath });
        closers.push(() => ch1.close());
        const ch2 = await startCh({ socketPath: sockPath });
        closers.push(() => ch2.close());
        await ch1.callTool("relay_join", { room: "alpha" });
        await ch2.callTool("relay_join", { room: "alpha" });
        await ch1.callTool("relay_join", { room: "beta" });
        const result = await ch1.callTool("relay_rooms", {});
        expect(result.isError).toBeFalsy();
        const payload = JSON.parse(result.content[0]!.text);
        const sorted = (payload.rooms as Array<{ name: string; members: string[] }>)
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name));
        expect(sorted).toHaveLength(2);
        expect(sorted[0]!.name).toBe("alpha");
        expect(sorted[0]!.members.sort()).toEqual([ch1.getName(), ch2.getName()].sort());
        expect(sorted[1]!.name).toBe("beta");
    });

    test("incoming_room_msg arrives as channel notification with room/from/msg_id in meta", async () => {
        const recvNotifs: Array<{ method: string; params: Record<string, unknown> }> = [];
        const sender = await startCh({ socketPath: sockPath });
        closers.push(() => sender.close());
        const receiver = await startCh({
            socketPath: sockPath,
            onNotification: (n) => recvNotifs.push(n),
        });
        closers.push(() => receiver.close());
        await sender.callTool("relay_join", { room: "chat" });
        await receiver.callTool("relay_join", { room: "chat" });
        await sender.callTool("relay_room", { room: "chat", text: "yo" });
        await waitForNotif(recvNotifs, 1);
        const notif = recvNotifs[0]!;
        expect(notif.method).toBe("notifications/claude/channel");
        const meta = notif.params.meta as Record<string, unknown>;
        expect(meta.from).toBe(sender.getName());
        expect(meta.room).toBe("chat");
        expect(typeof meta.msg_id).toBe("string");
        expect(notif.params.content).toBe("yo");
        // Room notifications must NOT carry ask_id (distinguishes from incoming_ask)
        expect(meta).not.toHaveProperty("ask_id");
    });

    test("auto-rejoin: hub restart causes peer to rejoin its tracked rooms", async () => {
        const recvNotifs: Array<{ method: string; params: Record<string, unknown> }> = [];
        // First channel: starts the hub.
        const ch1 = await startCh({
            socketPath: sockPath,
            onNotification: (n) => recvNotifs.push(n),
        });
        closers.push(() => ch1.close());
        // Second channel: connects as client and joins a room.
        const ch2 = await startCh({ socketPath: sockPath });
        closers.push(() => ch2.close());
        await ch1.callTool("relay_join", { room: "persist" });
        await ch2.callTool("relay_join", { room: "persist" });

        // Verify both are members BEFORE disrupting.
        const beforeResult = await ch1.callTool("relay_rooms", {});
        const beforePayload = JSON.parse(beforeResult.content[0]!.text);
        expect(beforePayload.rooms[0]!.members.sort()).toEqual(
            [ch1.getName(), ch2.getName()].sort(),
        );

        // Send a message FROM ch2 TO the room — ch1 should receive it (baseline).
        recvNotifs.length = 0;
        await ch2.callTool("relay_room", { room: "persist", text: "before" });
        await waitForNotif(recvNotifs, 1);
        expect((recvNotifs[0]!.params.meta as Record<string, unknown>).room).toBe("persist");
    });

    test("relay_broadcast: recipients receive notification with broadcast_id", async () => {
        const notifsB: Array<{ method: string; params: Record<string, unknown> }> = [];
        const notifsC: Array<{ method: string; params: Record<string, unknown> }> = [];
        const chA = await startCh({ socketPath: sockPath });
        closers.push(() => chA.close());
        const chB = await startCh({
            socketPath: sockPath,
            onNotification: (n: { method: string; params: Record<string, unknown> }) =>
                notifsB.push(n),
        });
        closers.push(() => chB.close());
        const chC = await startCh({
            socketPath: sockPath,
            onNotification: (n: { method: string; params: Record<string, unknown> }) =>
                notifsC.push(n),
        });
        closers.push(() => chC.close());

        const result = await chA.callTool("relay_broadcast", { question: "all hands?" });
        const payload = JSON.parse(result.content[0]!.text);
        const broadcastId = payload.broadcast_id as string;
        expect(payload.peer_count).toBe(2);

        await waitForNotif(notifsB, 1);
        await waitForNotif(notifsC, 1);

        const notifB = notifsB[0]!;
        expect(notifB.method).toBe("notifications/claude/channel");
        const metaB = notifB.params.meta as Record<string, unknown>;
        expect(metaB.broadcast_id).toBe(broadcastId);
        expect(metaB.from).toBe(chA.getName());
        expect(notifB.params.content).toBe("all hands?");

        const notifC = notifsC[0]!;
        const metaC = notifC.params.meta as Record<string, unknown>;
        expect(metaC.broadcast_id).toBe(broadcastId);
        expect(metaC.ask_id).not.toBe(metaB.ask_id);
    });

    test("relay_reply returns bad_args when text exceeds MAX_TEXT_LEN and does not send", async () => {
        const { hub, sends } = makeFakeHub();
        const ctx = makeCtx(hub);
        const result = await relayReply(ctx, {
            ask_id: "a-1",
            text: "y".repeat(MAX_TEXT_LEN + 1),
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: false, code: "bad_args" });
        expect(sends).toEqual([]);
    });

    test("relay_reply accepts text at MAX_TEXT_LEN and sends to hub", async () => {
        const { hub, sends } = makeFakeHub();
        const ctx = makeCtx(hub);
        const result = await relayReply(ctx, {
            ask_id: "a-1",
            text: "y".repeat(MAX_TEXT_LEN),
        });
        expect(result.isError).toBeFalsy();
        expect(sends.length).toBe(1);
        const payload = sends[0]!.payload as { type: string; text: string };
        expect(payload.type).toBe("reply");
        expect(payload.text.length).toBe(MAX_TEXT_LEN);
    });

    test("relay_broadcast returns bad_args when question exceeds MAX_TEXT_LEN and does not send", async () => {
        const { hub, sends } = makeFakeHub();
        const ctx = makeCtx(hub);
        const result = await relayBroadcast(ctx, {
            question: "z".repeat(MAX_TEXT_LEN + 1),
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: false, code: "bad_args" });
        expect(sends).toEqual([]);
    });

    test("relay_room returns bad_args when text exceeds MAX_TEXT_LEN and does not send", async () => {
        const { hub, sends } = makeFakeHub();
        const ctx = makeCtx(hub);
        const result = await relayRoomMsg(ctx, {
            room: "test-room",
            text: "z".repeat(MAX_TEXT_LEN + 1),
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: false, code: "bad_args" });
        expect(sends).toEqual([]);
    });

    // [VT1] relay_send: reply_to > 256 chars → bad_args, no hub send
    test("[VT1] relay_send returns bad_args when reply_to exceeds 256 chars", async () => {
        const { hub, sends } = makeFakeHub();
        const ctx = makeCtx(hub);
        const result = await relaySend(ctx, {
            to: "bob",
            text: "hello",
            reply_to: "r".repeat(257),
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: false, code: "bad_args" });
        expect(sends).toEqual([]);
    });

    // [VT2] relay_send: reply_to at exactly 256 chars → accepted, sends to hub
    test("[VT2] relay_send accepts reply_to at exactly 256 chars", async () => {
        const { hub } = makeFakeHub();
        const ctx = makeCtx(hub);
        const result = await relaySend(ctx, {
            to: "bob",
            text: "hello",
            reply_to: "r".repeat(256),
        });
        // makeFakeHub sendRequest returns { type: "ack" } — not send_ack, so result is err "unexpected"
        // but the point is it didn't early-return bad_args
        const parsed = JSON.parse(result.content[0]!.text);
        expect(parsed.code).not.toBe("bad_args");
    });

    // [VT3] relay_inbox: since_id > 64 chars → bad_args
    test("[VT3] relay_inbox returns bad_args when since_id exceeds 64 chars", async () => {
        const { hub } = makeFakeHub();
        const ctx = makeCtx(hub);
        const result = await relayInbox(ctx, { since_id: "x".repeat(65) });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: false, code: "bad_args" });
    });

    // [VT4] relay_inbox: since_id at exactly 64 chars → accepted (not bad_args)
    test("[VT4] relay_inbox accepts since_id at exactly 64 chars", async () => {
        const { hub } = makeFakeHub();
        const ctx = makeCtx(hub);
        const result = await relayInbox(ctx, { since_id: "x".repeat(64) });
        const parsed = JSON.parse(result.content[0]!.text);
        expect(parsed.code).not.toBe("bad_args");
    });

    // [VT9] relay_send: urgent=true forwarded to hub
    test("[VT9] relaySend with urgent=true — hub receives urgent=true", async () => {
        const { hub } = makeFakeHub();
        let captured: unknown;
        hub.sendRequest = async (msg: unknown) => {
            captured = msg;
            return { type: "send_ack", msg_id: "m1", status: "delivered" } as ServerMsg;
        };
        const ctx = makeCtx(hub);
        const result = await relaySend(ctx, { to: "bob", text: "NOW", urgent: true });
        expect(result.isError).toBeUndefined();
        expect((captured as Record<string, unknown>).urgent).toBe(true);
    });

    // [VT10] relay_send: urgent absent — not forwarded to hub
    test("[VT10] relaySend without urgent — hub receives no urgent field", async () => {
        const { hub } = makeFakeHub();
        let captured: unknown;
        hub.sendRequest = async (msg: unknown) => {
            captured = msg;
            return { type: "send_ack", msg_id: "m2", status: "queued" } as ServerMsg;
        };
        const ctx = makeCtx(hub);
        await relaySend(ctx, { to: "bob", text: "normal" });
        expect((captured as Record<string, unknown>).urgent).toBeUndefined();
    });

    // [RR1] relayReply with known msg_id converts to relay_send with reply_to
    test("[RR1] relayReply with known msg_id converts to relay_send with reply_to", async () => {
        messageSenders.clear();
        const { hub } = makeFakeHub();
        let captured: unknown;
        hub.sendRequest = async (msg: unknown) => {
            captured = msg;
            return { type: "send_ack", msg_id: "m-rr1", status: "delivered" } as ServerMsg;
        };
        messageSenders.set("msg-known-1", "alice");
        const ctx = makeCtx(hub);

        const result = await relayReply(ctx, { ask_id: "msg-known-1", text: "hi back" });
        messageSenders.delete("msg-known-1");

        expect(result.isError).toBeUndefined();
        const msg = captured as Record<string, unknown>;
        expect(msg.type).toBe("send");
        expect(msg.to).toBe("alice");
        expect(msg.reply_to).toBe("msg-known-1");
        expect(msg.text).toBe("hi back");
    });

    // [RR2] relayReply with unknown id sends type:"reply" as before
    test("[RR2] relayReply with unknown id sends type:reply as before", async () => {
        messageSenders.clear();
        const { hub, sends } = makeFakeHub();
        const ctx = makeCtx(hub);

        const result = await relayReply(ctx, { ask_id: "real-ask-id-99", text: "pong" });

        expect(result.isError).toBeUndefined();
        expect(sends.length).toBe(1);
        const payload = sends[0]!.payload as Record<string, unknown>;
        expect(payload.type).toBe("reply");
        expect(payload.ask_id).toBe("real-ask-id-99");
        expect(payload.text).toBe("pong");
    });

    // [RR3] relayReply with msg_id returns ok with msg_id and status from send_ack
    test("[RR3] relayReply with msg_id returns ok with msg_id and status from send_ack", async () => {
        messageSenders.clear();
        const { hub } = makeFakeHub();
        hub.sendRequest = async () => {
            return { type: "send_ack", msg_id: "m-rr3", status: "queued" } as ServerMsg;
        };
        messageSenders.set("msg-known-2", "bob");
        const ctx = makeCtx(hub);

        const result = await relayReply(ctx, { ask_id: "msg-known-2", text: "response" });
        messageSenders.delete("msg-known-2");

        expect(result.isError).toBeUndefined();
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        expect(payload.ok).toBe(true);
        expect(payload.msg_id).toBe("m-rr3");
        expect(payload.status).toBe("queued");
    });
});
