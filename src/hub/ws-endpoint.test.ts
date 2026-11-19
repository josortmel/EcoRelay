import { describe, expect, test } from "bun:test";
import { VirtualSocket } from "./ws-endpoint";

function mockWs() {
    return {
        sent: [] as string[],
        closed: false,
        closeCode: 0,
        closeReason: "",
        send(data: string) {
            this.sent.push(data);
        },
        close(code?: number, reason?: string) {
            this.closed = true;
            this.closeCode = code ?? 0;
            this.closeReason = reason ?? "";
        },
    };
}

describe("VirtualSocket EventEmitter contract", () => {
    test("write() returns false after destroy()", () => {
        const ws = mockWs();
        const vs = new VirtualSocket(ws);

        expect(vs.write("hello")).toBe(true);
        expect(ws.sent).toEqual(["hello"]);

        vs.destroy();
        expect(vs.write("after")).toBe(false);
    });

    test("destroy() triggers emit('close')", () => {
        const ws = mockWs();
        const vs = new VirtualSocket(ws);

        let closed = false;
        vs.on("close", () => {
            closed = true;
        });

        vs.destroy();
        expect(closed).toBe(true);
        expect(vs.destroyed).toBe(true);
        expect(vs.writable).toBe(false);
    });

    test("write() returns false on destroyed VirtualSocket even if underlying WS is still open", () => {
        const ws = mockWs();
        const vs = new VirtualSocket(ws);

        vs.destroy();
        // Underlying ws may still be "open" but VS considers itself destroyed
        expect(vs.write("nope")).toBe(false);
        // Underlying send should NOT have been called after destroy
        expect(ws.sent).toEqual([]);
    });

    test("double destroy() emits 'close' only once", () => {
        const ws = mockWs();
        const vs = new VirtualSocket(ws);

        let closeCount = 0;
        vs.on("close", () => closeCount++);

        vs.destroy();
        vs.destroy();
        expect(closeCount).toBe(1);
    });

    test("destroyed flag is false initially, true after destroy", () => {
        const ws = mockWs();
        const vs = new VirtualSocket(ws);
        expect(vs.destroyed).toBe(false);
        vs.destroy();
        expect(vs.destroyed).toBe(true);
    });

    test("writable flag is true initially, false after end(), false after destroy()", () => {
        const ws = mockWs();
        const vs = new VirtualSocket(ws);
        expect(vs.writable).toBe(true);

        vs.end();
        expect(vs.writable).toBe(false);

        const ws2 = mockWs();
        const vs2 = new VirtualSocket(ws2);
        vs2.destroy();
        expect(vs2.writable).toBe(false);
    });

    test("remoteAddress is 127.0.0.1", () => {
        const ws = mockWs();
        const vs = new VirtualSocket(ws);
        expect(vs.remoteAddress).toBe("127.0.0.1");
    });

    test("write() catches WS send errors and returns false", () => {
        const ws = {
            send() {
                throw new Error("boom");
            },
            close() {},
        };
        const vs = new VirtualSocket(ws);
        expect(vs.write("data")).toBe(false);
    });

    test("destroy() catches WS close errors gracefully", () => {
        const ws = {
            close() {
                throw new Error("already closing");
            },
            send() {},
        };
        const vs = new VirtualSocket(ws);
        // Should not throw
        expect(() => vs.destroy()).not.toThrow();
        expect(vs.destroyed).toBe(true);
    });

    test("end() catches WS close errors gracefully", () => {
        const ws = {
            close() {
                throw new Error("boom");
            },
            send() {},
        };
        const vs = new VirtualSocket(ws);
        expect(() => vs.end()).not.toThrow();
        expect(vs.writable).toBe(false);
    });
});
