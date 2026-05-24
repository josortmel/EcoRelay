import { describe, expect, test } from "bun:test";
import {
    buildAskErrorNotification,
    buildAskNotification,
    buildMessageNotification,
    buildReplyNotification,
} from "./notifications";

describe("channel notifications", () => {
    test("buildAskNotification meta has from + ask_id and no source key", () => {
        const notif = buildAskNotification({
            type: "incoming_ask",
            from: "peer-a",
            ask_id: "ask-1",
            question: "ping?",
        });

        expect(notif.method).toBe("notifications/claude/channel");
        expect(notif.params.content).toBe("ping?");
        const meta = notif.params.meta;
        expect(meta).not.toHaveProperty("source");
        expect(meta.from).toBe("peer-a");
        expect(meta.ask_id).toBe("ask-1");
        expect(meta).not.toHaveProperty("broadcast_id");
        expect(meta).not.toHaveProperty("thread_id");
    });

    test("buildAskNotification includes broadcast_id and thread_id only when provided", () => {
        const withExtras = buildAskNotification({
            type: "incoming_ask",
            from: "peer-a",
            ask_id: "ask-2",
            question: "q",
            broadcast_id: "bc-1",
            thread_id: "thread-1",
        });
        const metaExtras = withExtras.params.meta;
        expect(metaExtras).not.toHaveProperty("source");
        expect(metaExtras.broadcast_id).toBe("bc-1");
        expect(metaExtras.thread_id).toBe("thread-1");
    });

    test("buildReplyNotification meta has from + ask_id and no source key", () => {
        const notif = buildReplyNotification({
            type: "incoming_reply",
            from: "peer-b",
            ask_id: "ask-3",
            text: "pong!",
        });

        expect(notif.method).toBe("notifications/claude/channel");
        expect(notif.params.content).toBe("pong!");
        const meta = notif.params.meta;
        expect(meta).not.toHaveProperty("source");
        expect(meta.from).toBe("peer-b");
        expect(meta.ask_id).toBe("ask-3");
        expect(meta).not.toHaveProperty("broadcast_id");
        expect(meta).not.toHaveProperty("thread_id");
    });

    test("buildReplyNotification includes broadcast_id and thread_id only when provided", () => {
        const withExtras = buildReplyNotification({
            type: "incoming_reply",
            from: "peer-b",
            ask_id: "ask-4",
            text: "t",
            broadcast_id: "bc-2",
            thread_id: "thread-2",
        });
        const meta = withExtras.params.meta;
        expect(meta).not.toHaveProperty("source");
        expect(meta.broadcast_id).toBe("bc-2");
        expect(meta.thread_id).toBe("thread-2");
    });

    test("buildAskErrorNotification meta has ask_id + code and no source key", () => {
        const notif = buildAskErrorNotification("ask-5", "peer_not_found");
        expect(notif.method).toBe("notifications/claude/channel");
        const meta = notif.params.meta;
        expect(meta).not.toHaveProperty("source");
        expect(meta.ask_id).toBe("ask-5");
        expect(meta.code).toBe("peer_not_found");
    });

    test("buildAskErrorNotification carries human-readable text per code with anti-broadcast guidance", () => {
        for (const code of ["peer_not_found", "peer_gone", "timeout"] as const) {
            const notif = buildAskErrorNotification("ask-x", code);
            expect(notif.params.content.length).toBeGreaterThan(0);
            expect(notif.params.content).toMatch(/do not broadcast/i);
            expect(notif.params.meta.code).toBe(code);
        }
    });

    test("buildAskErrorNotification falls back to a generic message for unmapped codes and still emits anti-broadcast guidance", () => {
        const notif = buildAskErrorNotification("ask-z", "unexpected");
        expect(notif.params.content).toContain("unexpected");
        expect(notif.params.content).toMatch(/do not broadcast/i);
        expect(notif.params.meta.code).toBe("unexpected");
    });

    test("buildMessageNotification basic: content is text, meta has from + msg_id", () => {
        const notif = buildMessageNotification({
            type: "incoming_message",
            msg_id: "m-1-abc",
            from: "peer-a",
            text: "hey there",
            reply_to: null,
            ts: "2026-01-01T00:00:00.000Z",
        });
        expect(notif.method).toBe("notifications/claude/channel");
        expect(notif.params.content).toBe("hey there");
        expect(notif.params.meta.from).toBe("peer-a");
        expect(notif.params.meta.msg_id).toBe("m-1-abc");
        expect(notif.params.meta).not.toHaveProperty("reply_to");
        expect(notif.params.meta).not.toHaveProperty("origin_hub");
    });

    test("buildMessageNotification with reply_to: meta includes reply_to", () => {
        const notif = buildMessageNotification({
            type: "incoming_message",
            msg_id: "m-2-def",
            from: "peer-b",
            text: "re: your message",
            reply_to: "m-1-abc",
            ts: "2026-01-01T00:00:00.000Z",
        });
        expect(notif.params.meta.reply_to).toBe("m-1-abc");
    });

    test("buildMessageNotification with remote hub origin: meta includes origin_hub", () => {
        const notif = buildMessageNotification({
            type: "incoming_message",
            msg_id: "m-3-ghi",
            from: "peer-c@hub-remote",
            text: "from afar",
            reply_to: null,
            ts: "2026-01-01T00:00:00.000Z",
        });
        expect(notif.params.meta.from).toBe("peer-c@hub-remote");
        expect(notif.params.meta.origin_hub).toBe("hub-remote");
    });

    test("buildMessageNotification urgent=true — meta has urgent=true", () => {
        const notif = buildMessageNotification({
            type: "incoming_message",
            msg_id: "m-u1",
            from: "alice",
            text: "NOW",
            reply_to: null,
            ts: "2026-01-01T00:00:00.000Z",
            urgent: true,
        });
        expect(notif.params.meta.urgent).toBe("true");
    });

    test("buildMessageNotification urgent absent — meta has no urgent", () => {
        const notif = buildMessageNotification({
            type: "incoming_message",
            msg_id: "m-u2",
            from: "alice",
            text: "normal",
            reply_to: null,
            ts: "2026-01-01T00:00:00.000Z",
        });
        expect(notif.params.meta).not.toHaveProperty("urgent");
    });

    test("buildMessageNotification urgent=false — meta has no urgent", () => {
        const notif = buildMessageNotification({
            type: "incoming_message",
            msg_id: "m-u3",
            from: "alice",
            text: "not urgent",
            reply_to: null,
            ts: "2026-01-01T00:00:00.000Z",
            urgent: false,
        });
        expect(notif.params.meta).not.toHaveProperty("urgent");
    });
});
