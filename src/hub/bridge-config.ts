import * as fs from "node:fs";
import { z } from "zod";
import { bridgeConfigPaths } from "../data-dir";
import { makeLogger } from "../logger";

const log = makeLogger("bridge");

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

export function loadBridgeConfig(): BridgeConfig | null {
    const paths = bridgeConfigPaths();
    for (const p of paths) {
        let raw: string;
        try {
            raw = fs.readFileSync(p, "utf8");
        } catch {
            continue;
        }

        // Strip BOM (U+FEFF) — PowerShell on Windows may prepend it
        if (raw.charCodeAt(0) === 0xfeff) {
            raw = raw.slice(1);
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            log.warn("bridge_config_invalid_json", {
                path: p,
                hint: "bridge.json contains invalid JSON. If created with PowerShell, use [System.IO.File]::WriteAllText() or create with bash.",
            });
            continue;
        }

        try {
            const cfg = BridgeConfigSchema.parse(parsed);
            if (process.platform !== "win32") {
                try {
                    fs.chmodSync(p, 0o600);
                } catch {}
            }
            return cfg;
        } catch (e) {
            log.warn("bridge_config_invalid_schema", {
                path: p,
                error: e instanceof Error ? e.message : String(e),
                hint: "bridge.json has valid JSON but missing or invalid required fields. Check hub_id, secret, and peer format.",
            });
        }
    }
    return null;
}
