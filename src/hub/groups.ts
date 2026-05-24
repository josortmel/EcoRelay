import * as fs from "node:fs";
import * as path from "node:path";

const MAX_GROUP_MESSAGES = 500;

type GroupMember = { last_read: number; joined_at: string };
type GroupMessage = {
    id: number;
    from: string;
    text: string;
    ts: string;
    type: "message" | "system";
};
type GroupData = {
    name: string;
    admin: string;
    created_at: string;
    members: Record<string, GroupMember>;
    messages: GroupMessage[];
    next_id: number;
};

export type GroupStore = ReturnType<typeof createGroupStore>;

export function createGroupStore(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    function filePath(name: string): string {
        const base = path.basename(name);
        if (!base || base !== name) throw new Error(`invalid group name: ${name}`);
        return path.join(dir, `${name}.json`);
    }

    function load(name: string): GroupData | null {
        try {
            return JSON.parse(fs.readFileSync(filePath(name), "utf8")) as GroupData;
        } catch {
            return null;
        }
    }

    function save(data: GroupData): void {
        const fp = filePath(data.name);
        const tmp = `${fp}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, fp);
    }

    function create(name: string, admin: string, memberNames: string[]): GroupData {
        const now = new Date().toISOString();
        const allMembers = Array.from(new Set([admin, ...memberNames]));
        const members: Record<string, GroupMember> = {};
        for (const m of allMembers) members[m] = { last_read: 0, joined_at: now };
        const data: GroupData = {
            name,
            admin,
            created_at: now,
            members,
            messages: [],
            next_id: 1,
        };
        save(data);
        return data;
    }

    function totalGroupCount(): number {
        try {
            return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
        } catch {
            return 0;
        }
    }

    function addMember(name: string, peer: string): GroupData {
        const data = load(name);
        if (!data) throw new Error(`group ${name} not found`);
        data.members[peer] = { last_read: 0, joined_at: new Date().toISOString() };
        save(data);
        return data;
    }

    function removeMember(groupName: string, peer: string, reason: string, by: string): GroupData {
        const data = load(groupName);
        if (!data) throw new Error(`group ${groupName} not found`);
        data.members = Object.fromEntries(Object.entries(data.members).filter(([k]) => k !== peer));
        const msg: GroupMessage = {
            id: data.next_id++,
            from: by,
            text: `${by} removed ${peer}: ${reason}`,
            ts: new Date().toISOString(),
            type: "system",
        };
        if (data.messages.length >= MAX_GROUP_MESSAGES) data.messages.shift();
        data.messages.push(msg);
        save(data);
        return data;
    }

    function leaveMember(groupName: string, peer: string): GroupData {
        const data = load(groupName);
        if (!data) throw new Error(`group ${groupName} not found`);
        data.members = Object.fromEntries(Object.entries(data.members).filter(([k]) => k !== peer));
        const msg: GroupMessage = {
            id: data.next_id++,
            from: peer,
            text: `${peer} left`,
            ts: new Date().toISOString(),
            type: "system",
        };
        if (data.messages.length >= MAX_GROUP_MESSAGES) data.messages.shift();
        data.messages.push(msg);
        save(data);
        return data;
    }

    function addMessage(
        groupName: string,
        from: string,
        text: string,
    ): { data: GroupData; message: GroupMessage } {
        const data = load(groupName);
        if (!data) throw new Error(`group ${groupName} not found`);
        const message: GroupMessage = {
            id: data.next_id++,
            from,
            text,
            ts: new Date().toISOString(),
            type: "message",
        };
        if (data.messages.length >= MAX_GROUP_MESSAGES) data.messages.shift();
        data.messages.push(message);
        save(data);
        return { data, message };
    }

    function getUnread(
        groupName: string,
        peer: string,
        limit?: number,
    ): { messages: GroupMessage[]; remaining: number } {
        const data = load(groupName);
        if (!data) throw new Error(`group ${groupName} not found`);
        const member = data.members[peer];
        const lastRead = member?.last_read ?? 0;
        const unread = data.messages.filter((m) => m.id > lastRead);
        const cap = limit ?? unread.length;
        const page = unread.slice(0, cap);
        const remaining = unread.length - page.length;
        const last = page[page.length - 1];
        if (last !== undefined && member) {
            member.last_read = last.id;
            save(data);
        }
        return { messages: page, remaining };
    }

    function listForPeer(peer: string): Array<{ name: string; unread_count: number }> {
        let files: string[];
        try {
            files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
        } catch {
            return [];
        }
        const result: Array<{ name: string; unread_count: number }> = [];
        for (const f of files) {
            const name = f.slice(0, -5);
            const data = load(name);
            if (!data || !Object.hasOwn(data.members, peer)) continue;
            const memberData = data.members[peer];
            const lastRead = memberData?.last_read ?? 0;
            const unread_count = data.messages.filter((m) => m.id > lastRead).length;
            result.push({ name, unread_count });
        }
        return result;
    }

    function getInfo(name: string): GroupData | null {
        return load(name);
    }

    function deleteGroup(name: string): void {
        try {
            fs.unlinkSync(filePath(name));
        } catch {}
    }

    function exists(name: string): boolean {
        return load(name) !== null;
    }

    function isMember(name: string, peer: string): boolean {
        const data = load(name);
        return data !== null && Object.hasOwn(data.members, peer);
    }

    function isAdmin(name: string, peer: string): boolean {
        const data = load(name);
        return data !== null && data.admin === peer;
    }

    return {
        load,
        save,
        create,
        addMember,
        removeMember,
        leaveMember,
        addMessage,
        getUnread,
        listForPeer,
        getInfo,
        deleteGroup,
        exists,
        isMember,
        isAdmin,
        totalGroupCount,
    };
}
