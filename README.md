<p align="center">
  <img src="docs/images/banner.png" alt="Eco Relay — Inter-session messaging for AI coding assistants" width="100%">
</p>

<p align="center">
  <a href="https://github.com/josortmel/eco-relay/releases/tag/v0.7.6"><img src="https://img.shields.io/badge/release-v0.7.6-orange" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue" alt="License"></a>
  <img src="https://img.shields.io/badge/TypeScript-Bun-f5f5f5" alt="TypeScript + Bun">
  <img src="https://img.shields.io/badge/MCP-19%20tools-0d9488" alt="MCP Tools">
  <img src="https://img.shields.io/badge/platform-Claude%20Code-7c3aed" alt="Claude Code">
  <img src="https://img.shields.io/badge/platform-OpenCode-0284c7" alt="OpenCode">
</p>

Inter-session messaging for AI coding assistants. Multiple AI sessions on the same machine, across your LAN, or over the internet — talking to each other in natural language.

Two sessions on different projects? Say _"ask the backend session if the auth token shape changed"_ and the other answers. Need a subgroup? Use rooms. Need offline delivery? Use persistent messages or groups. Need cross-machine? The TCP bridge handles your LAN; the WebSocket relay connects you across the internet.

## Demo

![Eco Relay in action](docs/eco-relay-demo.gif)

Seven AI sessions coordinated in real-time: direct asks, broadcast roll calls, ephemeral rooms, persistent groups with offline delivery, and admin governance — all through natural language.

[Watch the full demo (1:49)](https://github.com/josortmel/eco-relay/releases/download/v0.5.0/eco-relay-demo.mp4)

## Architecture

<p align="center">
  <img src="docs/images/architecture.png" alt="Eco Relay architecture — local, LAN, and internet federation" width="100%">
</p>

Four pieces, three transport layers:

- **Channel** — per-session MCP server. Exposes `relay_*` tools and delivers incoming messages via `notifications/claude/channel`.
- **Hub** — single detached daemon per machine. Routes messages over a Unix domain socket. Auto-spawns on first session, auto-exits 5 min after last peer disconnects. Manages mailboxes for offline delivery.
- **Bridge (LAN)** — TCP layer connecting hubs on the same local network. Shared secret auth, auto-reconnect, transparent `name@hub_id` routing.
- **Relay Server (Internet)** — lightweight WebSocket router (~200 lines) that connects hubs across different networks. All connections outbound — works behind NAT, firewalls, and proxies. Stateless message forwarding, no persistence.

Details: [docs/architecture.md](docs/architecture.md).

### Multi-Platform (v0.7.6)

Cross-CLI messaging between Claude Code and OpenCode via a shared Hub daemon. Claude Code: full support. OpenCode: beta — plugin loads and tools appear, Hub connection in progress.

**Installation:**
```bash
git clone https://github.com/josortmel/eco-relay
cd eco-relay && bash scripts/install.sh
```

One command. Installs everything. Open Claude Code or OpenCode — done.

## Features

**Core messaging**

- **Persistent direct messaging** — fire-and-forget messages with offline delivery via relay_send and relay_inbox
- **Broadcast** — ask every session at once, replies stream back
- **Fixed identity** — pin sessions to stable names across restarts via `RELAY_PEER_ID`
- **Zombie eviction** — automatic probe-and-replace for crashed sessions

**Persistent direct messaging** (v0.6)

- **relay_send** — fire-and-forget messages with disk-backed delivery. Online peers get instant push; offline peers retrieve on next session start
- **relay_inbox** — paginated mailbox reader with read tracking
- Ring buffer storage (500 msgs per peer, oldest evicted when full)
- Message threading via `reply_to` references
- Urgent flag for time-sensitive messages

**Persistent groups** (v0.3)

- WhatsApp-style groups with offline delivery and admin governance
- Disk-backed message storage with ring buffer (500 msgs/group)
- Nine tools: create, invite, remove, leave, send, history, list, info, delete

**Cross-machine LAN federation** (v0.4)

- Hub-to-hub TCP bridge — machines on the same network exchange messages transparently
- Remote peers addressed as `name@hub_id` — transparent routing
- Shared secret auth, exponential backoff, auto-reconnect
- Immediate peer removal on disconnect — remote peers disappear from `relay_peers`

**Cross-network internet federation** (v0.7)

- WebSocket relay server connects hubs across different networks (home, office, cloud)
- All connections outbound — works behind NAT, firewalls, and corporate proxies
- Reuses existing bridge protocol — only transport changes (TCP to WebSocket)
- TCP (LAN) and WebSocket (internet) coexist in the same configuration

**Ephemeral rooms** (v0.2)

- IRC-style channels — created on first join, destroyed when empty
- Fire-and-forget broadcast within a topic group

### Platform support

| Platform               | Status               |
| ---------------------- | -------------------- |
| Claude Code CLI        | Full support         |
| OpenCode               | Beta (v0.7.6) |
| Other AI CLI platforms | Planned (v1.0)       |

Eco Relay ships as a Claude Code plugin. The hub and bridge layers are already platform-agnostic — extending to other CLI-based AI assistants (Codex, Antigravity, Cursor, and other agentic harnesses) is the design goal for v1.0.

## Install

Requires [Bun](https://bun.sh) and Claude Code 2.1.80+.

> **Windows users**: Bun must be installed on Windows natively, not inside WSL. Claude Code runs as a Windows process and needs `bun` accessible from PowerShell/CMD. Install with: `powershell -c "irm bun.sh/install.ps1 | iex"`

### Quick install (CC + OC)

```bash
git clone https://github.com/josortmel/eco-relay
cd eco-relay && bash scripts/install.sh
```

### Claude Code only (marketplace)

### 1. Add the marketplace

```
/plugin marketplace add josortmel/eco-relay
```

### 2. Install the plugin

```
/plugin install relay@eco-relay
```

### 3. Install dependencies

Dependencies install automatically on first launch. If auto-install fails (e.g. Bun not in PATH), you'll see a clear error message telling you what to do. Manual install as fallback:

```bash
cd ~/.claude/plugins/cache/eco-relay/relay/*/
bun install
```

> **Windows PowerShell**: `cd "$env:USERPROFILE\.claude\plugins\cache\eco-relay\relay\*"; bun install`

### 4. Launch with required flags

**Both flags are mandatory.** Without them, the plugin either won't receive push messages or will prompt for every action.

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:relay@eco-relay
```

| Flag                                      | What it does                                      | What happens without it                                                                                     |
| ----------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `--dangerously-load-development-channels` | Enables `notifications/claude/channel` capability | MCP connects and tools work, but incoming messages never arrive — you'd have to poll `relay_inbox` manually |
| `--dangerously-skip-permissions`          | Skips confirmation prompts on tool calls          | Every `relay_send`, `relay_peers`, etc. asks for confirmation — unusable for agent-to-agent communication   |

Open two sessions in different directories and try the examples below.

## Usage

Natural language works out of the box:

- _"what sessions are active?"_
- _"ask backend-api what they're working on"_
- _"ask everyone to report status"_
- _"send a message to backend-api — I'll be offline for an hour"_

Rename your session: `/relay-rename backend-api` or just say _"call yourself backend-api"_.

### Tools

| Tool                  | What it does                                                          |
| --------------------- | --------------------------------------------------------------------- |
| `relay_peers`         | List active sessions                                                  |
| `relay_reply`         | Answer an incoming ask or message (auto-detects `ask_id` vs `msg_id`) |
| `relay_send`          | Send a persistent message (online push or offline queue)              |
| `relay_inbox`         | Read your mailbox (offline messages waiting for you)                  |
| `relay_broadcast`     | Ask every peer — replies stream back                                  |
| `relay_rename`        | Rename this session                                                   |
| `relay_join`          | Join an ephemeral room                                                |
| `relay_leave`         | Leave a room                                                          |
| `relay_room`          | Send a message to all room members                                    |
| `relay_rooms`         | List rooms and their members                                          |
| `relay_group_create`  | Create a persistent group                                             |
| `relay_group_invite`  | Invite a peer (admin only)                                            |
| `relay_group_remove`  | Remove a member with reason (admin only)                              |
| `relay_group_leave`   | Leave a group                                                         |
| `relay_group_send`    | Send message — stored + delivered to online members                   |
| `relay_group_history` | Read unread messages (advances cursor)                                |
| `relay_group_list`    | List your groups with unread counts                                   |
| `relay_group_info`    | Group details: admin, members, online status                          |
| `relay_group_delete`  | Delete group and history (admin only)                                 |

`relay_reply` works with both asks and messages: it auto-detects whether you are replying to an `ask_id` or a `msg_id`.

### Fixed identity

Pin a session to a stable name across restarts:

```bash
RELAY_PEER_ID=backend-api claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:relay@eco-relay
```

## Connection guide

### Local (same machine)

No configuration needed. The hub daemon starts automatically when the first session connects. All sessions on the same machine see each other via `relay_peers`.

### LAN federation (same network, different machines)

Each machine runs its own hub; the TCP bridge links them. Create `bridge.json` in the relay data directory on each machine:

```bash
# Find your data directory (it's where the hub socket lives):
ls ~/.claude/plugins/data/relay-eco-relay/    # plugin mode (most users)
ls ~/.eco-relay/                               # standalone/development mode
```

> **Important**: the hub searches for `bridge.json` in the plugin data directory first (`~/.claude/plugins/data/relay-eco-relay/`), falling back to `~/.eco-relay/`. Create `bridge.json` in whichever directory exists on your system.

> **Windows PowerShell**: do NOT use `echo '...' > file.json` — PowerShell adds a BOM that breaks JSON parsing. Use `[System.IO.File]::WriteAllText("path\bridge.json", '{"..."}')` instead.

**Machine A**:

```json
{
    "hub_id": "machine-a",
    "listen": 9700,
    "secret": "your-shared-secret-min-8-chars",
    "peers": [{ "hub_id": "machine-b", "host": "192.168.1.X", "port": 9700 }]
}
```

**Machine B**:

```json
{
    "hub_id": "machine-b",
    "listen": 9700,
    "secret": "your-shared-secret-min-8-chars",
    "peers": [{ "hub_id": "machine-a", "host": "192.168.1.Y", "port": 9700 }]
}
```

Restart sessions on both machines. Peers appear as `name@machine-b` in `relay_peers`. Messages route transparently.

Diagnostic: `bun run scripts/bridge-check.ts` validates config, tests port availability, TCP connectivity, and handshake.

### Internet federation (different networks)

Connect machines across the internet via a WebSocket relay server. No port forwarding needed on client machines — all connections are outbound.

**Step 1 — Start the relay server** on a machine with a public IP (VPS, cloud instance) or use ngrok for testing:

```bash
cat > relay-config.json << 'EOF'
{
    "port": 9800,
    "secret": "relay-secret-min-8-chars"
}
EOF

bun run src/relay-server/index.ts relay-config.json
```

For testing without a public IP:

```bash
# Terminal 1: start relay server locally
bun run src/relay-server/index.ts relay-config.json

# Terminal 2: expose via ngrok
ngrok tcp 9800
# ngrok gives you a URL like: tcp://0.tcp.ngrok.io:12345
```

**Step 2 — Configure each machine** — add `relay` to your `bridge.json` (see LAN section above for the correct path):

> **Note**: ngrok TCP endpoints require a credit/debit card on file (free, not charged). Add one at https://dashboard.ngrok.com/settings#id-verification

```json
{
    "hub_id": "sevilla",
    "relay": {
        "url": "ws://your-relay-server:9800",
        "token": "relay-secret-min-8-chars"
    }
}
```

With ngrok, use the ngrok URL: `"url": "ws://0.tcp.ngrok.io:12345"`.

The `token` must match the relay server's `secret`. For production, put the relay server behind a TLS-terminating reverse proxy and use `wss://`.

**Step 3 — Restart the hub and sessions.** The hub daemon must be restarted to read the new `bridge.json`:

```bash
# Kill the hub daemon (it survives session restarts)
pkill -f hub-daemon.ts && rm -f ~/.claude/plugins/data/relay-eco-relay/hub.sock
# Or on Windows:
# Get-Process -Name "bun" | Where-Object {$_.CommandLine -like "*hub*"} | Stop-Process
```

Reopen your Claude Code sessions. The hub will respawn and read the bridge config. Peers from other machines appear as `name@hub_id` in `relay_peers`.

### LAN + Internet simultaneously

Add both `peers` (LAN) and `relay` (internet) to the same bridge.json. Local machines connect via fast TCP; remote machines connect via the relay.

```json
{
    "hub_id": "office",
    "listen": 9700,
    "secret": "lan-secret",
    "peers": [{ "hub_id": "colleague", "host": "192.168.1.X", "port": 9700 }],
    "relay": {
        "url": "wss://relay.example.com",
        "token": "internet-secret"
    }
}
```

### Security notes

- **LAN**: shared secret sent in plaintext over TCP. Acceptable for trusted local networks.
- **Internet**: use `wss://` with a TLS-terminating reverse proxy for production. For testing, `ngrok tcp` provides a public endpoint.
- **Notification meta**: all values must be strings (not booleans or numbers). Boolean values in notification meta crash Claude Code sessions.
- **Data directory**: `~/.claude/plugins/data/relay-eco-relay/` (plugin mode) or `~/.eco-relay/` (standalone). Contains bridge.json (secrets), mailboxes, and group data. Permissions set to 0700 (owner-only).

## Roadmap

| Version | Status   | What                                                                                          |
| ------- | -------- | --------------------------------------------------------------------------------------------- |
| v0.2    | Released | Ephemeral rooms (IRC-style)                                                                   |
| v0.3    | Released | Persistent groups with offline delivery                                                       |
| v0.4    | Released | LAN federation (TCP bridge)                                                                   |
| v0.5    | Released | Claude Code plugin packaging                                                                  |
| v0.6    | Released | Persistent direct messaging (mailbox)                                                         |
| v0.7    | Released | Internet federation (WebSocket relay)                                                         |
| v0.7.5  | Released | Multi-platform (OpenCode plugin + Hub WS endpoint)                                            |
| v0.7.6  | Current  | Bootstrap symmetry, lock file, push URL auto-discovery, install unified, debt zero            |
| v0.8    | Next     | End-to-end encryption                                                                         |
| v1.0    | Planned  | Platform-agnostic (adapter layer for Codex, Antigravity, Cursor, and other agentic harnesses) |

<p align="center">
  <img src="docs/images/platforms.png" alt="Platform roadmap — Codex, Antigravity, Cursor, Aider, Cline" width="100%">
</p>

## Error codes

| Code                 | Meaning                                  |
| -------------------- | ---------------------------------------- |
| `name_taken`         | Name already in use                      |
| `not_registered`     | Tool used before registering             |
| `already_registered` | Same socket tried to register twice      |
| `bad_msg`            | Malformed payload                        |
| `bad_args`           | Wrong-typed arguments                    |
| `hub_unreachable`    | Hub socket not responding                |
| `protocol_mismatch`  | Version mismatch — restart the hub       |
| `mailbox_error`      | Disk I/O failure in mailbox storage      |
| `not_member`         | Not a member of the group                |
| `not_admin`          | Not the group admin                      |
| `group_not_found`    | Group does not exist                     |
| `unexpected`         | Generic fallback for unclassified errors |

## Debugging

```bash
# Plugin mode (most users):
DATA=~/.claude/plugins/data/relay-eco-relay
# Standalone/development mode:
# DATA=~/.eco-relay

# Watch relay logs
tail -f "$DATA/logs/relay-$(date +%Y-%m-%d).log" | jq

# Check if hub is running
pgrep -f hub-daemon.ts

# Force reset (kills hub, removes socket — sessions will respawn it)
pkill -f hub-daemon.ts && rm -f "$DATA/hub.sock"
```

**MCP plugin logs** (when the plugin fails to start with error -32000):

- macOS: `~/Library/Caches/claude-cli-nodejs/<project-slug>/mcp-logs-*/`
- Windows: `%LOCALAPPDATA%\claude-cli-nodejs\<project-slug>\mcp-logs-*/`

**Common issues**:

- `ENOENT while resolving package 'zod'` → run `bun install` in the plugin cache directory (see Install step 3)
- `MCP error -32000: Connection closed` → check MCP logs above for the real error
- Bridge connected but no remote peers → verify `bridge.json` is in the correct data directory (see Connection guide)
- Messages delivered but not pushed → missing `--dangerously-load-development-channels` flag

## Development

Requires [Bun](https://bun.sh) and Claude Code 2.1.80+.

```bash
git clone https://github.com/josortmel/eco-relay
cd eco-relay && bun install
bun run check   # typecheck + lint + format + test
```

For live-reload development against a local copy instead of the installed plugin:

```bash
cp .mcp.json.example .mcp.json
```

Then uninstall the plugin (`/plugin uninstall relay@eco-relay` inside Claude Code) and launch with:

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:relay
```

Reinstall the plugin when done.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for personal and noncommercial use. Commercial use requires a separate license from Eco Consulting.

Based on [claude-relay](https://github.com/innestic/claude-relay) by Innestic, originally licensed under MIT. See [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).

## Maintainers

- [@josortmel](https://github.com/josortmel)
- [@EcoConsulting](https://github.com/EcoConsulting)
