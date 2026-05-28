import { ensureDeps } from "./channel/bootstrap-deps";
import { main } from "./channel/index";
import { initLogger } from "./logger";

initLogger({ console: true });

ensureDeps();

function shutdown(): void {
    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err: unknown) => {
    process.stderr.write(`relay: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
