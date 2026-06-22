import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { makeLogger } from "../logger";

const log = makeLogger("antigravity-backend");

const SEND_TIMEOUT_MS = 15_000;

function defaultAgyPath(): string {
    if (process.env.ANTIGRAVITY_AGY_PATH) return process.env.ANTIGRAVITY_AGY_PATH;
    if (process.platform === "win32") {
        return path.join(os.homedir(), "AppData", "Local", "agy", "bin", "agy.exe");
    }
    return path.join(os.homedir(), ".local", "bin", "agy");
}

export type SendTurnResult = {
    ok: boolean;
    error?: string;
};

/**
 * Injects a message into a live `agy` TUI conversation via the official
 * `agy agentapi send-message` command. agentapi is a client of the
 * in-process Language Server and handles the TLS/auth itself, so we never
 * touch the gRPC socket directly. Requires ANTIGRAVITY_LS_ADDRESS pointing
 * at the LS HTTP port.
 */
export class AgentApiBackend {
    private readonly agyPath: string;

    constructor(agyPath?: string) {
        this.agyPath = agyPath ?? defaultAgyPath();
    }

    sendTurn(conversationId: string, text: string, lsAddress: string): Promise<SendTurnResult> {
        return new Promise<SendTurnResult>((resolve) => {
            let settled = false;
            const done = (r: SendTurnResult): void => {
                if (settled) return;
                settled = true;
                resolve(r);
            };

            let child;
            try {
                child = spawn(this.agyPath, ["agentapi", "send-message", conversationId, text], {
                    shell: false,
                    windowsHide: true,
                    env: { ...process.env, ANTIGRAVITY_LS_ADDRESS: lsAddress },
                });
            } catch (e) {
                done({ ok: false, error: e instanceof Error ? e.message : String(e) });
                return;
            }

            const timer = setTimeout(() => {
                try {
                    child.kill();
                } catch {
                    /* ignore */
                }
                done({ ok: false, error: "agentapi send-message timeout" });
            }, SEND_TIMEOUT_MS);

            let stdout = "";
            let stderr = "";
            child.stdout?.on("data", (d) => {
                stdout += String(d);
            });
            child.stderr?.on("data", (d) => {
                stderr += String(d);
            });

            child.on("error", (e) => {
                clearTimeout(timer);
                done({ ok: false, error: e.message });
            });

            child.on("close", (code) => {
                clearTimeout(timer);
                // agentapi prints JSON: success => {"response":{"sendMessage":{...}}}
                //                      failure => {"response":{},"error":"..."}
                // agentapi prints PRETTY-PRINTED (multi-line) JSON, so we must
                // parse the whole blob — never line-by-line. If a banner wraps
                // it, extract the outermost { ... } object.
                let parsed: { response?: { sendMessage?: unknown }; error?: string } | null = null;
                const trimmed = stdout.trim();
                try {
                    parsed = JSON.parse(trimmed);
                } catch {
                    const start = trimmed.indexOf("{");
                    const end = trimmed.lastIndexOf("}");
                    if (start !== -1 && end > start) {
                        try {
                            parsed = JSON.parse(trimmed.slice(start, end + 1));
                        } catch {
                            /* give up — leave parsed null */
                        }
                    }
                }
                if (parsed?.response?.sendMessage) {
                    log.info("send_message_ok", { conversationId });
                    done({ ok: true });
                    return;
                }
                const err = parsed?.error || stderr.trim() || `exit ${code}`;
                log.warn("send_message_failed", { conversationId, err });
                done({ ok: false, error: err });
            });
        });
    }
}
