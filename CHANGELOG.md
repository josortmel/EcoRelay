# Changelog

All notable changes to Eco Relay are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

Eco Relay is based on [claude-relay](https://github.com/innestic/claude-relay) by Innestic (MIT). Versions prior to 0.5.0 were developed as an internal fork under [EcoConsulting/claude-relay](https://github.com/EcoConsulting/claude-relay).

## [0.9.1] — 2026-06-20

Hotfix: recovery after a Windows dynamic port-range reservation broke the WS endpoint and a fatal bridge bind crashed the Hub.

### Fixed

- **WS default port 9376 → 19736 across the Hub and all clients.** Windows (winnat/Hyper-V/WSL) dynamically reserves TCP port ranges (9317–9716 on the affected machine) and reassigns them on reboot; binding 9376 failed with `WSAEACCES`, silently taking down cross-CLI messaging while leaving `netstat` empty. Updated `hub-daemon.ts`, `shared/hub-spawner.ts`, `codex-adapter/hub-client.ts`, `opencode-plugin/ecorelay.ts`, and `copilot-extension/ecorelay.mjs`.
- **Bridge bind failure is now non-fatal** (`hub/bridge.ts`): a federation `server.listen` error (excluded or in-use port) no longer crashes the Hub serving local clients — it logs a hint and continues. Previously an unhandled `'error'` event took down the whole Hub on startup.

### Added

- **`ECORELAY_IDLE_MS=0` knob** (`hub-daemon.ts`): suppress the idle-exit so a manually launched canonical Hub stays alive.

## [0.7.6] — 2026-05-30

Bootstrap symmetry, lock file, push URL auto-discovery, version check, install unified. 490 tests, zero debt.

### Added

- **Bootstrap symétrico + Lock file** (`src/shared/hub-spawner.ts`, 340 LOC): ambos plugins pueden spawnear el Hub. Lock file atómico (`O_CREAT|O_EXCL`) en `~/.eco-relay/hub.lock` previene doble spawn. Hash SHA-256 de `hub-daemon.ts` embebido como constante para verificación pre-spawn (previene path injection).
- **Push URL auto-descubrimiento** (`discoverPushUrl`): 3 fuentes en cascada — `PluginContext.serverUrl` → `ECORELAY_OC_PORT` env → default `http://127.0.0.1:4096`. Validación de localhost y rango de puerto. Sin variables de entorno manuales.
- **Version check** (`isNewer`): comparación semántica de versiones (split por `.`, numérica). Si Hub es más nuevo que el plugin, `console.error` con comando exacto de reinstalación.
- **Install script unificado** (`scripts/install.sh`): un comando instala todo — Hub a `~/.ecorelay/`, plugin OC a `~/.config/opencode/plugins/`, sync cache CC. `bun install --ignore-scripts` + `bun test`. Limpia plugin viejo de `~/.opencode/plugin/`.

### Changed

- **OC plugin migrado a API real** (`@opencode-ai/plugin` v1.15.12): `export const server` devuelve `Hooks {tool, event, dispose, system.transform}`. 19 tools con `tool()` Zod schemas. Bootstrap fire-and-forget (no bloquea arranque de OC).
- **Protocolo bidireccional**: `PingMsg` en `ClientMsgSchema`, `PongMsg` en `ServerMsgSchema`. `case "ping"` en `handleLine` del Hub. El handshake de bootstrap funciona en ambas direcciones.
- **daemon-spawn.ts**: delegado a `shared/hub-spawner.ts` (3 LOC, re-export). Compatible hacia atrás con CC.
- **Badge + platform table**: v0.7.6, OpenCode partial support.

### Security

- **Event forgery prevention**: `Hooks.event` valida `event.properties` con type guards antes de procesar sesiones. Propiedades inválidas → `console.warn` + skip.
- **Prompt injection wrapper**: push via `client.session.prompt()` envuelve contenido no confiable en `<untrusted_peer_message>` con instrucción explícita de no seguir instrucciones embebidas. `</untrusted_peer_message>` sanitizado.
- **Module state isolation**: `projectDirectory`/`_client` en closure de `server()`, no en scope de módulo. `cleanup()` resetea todo el estado en `dispose`.
- **INSTRUCTIONS marker versionado**: `[ECORELAY_INSTRUCTIONS_v0.7.6]` como clave estable para idempotencia, reemplaza substring matching frágil.
- **crypto.getRandomValues() fallback**: reemplaza `Math.random()` en fallback de `randomUUID()` para Node <19.
- **localhost validation en push URL**: rechaza orígenes no-localhost en `discoverPushUrl`.
- **429 retry**: `pushToSession` reintenta en rate limit (previamente tratado como error permanente).
- **messageSenders + broadcastReceipts**: Maps separados. Cap de 200 entradas con evicción LRU.
- **pendingRequests cleanup**: `dispose` limpia timers + rechaza promesas pendientes.

### Fixed

- **Bootstrap handshake**: `tryConnect` manda ping, el Hub ahora responde pong. 44 tests que fallaban con "failed to connect to hub after spawn" — resueltos.
- **OC startup hang**: `await client.session.list()` reemplazado por IIFE fire-and-forget. El plugin devuelve Hooks inmediatamente.
- **Dual plugin load**: copia vieja en `~/.opencode/plugin/` eliminada por `install.sh`. Solo existe en `~/.config/opencode/plugins/`.
- **Windows spawn**: eliminado wrapper `cmd.exe`. `spawn("bun", ...)` directo con `windowsHide: true`, igual que v0.7.2.
- **Zod schema-handler parity**: constraints documentados en `describe()` ahora aplicados como validación de handler.
- **session.status**: implementado tracking busy/idle (`sessionStatus` Map).
- **Peer cache in-memory**: `_cachedPeers` Map evita lecturas de disco redundantes.
- **BC1-8, VS1-10**: ~25 fixes de seguridad y código de 2 loops adversariales. Ver informe de construcción para detalle completo.

### Known limitations

- **OC no spawnea el Hub**: `getBootstrapHub` eliminado (el import no resuelve en runtime OC). Workaround: abrir CC primero. Fix planeado para v0.8.
- **OC plugin requiere CC abierto**: el Hub solo arranca con WS endpoint si CC lo spawnea. `ECORELAY_WS_PORT` no se propaga del spawn al daemon en todos los casos.

## [0.7.5] — 2026-05-29

Multi-platform support: OpenCode plugin + Hub WebSocket endpoint. Cross-CLI messaging between Claude Code and OpenCode.

### Added

- **Hub WebSocket endpoint** (`src/hub/ws-endpoint.ts`): Bun.serve() WebSocket on 127.0.0.1:9376. VirtualSocket wraps WS as net.Socket-compatible EventEmitter. timingSafeEqual auth with token from ~/.eco-relay/hub-ws-token. Coexists with Unix socket on same registry.
- **OpenCode plugin** (`src/opencode-plugin/ecorelay.ts`): registers all 19 relay MCP tools in OpenCode. Connects to Hub via WebSocket. Session lifecycle events (created/deleted/status). Push delivery via OC Server API (`POST /session/:id/message`) with retry + backoff. Peer ID persistence across restarts (`~/.cache/ecorelay/peer-ids.json`). Agent instructions injection via `experimental.chat.system.transform`.
- **Install script** (`scripts/install-opencode-plugin.sh`): one-command plugin installation.
- **Integration tests** (`src/integration/cross-transport.test.ts`): cross-transport messaging verified (Unix ↔ WebSocket, 7 tests).

### Changed

- `startHub` options: new `wsPort` parameter activates WebSocket endpoint.
- `sendTo` dispatch: detects VirtualSocket → uses `write()` instead of `writeLine()`.
- `SocketLike` interface extracted for registry socket contract documentation.

### Security

- **WS auth**: `crypto.timingSafeEqual` for token comparison (constant-time). 5-second auth timeout, close code 4003 on failure.
- **Payload limits**: `maxPayloadLength: 1 MiB` on WS connections. Auth payload capped at 1024 bytes. Message size guard against multi-line accumulation bypass.
- **Empty token regeneration**: token files shorter than 16 chars auto-regenerate.
- **Idempotent instructions**: `experimental.chat.system.transform` guard prevents duplicate INSTRUCTIONS injection on every LLM request.

### Fixed

- `name_taken` on WS register: retry up to 10 times with numeric suffix before giving up.
- `scheduleReconnect` zombie: lazyConnect failures now propagate to reconnect loop.
- `messageSenders` unbounded growth: capped at 200 entries with oldest-first eviction.
- `loadPeerId` type safety: non-string cache values treated as cache miss.
- `savePeerId` disk error resilience: wrapped in try/catch, cache is auxiliary.

## [0.7.0] — 2026-05-24

Cross-network internet federation + unified messaging + security hardening. Two major versions in one release.

### Added — Cross-network federation (v0.7)

- **WebSocket relay server** (`src/relay-server/index.ts`): standalone Bun WebSocket server (~200 lines) that routes `bridge_forward` messages between hubs on different networks. All connections outbound — works behind NAT, firewalls, and proxies.
- **Hub WS bridge client**: `connectToRelayWs` in `bridge.ts` connects to a relay server via WebSocket. Exponential backoff reconnect, qualified name routing, peer sync.
- **`sendForward`**: unified function for routing bridge_forward via TCP (LAN) or WebSocket (internet). TCP first, relay fallback.
- **`broadcastPeerUpdate`**: unified peer join/leave announcements to all TCP connections + relay WS.
- **Bridge config**: `relay: { url, token }` optional field in `bridge.json`. TCP (`peers[]`) and WS (`relay`) coexist.
- **Relay config examples**: `relay-config.example.json`, `bridge.example-remote.json`.
- **Hub ID validation**: `/^[a-zA-Z0-9_-]+$/` regex enforced on relay handshake.
- 14 new tests (9 relay server + 5 bridge WS). Total suite: 354.

### Added — Unified messaging (v0.6)

- **`relay_send(to, text, reply_to?, urgent?)`**: persistent direct messaging. Returns `{msg_id, status}` — "delivered" (peer online, push notification sent) or "queued" (peer offline, stored for retrieval). Messages persist to disk. `reply_to` for threading. `urgent` flag instructs recipient to act immediately.
- **`relay_inbox(limit?, since_id?)`**: on-demand mailbox reader. Paginated, marks messages as read. Call at session start to check for offline messages.
- **MailboxStore** (`src/hub/mailbox.ts`): per-peer JSON mailbox at `{dataDir}/mailboxes/`. Ring buffer (500 messages FIFO). Atomic writes via temp+rename.
- **`incoming_message`** server→client notification: real-time push when recipient is online.

### Changed

- `PROTOCOL_VERSION` bumped from `"4"` to `"5"`.
- `relay_ask` description clarified: use for request-response; `relay_send` for fire-and-forget.
- **`relay_reply` smart fallback**: auto-detects whether the ID is an `ask_id` (from `relay_ask`) or `msg_id` (from `relay_send`). If `msg_id`, transparently converts to `relay_send(to=original_sender, reply_to=msg_id)`. Agents never need to know which protocol sent the original message.
- `handleSend` captures `sendTo` return value — reports "queued" if push fails (honest delivery status).
- `buildMessageNotification` includes `ts` in notification meta.
- `generateMsgId` uses `crypto.randomUUID()` (replaces `Math.random` 4-char suffix).
- `totalMailboxCount` uses in-memory counter (replaces `readdirSync` per send).
- Dead code removed: `getRoute`, `BridgeRoute` type.

### Security

- **`handleRegister`** now calls `sanitizeSessionName` on peer name (was the only handler without it — path traversal via registered name).
- **Relay server**: `safeSend` wrapper for all WebSocket sends (prevents throw on CLOSING/CLOSED state). Handshake timer stored + cleared on auth success. HTTP health endpoint stripped to "OK" (no version/hub count disclosure).
- **Secret comparison**: `crypto.timingSafeEqual` in relay server + TCP bridge listener (replaces `!==`).
- **Origin validation**: WS relay path validates `origin_hub` exists in known `relayHubs` set before accepting `bridge_forward`.
- **Peer name validation**: rejects empty names and names containing `@` from relay welcome/peer_update.
- **Qualified name broadcast**: hello-path peer announcements now qualify names (`name@hub_id`) consistently with peer_update handler.
- **Bridge close cleanup**: `removeAllRemotePeersForHub` + `onBridgeDisconnect` called per relay hub BEFORE clearing set.
- **Groups hardened**: `groups.ts` directory created with mode `0o700` + `path.basename` defense-in-depth (parity with mailbox).
- **Mailbox security**: path traversal protection (basename validation), directory permissions (0o700), MAX_MAILBOXES cap (500), `reply_to` max 256 chars, `since_id` max 64 chars, `req_id` max 64 chars, `to` max 64 chars, mailbox I/O error handling via try/catch.
- `filePath` rejects `.`, `..`, and path separator characters in owner/group name.

### Fixed

- **Notification meta boolean crash**: `meta.urgent = true` (boolean) crashed Claude Code sessions. All notification meta values must be strings. Fixed: `meta.urgent = "true"`.
- **relay_reply with msg_id**: agents receiving `incoming_message` (from `relay_send`) and calling `relay_reply` got `unknown_ask`. Fixed: channel tracks `msg_id→sender` mapping, auto-converts to `relay_send`.

### Protocol

- 2 new client→hub: `SendMsg`, `InboxMsg`.
- 3 new hub→client: `SendAckMsg`, `InboxResultMsg`, `IncomingMessageMsg`.
- `BridgeHelloMsg`, `BridgeWelcomeMsg`: optional `public_key` field (reserved for E2E, not yet active).
- `BridgeForwardMsg`: optional `encrypted`, `nonce` fields (reserved for E2E, not yet active).
- `BridgeConfigSchema`: optional `relay: { url, token }` field.
- New error code: `mailbox_error`.

## [0.5.0] — 2026-05-19

Rebranded to **Eco Relay**. Independent project under [josortmel/eco-relay](https://github.com/josortmel/eco-relay). License changed from MIT to PolyForm Noncommercial 1.0.0.

### Changed

- Project name: claude-relay → Eco Relay.
- License: MIT → PolyForm Noncommercial 1.0.0 (original MIT attribution preserved in THIRD_PARTY_LICENSES).
- Repository: moved from EcoConsulting/claude-relay to josortmel/eco-relay.
- All version fields synced to 0.5.0.
- Fallback data directory: `~/.claude-relay/` → `~/.eco-relay/`.
- MCP server identity: `relay-channel` → `eco-relay`.

### Migration

- **Plugin users:** after upgrading from `relay@claude-relay` to `relay@eco-relay`, copy your data directory to preserve groups and bridge config: `cp -r ~/.claude/plugins/data/relay-claude-relay/ ~/.claude/plugins/data/relay-eco-relay/`
- **Manual-install users:** rename `~/.claude-relay/` to `~/.eco-relay/` to preserve existing data.

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
