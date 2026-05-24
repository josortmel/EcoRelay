import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMailboxStore } from "./mailbox";

describe("MailboxStore", () => {
    let dir: string;
    let store: ReturnType<typeof createMailboxStore>;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mailbox-test-"));
        store = createMailboxStore(dir);
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test("addMessage creates mailbox file on first write", () => {
        store.addMessage("alice", "bob", "hello");
        expect(fs.existsSync(path.join(dir, "alice.json"))).toBe(true);
    });

    test("addMessage appends to existing mailbox", () => {
        store.addMessage("alice", "bob", "first");
        store.addMessage("alice", "carol", "second");
        const data = store.load("alice")!;
        expect(data.messages.length).toBe(2);
        expect(data.messages[0]!.text).toBe("first");
        expect(data.messages[1]!.text).toBe("second");
    });

    test("ring buffer: 501st message evicts first", () => {
        for (let i = 1; i <= 501; i++) {
            store.addMessage("bob", "alice", `msg-${i}`);
        }
        const data = store.load("bob")!;
        expect(data.messages.length).toBe(500);
        expect(data.messages[0]!.text).toBe("msg-2");
        expect(data.messages[499]!.text).toBe("msg-501");
    });

    test("getMessages returns all unread when no sinceId and no last_read", () => {
        store.addMessage("carol", "alice", "a");
        store.addMessage("carol", "alice", "b");
        const { messages, remaining } = store.getMessages("carol");
        expect(messages.length).toBe(2);
        expect(remaining).toBe(0);
        expect(messages.map((m) => m.text)).toEqual(["a", "b"]);
    });

    test("getMessages with sinceId returns only newer messages", () => {
        store.addMessage("dave", "alice", "first");
        const { message: second } = store.addMessage("dave", "alice", "second")!;
        store.addMessage("dave", "alice", "third");
        const { messages } = store.getMessages("dave", second.msg_id);
        expect(messages.length).toBe(1);
        expect(messages[0]!.text).toBe("third");
    });

    test("getMessages updates last_read", () => {
        store.addMessage("eve", "alice", "msg1");
        store.addMessage("eve", "alice", "msg2");
        store.getMessages("eve");
        const data = store.load("eve")!;
        expect(data.last_read).not.toBeNull();
        const { messages } = store.getMessages("eve");
        expect(messages.length).toBe(0);
    });

    test("getMessages with limit returns page and correct remaining count", () => {
        for (let i = 1; i <= 10; i++) store.addMessage("frank", "alice", `msg-${i}`);
        const { messages, remaining } = store.getMessages("frank", undefined, 3);
        expect(messages.length).toBe(3);
        expect(remaining).toBe(7);
    });

    test("generateMsgId returns unique strings", () => {
        const ids = new Set<string>();
        for (let i = 0; i < 100; i++) ids.add(store.generateMsgId());
        expect(ids.size).toBe(100);
    });

    test("atomic write: no .tmp file remains after save", () => {
        store.addMessage("grace", "alice", "hello");
        const tmpFile = path.join(dir, "grace.json.tmp");
        expect(fs.existsSync(tmpFile)).toBe(false);
        expect(fs.existsSync(path.join(dir, "grace.json"))).toBe(true);
    });

    test("addMessage with urgent=true stores urgent field", () => {
        const { message } = store.addMessage("henry", "alice", "NOW", null, true)!;
        expect(message.urgent).toBe(true);
        const data = store.load("henry")!;
        expect(data.messages[0]!.urgent).toBe(true);
    });

    test("addMessage without urgent omits urgent field", () => {
        const { message } = store.addMessage("ivy", "alice", "normal")!;
        expect(message.urgent).toBeUndefined();
        const data = store.load("ivy")!;
        expect(data.messages[0]!.urgent).toBeUndefined();
    });

    test("getMessages returns urgent field from stored messages", () => {
        store.addMessage("jake", "alice", "urgent msg", null, true);
        store.addMessage("jake", "alice", "normal msg");
        const { messages } = store.getMessages("jake");
        expect(messages[0]!.urgent).toBe(true);
        expect(messages[1]!.urgent).toBeUndefined();
    });
});

// ─── Verifier additional tests ────────────────────────────────────────────────

describe("MailboxStore — Verifier edge cases", () => {
    let dir: string;
    let store: ReturnType<typeof createMailboxStore>;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mailbox-verifier-"));
        store = createMailboxStore(dir);
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // [AT1] Empty string owner rejected by filePath sanitization (FIX 4)
    test("[AT1] empty string owner — throws invalid mailbox owner", () => {
        expect(() => store.addMessage("", "bob", "hello")).toThrow("invalid mailbox owner");
        expect(fs.existsSync(path.join(dir, ".json"))).toBe(false);
    });

    // [AT2] Empty from and text — stored without crash
    test("[AT2] empty from and text — no crash, stored as-is", () => {
        const { message } = store.addMessage("alice", "", "")!;
        expect(message.text).toBe("");
        expect(message.from).toBe("");
        const data = store.load("alice")!;
        expect(data.messages[0]!.text).toBe("");
    });

    // [AT3] 100KB text — no crash, full content preserved
    test("[AT3] 100KB text — stores and retrieves at full length", () => {
        const bigText = "x".repeat(100_000);
        store.addMessage("alice", "bob", bigText);
        const data = store.load("alice")!;
        expect(data.messages[0]!.text.length).toBe(100_000);
    });

    // [AT4] sinceId evicted from ring buffer → returns all remaining messages (FIX 3)
    test("[AT4] sinceId evicted by ring buffer — returns all 500 remaining messages", () => {
        const { message: first } = store.addMessage("alice", "bob", "first")!;
        for (let i = 0; i < 500; i++) store.addMessage("alice", "bob", `fill-${i}`);
        // first.msg_id was evicted — FIX 3: returns all current messages instead of []
        const { messages, remaining } = store.getMessages("alice", first.msg_id);
        expect(messages.length).toBe(500);
        expect(remaining).toBe(0);
    });

    // [AT5] last_read evicted → returns ALL 500 — inconsistent with sinceId eviction (AT4 returns [])
    test("[AT5] last_read evicted — returns all 500 current messages (opposite of sinceId eviction)", () => {
        store.addMessage("alice", "bob", "first");
        store.getMessages("alice"); // sets last_read to first
        for (let i = 0; i < 500; i++) store.addMessage("alice", "bob", `fill-${i}`);
        // last_read is now evicted; idx === -1 → slice() returns all messages
        const { messages } = store.getMessages("alice");
        // When last_read evicted: all 500 returned. When sinceId evicted: 0 returned.
        expect(messages.length).toBe(500);
    });

    // [AT6] Ring buffer: exactly 499 and 500 messages — no eviction yet
    test("[AT6] ring buffer boundary: 499→500 messages — no eviction until 501st", () => {
        for (let i = 1; i <= 499; i++) store.addMessage("alice", "bob", `msg-${i}`);
        let data = store.load("alice")!;
        expect(data.messages.length).toBe(499);
        expect(data.messages[0]!.text).toBe("msg-1"); // msg-1 still present

        store.addMessage("alice", "bob", "msg-500");
        data = store.load("alice")!;
        expect(data.messages.length).toBe(500);
        expect(data.messages[0]!.text).toBe("msg-1"); // msg-1 still NOT evicted at exactly 500
    });

    // [AT7] Corrupted JSON — load returns null, addMessage overwrites with fresh mailbox
    test("[AT7] corrupted JSON on disk — addMessage creates fresh mailbox", () => {
        const fp = path.join(dir, "alice.json");
        fs.writeFileSync(fp, "{ invalid json {{{{");
        expect(store.load("alice")).toBeNull();
        store.addMessage("alice", "bob", "fresh");
        const data = store.load("alice")!;
        expect(data.messages.length).toBe(1);
        expect(data.messages[0]!.text).toBe("fresh");
    });

    // [AT8] limit=0 — returns empty page, remaining=total unread, last_read NOT updated
    test("[AT8] getMessages with limit=0 — empty page returned, last_read not updated", () => {
        store.addMessage("alice", "bob", "msg1");
        store.addMessage("alice", "bob", "msg2");
        const { messages, remaining } = store.getMessages("alice", undefined, 0);
        expect(messages.length).toBe(0);
        expect(remaining).toBe(2);
        const data = store.load("alice")!;
        expect(data.last_read).toBeNull(); // last_read untouched since page was empty
    });

    // [AT9] Double getMessages — second returns 0, no crash
    test("[AT9] getMessages twice — second call returns 0 unread", () => {
        store.addMessage("alice", "bob", "msg1");
        const first = store.getMessages("alice");
        expect(first.messages.length).toBe(1);
        const second = store.getMessages("alice");
        expect(second.messages.length).toBe(0);
        expect(second.remaining).toBe(0);
    });

    // [AT10] Unicode owner — filename works on Windows NTFS
    test("[AT10] unicode owner (ñoño) — file created and readable", () => {
        store.addMessage("ñoño", "bob", "hola");
        expect(fs.existsSync(path.join(dir, "ñoño.json"))).toBe(true);
        const data = store.load("ñoño")!;
        expect(data.messages.length).toBe(1);
    });

    // [AT11] Path traversal — owner with ../ rejected by filePath sanitization (FIX 4)
    test("[AT11] path traversal — owner '../evil' throws, no file written outside dir", () => {
        expect(() => store.addMessage("../evil", "bob", "injected")).toThrow(
            "invalid mailbox owner",
        );
        const escapedPath = path.resolve(dir, "..", "evil.json");
        expect(fs.existsSync(escapedPath)).toBe(false);
    });

    // [AT12] sinceId = last message — returns empty
    test("[AT12] sinceId equals last message — returns empty, no crash", () => {
        store.addMessage("alice", "bob", "first");
        const { message: last } = store.addMessage("alice", "bob", "last")!;
        const { messages, remaining } = store.getMessages("alice", last.msg_id);
        expect(messages.length).toBe(0);
        expect(remaining).toBe(0);
    });

    // [AT13] Owner with spaces — file at "alice bob.json"
    test("[AT13] owner with spaces — file created at expected path", () => {
        store.addMessage("alice bob", "carol", "hello");
        expect(fs.existsSync(path.join(dir, "alice bob.json"))).toBe(true);
    });

    // [AT14] 500 messages then getMessages — ring buffer intact, all 500 returned
    test("[AT14] 500 messages then getMessages — all 500 returned, order preserved", () => {
        for (let i = 1; i <= 500; i++) store.addMessage("alice", "bob", `msg-${i}`);
        const { messages, remaining } = store.getMessages("alice");
        expect(messages.length).toBe(500);
        expect(remaining).toBe(0);
        expect(messages[0]!.text).toBe("msg-1");
        expect(messages[499]!.text).toBe("msg-500");
    });

    // [AT15] Rapid sequential addMessage (20 calls) — all messages persisted
    test("[AT15] 20 rapid sequential addMessage calls — all 20 persisted, none lost", () => {
        for (let i = 0; i < 20; i++) store.addMessage("alice", "bot", `rapid-${i}`);
        const data = store.load("alice")!;
        expect(data.messages.length).toBe(20);
        const texts = data.messages.map((m) => m.text);
        for (let i = 0; i < 20; i++) expect(texts).toContain(`rapid-${i}`);
    });

    // [AT16] getMessages on non-existent mailbox — no crash, returns empty
    test("[AT16] getMessages on non-existent mailbox — returns empty, no crash", () => {
        const { messages, remaining } = store.getMessages("nobody");
        expect(messages.length).toBe(0);
        expect(remaining).toBe(0);
    });

    // [AT17] replyTo preserved through write/read cycle
    test("[AT17] replyTo field preserved through disk round-trip", () => {
        const { message: m1 } = store.addMessage("alice", "bob", "original")!;
        store.addMessage("alice", "carol", "reply", m1.msg_id);
        const data = store.load("alice")!;
        expect(data.messages[1]!.reply_to).toBe(m1.msg_id);
    });

    // [AT18] getMessages with limit larger than unread — returns all unread, remaining=0
    test("[AT18] limit larger than unread count — returns all unread, remaining=0", () => {
        store.addMessage("alice", "bob", "only");
        const { messages, remaining } = store.getMessages("alice", undefined, 9999);
        expect(messages.length).toBe(1);
        expect(remaining).toBe(0);
    });

    // [AT19] Mailbox cap: 500 mailboxes created, 501st new owner returns null
    test("[AT19] mailbox cap — 501st new owner returns null, existing owner still works", () => {
        for (let i = 0; i < 500; i++) {
            const result = store.addMessage(`owner-${i}`, "bot", "hello");
            expect(result).not.toBeNull();
        }
        expect(store.totalMailboxCount()).toBe(500);

        // 501st new owner → null (cap exceeded)
        const overflow = store.addMessage("owner-501", "bot", "overflow");
        expect(overflow).toBeNull();
        expect(store.totalMailboxCount()).toBe(500); // count unchanged

        // Existing owner still works (not a new mailbox)
        const existing = store.addMessage("owner-0", "bot", "still works");
        expect(existing).not.toBeNull();
        const data = store.load("owner-0")!;
        expect(data.messages.length).toBe(2);
    });
});
