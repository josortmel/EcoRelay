import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeLogger } from "../logger";

const log = makeLogger("bootstrap-deps");

function rootDir(): string {
    return join(import.meta.dir, "../..");
}

export function ensureDeps(): void {
    const marker = join(rootDir(), ".bootstrap-deps-ok");

    if (existsSync(marker)) return;

    const nm = join(rootDir(), "node_modules");
    if (existsSync(nm)) {
        writeFileSync(marker, "");
        return;
    }

    log.info("installing_dependencies");
    const result = spawnSync("bun", ["install"], {
        cwd: rootDir(),
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
    });

    if (result.status !== 0) {
        const stderr = result.stderr?.toString() ?? "";
        const msg = `Failed to install dependencies in ${rootDir()}. bun install exited with code ${result.status}.${stderr ? `\n${stderr}` : ""} Ensure bun is installed and available in PATH. Run "bun install" manually in the plugin directory to diagnose.`;
        process.stderr.write(`relay: ${msg}\n`);
        log.error("install_failed", { status: result.status, stderr });
        return;
    }

    writeFileSync(marker, "");
    log.info("dependencies_installed");
}
