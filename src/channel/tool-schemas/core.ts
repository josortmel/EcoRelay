import { MAX_TEXT_LEN } from "../../protocol";
import type { ToolSchema } from "./index";

export const CORE_SCHEMAS: ToolSchema[] = [
    {
        name: "relay_peers",
        description:
            "List OTHER active sessions on this machine. Returns `{me, peers}` where `me` is your own session name and `peers` is every other session (excluding you). Each peer has `cwd` and `git_branch` for disambiguation.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "relay_reply",
        description:
            "Reply to an incoming ask or message. Auto-detects whether the ID is an ask_id or msg_id (from relay_send) and routes the reply correctly. text is a plain string — no streaming, no structured payload.",
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
            "Broadcast a question to ALL other peers on this machine, including sessions on unrelated projects. Use ONLY when the user explicitly wants every session asked. If you want to reach a specific peer, use relay_send.",
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
];
