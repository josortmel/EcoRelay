# Eco Relay — Rebranding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand the EcoConsulting/claude-relay fork into an independent project "Eco Relay" under `josortmel/eco-relay`, with PolyForm Noncommercial license and proper attribution to the original MIT project.

**Architecture:** Change all metadata, license, documentation, and 2 runtime path references. No functional code changes — all 268 tests must still pass. Create new GitHub repo (not a fork), push full commit history, archive old fork with redirect.

**Tech Stack:** Bun, TypeScript, GitHub CLI (`gh`)

**Repo:** `C:/Users/Admin/.claude/plugins/marketplaces/claude-relay`

**Version:** Sync all version fields to `0.5.0` (marks the rebrand; current state is desync'd — package.json says 0.2.1, mcp-server.ts says 0.1.0, CHANGELOG says 0.4.0).

---

## File Structure

| Action | File | What changes |
|--------|------|-------------|
| Rewrite | `LICENSE` | MIT Innestic → PolyForm Noncommercial 1.0.0, Eco Consulting |
| Create | `THIRD_PARTY_LICENSES` | MIT attribution to Innestic for original claude-relay |
| Modify | `package.json` | name, version, author, repository |
| Modify | `.claude-plugin/plugin.json` | version, author, homepage, repository, license |
| Modify | `.claude-plugin/marketplace.json` | name, owner, version |
| Modify | `src/channel/mcp-server.ts:16` | server name + version |
| Modify | `src/data-dir.ts:12` | fallback path `.claude-relay` → `.eco-relay` |
| Modify | `src/data-dir.ts:9` | comment |
| Modify | `scripts/bridge-check.ts:7` | fallback path `.claude-relay` → `.eco-relay` |
| Modify | `src/logger.ts:20` | comment |
| Rewrite | `README.md` | Full rewrite — new branding, professional portfolio piece |
| Modify | `CHANGELOG.md:1-6` | Header rebrand |
| Modify | `UBIQUITOUS_LANGUAGE.md` | path reference |
| Modify | `docs/architecture.md` | path reference |
| Delete | `docs/superpowers/plans/2026-05-16-persistent-groups-hub.md` | Old plan artifact |

**Not touched:** All `src/` runtime and test files except the 3 listed above. Tool names (`relay_*`) stay stable — they describe function, not brand.

---

### Task 1: Baseline verification

**Files:** None modified.

- [ ] **Step 1: Run full test suite**

```bash
cd C:/Users/Admin/.claude/plugins/marketplaces/claude-relay
bun test
```

Expected: 268 tests, all PASS. If any fail, stop and investigate before proceeding.

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: clean, no errors.

---

### Task 2: License & Attribution

**Files:**
- Rewrite: `LICENSE`
- Create: `THIRD_PARTY_LICENSES`

- [ ] **Step 1: Replace LICENSE with PolyForm Noncommercial 1.0.0**

Fetch the canonical license text first to verify:
```bash
curl -s https://polyformproject.org/licenses/noncommercial/1.0.0/ | head -5
```

Then write `LICENSE`:

```
# PolyForm Noncommercial License 1.0.0

<https://polyformproject.org/licenses/noncommercial/1.0.0>

## Acceptance

In order to get any license under these terms, you must agree
to them as both strict obligations and conditions to all
your licenses.

## Copyright License

The licensor grants you a copyright license for the
software to do everything you might do with the software
that would otherwise infringe the licensor's copyright
in it for any permitted purpose. However, you may only
distribute the software according to [Distribution
License](#distribution-license) and make changes or new works
based on the software according to [Changes and New Works
License](#changes-and-new-works-license).

## Distribution License

The licensor grants you an additional copyright license
to distribute copies of the software. Your license
to distribute covers distributing the software with
changes and new works permitted by [Changes and New Works
License](#changes-and-new-works-license).

## Notices

You must ensure that anyone who gets a copy of any part of
the software from you also gets a copy of these terms or the
URL for them above, as well as copies of any plain-text lines
beginning with `Required Notice:` that the licensor provided
with the software. For example:

> Required Notice: Copyright Eco Consulting
> (https://github.com/EcoConsulting)

## Changes and New Works License

The licensor grants you an additional copyright license to
make changes and new works based on the software for any
permitted purpose.

## Patent License

The licensor grants you a patent license for the software that
covers patent claims the licensor can license, or becomes able
to license, that you would infringe by using the software.

## Noncommercial Purposes

Any noncommercial purpose is a permitted purpose.

## Personal Uses

Personal use for research, experiment, and testing for
the benefit of public knowledge, personal study, private
entertainment, hobby projects, amateur pursuits, or religious
observance, without any anticipated commercial application,
is use for a permitted purpose.

## Noncommercial Organizations

Use by any charitable organization, educational institution,
public research organization, public safety or health
organization, environmental protection organization, or
government institution is use for a permitted purpose
regardless of the source of funding or obligations resulting
from the funding.

## Fair Use

You may have "fair use" rights for the software under the
law. These terms do not limit them.

## No Other Rights

These terms do not allow you to sublicense or transfer any of
your licenses to anyone else, or prevent the licensor from
granting licenses to anyone else. These terms do not imply
any other licenses.

## Patent Defense

If you make any written claim that the software infringes or
contributes to infringement of any patent, your patent license
for the software granted under these terms ends immediately. If
your company makes such a claim, your patent license ends
immediately for work on behalf of your company.

## Violations

The first time you are notified in writing that you have
violated any of these terms, or done anything with the software
not covered by your licenses, your licenses can nonetheless
continue if you come into full compliance with these terms,
and take practical steps to correct past violations, within
32 days of receiving notice. Otherwise, all your licenses
end immediately.

## No Liability

***As far as the law allows, the software comes as is, without
any warranty or condition, and the licensor will not be liable
to you for any damages arising out of these terms or the use
or nature of the software, under any kind of legal claim.***

## Definitions

The **licensor** is the individual or entity offering these
terms, and the **software** is the software the licensor makes
available under these terms.

**You** refers to the individual or entity agreeing to these
terms.

**Your company** is any legal entity, sole proprietorship,
or other kind of organization that you work for, plus all
organizations that have control over, are under the control of,
or are under common control with that organization. **Control**
means ownership of substantially all the assets of an entity,
or the power to direct its management and policies by vote,
contract, or otherwise. Control can be direct or indirect.

**Your licenses** are all the licenses granted to you for the
software under these terms.

**Use** means anything you do with the software requiring one
of your licenses.
```

**IMPORTANT:** Verify the text matches the canonical source at `https://polyformproject.org/licenses/noncommercial/1.0.0/` before committing. The text above is from training data and may have minor formatting differences.

- [ ] **Step 2: Create THIRD_PARTY_LICENSES**

```
This project is based on claude-relay by Innestic.

The original code is licensed under the MIT License:

---

MIT License

Copyright (c) 2026 Innestic

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

Source: https://github.com/innestic/claude-relay
```

---

### Task 3: Package metadata & version sync

**Files:**
- Modify: `package.json`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

- [ ] **Step 1: Update package.json**

Change these fields (leave everything else untouched):

```json
{
    "name": "eco-relay",
    "version": "0.5.0",
```

Add after `"version"`:

```json
    "author": "Eco Consulting (https://github.com/EcoConsulting)",
    "contributors": [
        "josortmel (https://github.com/josortmel)",
        "Eco Consulting (https://github.com/EcoConsulting)"
    ],
    "repository": {
        "type": "git",
        "url": "https://github.com/josortmel/eco-relay.git"
    },
    "license": "PolyForm-Noncommercial-1.0.0",
```

- [ ] **Step 2: Update .claude-plugin/plugin.json**

Full file:

```json
{
    "name": "relay",
    "version": "0.5.0",
    "description": "Inter-session communication for AI coding assistants. Direct messaging, persistent groups, and cross-machine LAN federation.",
    "author": {
        "name": "Eco Consulting",
        "url": "https://github.com/EcoConsulting"
    },
    "homepage": "https://github.com/josortmel/eco-relay",
    "repository": "https://github.com/josortmel/eco-relay",
    "license": "PolyForm-Noncommercial-1.0.0",
    "keywords": ["mcp", "claude-code", "multi-agent", "messaging", "inter-session", "federation"],
    "mcpServers": {
        "relay": {
            "command": "bun",
            "args": ["run", "${CLAUDE_PLUGIN_ROOT}/src/main.ts"]
        }
    }
}
```

Note: `"name": "relay"` stays unchanged — this is the plugin identifier and affects tool prefixes (`relay_ask`, etc.).

- [ ] **Step 3: Update .claude-plugin/marketplace.json**

Full file:

```json
{
    "name": "eco-relay",
    "owner": {
        "name": "Eco Consulting",
        "url": "https://github.com/EcoConsulting"
    },
    "plugins": [
        {
            "name": "relay",
            "source": "./",
            "description": "Inter-session communication for AI coding assistants — direct messaging, persistent groups, cross-machine LAN federation",
            "version": "0.5.0"
        }
    ]
}
```

---

### Task 4: MCP server identity

**Files:**
- Modify: `src/channel/mcp-server.ts:16`

- [ ] **Step 1: Update server name and version**

In `src/channel/mcp-server.ts`, line 16, change:

```typescript
        { name: "relay-channel", version: "0.1.0" },
```

to:

```typescript
        { name: "eco-relay", version: "0.5.0" },
```

---

### Task 5: Runtime paths

**Files:**
- Modify: `src/data-dir.ts` (line 9 comment + line 12 path)
- Modify: `scripts/bridge-check.ts` (line 7 path)
- Modify: `src/logger.ts` (line 20 comment)

- [ ] **Step 1: Update src/data-dir.ts**

Line 9 — change comment:
```
 * 2. ~/.claude-relay/ — fallback for manual installs.
```
to:
```
 * 2. ~/.eco-relay/ — fallback for manual installs.
```

Line 12 — change path:
```typescript
    return process.env.CLAUDE_PLUGIN_DATA ?? path.join(os.homedir(), ".claude-relay");
```
to:
```typescript
    return process.env.CLAUDE_PLUGIN_DATA ?? path.join(os.homedir(), ".eco-relay");
```

- [ ] **Step 2: Update scripts/bridge-check.ts**

Line 7 — change:
```typescript
process.env.CLAUDE_PLUGIN_DATA ?? path.join(require("node:os").homedir(), ".claude-relay");
```
to:
```typescript
process.env.CLAUDE_PLUGIN_DATA ?? path.join(require("node:os").homedir(), ".eco-relay");
```

- [ ] **Step 3: Update src/logger.ts comment**

Line 20 — change:
```
 * Creates ~/.claude-relay/logs/ if missing and configures transports.
```
to:
```
 * Creates ~/.eco-relay/logs/ if missing and configures transports.
```

---

### Task 6: README.md — full rewrite

**Files:**
- Rewrite: `README.md`

- [ ] **Step 1: Write new README.md**

```markdown
# Eco Relay

Inter-session communication for AI coding assistants. Let multiple AI sessions on the same machine — or across your LAN — talk to each other in natural language.

Two sessions on different projects? In one, say _"ask the backend session if the auth token shape changed"_ and the other answers. Need a subgroup? Use rooms. Need offline delivery? Use persistent groups. Need cross-machine? The TCP bridge has you covered.

## Features

**Core messaging**
- **Direct ask/reply** — ask one peer, get a natural-language reply
- **Broadcast** — ask every session at once, replies stream back
- **Fixed identity** — pin sessions to stable names across restarts via `RELAY_PEER_ID`
- **Zombie eviction** — automatic probe-and-replace for crashed sessions

**Persistent groups** (v0.3)
- WhatsApp-style groups with offline delivery and admin governance
- Disk-backed message storage with ring buffer (500 msgs/group)
- Nine tools: create, invite, remove, leave, send, history, list, info, delete

**Cross-machine LAN federation** (v0.4)
- Hub-to-hub TCP bridge — two machines on the same network exchange messages transparently
- Remote peers as `name@hub_id` — transparent routing via `relay_ask`
- Shared secret auth, exponential retry with backoff, auto-reconnect
- Bridge disconnect sends immediate `peer_gone` — no 600s timeout hangs

**Ephemeral rooms** (v0.2)
- IRC-style channels — created on first join, destroyed when empty
- Fire-and-forget broadcast within a topic group

### Platform support

| Platform | Status |
|----------|--------|
| Claude Code CLI | Full support |
| Other AI CLI platforms | Planned |

Eco Relay currently ships as a Claude Code plugin. The architecture (hub + channel + protocol) is platform-agnostic — extending to other CLI-based AI assistants is a design goal.

## Install

### 1. Add the marketplace

```
/plugin marketplace add josortmel/eco-relay
```

### 2. Install the plugin

```
/plugin install relay@eco-relay
```

### 3. Launch with channel capability

Eco Relay delivers messages via `notifications/claude/channel` (Claude Code research preview). Each session must be launched with:

```bash
claude --dangerously-load-development-channels plugin:relay@eco-relay
```

Open two sessions in different directories and try the examples below.

## Usage

Natural language works out of the box:

- _"what sessions are active?"_
- _"ask backend-api what they're working on"_
- _"ask everyone to report status"_

Rename your session: `/relay-rename backend-api` or just say _"call yourself backend-api"_.

### Tools

| Tool | What it does |
|------|-------------|
| `relay_peers` | List active sessions |
| `relay_ask` | Ask one peer — reply arrives as a notification |
| `relay_reply` | Answer an incoming ask by `ask_id` |
| `relay_broadcast` | Ask every peer — replies stream back |
| `relay_rename` | Rename this session |
| `relay_join` | Join an ephemeral room |
| `relay_leave` | Leave a room |
| `relay_room` | Send a message to all room members |
| `relay_rooms` | List rooms and their members |
| `relay_group_create` | Create a persistent group |
| `relay_group_invite` | Invite a peer (admin only) |
| `relay_group_remove` | Remove a member with reason (admin only) |
| `relay_group_leave` | Leave a group |
| `relay_group_send` | Send message — stored + delivered to online members |
| `relay_group_history` | Read unread messages (advances cursor) |
| `relay_group_list` | List your groups with unread counts |
| `relay_group_info` | Group details: admin, members, online status |
| `relay_group_delete` | Delete group and history (admin only) |

### Fixed identity

Pin a session to a stable name across restarts:

```bash
RELAY_PEER_ID=backend-api claude --dangerously-load-development-channels plugin:relay@eco-relay
```

### Cross-machine setup

Create `bridge.json` in the relay data directory on each machine:

```json
{
    "hub_id": "my-machine",
    "listen": 9700,
    "secret": "shared-secret-min-8-chars",
    "peers": [{ "hub_id": "other-machine", "host": "192.168.1.X", "port": 9700 }]
}
```

Run the diagnostic script to verify connectivity:

```bash
bun run scripts/bridge-check.ts
```

Without `bridge.json`, Eco Relay works as a local-only tool — no changes needed.

## Architecture

Three pieces:

- **Channel** — per-session MCP server. Exposes `relay_*` tools and listens for incoming messages.
- **Hub** — single detached daemon per machine. Routes messages over a Unix socket.
- **Bridge** — optional TCP layer connecting hubs across machines.

The first session spawns the hub; later sessions connect to it. The hub self-exits 5 minutes after the last peer disconnects. Incoming messages arrive as `notifications/claude/channel`.

Details: [docs/architecture.md](docs/architecture.md).

## Error codes

| Code | Meaning |
|------|---------|
| `peer_not_found` | No peer registered under that name |
| `peer_gone` | Target disconnected before replying |
| `timeout` | Ask timed out (10 min default) |
| `name_taken` | Name already in use |
| `not_registered` | Tool used before registering |
| `already_registered` | Same socket tried to register twice |
| `unknown_ask` | Reply references unknown `ask_id` |
| `bad_msg` | Malformed payload |
| `hub_unreachable` | Hub socket not responding |
| `bad_args` | Wrong-typed arguments |
| `protocol_mismatch` | Version mismatch — restart the hub |
| `not_member` | Not a member of the group |
| `not_admin` | Not the group admin |
| `group_not_found` | Group does not exist |

## Debugging

```bash
DATA=~/.claude/plugins/data/relay-eco-relay
tail -f "$DATA/logs/relay-$(date +%Y-%m-%d).log" | jq
pgrep -f hub-daemon.ts
pkill -f hub-daemon.ts && rm -f "$DATA/hub.sock"   # force reset
```

## Development

Requires [Bun](https://bun.sh) and Claude Code 2.1.80+.

```bash
git clone https://github.com/josortmel/eco-relay
cd eco-relay && bun install
bun run check   # typecheck + lint + format + test
```

For live-reload development:

```bash
cp .mcp.json.example .mcp.json
/plugin uninstall relay@eco-relay
```

Launch with `--dangerously-load-development-channels server:relay`. Reinstall the plugin when done.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for personal and noncommercial use. Commercial use requires a separate license from Eco Consulting.

Based on [claude-relay](https://github.com/innestic/claude-relay) by Innestic, originally licensed under MIT. See [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).

## Maintainers

- [@josortmel](https://github.com/josortmel)
- [@EcoConsulting](https://github.com/EcoConsulting)
```

---

### Task 7: CHANGELOG & supporting docs

**Files:**
- Modify: `CHANGELOG.md` (lines 1-6)
- Modify: `UBIQUITOUS_LANGUAGE.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Rebrand CHANGELOG header**

Replace lines 1-6:

```markdown
# Changelog

All notable changes to this fork are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

This is an internal fork of [innestic/claude-relay](https://github.com/innestic/claude-relay) maintained by Eco Consulting. The public marketplace ships v0.1.0; this branch carries the extensions described below and is not currently distributed via the marketplace.
```

With:

```markdown
# Changelog

All notable changes to Eco Relay are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

Eco Relay is based on [claude-relay](https://github.com/innestic/claude-relay) by Innestic (MIT). Versions prior to 0.5.0 were developed as an internal fork under [EcoConsulting/claude-relay](https://github.com/EcoConsulting/claude-relay).
```

Then add a new version entry at the top (after the header, before `## [0.4.0]`):

```markdown
## [0.5.0] — 2026-05-19

Rebranded to **Eco Relay**. Independent project under [josortmel/eco-relay](https://github.com/josortmel/eco-relay). License changed from MIT to PolyForm Noncommercial 1.0.0.

### Changed

- Project name: claude-relay → Eco Relay.
- License: MIT → PolyForm Noncommercial 1.0.0 (original MIT attribution preserved in THIRD_PARTY_LICENSES).
- Repository: moved from EcoConsulting/claude-relay to josortmel/eco-relay.
- All version fields synced to 0.5.0.
- Fallback data directory: `~/.claude-relay/` → `~/.eco-relay/`.
- MCP server identity: `relay-channel` → `eco-relay`.
```

- [ ] **Step 2: Update UBIQUITOUS_LANGUAGE.md**

Find the reference to `$CLAUDE_PLUGIN_DATA/hub.sock (plugin) or ~/.claude-relay/hub.sock` and change `~/.claude-relay/` to `~/.eco-relay/`.

- [ ] **Step 3: Update docs/architecture.md**

Find the reference to `$CLAUDE_PLUGIN_DATA/logs/ (plugin) or ~/.claude-relay/logs/` and change `~/.claude-relay/` to `~/.eco-relay/`.

---

### Task 8: Cleanup, verify & commit

**Files:**
- Delete: `docs/superpowers/plans/2026-05-16-persistent-groups-hub.md`

- [ ] **Step 1: Remove old plan artifact**

```bash
rm docs/superpowers/plans/2026-05-16-persistent-groups-hub.md
```

- [ ] **Step 2: Run full test suite**

```bash
bun test
```

Expected: 268 tests, all PASS. The only runtime changes are 2 fallback paths that are only used when `CLAUDE_PLUGIN_DATA` is unset (manual installs) — tests use the env var, so they should be unaffected.

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

Expected: clean.

- [ ] **Step 4: Run lint + format check**

```bash
bun run check
```

Expected: clean pass on all checks (typecheck + lint + format + test).

- [ ] **Step 5: Commit all changes**

```bash
git add -A
git commit -m "feat: rebrand to Eco Relay v0.5.0

- License: PolyForm Noncommercial 1.0.0 (MIT attribution in THIRD_PARTY_LICENSES)
- Repository: josortmel/eco-relay
- All version fields synced to 0.5.0
- Fallback data dir: ~/.eco-relay/
- README rewritten for independent project identity"
```

---

### Task 9: GitHub operations

**These steps are executed by Hilo (orchestrator), not by code.**

- [ ] **Step 1: Switch to josortmel account**

```bash
gh auth switch --user josortmel
```

- [ ] **Step 2: Create new public repo**

```bash
gh repo create josortmel/eco-relay --public --description "Inter-session communication for AI coding assistants. Direct messaging, persistent groups, cross-machine LAN federation."
```

- [ ] **Step 3: Add new remote and push**

```bash
git remote add eco-relay https://github.com/josortmel/eco-relay.git
git push eco-relay main
```

- [ ] **Step 4: Add EcoConsulting as collaborator (admin)**

```bash
gh api repos/josortmel/eco-relay/collaborators/EcoConsulting -X PUT -f permission=admin
```

Note: this invites the EcoConsulting org. If GitHub requires inviting individual users rather than orgs, use:
```bash
gh api repos/josortmel/eco-relay/collaborators/EcoConsulting -X PUT -f permission=admin
```
And accept the invitation from the EcoConsulting account.

- [ ] **Step 5: Archive old fork**

Switch back to EcoConsulting:
```bash
gh auth switch --user EcoConsulting
```

Update the old repo description and archive it:
```bash
gh repo edit EcoConsulting/claude-relay --description "ARCHIVED — moved to https://github.com/josortmel/eco-relay"
gh repo archive EcoConsulting/claude-relay --yes
```

- [ ] **Step 6: Verify**

```bash
gh repo view josortmel/eco-relay
```

Confirm: public, description correct, files visible.

---

## Post-deployment: local migration (Pepe's machine)

After the repo is live, the local plugin installation needs updating. These are manual steps for Pepe:

1. **Uninstall old plugin:**
   ```
   /plugin uninstall relay@claude-relay
   /plugin marketplace remove claude-relay
   ```

2. **Install new plugin:**
   ```
   /plugin marketplace add josortmel/eco-relay
   /plugin install relay@eco-relay
   ```

3. **Migrate data directory** (preserves groups, bridge config, logs):
   ```bash
   cp -r ~/.claude/plugins/data/relay-claude-relay/ ~/.claude/plugins/data/relay-eco-relay/
   ```

4. **Update launch commands** in `.bat` files:
   Change `plugin:relay@claude-relay` → `plugin:relay@eco-relay`

5. **Update `.claude/settings.json`** if it references `claude-relay` in any allow/deny rules.
