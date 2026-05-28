import { MAX_TEXT_LEN } from "../../protocol";
import type { ToolSchema } from "./index";

export const GROUP_SCHEMAS: ToolSchema[] = [
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
];
