import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { dataDir } from "../data-dir";

const BridgePeerSchema = z.object({
    hub_id: z.string().min(1).max(64),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
});

const RelaySchema = z.object({
    url: z.string(),
    token: z.string().min(8),
});

const BridgeConfigSchema = z.object({
    hub_id: z.string().min(1).max(64),
    listen: z.number().int().min(0).max(65535).default(0),
    bind: z.string().optional(),
    secret: z.string().min(8),
    peers: z.array(BridgePeerSchema).default([]),
    relay: RelaySchema.optional(),
});

export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;
export type BridgePeerConfig = z.infer<typeof BridgePeerSchema>;
export type RelayConfig = z.infer<typeof RelaySchema>;

export function bridgeConfigPath(): string {
    return path.join(dataDir(), "bridge.json");
}

export function loadBridgeConfig(): BridgeConfig | null {
    const p = bridgeConfigPath();
    try {
        const raw = JSON.parse(fs.readFileSync(p, "utf8"));
        const cfg = BridgeConfigSchema.parse(raw);
        if (process.platform !== "win32") {
            try {
                fs.chmodSync(p, 0o600);
            } catch {}
        }
        return cfg;
    } catch {
        return null;
    }
}
