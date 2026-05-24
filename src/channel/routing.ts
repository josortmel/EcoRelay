import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { makeLogger } from "../logger";
import type { HubConnection } from "./hub-connection";
import {
    buildAskErrorNotification,
    buildAskNotification,
    buildGroupMsgNotification,
    buildMessageNotification,
    buildReplyNotification,
    buildRoomMsgNotification,
    type ChannelNotification,
} from "./notifications";
import type { PendingBroadcasts } from "./pending-broadcasts";

const log = makeLogger("channel");

export type NotificationSink = {
    onNotification?: (n: { method: string; params: Record<string, unknown> }) => void;
    transport?: unknown;
    server: Server;
};

export function buildEmitNotification(
    sink: NotificationSink,
): (notif: ChannelNotification) => void {
    return (notif) => {
        const meta = notif.params.meta as Record<string, unknown>;
        log.info("notification_emit", {
            method: notif.method,
            from: meta.from as string | undefined,
            ask_id: meta.ask_id as string | undefined,
            broadcast_id: meta.broadcast_id as string | undefined,
        });
        if (sink.onNotification) {
            sink.onNotification(notif);
            return;
        }
        if (!sink.transport) return;
        void sink.server.notification(notif).catch((e: unknown) => {
            log.error("notification_err", { err: e instanceof Error ? e.message : String(e) });
        });
    };
}

export function wireHubRouting(
    hub: HubConnection,
    pendingBroadcasts: PendingBroadcasts,
    emitNotification: (notif: ChannelNotification) => void,
): void {
    hub.onMessage((m) => {
        if (m.type === "broadcast_ack") {
            pendingBroadcasts.resolveWithAck(m.broadcast_id, m.peer_count);
            return;
        }
        if (m.type === "incoming_ask") {
            emitNotification(buildAskNotification(m));
            return;
        }
        if (m.type === "incoming_reply") {
            emitNotification(buildReplyNotification(m));
            return;
        }
        if (m.type === "incoming_room_msg") {
            emitNotification(buildRoomMsgNotification(m));
            return;
        }
        if (m.type === "incoming_group_msg") {
            emitNotification(buildGroupMsgNotification(m));
            return;
        }
        if (m.type === "incoming_message") {
            emitNotification(buildMessageNotification(m));
            return;
        }
        if (m.type === "err" && m.ask_id) {
            emitNotification(buildAskErrorNotification(m.ask_id, m.code));
            return;
        }
        if (m.type === "ping") {
            hub.send({ type: "pong", req_id: m.req_id });
        }
    });

    hub.onDisconnect(() => {
        pendingBroadcasts.failAll("hub_unreachable");
    });
}
