import { hubSocketPath } from "./data-dir";
import { startHub } from "./hub/index";
import { initLogger, makeLogger } from "./logger";

const log = makeLogger("hub-daemon");

initLogger({ console: false });

async function run(): Promise<void> {
    const socketPath = process.env.RELAY_HUB_SOCKET ?? hubSocketPath();
    const rawPort = Number(process.env.ECORELAY_WS_PORT || "19736");
    const wsPort = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535
        ? rawPort
        : (log.warn("invalid_ws_port", { raw: process.env.ECORELAY_WS_PORT }), 19736);
    const noIdle = process.env.ECORELAY_IDLE_MS === "0";
    const hub = await startHub({
        socketPath,
        wsPort,
        ...(noIdle ? { onIdleExit: () => log.info("idle_exit_suppressed") } : {}),
    });
    log.info("daemon_start", { socketPath, pid: process.pid });

    const shutdown = (): void => {
        void hub.close().finally(() => process.exit(0));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}

run().catch((err: unknown) => {
    process.stderr.write(
        `relay-hub-daemon: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
});
