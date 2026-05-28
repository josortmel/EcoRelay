import { CORE_SCHEMAS } from "./core";
import { GROUP_SCHEMAS } from "./groups";
import { MSG_SCHEMAS } from "./messaging";
import { ROOM_SCHEMAS } from "./rooms";

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
    ...CORE_SCHEMAS,
    ...MSG_SCHEMAS,
    ...ROOM_SCHEMAS,
    ...GROUP_SCHEMAS,
];

export function getToolSchemas(): ToolSchema[] {
    return TOOLS;
}
