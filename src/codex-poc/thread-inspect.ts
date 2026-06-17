/**
 * Inspect threads to understand which is the TUI's active thread.
 */
const APP_SERVER_URL = process.env.CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:4580";
let reqId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }>();

function send(ws: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++reqId;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 15_000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ jsonrpc: "2.0", method, id, params }));
    });
}

function notify(ws: WebSocket, method: string, params: Record<string, unknown> = {}): void {
    ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
}

async function run(): Promise<void> {
    const ws = new WebSocket(APP_SERVER_URL);
    await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("connection failed"));
    });

    ws.onmessage = (e) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(String(e.data)); } catch { return; }
        if (typeof msg.id === "number" && pending.has(msg.id)) {
            const p = pending.get(msg.id)!;
            clearTimeout(p.timer);
            pending.delete(msg.id);
            if (msg.error) p.reject(msg.error);
            else p.resolve(msg.result);
        }
    };

    await send(ws, "initialize", {
        clientInfo: { name: "thread-inspector", title: "Thread Inspector", version: "0.0.1" },
        capabilities: { experimentalApi: true },
    });
    notify(ws, "initialized");

    // 1. Loaded threads
    const loaded = (await send(ws, "thread/loaded/list")) as { data?: string[] };
    console.log("\n=== Loaded threads ===");
    console.log(JSON.stringify(loaded, null, 2));

    // 2. For each loaded thread, get details
    for (const tid of loaded?.data ?? []) {
        try {
            const info = await send(ws, "thread/read", { threadId: tid });
            console.log(`\n=== Thread ${tid} ===`);
            console.log(JSON.stringify(info, null, 2).slice(0, 500));
        } catch (e) {
            console.log(`\n=== Thread ${tid} === ERROR:`, JSON.stringify(e).slice(0, 200));
        }
    }

    // 3. List recent threads
    const list = (await send(ws, "thread/list", { limit: 5 })) as { data?: Array<Record<string, unknown>> };
    console.log("\n=== Recent threads (list) ===");
    for (const t of list?.data ?? []) {
        console.log(`  ${t.id}: preview="${String(t.preview ?? "").slice(0, 60)}" cwd=${t.cwd ?? "?"}`);
    }

    ws.close();
}

run().catch(e => { console.error("Fatal:", e); process.exit(1); });
