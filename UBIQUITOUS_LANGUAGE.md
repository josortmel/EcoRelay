# Ubiquitous Language

Terms used consistently across code, docs, and conversation.

## Core concepts

**Hub** — single per-machine daemon process that routes messages between peers. Owns the Unix socket at `$CLAUDE_PLUGIN_DATA/hub.sock` (plugin) or `~/.eco-relay/hub.sock` (manual install). Lives independently of any session; self-exits 5 minutes after the last peer disconnects.

**Channel** — per-session MCP server that connects the session to the hub and exposes the Relay tools to Claude. Each Claude Code session runs one channel.

**Peer** — a channel registered with the hub. Identified by a unique name. Sessions discover peers via `relay_peers`.

**Session** — a Claude Code process. One session = one channel. The peer the session owns.

**Ask** — a directed message from one peer (`caller`) to another (`target`). Has an `ask_id` for correlation. Answered with a `reply`; fails with `peer_not_found`, `peer_gone`, or `timeout`.

**Reply** — a response to an ask, routed back to the caller by `ask_id`.

**Broadcast** — a message to all other peers. Has a `broadcast_id`. Returns `{broadcast_id, peer_count}` synchronously to the caller. Each peer's reply streams back as a separate notification tagged with `broadcast_id`.

**Channel notification** — an MCP `notifications/claude/channel` event that surfaces an incoming ask or broadcast reply to Claude between turns. Built by Claude Code from `{content, meta}` params into `<channel ...>body</channel>` XML.

**Thread** — an opaque identifier that rides along with an ask and its matching reply, letting callers correlate multi-turn exchanges. The hub auto-generates a `thread_id` on `ask` if the caller omits one. Broadcasts reuse `broadcast_id` as the `thread_id` so all per-peer asks and their replies share a single thread.

## Roles

**Host** — the channel that spawned the hub daemon in the current lifecycle. Informational only; all peers act as clients at the protocol layer.

**Client** — any channel connected to an existing hub. Sends all messages over the Unix socket.

**Asker / Caller** — the peer that sent an ask.

**Target** — the peer an ask is addressed to.

## Wire protocol types

**`register`** — client→hub, announces presence with `{name, cwd, git_branch, protocol_version}`.

**`rename`** — client→hub, changes the peer's name. First-wins.

**`list_peers`** — client→hub, requests the peer directory.

**`ask` / `reply` / `broadcast`** — client→hub, the three message kinds. `ask` carries an optional `thread_id`.

**`incoming_ask` / `incoming_reply`** — hub→client, delivered routed messages. Both carry an optional `thread_id` mirrored from the originating ask.

**`ack` / `err` / `peers` / `broadcast_ack`** — hub→client, responses.

## Error codes

See [README](README.md#error-codes) for the full table. Canonical codes: `peer_not_found`, `peer_gone`, `timeout`, `name_taken`, `not_registered`, `already_registered`, `unknown_ask`, `bad_msg`, `hub_unreachable`, `bad_args`, `protocol_mismatch`, `unexpected`.

## State

**Pending ask** — an ask the hub is waiting to route a reply for. Keyed by `ask_id`. Has a timeout; removed on reply or timer fire.

**Registry** — the hub's in-memory map of `name → peer entry`. Includes `cwd`, `git_branch`, `last_seen`.

**Stale socket** — a Unix socket file left behind from a crashed hub. Detected on startup via a short-timeout probe; unlinked and replaced.

## Not domain terms

Avoid in docs and identifiers: _session peer_ (pick one), _ticket_, _message queue_, _daemon connection_ (say "hub socket"), _actor_ (say "peer").
