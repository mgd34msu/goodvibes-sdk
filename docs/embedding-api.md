# SDK Embedding API 1.0

`@pellux/goodvibes-sdk/embed` is the supported, stability-marked surface for
embedding a GoodVibes session in another application. It is a curation of
existing runtime machinery — it adds no new engine; it names the minimal stable
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

| member        | purpose                                                        |
| ------------- | ------------------------------------------------------------- |
| `workspace`   | the project root the session operates against                 |
| `url`         | base URL of the daemon's HTTP surface                          |
| `events`      | the `RuntimeEventBus` — `.on(type, cb)` / `.onDomain(dom, cb)` |
| `approvals`   | the `ApprovalBroker` permission asks flow through             |
| `sessions`    | the `SharedSessionBroker` backing the session                 |
| `submit(in)`  | send input; resolves with the broker's submission record      |
| `stop()`      | tear down and release the port (idempotent)                   |

**Permission callback injection.** When `requestPermission` is provided, every
pending approval on the session's broker is routed to it and resolved with its
decision — an embedder answers permission asks with a callback instead of driving
the HTTP approvals routes.

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
