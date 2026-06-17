import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { makeLogger } from "../logger";

const log = makeLogger("channel");

function envEnabled(value: string | undefined): boolean {
    return value === "1" || value === "true" || value === "yes";
}

function betaPingDelayMs(): number {
    const raw = process.env.ECORELAY_CODEX_BETA_PING_DELAY_MS;
    if (!raw) return 8000;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return 8000;
    return parsed;
}

export function maybeScheduleCodexBetaPing(server: Server, getName: () => string): void {
    if (!envEnabled(process.env.ECORELAY_CODEX_BETA_PING)) return;

    const previous = server.oninitialized;
    server.oninitialized = () => {
        previous?.();
        const delayMs = betaPingDelayMs();
        setTimeout(() => {
            void server
                .elicitInput(
                    {
                        mode: "form",
                        message: `EcoRelay Codex beta ping from ${getName()} after ${delayMs}ms.`,
                        requestedSchema: {
                            type: "object",
                            properties: {
                                ack: {
                                    type: "boolean",
                                    title: "Acknowledge",
                                    description: "Confirms Codex rendered an idle MCP push.",
                                    default: true,
                                },
                            },
                            required: ["ack"],
                        },
                    },
                    { timeout: 60_000 },
                )
                .then((result) => {
                    log.info("codex_beta_ping_result", {
                        action: result.action,
                        has_content: result.content !== undefined && result.content !== null,
                    });
                })
                .catch((err: unknown) => {
                    log.error("codex_beta_ping_failed", {
                        err: err instanceof Error ? err.message : String(err),
                    });
                });
        }, delayMs).unref();
    };
}
