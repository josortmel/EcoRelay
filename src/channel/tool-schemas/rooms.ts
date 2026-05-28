import { MAX_TEXT_LEN } from "../../protocol";
import type { ToolSchema } from "./index";

export const ROOM_SCHEMAS: ToolSchema[] = [
    {
        name: "relay_join",
        description:
            "Join an ephemeral room. Rooms are IRC-style: created implicitly on first join, destroyed implicitly when the last member leaves. No permissions, no persistence. Returns `{ok, room, members}` where `members` is the current membership list (including yourself). Use this to coordinate with a subgroup of peers without spamming everyone via relay_broadcast.",
        inputSchema: {
            type: "object",
            properties: {
                room: {
                    type: "string",
                    description:
                        "Room name (max 64 chars, [A-Za-z0-9._-] only). Same sanitization rules as peer names.",
                },
            },
            required: ["room"],
        },
    },
    {
        name: "relay_leave",
        description:
            "Leave a room you previously joined. Idempotent — leaving a room you are not in returns `{ok}` silently. The room is destroyed when its last member leaves.",
        inputSchema: {
            type: "object",
            properties: {
                room: { type: "string", description: "Room name to leave" },
            },
            required: ["room"],
        },
    },
    {
        name: "relay_room",
        description:
            "Send a fire-and-forget message to all members of a room (excluding yourself). Returns `{ok, room, delivered_count}` where `delivered_count` is the number of peers the hub successfully forwarded to (may be lower than total members if some are mid-reconnect). Recipients receive the message as a channel notification with `from`, `room`, `text`, and `msg_id` in meta. relay_room is for broadcast-to-subgroup, not request/response.",
        inputSchema: {
            type: "object",
            properties: {
                room: { type: "string", description: "Room to send to" },
                text: { type: "string", description: "Message text", maxLength: MAX_TEXT_LEN },
            },
            required: ["room", "text"],
        },
    },
    {
        name: "relay_rooms",
        description:
            "List all active rooms on this hub with their current members. Returns `{rooms: [{name, members}, ...]}`. Useful before relay_join to see if a coordination space already exists, or before relay_room to confirm membership.",
        inputSchema: { type: "object", properties: {} },
    },
];
