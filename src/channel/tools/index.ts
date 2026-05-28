export {
    errResult,
    okResult,
    relayBroadcast,
    relayPeers,
    relayRename,
    relayReply,
    renameWithHub,
    type ChannelContext,
    type RenameResult,
    type ToolResult,
} from "./core";
export {
    relayGroupCreate,
    relayGroupDelete,
    relayGroupHistory,
    relayGroupInfo,
    relayGroupInvite,
    relayGroupLeave,
    relayGroupList,
    relayGroupRemove,
    relayGroupSend,
} from "./groups";
export { relayInbox, relaySend } from "./messaging";
export { relayJoin, relayLeave, relayListRooms, relayRoomMsg } from "./rooms";

import type { ChannelContext, ToolResult } from "./core";
import { relayBroadcast, relayPeers, relayRename, relayReply } from "./core";
import {
    relayGroupCreate,
    relayGroupDelete,
    relayGroupHistory,
    relayGroupInfo,
    relayGroupInvite,
    relayGroupLeave,
    relayGroupList,
    relayGroupRemove,
    relayGroupSend,
} from "./groups";
import { relayInbox, relaySend } from "./messaging";
import { relayJoin, relayLeave, relayListRooms, relayRoomMsg } from "./rooms";

export async function callTool(
    ctx: ChannelContext,
    name: string,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    switch (name) {
        case "relay_peers":
            return relayPeers(ctx);
        case "relay_rename":
            return relayRename(ctx, args);
        case "relay_reply":
            return relayReply(ctx, args);
        case "relay_broadcast":
            return relayBroadcast(ctx, args);
        case "relay_join":
            return relayJoin(ctx, args);
        case "relay_leave":
            return relayLeave(ctx, args);
        case "relay_room":
            return relayRoomMsg(ctx, args);
        case "relay_rooms":
            return relayListRooms(ctx);
        case "relay_group_create":
            return relayGroupCreate(ctx, args);
        case "relay_group_invite":
            return relayGroupInvite(ctx, args);
        case "relay_group_remove":
            return relayGroupRemove(ctx, args);
        case "relay_group_leave":
            return relayGroupLeave(ctx, args);
        case "relay_group_send":
            return relayGroupSend(ctx, args);
        case "relay_group_history":
            return relayGroupHistory(ctx, args);
        case "relay_group_list":
            return relayGroupList(ctx);
        case "relay_group_info":
            return relayGroupInfo(ctx, args);
        case "relay_group_delete":
            return relayGroupDelete(ctx, args);
        case "relay_send":
            return relaySend(ctx, args);
        case "relay_inbox":
            return relayInbox(ctx, args);
        default:
            return {
                isError: true,
                content: [
                    { type: "text", text: JSON.stringify({ ok: false, code: "not_implemented" }) },
                ],
            };
    }
}
