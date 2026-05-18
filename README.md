# Claude Relay

Let local Claude Code sessions talk to each other in natural language.

Running two Claude sessions on different projects? In one, say _"ask the backend session if the auth token shape changed"_ and the other answers. Or _"ask everyone what they're working on"_ and replies stream back. Need a subgroup chat? Use rooms.

> **Eco Consulting fork — v0.4.0.** This is a fork of [innestic/claude-relay](https://github.com/innestic/claude-relay) maintained by [Eco Consulting](https://github.com/EcoConsulting). The upstream ships v0.1.0; this fork adds **fixed identity**, **ephemeral rooms**, **zombie eviction**, **persistent groups**, and **cross-machine LAN federation**. Install instructions below point to this fork; full release notes in [CHANGELOG.md](CHANGELOG.md).

<img width="1280" height="678" alt="ezgif-7f30f78a18c9905f" src="https://github.com/user-attachments/assets/9a132dfa-9db1-4550-96e0-cd25a2744fce" />

## What's new in v0.4.0

**Cross-machine LAN federation** — two machines on the same network can now exchange relay messages:

- Hub-to-hub TCP bridge with shared secret authentication.
- Remote peers appear as `name@hub_id` in `relay_peers` — transparent routing.
- `relay_ask(to="Dev1@laptop")` works exactly like asking a local peer.
- Exponential retry with backoff (1s→30s) on connection failure + auto-reconnect.
- Bridge disconnect sends immediate `peer_gone` to in-flight callers (no 600s hang).
- Security: 5 adversarial loops. `from` always re-qualified with verified hub_id, `ServerMsgSchema` validation on all forwarded messages, cross-hub ask guards.
- Diagnostic script: `bun run scripts/bridge-check.ts` verifies config, ports, connectivity, and handshake.

**Setup:** create `bridge.json` in the relay data directory on each machine:

```json
{
    "hub_id": "my-machine",
    "listen": 9700,
    "secret": "shared-secret-min-8-chars",
    "peers": [{ "hub_id": "other-machine", "host": "192.168.1.X", "port": 9700 }]
}
```

Without `bridge.json`, relay works as a local-only tool — no changes needed.

## What's new in v0.3.1

**Security hardening** from 2-loop adversarial review: peer name sanitization in `group_invite`/`group_remove`, `last_read` privacy (only your own read position visible), `msg_id` type standardized to string, delete/remove notifications to affected members. See [CHANGELOG.md](CHANGELOG.md).

## What's new in v0.3.0

**Persistent groups** — WhatsApp-style groups that survive disconnections:

- Nine new MCP tools: `relay_group_create`, `relay_group_invite`, `relay_group_remove`, `relay_group_leave`, `relay_group_send`, `relay_group_history`, `relay_group_list`, `relay_group_info`, `relay_group_delete`.
- Messages stored on disk (JSON, one file per group). Offline members read later with `relay_group_history`.
- Admin governance: creator = admin. Only admin can invite, remove (with mandatory reason), and delete.
- Ring buffer: 500 messages per group (FIFO). `last_read` cursor per member.
- Global cap: 200 groups max.
- Security hardened: path traversal protection, `Object.hasOwn` for membership checks, admin self-removal blocked.

**Also in v0.3.0 (v0.2.1 merged):**

- Merge upstream v0.1.2 (anti-broadcast fallback, 512KB text cap, 1MB line cap, verbatim quoting).
- 10-minute ask/broadcast timeout (up from 2 min).
- Windows daemon-spawn fix, `fs.existsSync` guard removed for UDS compatibility.
- Defensive try/catch in hub `handleLine` and channel listener dispatch.

**Previous releases:** v0.2.0 added fixed identity (`RELAY_PEER_ID`), zombie eviction, and ephemeral rooms. See [CHANGELOG.md](CHANGELOG.md).

**Protocol**: `PROTOCOL_VERSION` bumped to `"4"`. Nine new client→hub message types and six new hub→client message types for persistent groups. See [CHANGELOG.md](CHANGELOG.md) for the full list.

## Install

Claude Relay ships as a Claude Code plugin. Three steps.

### 1. Add the marketplace

From any Claude Code session:

```
/plugin marketplace add EcoConsulting/claude-relay
```

### 2. Install the plugin

```
/plugin install relay@claude-relay
```

This registers the MCP server and slash commands.

### 3. Launch sessions with the channel capability

Relay delivers inbound messages via `notifications/claude/channel` — a Claude Code capability still in research preview. Because this fork isn't on Anthropic's official channel allowlist, every session that should send or receive messages must be launched with the development flag:

```bash
claude --dangerously-load-development-channels plugin:relay@claude-relay
```

Open two sessions in different project dirs and try the examples below.

## Usage

Try:

- _"what sessions are active?"_
- _"ask backend-api what they're working on"_
- _"ask everyone to report status"_

Rename your session: `/relay-rename backend-api`. Natural language works too (_"call yourself backend-api"_), but the slash command is faster. Claude Code's built-in `/rename` also auto-syncs.

### Tools

| Tool                  | What it does                                                               |
| --------------------- | -------------------------------------------------------------------------- |
| `relay_peers`         | List active sessions on this machine                                       |
| `relay_ask`           | Ask one peer; returns immediately, reply arrives as a notification         |
| `relay_reply`         | Answer an incoming ask by `ask_id`                                         |
| `relay_broadcast`     | Ask every other peer; replies stream back as notifications                 |
| `relay_rename`        | Rename this session                                                        |
| `relay_join`          | Join an ephemeral room (created implicitly on first join) — **v0.2**       |
| `relay_leave`         | Leave a room (destroyed implicitly when the last member leaves) — **v0.2** |
| `relay_room`          | Send a fire-and-forget message to all members of a room — **v0.2**         |
| `relay_rooms`         | List all active rooms with their members — **v0.2**                        |
| `relay_group_create`  | Create a persistent group with initial members — **v0.3**                  |
| `relay_group_invite`  | Invite a peer to a group (admin only) — **v0.3**                           |
| `relay_group_remove`  | Remove a member with reason (admin only, logged) — **v0.3**                |
| `relay_group_leave`   | Leave a group voluntarily (admin cannot leave) — **v0.3**                  |
| `relay_group_send`    | Send message; stored + delivered to online members — **v0.3**              |
| `relay_group_history` | Read unread messages; advances cursor — **v0.3**                           |
| `relay_group_list`    | List your groups with unread counts — **v0.3**                             |
| `relay_group_info`    | Group details: admin, members, online status — **v0.3**                    |
| `relay_group_delete`  | Delete group and history (admin only) — **v0.3**                           |

Claude routes to these automatically. You rarely call them by name.

If two sessions share a slugged basename (both `~/Code/backend/api`), Relay suffixes `-2`, `-3`. Use `relay_peers` to disambiguate by `cwd` — or pin the identity with `RELAY_PEER_ID` (see below).

### Fixed identity (v0.2)

By default, sessions are named after the project's directory basename and may collect `-2` / `-3` suffixes if names collide. To pin a session to a stable name across restarts, export `RELAY_PEER_ID` before launching:

```bash
RELAY_PEER_ID=backend-api claude --dangerously-load-development-channels plugin:relay@claude-relay
```

The hub also evicts zombie peers automatically: when a name collision happens, the hub probes the existing socket with a 500ms ping; if it doesn't respond, the slot is freed and the new session takes over. Crashed sessions and orphan plugins no longer block their own re-registration.

### Rooms (v0.2)

Rooms let a subgroup talk without spamming everyone via `relay_broadcast`. They are IRC-style: created implicitly on first join, destroyed when the last member leaves, no permissions, no persistence.

Try:

- _"join the design room"_ → `relay_join({room: "design"})`
- _"who's in the design room?"_ → `relay_rooms()`
- _"tell the design room standup moved to 11"_ → `relay_room({room: "design", text: "..."})`

Room messages arrive as `<channel>` notifications carrying `room`, `from`, `text`, and `msg_id` — but **no `ask_id`**. They are announcements, not questions: don't `relay_reply` to them. If you want a directed answer from one peer in the room, use `relay_ask` instead — `relay_room` is broadcast-style fire-and-forget.

Limits (configurable in `src/hub/handlers.ts`): up to 50 rooms total, 20 members per room.

## Error codes

| Code                 | Meaning                                               |
| -------------------- | ----------------------------------------------------- |
| `peer_not_found`     | No peer registered under that name                    |
| `peer_gone`          | Target peer disconnected before replying              |
| `timeout`            | Ask timed out waiting for a reply                     |
| `name_taken`         | Rename or register name already in use                |
| `not_registered`     | Caller tried to use a tool before registering         |
| `already_registered` | Same socket tried to register twice                   |
| `unknown_ask`        | Reply references an `ask_id` the hub has no record of |
| `bad_msg`            | Malformed JSON or schema-invalid payload              |
| `hub_unreachable`    | Hub socket died or never replied                      |
| `bad_args`           | Tool called with missing or wrong-typed arguments     |
| `protocol_mismatch`  | Client version != hub version; kill the hub and retry |
| `not_member`         | Caller is not a member of the group — **v0.3**        |
| `not_admin`          | Caller is not the group admin — **v0.3**              |
| `group_not_found`    | Group does not exist — **v0.3**                       |

## Debugging

Runtime data lives under `$CLAUDE_PLUGIN_DATA` (`~/.claude/plugins/data/relay-claude-relay/`).

```bash
DATA=~/.claude/plugins/data/relay-claude-relay
tail -f "$DATA/logs/relay-$(date +%Y-%m-%d).log" | jq   # today's log
pgrep -f hub-daemon.ts                                  # hub alive?
pkill -f hub-daemon.ts && rm -f "$DATA/hub.sock"        # force reset
```

Per-session MCP stderr lives under `~/Library/Caches/claude-cli-nodejs/<project-slug>/mcp-logs-*/`. Start there when a channel fails to register.

## How it works

Three pieces:

- **Session** — a Claude Code process you launched.
- **Channel** — per-session MCP server (this plugin). Exposes the `relay_*` tools to Claude and listens for incoming messages.
- **Hub** — single detached daemon per machine. Routes messages between channels over a Unix socket at `$CLAUDE_PLUGIN_DATA/hub.sock`.

The first session to launch spawns the hub; later sessions connect to it. The hub survives session restarts and self-exits five minutes after the last peer disconnects. Incoming peer messages arrive as `notifications/claude/channel` so Claude sees them between turns.

Details: [docs/architecture.md](docs/architecture.md).

## Out of scope

- Single user per machine; no multi-tenant auth
- LAN only in v0.4; internet relay planned for future versions

## Development

Requires [Bun](https://bun.sh) and Claude Code 2.1.80+.

```bash
git clone https://github.com/EcoConsulting/claude-relay
cd claude-relay && bun install
bun run check   # typecheck + lint + format + test
```

For a live-reload loop (edits hit Claude Code on restart), bypass the plugin with a project-scope `.mcp.json`:

```bash
cp .mcp.json.example .mcp.json
/plugin uninstall relay@claude-relay
```

Launch Claude Code with `--dangerously-load-development-channels server:relay` (note `server:`, since the MCP is now manually registered). Reinstall the plugin when you're done. `.mcp.json` is gitignored.

Open an issue before a PR so we can align on scope.

## License

MIT
