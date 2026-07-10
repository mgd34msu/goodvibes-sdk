# ACP agent — drive GoodVibes from ACP-capable editors

GoodVibes ships an **agent-side** adapter for the Agent Client Protocol (ACP),
the editor-agnostic protocol used by Zed and other clients. An editor spawns the
adapter over stdio and drives a GoodVibes session through the protocol. (This is
the counterpart of the existing client side under `platform/acp`, where GoodVibes
itself spawns ACP subagents.)

## Running it

Point the editor's agent-server command at:

```
bun scripts/acp-agent.ts
```

Environment: `GOODVIBES_HOME` sets the embedded daemon's home directory
(default `$HOME`).

Programmatic use (exported from `@pellux/goodvibes-sdk/platform/acp`):

```ts
import { serveAcpAgent, GoodVibesAcpAgent } from '@pellux/goodvibes-sdk/platform/acp';
const { connection, dispose } = serveAcpAgent({ homeDirectory: process.env.HOME! });
```

## What it maps

The substrate is the SDK Embedding API (`@pellux/goodvibes-sdk/embed`) — each
ACP `session/new` boots an embedded GoodVibes session against the request's
`cwd`, and the adapter is a protocol mapping over that surface:

| ACP                           | GoodVibes                                              |
| ----------------------------- | ------------------------------------------------------ |
| `initialize` / `authenticate` | capability report; no auth (process-local daemon)      |
| `session/new` (cwd)           | `createEmbeddedSession({ workspace: cwd })`            |
| `session/prompt` (text)       | `session.submit(text)`                                 |
| `agent_message_chunk`         | runtime `STREAM_DELTA` turn events                     |
| `tool_call` / `tool_call_update` | runtime `TOOL_EXECUTING` / `TOOL_SUCCEEDED` / `TOOL_FAILED` |
| stop reason                   | terminal turn events (see mapping below)               |
| `session/request_permission`  | the platform permission callback (allow once / always / reject) |
| `session/cancel`              | broker `cancelInput` + prompt resolves `cancelled`     |

Stop-reason mapping: `TURN_COMPLETED → end_turn`, `TURN_CANCEL → cancelled`,
`context_overflow → max_tokens`, `tool_loop_circuit_breaker →
max_turn_requests`, other turn errors → `refusal`.

## Honest capability surface

Anything the platform does not support is reported `false` — never stubbed:

- `loadSession: false` — no session restore over ACP.
- `promptCapabilities.image / audio / embeddedContext: false` — prompt input is
  text (text blocks plus `resource_link` URIs folded in as text references).
- `mcpCapabilities.http / sse: false` — the adapter does not wire the client's
  MCP servers into the embedded session; `mcpServers` entries in `session/new`
  are ignored.
- Cancellation is best-effort: a queued input is cancelled via the broker; an
  already-executing provider call is not aborted mid-flight.

## Event attribution

Runtime envelopes are matched to an ACP session by runtime session id (the
shared-session record id and, when present, the active agent id). When exactly
one ACP session is active — the common editor case — all turn/tool events are
forwarded to it.
