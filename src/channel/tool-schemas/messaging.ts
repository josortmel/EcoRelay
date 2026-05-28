import { MAX_TEXT_LEN } from "../../protocol";
import type { ToolSchema } from "./index";

export const MSG_SCHEMAS: ToolSchema[] = [
    {
        name: "relay_send",
        description:
            "Send a persistent message to a peer. Returns {msg_id, status} where status is 'delivered' (peer online) or 'queued' (peer offline, retrieve via relay_inbox). Messages persist on disk (up to 500 per recipient; oldest evicted when full). To reply to a received message, pass reply_to with its msg_id.",
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
