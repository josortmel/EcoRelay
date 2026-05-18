# Changelog

All notable changes to this fork are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

This is an internal fork of [innestic/claude-relay](https://github.com/innestic/claude-relay) maintained by Eco Consulting. The public marketplace ships v0.1.0; this branch carries the extensions described below and is not currently distributed via the marketplace.

## [0.4.0] — 2026-05-18

Cross-machine LAN federation: hub-to-hub TCP bridge. Two machines on the same network exchange relay messages transparently. 5 adversarial security loops.

### Added

- **TCP bridge** (`src/hub/bridge.ts`): server + client with shared secret auth, protocol version check, handshake timeout (5s both sides), duplicate hub_id rejection.
- **Bridge config** (`src/hub/bridge-config.ts`): `bridge.json` loader with Zod validation. Fields: `hub_id`, `listen`, `bind`, `secret`, `peers[]`.
- **Remote peer registry**: peers from other hubs tracked as `name@hub_id`. Included in `relay_peers`, transparent to `relay_ask`/`relay_reply`.
- **Bridge forward handler**: receives cross-hub messages, validates with `ServerMsgSchema`, always re-qualifies `from` with verified hub_id (no spoofing), guards `incoming_reply`/`err` to only affect cross-hub asks.
- **Exponential retry**: connection failures retry at 1s→2s→4s→8s→16s→30s cap. Auto-reconnect on disconnect with attempt reset on success.
- **Bridge disconnect cleanup**: immediate `peer_gone` to all callers with in-flight asks targeting the disconnected hub. Mirror pending asks cleaned up.
- **Peer sync**: `bridge_peer_update` messages notify remote hubs when local peers join/leave.
- **Channel enrichment**: `origin_hub` field in notification meta for cross-machine messages.
- **Diagnostic script**: `scripts/bridge-check.ts` — validates config, tests port availability, TCP connectivity, and full handshake with each configured peer.
- **4 bridge protocol schemas**: `BridgeHelloMsg`, `BridgeWelcomeMsg`, `BridgePeerUpdateMsg`, `BridgeForwardMsg`. Separate `BridgeMsgSchema` (not mixed with client/server schemas).
- 24 new tests (19 bridge + 5 groups). Total suite: 268.

### Security

- Shared secret auth on handshake (plaintext for LAN, HMAC planned for internet).
- `from` field always stripped and re-qualified with verified `remoteHubId` from handshake — prevents hub impersonation even from authenticated peers.
- `ServerMsgSchema.safeParse` validates all forwarded messages before delivery to local peers.
- `incoming_reply` and `err` messages only resolve pending asks where `target.includes("@")` — prevents malicious hub from interfering with local ask/reply flows.
- Peer arrays capped at 500 per hub (`BridgeHelloMsg`, `BridgeWelcomeMsg`). Remote peers per hub capped at 500.
- `bridge.json` gets `chmod 0600` on non-Windows.
- `hub_id` validated with `min(1).max(64)` on wire schemas.
- Protocol version checked during handshake — incompatible versions rejected.
- `welcome.hub_id` verified against expected `peerConfig.hub_id` — prevents MITM.
- Client handshake timeout matches server (5s).
- Configurable `bind` address (default `0.0.0.0`).

### Fixed

- **`group_create` members sanitized**: initial members array now filtered through `sanitizeSessionName`.
- **`RenameMsg.new_name` sanitized**: invalid names rejected with `bad_args`.
- **Dead protocol fields removed**: `origin_peer` from `BridgeForwardMsg`, `hub_id` from `BridgePeerUpdateMsg`.

### Changed

- `HubContext` gains optional `onLocalPeerJoin` callback for bridge peer sync.
- `pending-asks.ts` gains `cleanupByTargetSuffix` and `cleanupByCallerSuffix` for bridge disconnect cleanup.
- `registry.ts` gains remote peer tracking (5 new functions).
- `notifications.ts` extracts `origin_hub` from `@`-qualified `from` fields.

## [0.3.1] — 2026-05-18

Security hardening + UX from 2-loop adversarial review (adv-seg, adv-code, verificador).

### Security

- **last_read privacy**: `group_info` only exposes caller's own `last_read`; other members' read positions are omitted.
- **Peer name sanitization in `group_invite`**: `sanitizeSessionName(msg.peer)` now runs before `isMember` check — prevents whitespace-padded names from bypassing the already-member guard and resetting a member's `last_read`.
- **Peer name sanitization in `group_remove`**: same pattern applied; `isMember` guard added to prevent notifications to non-members and history contamination.
- **handleRegister async safety**: `.catch()` wrapper prevents unhandled Promise rejection crash.

### Fixed

- **msg_id type standardized**: `IncomingGroupMsgMsg.msg_id` changed from `z.number()` to `z.string()` across protocol, hub handlers, and channel notifications. Eliminates client-side `String()` conversion workaround.
- **Remove notification msg_id**: uses sequential `data.next_id` instead of `Date.now()` — consistent with all other handlers, no duplicate IDs under concurrent removes.
- **`GroupInfoResultMsg.members.last_read`**: now `z.number().optional()` in schema (was required).

### Added

- **Delete notification**: `group_delete` now notifies all non-admin members via `incoming_group_msg` before deleting.
- **Remove notification**: `group_remove` now notifies the removed peer before removal.

## [0.3.0] — 2026-05-16

Persistent groups: WhatsApp-style groups with offline delivery, admin governance, and disk-backed message storage.

### Added

- **9 new MCP tools**: `relay_group_create`, `relay_group_invite`, `relay_group_remove`, `relay_group_leave`, `relay_group_send`, `relay_group_history`, `relay_group_list`, `relay_group_info`, `relay_group_delete`.
- **GroupStore** (`src/hub/groups.ts`): disk-backed JSON storage, one file per group at `{dataDir}/groups/`. Ring buffer (500 messages FIFO), `last_read` cursor per member, atomic writes via temp+rename.
- **Admin governance**: creator = admin. Only admin can invite, remove (reason mandatory + logged as system message), and delete. Admin cannot leave or self-remove.
- **Global group cap**: 200 groups max via `totalGroupCount()`.
- **3 new error codes**: `not_member`, `not_admin`, `group_not_found`.

### Security

- **Path traversal protection**: `sanitizeSessionName()` applied to group name in all 9 handlers.
- **Prototype chain bypass**: `Object.hasOwn(data.members, peer)` replaces `in` operator — prevents peers named "constructor" from bypassing membership checks.
- **Disk exhaustion cap**: global 200-group limit prevents create+leave cycle attack.
- **Admin guards**: admin cannot leave (`group_leave`) or self-remove (`group_remove`).
- **Null guards**: all 5 mutating GroupStore functions throw on null load instead of unsafe cast.
- **Defensive try/catch**: `handleLine` in hub wraps all handler dispatch; channel `hub-connection.ts` wraps listener calls.

### Fixed

- **Channel crash on `incoming_group_msg`**: `msg_id` sent as number in notification meta crashed Claude Code's handler. Fixed: `String(msg.msg_id)` in `buildGroupMsgNotification`.
- **Windows UDS test failures**: removed `fs.existsSync()` guard in `waitForSocketReady` — Windows doesn't see Unix domain socket files via `existsSync`.
- **Windows chmod test**: skipped on `win32` (Unix file permissions not supported).
- **Broadcast timeout code**: changed from `"timeout"` to `"hub_unreachable"` for client-side hub ack timeout.

### Changed

- `PROTOCOL_VERSION` bumped from `"3"` to `"4"`.
- Merged upstream v0.1.2: anti-broadcast fallback instruction, `MAX_TEXT_LEN` 512KB, `MAX_LINE_LEN` 1MB, verbatim quoting instruction.
- Ask/broadcast timeout raised to 600s (10 min).
- Minimal daemon environment on Windows (security).

### Protocol

- 9 new client→hub messages: `GroupCreateMsg`, `GroupInviteMsg`, `GroupRemoveMsg`, `GroupLeaveMsg`, `GroupSendMsg`, `GroupHistoryMsg`, `GroupListMsg`, `GroupInfoMsg`, `GroupDeleteMsg`.
- 6 new hub→client messages: `GroupCreatedMsg`, `GroupAckMsg`, `GroupMessagesMsg`, `GroupListResultMsg`, `GroupInfoResultMsg`, `IncomingGroupMsgMsg`.

### Tests

- 21 new tests (11 GroupStore unit + 10 integration). Total suite: 244 (was 223).
- All 244 pass on Windows.

### Known debt (resolved in v0.3.1 and v0.4.0)

All items from v0.3.0 known debt have been resolved: handleRegister async safety, last_read privacy, peer name sanitization, group_create members validation. See v0.3.1 and v0.4.0 changelogs.

- `group_delete` sends no notification to remaining members.

## [0.2.0] — 2026-05-07

Two parallel features resolving pain points found on day one of multi-agent use.

### Block 1 — Fixed identity (resolves zombie peers)

Before this block, every session restart left a zombie entry in the hub's registry; the new session got a `-2` / `-3` suffix and peers sending to the original name routed into the void. Now sessions can pin a stable identity, and zombies are evicted automatically.

#### Added

- **`RELAY_PEER_ID` environment variable**: when set, takes precedence over the basename and the Claude session name as the registered peer name. Sanitized through the existing `[A-Za-z0-9._-]{1,64}` rule; invalid values fall back through the existing resolution chain.
- **Active probe in `register()`**: when a name collides with an existing socket that still looks alive (local flags), the hub sends a `ping` with 500ms timeout. If the peer responds with `pong` the new register gets `name_taken`; otherwise the zombie is evicted and the new register succeeds. Race-protected via a per-name `registerInProgress` set.
- **Proactive sweep** (every 30s, configurable) that pings all registered peers and evicts those that don't respond. Catches orphan plugins whose Claude Code parent died but whose socket is still up.
- **Parent-death detection** in the channel: combined check of `process.ppid` change, `stdin.destroyed`, and `stdin.readableEnded`. Necessary because Windows doesn't re-parent on parent death and `process.kill(pid, 0)` is unreliable for liveness probes there.

#### Protocol

- Added `ping` / `pong` messages for probe correlation (`req_id`-based).

### Block 2 — Ephemeral rooms (resolves "no subgroup messaging")

Before this block, the only options were `relay_ask` (one-to-one) and `relay_broadcast` (everyone). Sessions can now coordinate through IRC-style ephemeral rooms.

#### Added

- **4 new MCP tools**: `relay_join`, `relay_leave`, `relay_room`, `relay_rooms`.
- **Implicit lifecycle**: rooms are created on first join, destroyed when the last member leaves. No permissions, no persistence.
- **Auto-rejoin on hub reconnect**: each channel keeps a local set of joined rooms and resends `join_room` for each on `onReconnect`.
- **Limits**: `MAX_ROOMS = 50`, `MAX_MEMBERS_PER_ROOM = 20`. Both defined in `src/hub/handlers.ts`.

#### Protocol

- `PROTOCOL_VERSION` bumped from `"2"` to `"3"`.
- New client→hub messages: `JoinRoomMsg`, `LeaveRoomMsg`, `RoomMsgMsg`, `ListRoomsMsg`.
- New hub→client messages: `RoomAckMsg`, `RoomSendAckMsg`, `IncomingRoomMsgMsg`, `RoomsListMsg`.

#### INSTRUCTIONS

Two new entries guide the model on when to use rooms vs ask, and on how to distinguish `incoming_room_msg` notifications (no `ask_id` in meta) from `incoming_ask` (with `ask_id`). The first existing entry was tightened from _"if an incoming `<channel>` message is present"_ to _"if an incoming `<channel>` message carries an `ask_id` in its meta"_ to make the distinction unambiguous.

### Tests

33 new tests: 9 protocol parsing, 8 registry unit, 9 hub handlers E2E, 7 channel tools E2E (including a baseline auto-rejoin scenario). 26 pass on Windows; 7 E2E need Unix domain sockets and pass on Linux/macOS — same constraint as the v0.1.0 test suite.

### Known debt

- **Auto-rejoin is fire-and-forget**: if a room hit `MAX_MEMBERS_PER_ROOM` while a peer was disconnected, the hub's `bad_args` reply is dropped and the channel's `joinedRooms` set drifts from hub state silently. Observable symptom: `relay_room` returns `delivered_count: 0` without diagnostic. Marked TODO in `src/channel/index.ts`; fix planned for v0.3 using `sendRequest` + cleanup.

## [0.1.0] — upstream baseline

Initial public release at [innestic/claude-relay](https://github.com/innestic/claude-relay). Tools: `relay_peers`, `relay_ask`, `relay_reply`, `relay_broadcast`, `relay_rename`. Single-host, in-memory hub, no rooms, no fixed identity.
