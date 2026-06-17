/**
 * Stress tests para validar edge cases del plan de integración.
 *
 * Tests:
 * 1. turn/start durante turn activo — ¿falla, encola, o interrumpe?
 * 2. Thread tracking — ¿thread/loaded/list es estable?
 * 3. Doble cliente — ¿el segundo cliente ve los turns del primero?
 * 4. turn/start rápido consecutivo — ¿rate limiting?
 */

const APP_SERVER_URL = process.env.CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:4580";

let reqId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }>();

function send(ws: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++reqId;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 30_000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ jsonrpc: "2.0", method, id, params }));
    });
}

function notify(ws: WebSocket, method: string, params: Record<string, unknown> = {}): void {
    ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
}

function connect(label: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(APP_SERVER_URL);
        ws.onopen = () => {
            console.log(`[${label}] connected`);
            resolve(ws);
        };
        ws.onerror = () => reject(new Error(`[${label}] connection failed`));
        ws.onmessage = (e) => {
            let msg: Record<string, unknown>;
            try { msg = JSON.parse(String(e.data)); } catch { return; }
            if (typeof msg.id === "number" && pending.has(msg.id)) {
                const p = pending.get(msg.id)!;
                clearTimeout(p.timer);
                pending.delete(msg.id);
                if (msg.error) p.reject(msg.error);
                else p.resolve(msg.result);
            } else if (msg.method) {
                console.log(`[${label}] event: ${msg.method}`);
            }
        };
    });
}

async function initClient(ws: WebSocket, name: string): Promise<void> {
    await send(ws, "initialize", {
        clientInfo: { name, title: name, version: "0.0.1" },
        capabilities: { experimentalApi: true },
    });
    notify(ws, "initialized");
}

async function findThread(ws: WebSocket): Promise<string | null> {
    const loaded = (await send(ws, "thread/loaded/list")) as { data?: string[] };
    return loaded?.data?.[0] ?? null;
}

async function test1_turnDuringActiveTurn(ws: WebSocket, threadId: string): Promise<void> {
    console.log("\n=== TEST 1: turn/start durante turn activo ===");

    // Enviar primer turn (que tardará en completarse)
    console.log("Enviando turn 1 (largo)...");
    const turn1 = send(ws, "turn/start", {
        threadId,
        input: [{ type: "text", text: "Cuenta del 1 al 20 lentamente, un número por línea." }],
    });

    // Esperar un poco y enviar segundo turn
    await new Promise(r => setTimeout(r, 2000));

    console.log("Enviando turn 2 (durante turn 1 activo)...");
    try {
        const turn2 = await send(ws, "turn/start", {
            threadId,
            input: [{ type: "text", text: "INTERRUPCIÓN: esto es un test de push durante turn activo." }],
        });
        console.log("TEST 1 RESULT: turn/start durante turn activo → ACEPTADO:", JSON.stringify(turn2).slice(0, 200));
    } catch (e) {
        console.log("TEST 1 RESULT: turn/start durante turn activo → RECHAZADO:", JSON.stringify(e).slice(0, 200));
    }

    // Esperar que turn 1 termine
    try { await turn1; } catch { /* ignore */ }
    console.log("Turn 1 completado.");

    // Esperar que todo se asiente
    await new Promise(r => setTimeout(r, 3000));
}

async function test2_threadStability(ws: WebSocket): Promise<void> {
    console.log("\n=== TEST 2: Estabilidad de thread/loaded/list ===");

    for (let i = 0; i < 3; i++) {
        const loaded = (await send(ws, "thread/loaded/list")) as { data?: string[] };
        console.log(`  Intento ${i + 1}: ${loaded?.data?.length ?? 0} threads loaded: ${JSON.stringify(loaded?.data?.slice(0, 3))}`);
        await new Promise(r => setTimeout(r, 500));
    }

    console.log("TEST 2 RESULT: OK si los IDs son consistentes entre intentos.");
}

async function test3_consecutivePush(ws: WebSocket, threadId: string): Promise<void> {
    console.log("\n=== TEST 3: 3 turn/start consecutivos rápidos ===");

    for (let i = 1; i <= 3; i++) {
        console.log(`  Push ${i}...`);
        try {
            await send(ws, "turn/start", {
                threadId,
                input: [{ type: "text", text: `[EcoRelay test] push rápido #${i}. Responde solo: ACK${i}` }],
            });
            console.log(`  Push ${i}: OK`);
        } catch (e) {
            console.log(`  Push ${i}: FAILED —`, JSON.stringify(e).slice(0, 150));
        }
        // Esperar que el turn complete antes del siguiente
        await new Promise(r => setTimeout(r, 10000));
    }

    console.log("TEST 3 RESULT: OK si los 3 fueron aceptados.");
}

async function run(): Promise<void> {
    console.log("Conectando al app-server...\n");

    const ws = await connect("stress");
    await initClient(ws, "ecorelay-stress-test");

    const threadId = await findThread(ws);
    if (!threadId) {
        console.log("FAIL: No hay thread activo.");
        ws.close();
        return;
    }
    console.log(`Thread activo: ${threadId}`);

    // Test 2 primero (no destructivo)
    await test2_threadStability(ws);

    // Test 1: turn durante turn activo
    await test1_turnDuringActiveTurn(ws, threadId);

    // Test 3: pushes consecutivos (solo si queda tiempo)
    // Descomenta si quieres correrlo — tarda ~30s
    // await test3_consecutivePush(ws, threadId);

    console.log("\n=== TODOS LOS TESTS COMPLETADOS ===");
    ws.close();
}

run().catch(e => { console.error("Fatal:", e); process.exit(1); });
