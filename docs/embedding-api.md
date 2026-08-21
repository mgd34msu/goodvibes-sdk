# SDK embedding API 1.0

`@pellux/goodvibes-sdk/embed` is the supported, stability-marked surface for
embedding a GoodVibes session in another application. It is a curation of
existing runtime machinery. It adds no new engine. It names the minimal stable
contract: **create a session against a workspace, send input, receive typed
events, inject a permission callback, and shut down.**

## Quick start

```ts
import { createEmbeddedSession } from '@pellux/goodvibes-sdk/embed';

const session = await createEmbeddedSession({
  workspace: process.cwd(),
  homeDirectory: process.env.HOME!,
  requestPermission: async (request) => ({ approved: request.category === 'read' }),
});

const stop = session.events.onDomain('turn', (envelope) => {
  console.log(envelope.type, envelope.payload.type);
});

await session.submit('Summarize the README.');

stop();
await session.stop();
```

See `examples/embed-session-quickstart.ts` (compile-checked in CI).

## The contract

`createEmbeddedSession(options)` boots an in-process daemon for the workspace and
returns an `EmbeddedSession`:

| member                  | purpose                                                        |
| ------------------------ | ------------------------------------------------------------- |
| `workspace`               | the project root the session operates against                 |
| `url`                     | base URL of the daemon's HTTP surface                          |
| `events`                  | the `RuntimeEventBus`: `.on(type, cb)` or `.onDomain(dom, cb)` |
| `approvals`               | the `ApprovalBroker` permission asks flow through             |
| `sessions`                | the `SharedSessionBroker` backing the session                 |
| `submit(in)`              | send input; resolves with the broker's submission record      |
| `cancelActive(agentIds)`  | cancel one or more in-flight agent turns by the agent id a submission reported as `activeAgentId`; returns the number actually cancelled |
| `stop()`                  | tear down and release the port (idempotent)                   |

**Permission callback injection.** When `requestPermission` is provided, every
pending approval on the session's broker is routed to it and resolved with its
decision. An embedder answers permission asks with a callback instead of driving
the HTTP approvals routes.

**Cancelling in-flight work.** `cancelActive` is a real cancellation, not a
courtesy flag: it aborts the agent's in-flight provider call so the turn stops
mid-flight and emits its cancelled outcome, rather than only cancelling a
still-queued input. Unknown agent ids are ignored.

**Connecting MCP servers.** `EmbedSessionOptions.mcpServers` lets an embedder
declare MCP servers (for example, the servers an ACP client passes in
`session/new`) to connect into the session's live tool surface at boot; their
tools join the session namespaced as `mcp:<name>:<tool>`. Only the stdio
transport is supported; the registry spawns a process for each server. A
server that fails to connect is logged and skipped; it never aborts session
creation.

**Receiving events.** Subscribe to the typed `RuntimeEventBus`. Each envelope
carries `type`, `payload` (the typed event), and correlation ids
(`sessionId`, `turnId`, …).

## Stability guarantees

The surface is **frozen at 1.0** and pinned by an api-extractor report
(`etc/goodvibes-sdk-embed.api.md`) so an accidental breaking change fails the
`api:check` gate. Frozen:

- `createEmbeddedSession` and the `EmbeddedSession` shape;
- `EmbedSessionOptions`, `EmbeddedSessionInput`;
- the re-exported `bootDaemon` / `BootDaemonOptions` / `BootedDaemon`;
- the permission-callback contract (`PermissionRequestHandler`,
  `PermissionPromptRequest`, `PermissionPromptDecision`);
- the event-subscription contract (`RuntimeEventBus`, `AnyRuntimeEvent`,
  `RuntimeEventDomain`).

**Internal** (reachable through these types but not part of the frozen contract,
may change in a minor): the full member surface of `DaemonServer`,
`ApprovalBroker`, and `SharedSessionBroker` beyond the members named above, and
the concrete per-domain event payload fields.
