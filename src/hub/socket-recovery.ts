import * as fs from "node:fs";
import * as net from "node:net";
import { makeLogger } from "../logger";

const log = makeLogger("hub");

export function probeLiveSocket(socketPath: string, timeoutMs = 200): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const probe = net.createConnection(socketPath);
        const done = (alive: boolean) => {
            try {
                probe.destroy();
            } catch {}
            resolve(alive);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        probe.once("connect", () => {
            clearTimeout(timer);
            done(true);
        });
        probe.once("error", () => {
            clearTimeout(timer);
            done(false);
        });
    });
}

export async function listenWithRecovery(server: net.Server, socketPath: string): Promise<void> {
    const tryListen = () =>
        new Promise<void>((resolve, reject) => {
            const onError = (err: NodeJS.ErrnoException) => {
                server.removeListener("listening", onListening);
                reject(err);
            };
            const onListening = () => {
                server.removeListener("error", onError);
                resolve();
            };
            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(socketPath);
        });

    if (fs.existsSync(socketPath)) {
        const alive = await probeLiveSocket(socketPath);
        if (alive) {
            const err = new Error(
                `listen EADDRINUSE: address already in use ${socketPath}`,
            ) as NodeJS.ErrnoException;
            err.code = "EADDRINUSE";
            throw err;
        }
        try {
            fs.unlinkSync(socketPath);
            log.info("stale_socket_unlinked", { socketPath });
        } catch (err) {
            log.warn("stale_socket_unlink_failed", {
                socketPath,
                err: (err as NodeJS.ErrnoException).message,
            });
        }
    }

    try {
        await tryListen();
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "EADDRINUSE") throw err;
        const alive = await probeLiveSocket(socketPath);
        if (alive) throw err;
        fs.unlinkSync(socketPath);
        await tryListen();
    }
}
