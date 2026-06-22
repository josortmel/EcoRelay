# EcoRelay — Guía del proyecto

> Última actualización: 2026-06-22 (v1.0.0 — five-CLI release). Actualizar al final de cada sesión.

## Qué es

Mensajería entre sesiones de IA en la misma máquina o red. Claude Code, OpenCode, Copilot CLI, Codex CLI, **Antigravity CLI (`agy`)** y **Cursor CLI (`cursor-agent`)** hablan entre sí en lenguaje natural a través de un Hub central. 19 tools MCP. Mensajes persistentes, grupos, salas, federación LAN e internet.

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

CC se conecta al Hub por **Unix socket**. OC se conecta por **WebSocket** (puerto 19736). Ambos hablan al mismo Hub.

## Arquitectura: las piezas

### 1. Hub (`src/hub/`) — el cerebro

Proceso daemon standalone (`src/hub-daemon.ts`). Uno por máquina. Hace:

- **Registry** (`registry.ts`): quién está conectado, evicción de zombis, probe con ping.
- **Mailbox** (`mailbox.ts`): ring buffer de 500 msgs por peer, persiste en disco.
- **Groups** (`groups.ts`): grupos persistentes estilo WhatsApp con admin.
- **WS endpoint** (`ws-endpoint.ts`): WebSocket en :19736 para OC. Auth por token (`~/.eco-relay/hub-ws-token`, timingSafeEqual, 32 bytes random).
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

### 4. Adaptador Codex CLI (`src/codex-adapter/`) — modular, 7 archivos

MCP server que conecta el Hub con Codex. A diferencia de CC/OC/Copilot, **Codex no tiene gancho de push in-process para terceros** (su daemon nativo es Unix-only; su named-pipe está firmado por OpenAI; no hay inyección vía MCP). Por eso necesita un **launcher** y un app-server aparte.

**Topología (Windows)** — `scripts/ecorelay-codex.cmd` → `ecorelay-codex-launch.ts` arranca DOS procesos:

1. `codex app-server --listen ws://127.0.0.1:PORT` (backend, oculto). **El adapter MCP corre AQUÍ** (los MCP servers de config.toml cargan en el backend, no en el cliente TUI).
2. `codex --remote ws://127.0.0.1:PORT` (TUI cliente). Comparte backend con #1 → el push del adapter llega al hilo del TUI.

El adapter empuja haciendo `turn/start` contra el app-server (al que se conecta como otro cliente WS).

**Gotchas críticos descubiertos en vivo (2026-06-17) — NO romper:**

- **El adapter descubre el puerto del app-server leyendo `~/.eco-relay/codex-appserver.pid`** ({pid, port} que escribe el launcher). NO depende de la env var: **Codex NO propaga el env del proceso al MCP child** — solo pasa lo que esté en `config.toml [mcp_servers.X.env]`. Poner `ECORELAY_CODEX_APP_SERVER` en el spawn NO llega al adapter.
- **El transporte MCP (`server.connect`) se registra ANTES** de conectar al app-server + `tracker.discover()` (que reintenta hasta 30s). Si discover bloquea el arranque → `startup_timeout_sec` (20s) mata el MCP. App-server connect + discovery van en BACKGROUND (IIFE).
- **El adapter se auto-mata al cerrar el padre** (`server.onclose` / `process.stdin` 'end'/'close' → `parent_gone_exiting`). Sin esto queda HUÉRFANO vivo conectado al Hub = peer zombie.
- **config.toml: rutas Windows con comillas SIMPLES** (literal TOML). Comillas dobles → `\U` de `\Users` = escape unicode → parseo roto. (Las entradas nativas tipo node_repl usan comillas simples por esto.)
- **Cold-start**: codex recién abierto no tiene hilo hasta que el usuario teclea → push retenido (no perdido) hasta que el poll (60s) descubre el hilo → `onThreadChanged` llama `notifyThreadAvailable` para vaciar el buffer. Compartido con OC.

**Sonda research** (`src/channel/codex-beta-ping.ts`): probe env-gated (`ECORELAY_CODEX_BETA_PING`) que usa `elicitInput` para investigar push MCP. No-op por defecto. Es del channel CC, de la fase de plan.

### 5. Adaptador Antigravity CLI (`src/antigravity-adapter/`) — modular, 8 archivos

MCP server que conecta el Hub con `agy` (Antigravity CLI de Google, derivado de Gemini CLI). Sigue el patrón del codex-adapter (HubClient + PushRouter + backend pluggable), pero con `AppServerClient` reemplazado por `AgentApiBackend`. Construido + verificado E2E el 2026-06-20.

**Cómo funciona el push (la parte difícil, resuelta vía oficial):**

- `agy.exe` corre un **Language Server in-process** que escucha en dos puertos loopback **aleatorios por sesión** (uno gRPC HTTPS, otro HTTP). El backend NO es un proceso aparte (a diferencia del app-server de Codex).
- La inyección en el TUI vivo se hace con el subcomando oficial **`agy agentapi send-message <conversation_id> <texto>`** (`AgentApiBackend`, spawn directo `shell:false`). agentapi es un cliente gRPC del LS que **maneja la auth/TLS él solo** → NO reverseamos mTLS, ni PTY, ni CDP. Necesita env `ANTIGRAVITY_LS_ADDRESS=127.0.0.1:<puerto HTTP>`.
- **Registro:** el adapter es un MCP server en `~/.gemini/config/mcp_config.json`. agy lo spawnea al arrancar → provee las 19 relay tools (agy **responde**) + empuja los mensajes entrantes (agy **reacciona**).

**Discovery** (`conversation-discovery.ts`, poll 5s):

- **Puerto LS**: del log de la sesión actual (`~/.gemini/antigravity-cli/log/cli-*.log`, línea `listening on random port at N for HTTP`), validado con `GET /healthz`. Usar el puerto **HTTP**, no el gRPC puro. Env `ANTIGRAVITY_LS_ADDRESS` (sidecar) tiene prioridad.
- **Conversación activa**: del MISMO log (último `conversation <uuid>`), que es autoritativo para la sesión viva. **NO usar `last_conversations.json`** (cache histórica que va con retraso → tras relanzar apunta a una conv muerta; inyectar ahí da exit 0 pero es invisible). Fallback gateado por env `ECORELAY_AGY_ALLOW_STALE_CONVERSATION_FALLBACK=1` (debug, nunca default).

**Gotchas críticos (descubiertos en E2E vivo, 2026-06-20) — NO romper:**

- **agentapi imprime JSON PRETTY-PRINTED multi-línea**. Parsear el blob ENTERO (`JSON.parse(stdout.trim())` + fallback substring `{..}`), NUNCA línea a línea. Un parser línea-a-línea da falso fallo → `PushRouter` reintenta en bucle (lo vivimos: spam cada 3s).
- **`PushRouter` tiene `MAX_SEND_FAILURES=5`** (circuit breaker): tras 5 fallos reales descarta el batch en vez de bucle infinito.
- **agy NO respawnea de forma fiable su MCP server (el adapter) al matarlo** — hay que **relanzar agy** para recargar código nuevo del adapter. Cada relanzamiento crea una **conversación nueva** (por eso el discovery lee el log de la sesión actual).
- **connect-only**: a diferencia del codex-adapter, NO spawnea el Hub (un spawn con allowlist sin `CLAUDE_PLUGIN_DATA` crearía isla de data-dir). Si el Hub está caído, log + reconnect.

### 6. Adaptador Cursor CLI (`src/cursor-adapter/`) — modular, 6 archivos

MCP server que conecta el Hub con `cursor-agent` (el CLI de Cursor, modelo Composer/backend de Cursor). Sigue el patrón connect-only de Antigravity (reutiliza `hub-client.ts`, `identity.ts`, `tools.ts`, `instructions.ts` casi 1:1, prefijo `cursor-`). Construido + integración "responde" verificada E2E el 2026-06-22.

**Las dos mitades:**

- **Responde (✅ verificado en vivo):** el adapter es un MCP server en `~/.cursor/mcp.json` (`{"type":"stdio","command":"bun","args":["run",".../cursor-adapter/index.ts"]}` + `agent mcp enable ecorelay`). Provee las 19 relay tools → Cursor envía/responde y aparece en `relay_peers` como `cursor-<workspace>`. Confirmado: Cursor llamó `relay_peers`/`relay_send` y los mensajes se entregaron.
- **Push idle (🟡 mecanismo resuelto, falta test final por cuota):** Cursor CLI **no** tiene inyección directa a TUI vivo ni surfacing async de notificaciones MCP (elicitation server-initiated fuera de tool call → `decline` silencioso, verificado en `McpSdkClient.setupElicitationHandler`). El **único canal nativo** que despierta una sesión idle es **background shell + `output_notification` (notify_on_output)**: el adapter escribe los mensajes entrantes a `~/.cursor/ecorelay-inbox.jsonl`; `relay-listener.ts` (armado por el agente como background shell monitorizado) emite `ECORELAY_MSG {...}` por mensaje → `BackgroundWorkRegistry.enqueueCompletion` → `setOnCompletionEnqueued` → `Ti("idle-enqueue")` → `backgroundTaskCompletionAction` (turno autónomo sin prompt humano). **Requiere el flag `long_running_jobs=true`**, off por defecto pero activable con `CURSOR_STATSIG_OVERRIDES` (env, lo deja persistente install.sh) — QF respeta overrides locales antes que el remoto.

**Gotchas / decisiones (2026-06-22):**

- **DeepSeek/BYOK NO funciona en el CLI**: la BYOK del IDE de Cursor no propaga al CLI (`agent --model deepseek-chat` → "Cannot use this model"; solo allowlist del servidor). El CLI solo lee env `CURSOR_API_*`, no `ANTHROPIC_BASE_URL`/`OPENAI_*`.
- **Sin `cursor-agent.exe`**: wrappers `.cmd`/`.ps1` + `node.exe` + `index.js` bundled en `versions/<v>/`. Para spawn limpio invocar `node.exe index.js` directo.
- **Descartados** (NO reintentar): `stop` hook + followup_message (turn-boundary, no push idle), headless `-p --resume` y ACP (instancia manejada aparte, no el TUI vivo), elicitation MCP (declina fuera de tool call).
- Diseño completo y receta de cierre en `F:\obsidian\...\EcoRelay_Cursor\solucion_push_cursor.md`. PoCs de estudio en `src/cursor-poc/` (ACP/headless, no son la solución de push).

## Dependencias entre módulos

```
hub-daemon.ts → hub/index.ts → registry, mailbox, groups, ws-endpoint, handlers/*, bridge
main.ts → channel/index.ts → bootstrap, register, hub-connection, reconnect, routing, tools/*
ecorelay.ts → (standalone OC, no importa de channel/ ni hub/)
ecorelay.mjs → (standalone Copilot, no importa de channel/ ni hub/)
codex-adapter/index.ts → identity, hub-client, app-server-client, thread-tracker, push, tools, instructions
antigravity-adapter/index.ts → identity, hub-client, conversation-discovery, agent-api-backend, push, tools, instructions
cursor-adapter/index.ts → identity, hub-client, tools, instructions (+ escribe ecorelay-inbox.jsonl; relay-listener.ts standalone)
hub-spawner.ts → (shared: lo usan channel/bootstrap.ts y potencialmente ecorelay.ts)
protocol.ts → (shared: define ClientMsg/ServerMsg, lo importan hub y channel)
framing.ts → (shared: readLines/writeLine sobre sockets)
data-dir.ts → (shared: resuelve paths ~/.eco-relay, CLAUDE_PLUGIN_DATA)
```

**ecorelay.ts y ecorelay.mjs son independientes**: no importan nada de `channel/` ni `hub/`. Monolitos por diseño.

**codex-adapter/ es modular**: 7 archivos TS. Importa `channel/tool-schemas/` y `protocol.ts`. Push via Codex app-server `turn/start` (WS). Requiere launcher (`ecorelay-codex.cmd`) para arrancar app-server + codex --remote.

**antigravity-adapter/ es modular**: 8 archivos TS. Importa `channel/tool-schemas/` y `protocol.ts`. Push via `agy agentapi send-message` (subproceso). Connect-only (no spawnea Hub). No requiere launcher: agy lo lanza como MCP server desde `~/.gemini/config/mcp_config.json`.

## Cómo se despliega

CC y OC tienen ubicaciones de código **separadas**. `scripts/install.sh` las cubre todas.

| Destino        | Path                                                                        | Quién lo usa                                                                                |
| -------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Standalone     | `~/.ecorelay/`                                                              | OC spawnea el daemon desde aquí                                                             |
| OC plugin      | `~/.config/opencode/plugins/ecorelay.ts`                                    | OC carga el plugin                                                                          |
| CC marketplace | `~/.claude/plugins/marketplaces/eco-relay/src/`                             | CC (a veces ejecuta desde aquí)                                                             |
| CC cache       | `~/.claude/plugins/cache/eco-relay/relay/<version>/`                        | CC (normalmente ejecuta desde aquí)                                                         |
| CC registry    | `~/.claude/plugins/installed_plugins.json`                                  | CC resuelve version → path                                                                  |
| Antigravity    | `~/.gemini/config/mcp_config.json` → `~/.ecorelay/src/antigravity-adapter/` | agy lanza el adapter como MCP server                                                        |
| Cursor CLI     | `~/.cursor/mcp.json` → `~/.ecorelay/src/cursor-adapter/`                    | cursor-agent lanza el adapter como MCP server (+ `CURSOR_STATSIG_OVERRIDES` para push idle) |

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
| `src/codex-adapter/index.ts` | Server version |
| `src/codex-adapter/app-server-client.ts` | clientInfo version |
| `src/antigravity-adapter/index.ts` | Server version |
| `src/cursor-adapter/index.ts` | Server version |
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

| Síntoma                                                                  | Causa probable                                                                                                        | Fix                                                                                                                 |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| CC no ve peers OC                                                        | Hub no abre WS (wsPort no se pasa)                                                                                    | Verificar hub-daemon.ts lee ECORELAY_WS_PORT                                                                        |
| OC ve peers zombis (sesiones muertas)                                    | session.list() bootstrap registra historial                                                                           | Verificar que bootstrap fue eliminado (v0.8+)                                                                       |
| CC arranca con código viejo tras deploy                                  | install.sh no cubrió marketplace o cache                                                                              | Verificar de dónde ejecuta CC (command line bun.exe)                                                                |
| installed_plugins.json con path roto                                     | Rutas Git Bash (/c/) vs Windows (C:\\)                                                                                | Usar cygpath -w para convertir                                                                                      |
| `bun` no ejecuta en bash/hook                                            | bun en PATH es shim .ps1                                                                                              | Usar ~/.bun/bin/bun.exe                                                                                             |
| Pre-commit hook falla con 72 errores                                     | `bun run check` → eslint src completo                                                                                 | --no-verify (deuda: arreglar hook o los 72 errores)                                                                 |
| Daemon no se apaga                                                       | Peers conectados lo mantienen vivo                                                                                    | Cerrar todos los CLI → 10s idle → exit                                                                              |
| Push reactivo no funciona (OC no reacciona)                              | session.prompt falla o token inválido                                                                                 | Verificar hub-ws-token existe + WS :19736 escucha                                                                   |
| Codex en `mode:tools-only` (envía pero no recibe push)                   | adapter sin app-server URL (env no propagada)                                                                         | El adapter lee el puerto del pid file; verificar `~/.eco-relay/codex-appserver.pid` y log `app_server_from_pidfile` |
| Codex MCP `timed out after 20s` al arrancar                              | `discover()` bloquea antes de `server.connect`                                                                        | Transporte MCP primero, app-server connect en background (ya en index.ts)                                           |
| Codex deja peers zombis al cerrar                                        | adapter huérfano (no se auto-mata)                                                                                    | Verificar `parent_gone_exiting` en el log; auto-muerte por stdin close (index.ts)                                   |
| Codex `error loading config.toml ... unicode value`                      | ruta Windows con comillas dobles en config.toml                                                                       | Comillas SIMPLES (literal TOML) en command/args                                                                     |
| Codex no recibe push hasta teclear                                       | cold-start: sin hilo activo hasta primer input                                                                        | Comportamiento esperado (compartido con OC); el push se retiene y entra al descubrir hilo (poll 60s)                |
| Codex no arranca / `.cmd` se cierra de golpe                             | error en launcher/adapter antes del TUI                                                                               | Correr a mano `~/.bun/bin/bun.exe run ~/.ecorelay/ecorelay-codex-launch.ts` para ver el error                       |
| agy: `push_sent` en el log pero el mensaje NO aparece en el TUI          | el adapter apunta a una conv obsoleta (`last_conversations.json` va con retraso)                                      | la conv activa se saca del log de la sesión actual; relanzar agy crea conv nueva (poll 5s la coge)                  |
| agy: el mismo mensaje entra en bucle cada ~3s                            | parser de agentapi roto con JSON multi-línea → falso fallo → requeue                                                  | parsear el blob entero, no línea a línea; `MAX_SEND_FAILURES=5` corta el bucle                                      |
| Hub WS falla a bindear (WSAEACCES / "is port in use" pero netstat vacío) | puerto en rango excluido de Windows (winnat/Hyper-V reserva bloques; 9376/9700 cayeron en 9317-9716 tras un reinicio) | usar puertos fuera del rango (WS 19736, bridge 19700); `netsh int ipv4 show excludedportrange protocol=tcp`         |
| agy no recibe push nuevo tras matar el adapter                           | agy NO respawnea su MCP server de forma fiable                                                                        | relanzar agy para recargar el adapter                                                                               |

## Decisiones de arquitectura (por qué las cosas son así)

- **ecorelay.ts monolito**: OC plugins son un solo archivo por diseño de @opencode-ai/plugin. No se puede separar.
- **Channel CC separado (no reutiliza ecorelay.ts)**: CC tiene su propio sistema MCP (@modelcontextprotocol/sdk). Las APIs son incompatibles. Dos implementaciones independientes.
- **Hub como daemon detached**: sobrevive al cierre de cualquier CLI individual. Los que abren después se conectan.
- **Bootstrap simétrico**: CC y OC ambos pueden spawnear el Hub. El primero gana, el otro conecta. No importa el orden.
- **Push reactivo sin noReply**: decisión de producto (Pepe). El agente receptor procesa y reacciona automáticamente. Superficie de prompt injection aceptada como deuda (salvaguarda = trabajo adversarial + límites agénticos).
- **Token auth WS (no Unix socket)**: Unix socket ya está protegido por permisos del filesystem (solo el usuario). WS es TCP → necesita auth explícita.
- **Codex requiere launcher (asimetría asumida)**: en Windows no hay forma de que un tercero pushee a un codex TUI normal (daemon Unix-only, named-pipe OpenAI-firmado, sin inyección MCP). Verificado primera mano. Única vía = launcher que arranca `codex app-server --listen` + `codex --remote`. Pepe lo aceptó en previsión de un futuro dashboard de control de EcoRelay que lanzaría Codex. Encaja ahí.
- **Codex: descubrimiento por pid file (no env)**: porque Codex no propaga el env del proceso a los MCP children. El adapter lee el puerto del pid file que escribe el launcher. Sin puerto fijo, sin env var.
- **codex-adapter modular (no monolito como OC/Copilot)**: 7 archivos TS. Reutiliza `channel/tool-schemas/` + `protocol.ts`. Se pudo modularizar porque usa el SDK MCP estándar (no la API de plugin de un harness concreto).
- **Antigravity: push via `agentapi` (vía oficial)**: agy expone el subcomando interno `agy agentapi send-message`, un cliente gRPC de su Language Server in-process que maneja auth/TLS solo. Descartados: SDK Python (spawnea su propio runtime `localharness.exe` aislado, no inyecta en el TUI), gRPC directo (mTLS), PTY y CDP (frágiles). Verificado E2E con confirmación visual de agy.
- **Antigravity: conv activa del log, no de `last_conversations.json`**: la cache histórica va con retraso y tras relanzar apunta a conv muerta (inyectar ahí da exit 0 pero invisible). El log de la sesión actual (`cli-*.log`) es la fuente autoritativa de la conversación viva.

## Deuda conocida (v1.0.0)

| Deuda                                             | Severidad       | Contexto                                                                                                                                                                                   |
| ------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DC2: dead code hub-spawner.ts:161-314             | LOW             | ~150 líneas (deleteLock, acquireLock, HubHandle, etc.) Pre-existente                                                                                                                       |
| VS3-C5: push reactivo = injection surface         | ACCEPTED (Pepe) | Salvaguarda = adversarial + límites agénticos                                                                                                                                              |
| Pre-commit hook: 72 eslint errors                 | MEDIUM          | Sesión de lint/prettier pendiente                                                                                                                                                          |
| OC sessions: no auto-register hasta activación    | LOW             | Limitación de OpenCode, no de relay                                                                                                                                                        |
| INSTRUCTIONS_MARKER: sigue en v0.7.6              | LOW             | Es marcador de protocolo, no display                                                                                                                                                       |
| bump-version.sh: no existe                        | LOW             | Versiones se alinean a mano (8 archivos ahora)                                                                                                                                             |
| Codex launcher (asimetría con CC/OC/Copilot)      | ACCEPTED (Pepe) | Inherente a Codex en Windows; encaja en futuro dashboard EcoRelay                                                                                                                          |
| Codex cold-start: no recibe hasta primer input    | ACCEPTED        | Compartido con OC. Mejora futura: bajar poll interval cuando no hay hilo                                                                                                                   |
| Codex peer naming `codex-.ecorelay`               | LOW             | cwd = dir de instalación; afinar para reflejar el proyecto del usuario                                                                                                                     |
| codex-adapter security residuales                 | ACCEPTED        | Single-user/loopback (VS40, VS48-deep, VS35, VS18, VS25...) — re-evaluar si multi-user                                                                                                     |
| Backport VS1 (escape ambos tags) a OC             | OPEN            | `opencode-plugin/ecorelay.ts` tiene el bug single-tag; codex ya lo arregla                                                                                                                 |
| codex-beta-ping (channel CC, env-gated)           | LOW             | Sonda research de la fase de plan; no-op por defecto                                                                                                                                       |
| antigravity-adapter: faltan tests `bun:test`      | MEDIUM          | identity, conversation-discovery (formato last_conversations + healthz mock), agent-api-backend (spawn mock + stdout multi-línea), push (dedup/batch/rate/requeue/cap)                     |
| antigravity: registro vía sidecar (no mcp_config) | OPEN            | `~/.gemini/config/config.json` con SidecarConfig inyecta `ANTIGRAVITY_LS_ADDRESS`/CSRF/PROJECT_ID — vía soportada más limpia que mcp_config + auto-discovery. Sacar schema del oráculo agy |
| antigravity: discovery multi-agy                  | LOW             | el discovery lee el log más nuevo (1 sesión). Con varias agy a la vez habría que cruzar PID/puerto/conv. Phase 2                                                                           |
| trusted-peers (suprimir wrapper untrusted)        | OPEN (Pepe)     | producto-wide (todos los adapters): lista de peers de confianza → etiqueta ligera en vez de `<untrusted_peer_message>`. Coordinar con Hilo                                                 |

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
│   ├── ws-endpoint.ts          #   WS :19736 + token auth
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
├── copilot-extension/          # Extension Copilot CLI (monolito)
│   └── ecorelay.mjs            #   ~1337 líneas, JS puro
├── codex-adapter/              # Adaptador Codex CLI (modular, 7 archivos)
│   ├── index.ts                #   Entry MCP server, orquesta lifecycle
│   ├── identity.ts             #   Peer naming, cwd, git branch, cache
│   ├── hub-client.ts           #   WS al Hub, protocol v5, reconnect
│   ├── app-server-client.ts    #   WS al app-server Codex, turn/start
│   ├── thread-tracker.ts       #   Descubre y sigue el thread activo
│   ├── push.ts                 #   Hub msg → batch → wrapUntrusted → turn/start
│   ├── tools.ts                #   19 relay tools sobre hub-client
│   └── instructions.ts         #   MCP instructions para el modelo
├── antigravity-adapter/        # Adaptador Antigravity CLI (modular, 8 archivos)
│   ├── index.ts                #   Entry MCP server, orquesta lifecycle
│   ├── identity.ts             #   Peer naming (agy-<workspace>)
│   ├── hub-client.ts           #   WS al Hub, connect-only (no spawn)
│   ├── conversation-discovery.ts #  Puerto LS + conv activa del cli log (+/healthz)
│   ├── agent-api-backend.ts    #   Push via `agy agentapi send-message`
│   ├── push.ts                 #   Hub msg → batch → wrapUntrusted → backend
│   ├── tools.ts                #   19 relay tools sobre hub-client
│   └── instructions.ts         #   MCP instructions para el modelo
├── cursor-adapter/             # Adaptador Cursor CLI (modular, 6 archivos)
│   ├── index.ts                #   Entry MCP server + escribe ecorelay-inbox.jsonl
│   ├── identity.ts             #   Peer naming (cursor-<workspace>)
│   ├── hub-client.ts           #   WS al Hub, connect-only (no spawn)
│   ├── relay-listener.ts       #   Background shell: tail inbox → emite ECORELAY_MSG (push idle)
│   ├── tools.ts                #   19 relay tools sobre hub-client
│   └── instructions.ts         #   MCP instructions para el modelo
├── shared/
│   └── hub-spawner.ts          #   spawnDetachedDaemon, tryConnect
├── relay-server/
│   └── index.ts                #   WS relay (internet federation)
└── integration/
    └── cross-transport.test.ts #   CC↔OC integration
```
