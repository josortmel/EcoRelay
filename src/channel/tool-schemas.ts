import { MAX_TEXT_LEN } from "../protocol";

export type JsonSchemaProperty = {
    type: string;
    description?: string;
    maxLength?: number;
    items?: { type: string };
};

export type JsonSchemaObject = {
    type: "object";
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
};

export type ToolSchema = {
    name: string;
    description: string;
    inputSchema: JsonSchemaObject;
};

export const TOOLS: ToolSchema[] = [
    {
        name: "relay_peers",
        description:
            "List OTHER active sessions on this machine. Returns `{me, peers}` where `me` is your own session name and `peers` is every other session (excluding you). Each peer has `cwd` and `git_branch` for disambiguation.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "relay_ask",
        description:
            "Ask a specific peer a question. Non-blocking: returns immediately with {ok, ask_id}; the reply arrives later as a channel notification. For fire-and-forget messages that don't need a correlated reply, use relay_send instead. If multiple peers may share a similar name, call relay_peers first and match by cwd or git_branch to pick the right target.",
        inputSchema: {
            type: "object",
            properties: {
                to: { type: "string" },
                question: { type: "string", maxLength: MAX_TEXT_LEN },
                thread_id: {
                    type: "string",
                    description:
                        "Optional thread identifier to correlate multi-turn exchanges. If you received an ask with a thread_id and are replying or continuing, pass the same thread_id.",
                },
            },
            required: ["to", "question"],
        },
    },
    {
        name: "relay_reply",
        description:
            "Reply to an incoming ask or message. Auto-detects whether the ID is an ask_id (from relay_ask) or msg_id (from relay_send) and routes the reply correctly. text is a plain string — no streaming, no structured payload.",
        inputSchema: {
            type: "object",
            properties: {
                ask_id: { type: "string" },
                text: { type: "string", maxLength: MAX_TEXT_LEN },
            },
            required: ["ask_id", "text"],
        },
    },
    {
        name: "relay_broadcast",
        description:
            "Broadcast a question to ALL other peers on this machine, including sessions on unrelated projects. Use ONLY when the user explicitly wants every session asked. Do NOT use as a fallback when relay_ask returns an error (peer_not_found, peer_gone, timeout); surface the error to the user and let them decide. If you want to reach a specific peer, use relay_ask.",
        inputSchema: {
            type: "object",
            properties: {
                question: { type: "string", maxLength: MAX_TEXT_LEN },
                exclude_self: { type: "boolean" },
            },
            required: ["question"],
        },
    },
    {
        name: "relay_rename",
        description: "Rename this session's registered name.",
        inputSchema: {
            type: "object",
            properties: {
                new_name: { type: "string" },
            },
            required: ["new_name"],
        },
    },
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
            "Send a fire-and-forget message to all members of a room (excluding yourself). Returns `{ok, room, delivered_count}` where `delivered_count` is the number of peers the hub successfully forwarded to (may be lower than total members if some are mid-reconnect). Recipients receive the message as a channel notification with `from`, `room`, `text`, and `msg_id` in meta. Use relay_ask if you need a directed reply from a specific peer; relay_room is for broadcast-to-subgroup, not request/response.",
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
    {
        name: "relay_group_create",
        description:
            "Create a persistent group with initial members. You become the admin. Groups survive disconnections — messages are stored and can be read later with relay_group_history. Use for coordination that needs offline delivery (unlike ephemeral rooms).",
        inputSchema: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    description: "Group name (max 64 chars, [A-Za-z0-9._-] only)",
                },
                members: {
                    type: "array",
                    items: { type: "string" },
                    description: "Initial member names (max 20). You are always included.",
                },
            },
            required: ["name", "members"],
        },
    },
    {
        name: "relay_group_invite",
        description: "Invite a peer to a group you admin. Only the group admin can invite.",
        inputSchema: {
            type: "object",
            properties: {
                group: { type: "string", description: "Group name" },
                peer: { type: "string", description: "Peer name to invite" },
            },
            required: ["group", "peer"],
        },
    },
    {
        name: "relay_group_remove",
        description:
            "Remove a member from a group you admin. Reason is required and logged in group history.",
        inputSchema: {
            type: "object",
            properties: {
                group: { type: "string", description: "Group name" },
                peer: { type: "string", description: "Peer to remove" },
                reason: {
                    type: "string",
                    description: "Reason for removal (required, max 256 chars)",
                    maxLength: 256,
                },
            },
            required: ["group", "peer", "reason"],
        },
    },
    {
        name: "relay_group_leave",
        description:
            "Leave a group voluntarily. Admins cannot leave — use relay_group_delete to delete the group first.",
        inputSchema: {
            type: "object",
            properties: {
                group: { type: "string", description: "Group name" },
            },
            required: ["group"],
        },
    },
    {
        name: "relay_group_send",
        description:
            "Send a message to a persistent group. Message is stored and delivered to online members immediately. Offline members can read it later via relay_group_history.",
        inputSchema: {
            type: "object",
            properties: {
                group: { type: "string", description: "Group name" },
                text: { type: "string", description: "Message text", maxLength: MAX_TEXT_LEN },
            },
            required: ["group", "text"],
        },
    },
    {
        name: "relay_group_history",
        description:
            "Read unread messages from a persistent group. Returns messages since your last read position and advances your cursor. Use limit to control how many messages to load.",
        inputSchema: {
            type: "object",
            properties: {
                group: { type: "string", description: "Group name" },
                limit: {
                    type: "number",
                    description: "Max messages to return (1-500, default: all unread)",
                },
            },
            required: ["group"],
        },
    },
    {
        name: "relay_group_list",
        description: "List all persistent groups you are a member of, with unread count per group.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "relay_group_info",
        description:
            "Get details about a persistent group: admin, members, online status, your unread count. You must be a member.",
        inputSchema: {
            type: "object",
            properties: {
                group: { type: "string", description: "Group name" },
            },
            required: ["group"],
        },
    },
    {
        name: "relay_group_delete",
        description:
            "Delete a persistent group. Only the admin can delete. This removes the group and all its message history permanently.",
        inputSchema: {
            type: "object",
            properties: {
                group: { type: "string", description: "Group name" },
            },
            required: ["group"],
        },
    },
    {
        name: "relay_send",
        description:
            "Send a persistent message to a peer. Returns {msg_id, status} where status is 'delivered' (peer online) or 'queued' (peer offline, retrieve via relay_inbox). Messages persist on disk (up to 500 per recipient; oldest evicted when full). To reply to a received message, pass reply_to with its msg_id. For request-response exchanges that need correlated replies, use relay_ask/relay_reply instead.",
        inputSchema: {
            type: "object",
            properties: {
                to: { type: "string", description: "Target peer name" },
                text: { type: "string", maxLength: MAX_TEXT_LEN, description: "Message content" },
                reply_to: {
                    type: "string",
                    maxLength: 256,
                    description: "Optional msg_id of the message you are replying to",
                },
                urgent: {
                    type: "boolean",
                    description:
                        "If true, recipient is instructed to act on this message immediately. Default false.",
                },
            },
            required: ["to", "text"],
        },
    },
    {
        name: "relay_inbox",
        description:
            "Read your pending messages. Returns {messages, remaining}. Messages are marked as read after retrieval. If remaining > 0, call again to retrieve the next page. Use since_id for pagination. Call at session start to check for offline messages.",
        inputSchema: {
            type: "object",
            properties: {
                limit: {
                    type: "number",
                    description: "Max messages to return (1-100, default 20)",
                },
                since_id: {
                    type: "string",
                    maxLength: 64,
                    description: "Only return messages after this msg_id",
                },
            },
        },
    },
];

export function getToolSchemas(): ToolSchema[] {
    return TOOLS;
}
