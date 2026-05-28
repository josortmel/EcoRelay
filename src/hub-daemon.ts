import { hubSocketPath } from "./data-dir";
import { startHub } from "./hub/index";
import { initLogger, makeLogger } from "./logger";

const log = makeLogger("hub-daemon");

initLogger({ console: false });

async function run(): Promise<void> {
    const socketPath = process.env.RELAY_HUB_SOCKET ?? hubSocketPath();
    const hub = await startHub({ socketPath });
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
