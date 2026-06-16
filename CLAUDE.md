# EcoRelay — Guía del proyecto

> Última actualización: 2026-05-30 (v0.8.0). Actualizar al final de cada sesión.

## Qué es

Mensajería entre sesiones de IA en la misma máquina o red. Claude Code, OpenCode, y futuros CLI hablan entre sí en lenguaje natural a través de un Hub central. 19 tools MCP. Mensajes persistentes, grupos, salas, federación LAN e internet.

## Cómo funciona (el flujo de un mensaje)

```
Sesión A (CC) dice "envía a backend-api que cambie el token"
    → tool relay_send(to="backend-api", text="...")
    → channel/tools/messaging.ts → envía JSON al Hub vía Unix socket
    → Hub (hub/handlers/messaging.ts) → busca "backend-api" en registry
    → Si online: envía por socket/WS directo + persiste en mailbox
    → Si offline: solo persiste en mailbox (relay_inbox lo recupera)
    → Sesión B (OC o CC) recibe el mensaje como notification
    → El agente receptor lo procesa y puede responder
```

CC se conecta al Hub por **Unix socket**. OC se conecta por **WebSocket** (puerto 9376). Ambos hablan al mismo Hub.

## Arquitectura: las 3 piezas

### 1. Hub (`src/hub/`) — el cerebro

Proceso daemon standalone (`src/hub-daemon.ts`). Uno por máquina. Hace:

- **Registry** (`registry.ts`): quién está conectado, evicción de zombis, probe con ping.
- **Mailbox** (`mailbox.ts`): ring buffer de 500 msgs por peer, persiste en disco.
- **Groups** (`groups.ts`): grupos persistentes estilo WhatsApp con admin.
- **WS endpoint** (`ws-endpoint.ts`): WebSocket en :9376 para OC. Auth por token (`~/.eco-relay/hub-ws-token`, timingSafeEqual, 32 bytes random).
- **Handlers** (`handlers/`): un archivo por dominio (core, messaging, rooms, groups, federation).
- **Bridge** (`bridge.ts`): federación LAN hub-to-hub vía TCP.

Arranca automáticamente: la primera sesión (CC o OC) que abre lo spawnea. Se apaga solo en **10 segundos** sin peers (`idleExitMs`, hub/index.ts:63).

### 2. Channel CC (`src/channel/`) — el plugin de Claude Code

Un MCP server por sesión CC. Registra UNA sesión (la propia) con el Hub. NO hace `session.list()`. Estructura separada: tools/ (implementación), tool-schemas/ (definiciones), routing, reconnect, notifications.

**No se tocó en v0.8.** Si se rompe, CC↔CC deja de funcionar. Tratar como invariante.

### 3. Plugin OC (`src/opencode-plugin/ecorelay.ts`) — el plugin de OpenCode

Un solo archivo (~1400 líneas). Maneja múltiples sesiones OC (una por tab). Incluye:

- Conexión WS al Hub con auth por token
- 19 tools MCP (mismas que CC pero implementación propia)
- Push reactivo: `session.prompt` sin noReply → el agente receptor reacciona
- Auto-spawn del daemon (`spawnHubDaemon`, process.execPath)
- Validación de DAEMON_PATH + env allowlist (no hereda API keys)

## Dependencias entre módulos

```
hub-daemon.ts → hub/index.ts → registry, mailbox, groups, ws-endpoint, handlers/*, bridge
main.ts → channel/index.ts → bootstrap, register, hub-connection, reconnect, routing, tools/*
ecorelay.ts → (standalone, no importa de channel/ ni hub/)
hub-spawner.ts → (shared: lo usan channel/bootstrap.ts y potencialmente ecorelay.ts)
protocol.ts → (shared: define ClientMsg/ServerMsg, lo importan hub y channel)
framing.ts → (shared: readLines/writeLine sobre sockets)
data-dir.ts → (shared: resuelve paths ~/.eco-relay, CLAUDE_PLUGIN_DATA)
```

**ecorelay.ts es independiente**: no importa nada de `channel/` ni `hub/`. Tiene su propia implementación de todo. Es un monolito por diseño (OC plugins son un solo archivo).

## Cómo se despliega

CC y OC tienen ubicaciones de código **separadas**. `scripts/install.sh` las cubre todas.

| Destino        | Path                                                 | Quién lo usa                        |
| -------------- | ---------------------------------------------------- | ----------------------------------- |
| Standalone     | `~/.ecorelay/`                                       | OC spawnea el daemon desde aquí     |
| OC plugin      | `~/.config/opencode/plugins/ecorelay.ts`             | OC carga el plugin                  |
| CC marketplace | `~/.claude/plugins/marketplaces/eco-relay/src/`      | CC (a veces ejecuta desde aquí)     |
| CC cache       | `~/.claude/plugins/cache/eco-relay/relay/<version>/` | CC (normalmente ejecuta desde aquí) |
| CC registry    | `~/.claude/plugins/installed_plugins.json`           | CC resuelve version → path          |

**CC puede ejecutar desde marketplace O cache.** Verificar cuál:

```powershell
Get-CimInstance Win32_Process -Filter "Name='bun.exe'" | Select CommandLine
```

**Runtime data** (no en el repo, no tocar):

- `~/.eco-relay/` — hub.sock, hub-ws-token
- `~/.claude/plugins/data/relay-eco-relay/` — logs, mailboxes, groups

## Versionado

**`package.json` version = fuente de verdad.** install.sh lee de ahí.

Archivos que deben coincidir:
| Archivo | Campo |
|---|---|
| `package.json` | version |
| `.claude-plugin/plugin.json` | version |
| `.claude-plugin/marketplace.json` | plugins[0].version |
| `src/opencode-plugin/ecorelay.ts` | PLUGIN_VERSION |
| `src/copilot-extension/ecorelay.mjs` | PLUGIN_VERSION |
| `README.md` | badge + refs |

Si no coinciden, el deploy falla silenciosamente (CC busca una versión en cache que no existe).

## Stack técnico

- **Runtime**: Bun 1.3.x (TypeScript, ESNext, strict)
- **Protocolo**: JSON-over-newline (framing.ts) sobre Unix socket / WebSocket
- **MCP CC**: @modelcontextprotocol/sdk
- **MCP OC**: @opencode-ai/plugin (devDependency para typecheck; OC lo provee en runtime)
- **Logging**: winston + daily-rotate-file
- **Validación**: zod (protocolo)
- **Tests**: bun:test (~489 tests, 31 archivos)
- **CI**: GitHub Actions → typecheck + lint + format + test
- **Lint**: eslint + prettier + lint-staged + husky

## Tests

```bash
bun test                                              # todos (~489)
bun test --path-ignore-patterns "src/integration/*"   # sin integration
bun test src/opencode-plugin/                         # solo OC
bun test src/hub/                                     # solo Hub
bun test src/channel/                                 # solo CC
```

Baseline: **488-489/489**. 1 known-fail (socket-recovery). Si baja de 488 → regresión.

## Errores comunes y cómo resolverlos

| Síntoma                                     | Causa probable                              | Fix                                                  |
| ------------------------------------------- | ------------------------------------------- | ---------------------------------------------------- |
| CC no ve peers OC                           | Hub no abre WS (wsPort no se pasa)          | Verificar hub-daemon.ts lee ECORELAY_WS_PORT         |
| OC ve peers zombis (sesiones muertas)       | session.list() bootstrap registra historial | Verificar que bootstrap fue eliminado (v0.8+)        |
| CC arranca con código viejo tras deploy     | install.sh no cubrió marketplace o cache    | Verificar de dónde ejecuta CC (command line bun.exe) |
| installed_plugins.json con path roto        | Rutas Git Bash (/c/) vs Windows (C:\\)      | Usar cygpath -w para convertir                       |
| `bun` no ejecuta en bash/hook               | bun en PATH es shim .ps1                    | Usar ~/.bun/bin/bun.exe                              |
| Pre-commit hook falla con 72 errores        | `bun run check` → eslint src completo       | --no-verify (deuda: arreglar hook o los 72 errores)  |
| Daemon no se apaga                          | Peers conectados lo mantienen vivo          | Cerrar todos los CLI → 10s idle → exit               |
| Push reactivo no funciona (OC no reacciona) | session.prompt falla o token inválido       | Verificar hub-ws-token existe + WS :9376 escucha     |

## Decisiones de arquitectura (por qué las cosas son así)

- **ecorelay.ts monolito**: OC plugins son un solo archivo por diseño de @opencode-ai/plugin. No se puede separar.
- **Channel CC separado (no reutiliza ecorelay.ts)**: CC tiene su propio sistema MCP (@modelcontextprotocol/sdk). Las APIs son incompatibles. Dos implementaciones independientes.
- **Hub como daemon detached**: sobrevive al cierre de cualquier CLI individual. Los que abren después se conectan.
- **Bootstrap simétrico**: CC y OC ambos pueden spawnear el Hub. El primero gana, el otro conecta. No importa el orden.
- **Push reactivo sin noReply**: decisión de producto (Pepe). El agente receptor procesa y reacciona automáticamente. Superficie de prompt injection aceptada como deuda (salvaguarda = trabajo adversarial + límites agénticos).
- **Token auth WS (no Unix socket)**: Unix socket ya está protegido por permisos del filesystem (solo el usuario). WS es TCP → necesita auth explícita.

## Deuda conocida (v0.8.0)

| Deuda                                          | Severidad       | Contexto                                                             |
| ---------------------------------------------- | --------------- | -------------------------------------------------------------------- |
| DC2: dead code hub-spawner.ts:161-314          | LOW             | ~150 líneas (deleteLock, acquireLock, HubHandle, etc.) Pre-existente |
| VS3-C5: push reactivo = injection surface      | ACCEPTED (Pepe) | Salvaguarda = adversarial + límites agénticos                        |
| Pre-commit hook: 72 eslint errors              | MEDIUM          | Sesión de lint/prettier pendiente                                    |
| OC sessions: no auto-register hasta activación | LOW             | Limitación de OpenCode, no de relay                                  |
| INSTRUCTIONS_MARKER: sigue en v0.7.6           | LOW             | Es marcador de protocolo, no display                                 |
| bump-version.sh: no existe                     | LOW             | Versiones se alinean a mano (5 archivos)                             |

## Estructura de archivos

```
src/
├── main.ts                     # Entry CC (MCP server)
├── hub-daemon.ts               # Entry daemon Hub
├── protocol.ts                 # ClientMsg / ServerMsg types
├── framing.ts                  # JSON-over-newline
├── data-dir.ts                 # Path resolution
├── identity.ts                 # Peer names
├── logger.ts                   # Winston factory
├── hub/                        # Daemon Hub
│   ├── index.ts                #   startHub()
│   ├── registry.ts             #   Peer registry
│   ├── mailbox.ts              #   Persistent mailbox (ring buffer)
│   ├── groups.ts               #   Persistent groups
│   ├── ws-endpoint.ts          #   WS :9376 + token auth
│   ├── socket-recovery.ts      #   Stale socket handling
│   ├── bridge.ts               #   LAN federation TCP
│   ├── bridge-config.ts        #   Bridge config
│   └── handlers/               #   core, messaging, rooms, groups, federation
├── channel/                    # Plugin CC — NO TOCAR si no es necesario
│   ├── index.ts                #   startChannel()
│   ├── bootstrap.ts            #   tryConnect → spawn daemon
│   ├── tools/                  #   Tool implementations
│   └── tool-schemas/           #   Tool definitions
├── opencode-plugin/            # Plugin OC (monolito)
│   └── ecorelay.ts             #   ~1400 líneas, todo incluido
├── shared/
│   └── hub-spawner.ts          #   spawnDetachedDaemon, tryConnect
├── relay-server/
│   └── index.ts                #   WS relay (internet federation)
└── integration/
    └── cross-transport.test.ts #   CC↔OC integration
```
