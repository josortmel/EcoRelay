# EcoRelay — Mapa del código

> Última actualización: 2026-05-30 (v0.8.0). Actualizar al final de cada sesión que toque este repo.

## Qué es

Sistema de mensajería entre sesiones de IA (Claude Code, OpenCode, futuros CLI). Un Hub daemon por máquina, peers se conectan vía Unix socket (CC) o WebSocket (OC). 19 tools MCP. Mensajes persistentes, grupos, salas, federación LAN+internet.

## Stack

- **Runtime**: Bun (TypeScript, ESNext, strict)
- **Protocolo**: JSON-over-newline sobre Unix socket / WebSocket
- **MCP**: @modelcontextprotocol/sdk (CC channel), @opencode-ai/plugin (OC plugin)
- **Logging**: winston + daily-rotate-file
- **Tests**: bun:test (~489 tests, 31 archivos)
- **CI**: GitHub Actions (ci.yml) — typecheck + lint + format + test

## Estructura del repo

```
src/
├── main.ts                    # Entry point del plugin CC (MCP server)
├── hub-daemon.ts              # Entry point del daemon Hub (proceso standalone)
├── protocol.ts                # Tipos de mensajes cliente↔hub (ClientMsg, ServerMsg)
├── framing.ts                 # JSON-over-newline framing (readLines, writeLine)
├── data-dir.ts                # Resolución de paths (~/.eco-relay, CLAUDE_PLUGIN_DATA)
├── identity.ts                # Peer identity (nombres, RELAY_PEER_ID)
├── logger.ts                  # Winston logger factory
│
├── hub/                       # El daemon Hub (routing, storage, federation)
│   ├── index.ts               # startHub() — entry principal, crea socket + WS + bridge
│   ├── registry.ts            # Peer registry (nameToSocket, register, evict, probe)
│   ├── mailbox.ts             # Persistent mailbox (ring buffer 500 msgs/peer)
│   ├── groups.ts              # Persistent groups (WhatsApp-style, admin governance)
│   ├── ws-endpoint.ts         # WebSocket endpoint para OC (port 9376, token auth)
│   ├── socket-recovery.ts     # Unix socket recovery (stale socket handling)
│   ├── bridge.ts              # LAN federation (TCP hub-to-hub)
│   ├── bridge-config.ts       # Bridge configuration (bridge.json)
│   └── handlers/              # Message handlers por tipo
│       ├── core.ts            # register, list_peers, rename, ping/pong
│       ├── messaging.ts       # send, inbox, reply, broadcast
│       ├── rooms.ts           # join, leave, room_send, list_rooms
│       ├── groups.ts          # group_create, invite, remove, send, history...
│       └── federation.ts      # Bridge peer updates
│
├── channel/                   # Plugin CC (MCP channel, per-session)
│   ├── index.ts               # startChannel() — conecta al Hub, registra peer
│   ├── bootstrap.ts           # bootstrapHub — tryConnect o spawn daemon
│   ├── daemon-spawn.ts        # Re-exports de hub-spawner para CC
│   ├── hub-connection.ts      # Conexión raw al Hub (framing, send/receive)
│   ├── reconnect.ts           # Auto-reconnect con backoff
│   ├── register.ts            # registerWithRetries + name_taken handling
│   ├── routing.ts             # Routing de mensajes Hub → MCP notifications
│   ├── notifications.ts       # Push notifications al host CC
│   ├── session-watcher.ts     # Watcher de rename/session changes
│   ├── mcp-server.ts          # MCP server setup (tools, schemas)
│   ├── pending-broadcasts.ts  # Broadcast reply aggregation
│   ├── tools/                 # Tool implementations (execute)
│   │   ├── messaging.ts       # relay_send, relay_inbox, relay_reply, relay_broadcast
│   │   ├── core.ts            # relay_peers, relay_rename
│   │   ├── rooms.ts           # relay_join/leave/room/rooms
│   │   └── groups.ts          # relay_group_*
│   └── tool-schemas/          # Tool definitions (name, description, args)
│       ├── messaging.ts, core.ts, rooms.ts, groups.ts
│       └── index.ts
│
├── opencode-plugin/           # Plugin OC (standalone, single file)
│   └── ecorelay.ts            # ~1400 líneas. TODO en un fichero:
│                              #   - Peer lifecycle (ensurePeer, removePeer, lazyConnect)
│                              #   - WS connection + auth + reconnect
│                              #   - Hub message handling
│                              #   - 19 tool implementations
│                              #   - Push reactivo (session.prompt sin noReply)
│                              #   - Auto-spawn daemon (process.execPath, C7)
│                              #   - Session events (session.created/deleted)
│
├── shared/
│   └── hub-spawner.ts         # spawnDetachedDaemon, tryConnect, lock handling
│                              # NOTA: tiene dead code (DC2 ~150 líneas: deleteLock,
│                              # acquireLock, HubHandle, HubInfo, bootstrapHub)
│
├── relay-server/
│   └── index.ts               # WebSocket relay server (internet federation, ~200 LOC)
│
└── integration/
    └── cross-transport.test.ts # Integration tests (CC↔OC cross-transport)
```

## Cómo se despliega (v0.8+)

CC y OC tienen ubicaciones de código SEPARADAS. `scripts/install.sh` las cubre todas:

| Destino | Path | Para qué |
|---|---|---|
| Standalone | `~/.ecorelay/` | OC spawnea el daemon desde aquí (C7) |
| OC plugin | `~/.config/opencode/plugins/ecorelay.ts` | OC carga el plugin de aquí |
| CC marketplace | `~/.claude/plugins/marketplaces/eco-relay/src/` | CC a veces ejecuta desde aquí |
| CC cache | `~/.claude/plugins/cache/eco-relay/relay/<version>/` | CC normalmente ejecuta desde aquí |
| CC registry | `~/.claude/plugins/installed_plugins.json` | CC resuelve version → path desde aquí |

**Verificar de dónde ejecuta CC realmente:**
```powershell
Get-CimInstance Win32_Process -Filter "Name='bun.exe'" | Select CommandLine
```

**Runtime data** (NO en el repo, no tocar en install):
- `~/.eco-relay/` — hub.sock, hub-ws-token (0o600)
- `~/.claude/plugins/data/relay-eco-relay/` — logs, mailboxes/*.json, groups/*.json

## Versionado

**`package.json` version es la fuente de verdad.** install.sh la lee de ahí (no hardcodea).

Archivos que deben coincidir en versión:
- `package.json` → version
- `.claude-plugin/plugin.json` → version
- `.claude-plugin/marketplace.json` → plugins[0].version
- `src/opencode-plugin/ecorelay.ts` → PLUGIN_VERSION const
- `README.md` → badge + refs

## Conexiones clave

```
CC session → channel/index.ts → Unix socket → Hub (hub/index.ts)
OC session → ecorelay.ts → WebSocket :9376 → Hub (hub/index.ts → ws-endpoint.ts)
Hub daemon ← hub-daemon.ts (standalone process, auto-spawned)
```

- CC spawnea el daemon vía `channel/bootstrap.ts → hub-spawner.ts → spawnDetachedDaemon`
- OC spawnea el daemon vía `ecorelay.ts → spawnHubDaemon` (C7, process.execPath)
- El que abre primero gana; el otro conecta (bootstrap simétrico)
- Idle-exit: 10s sin peers → `process.exit(0)` (hub/index.ts:63)

## Qué NO tocar (invariantes)

- `src/channel/` — el canal CC funciona y no se tocó en v0.8. Si se rompe CC↔CC, es catastrófico.
- `src/data-dir.ts` — resolución de paths. No tocar sin verificar todas las dependencias.
- `~/.eco-relay/hub-ws-token` — token de auth WS, creado por el daemon. Borrarlo rompe la auth hasta restart.

## Tests

```bash
bun test                                        # todos (~489)
bun test --path-ignore-patterns "src/integration/*"  # sin integration
bun test src/opencode-plugin/                   # solo plugin OC
bun test src/hub/                               # solo Hub
```

Test baseline: 488-489/489 (1 socket-recovery pre-existing known-fail). Si baja de 488, es regresión.

## Pre-commit hook (ROTO — deuda)

`.husky/pre-commit` corre `bunx lint-staged` + `bun run check`. `bun run check` = `eslint src` de TODO el proyecto → **72 errores pre-existentes**. Todos los commits de v0.8 usaron `--no-verify`. Arreglar: o quitar `bun run check` del hook (dejarlo para CI), o arreglar los 72 errores (sesión de lint/prettier pendiente).

## Deuda conocida (v0.8.0)

- **DC2**: cluster dead code en hub-spawner.ts:161-314 (~150 líneas: deleteLock, acquireLock, HubHandle, HubInfo, bootstrapHub)
- **VS3-C5**: push reactivo (sin noReply) = superficie de prompt injection. Decisión de Pepe: deuda aceptada. Salvaguarda = trabajo adversarial + límites agénticos.
- **Pre-commit hook**: 72 errores eslint pre-existentes (ver arriba).
- **OC sessions**: no se auto-registran hasta activación manual (limitación de OC, no de relay).
- **Versión en INSTRUCTIONS_MARKER**: sigue en v0.7.6 (es marcador de protocolo, no display).

## bun en Windows

`bun` en PATH puede ser un shim `.ps1` (PowerShell) que bash/sh no ejecuta. El bun real está en `~/.bun/bin/bun.exe`. install.sh lo resuelve automáticamente. En scripts propios: usar `"$HOME/.bun/bin/bun.exe"` o `process.execPath` (desde bun runtime).
