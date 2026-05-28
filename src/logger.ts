import * as fs from "node:fs";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { logsDir } from "./data-dir";

interface InitLoggerOptions {
    /** Enable console transport (writes to stderr — stdout is reserved for MCP stdio). */
    console?: boolean;
}

let logger: winston.Logger | null = null;
let initialized = false;

function isTestEnv(): boolean {
    return process.env.NODE_ENV === "test";
}

/**
 * Initialize the Winston logger singleton.
 * Creates `~/.eco-relay/logs/` if missing and configures transports.
 * Safe to call multiple times; subsequent calls are no-ops.
 * When `NODE_ENV=test` (set by `bun test`), this is a no-op — no file, no console.
 */
export function initLogger(options?: InitLoggerOptions): void {
    if (initialized) return;

    if (isTestEnv()) return;
    initialized = true;

    const dir = logsDir();

    try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

        const fileTransport = new DailyRotateFile({
            dirname: dir,
            filename: "relay-%DATE%.log",
            datePattern: "YYYY-MM-DD",
            maxFiles: "7d",
            maxSize: "200m",
            format: winston.format.combine(
                winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
                winston.format.json(),
            ),
        });

        const transports: winston.transport[] = [fileTransport];

        if (options?.console) {
            transports.push(
                new winston.transports.Console({
                    stderrLevels: ["debug", "info", "warn", "error"],
                    format: winston.format.combine(
                        winston.format.timestamp({ format: "HH:mm:ss" }),
                        winston.format.printf(({ timestamp, level, message, label: lbl }) => {
                            const tag = lbl ? `[${lbl as string}]` : "[relay]";
                            return `${timestamp as string} ${level.toUpperCase()} ${tag} ${message as string}`;
                        }),
                    ),
                }),
            );
        }

        logger = winston.createLogger({
            level: "debug",
            transports,
        });
    } catch (err) {
        process.stderr.write(
            `relay: failed to initialize logger: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        logger = null;
    }
}

function sanitize(value: string): string {
    return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function log(level: string, message: string, label?: string): void {
    if (!logger) return;
    try {
        logger.log({ level, message: sanitize(message), label: sanitize(label ?? "relay") });
    } catch {
        // Never throw from logger.
    }
}

export function info(message: string, label?: string): void {
    log("info", message, label);
}

export function warn(message: string, label?: string): void {
    log("warn", message, label);
}

export function error(message: string, label?: string): void {
    log("error", message, label);
}

export function debug(message: string, label?: string): void {
    log("debug", message, label);
}

export function makeLogger(label: string) {
    const fmt = (ev: string, fields?: Record<string, unknown>): string =>
        fields === undefined ? ev : `${ev} ${JSON.stringify(fields)}`;
    return {
        info(ev: string, fields?: Record<string, unknown>): void {
            info(fmt(ev, fields), label);
        },
        warn(ev: string, fields?: Record<string, unknown>): void {
            warn(fmt(ev, fields), label);
        },
        error(ev: string, fields?: Record<string, unknown>): void {
            error(fmt(ev, fields), label);
        },
        debug(ev: string, fields?: Record<string, unknown>): void {
            debug(fmt(ev, fields), label);
        },
    };
}
