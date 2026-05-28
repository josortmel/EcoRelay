import * as fs from "node:fs";
import * as path from "node:path";

const MAX_MAILBOX_MESSAGES = 500;
const MAX_MAILBOXES = 500;

type MailboxMessage = {
    msg_id: string;
    from: string;
    text: string;
    reply_to: string | null;
    ts: string;
    urgent?: boolean;
};

type MailboxData = {
    owner: string;
    messages: MailboxMessage[];
    last_read: string | null;
};

export type MailboxStore = ReturnType<typeof createMailboxStore>;

export function createMailboxStore(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    function filePath(owner: string): string {
        const base = path.basename(owner);
        if (!base || base === "." || base === ".." || base !== owner)
            throw new Error(`invalid mailbox owner: ${owner}`);
        return path.join(dir, `${base}.json`);
    }

    function load(owner: string): MailboxData | null {
        try {
            return JSON.parse(fs.readFileSync(filePath(owner), "utf8")) as MailboxData;
        } catch {
            return null;
        }
    }

    function save(data: MailboxData): void {
        const fp = filePath(data.owner);
        const tmp = `${fp}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, fp);
    }

    function ensureMailbox(owner: string): MailboxData {
        return load(owner) ?? { owner, messages: [], last_read: null };
    }

    function generateMsgId(): string {
        return `m-${crypto.randomUUID()}`;
    }

    let mailboxCount = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;

    function totalMailboxCount(): number {
        return mailboxCount;
    }

    function addMessage(
        owner: string,
        from: string,
        text: string,
        replyTo: string | null = null,
        urgent: boolean = false,
    ): { data: MailboxData; message: MailboxMessage } | null {
        const existing = load(owner);
        if (
            !existing &&
            fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length >= MAX_MAILBOXES
        ) {
            return null;
        }
        const data = existing ?? { owner, messages: [], last_read: null };
        const message: MailboxMessage = {
            msg_id: generateMsgId(),
            from,
            text,
            reply_to: replyTo,
            ts: new Date().toISOString(),
            ...(urgent ? { urgent: true } : {}),
        };
        if (data.messages.length >= MAX_MAILBOX_MESSAGES) data.messages.shift();
        data.messages.push(message);
        save(data);
        if (!existing) mailboxCount++;
        return { data, message };
    }

    function getMessages(
        owner: string,
        sinceId?: string,
        limit?: number,
    ): { messages: MailboxMessage[]; remaining: number } {
        const data = ensureMailbox(owner);
        let unread: MailboxMessage[];

        if (sinceId !== undefined) {
            const idx = data.messages.findIndex((m) => m.msg_id === sinceId);
            unread = idx === -1 ? data.messages.slice() : data.messages.slice(idx + 1);
        } else if (data.last_read !== null) {
            const idx = data.messages.findIndex((m) => m.msg_id === data.last_read);
            unread = idx === -1 ? data.messages.slice() : data.messages.slice(idx + 1);
        } else {
            unread = data.messages.slice();
        }

        const cap = limit ?? unread.length;
        const page = unread.slice(0, cap);
        const remaining = unread.length - page.length;
        const last = page[page.length - 1];
        if (last !== undefined) {
            data.last_read = last.msg_id;
            save(data);
        }
        return { messages: page, remaining };
    }

    return {
        load,
        save,
        ensureMailbox,
        generateMsgId,
        addMessage,
        getMessages,
        totalMailboxCount,
    };
}
