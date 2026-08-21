# Daemon Embedding

This is the **full surface**. Bun runtime required. See [Runtime surfaces](./surfaces.md).

## What the daemon surface gives you

Use `@pellux/goodvibes-sdk/daemon` when you want to host GoodVibes daemon routes in another server process, rather than running the standalone `goodvibes-daemon` binary. It gives you:

- **Agent execution and lifecycle management**: creating, running, and tearing down agent turns.
- **Tool execution, LSP integration, and MCP protocol support**: the tool-calling surface an agent turn drives, including language-server-backed tools and MCP server connections.
- **Workflow triggers and runtime automation**: scheduled and event-driven automation that starts sessions without a human present.
- **An HTTP server built on `Bun.serve`** with typed daemon route contracts, so route handlers and their request/response shapes are checked at compile time.
- **File-system state and process spawning**: the daemon's own persisted state and the subprocesses it starts for tools and channels.
- **Full operator control and telemetry surfaces**: the control-plane routes and metrics/tracing endpoints an operator dashboard or CLI drives.
- **Structured daemon error handling** through the `SDKErrorKind` taxonomy described below, so callers branch on an error's kind instead of parsing English messages.

Concretely, the package gives you:
- **typed route-handler contracts**, the request/response shapes each route factory expects and returns;
- **route-group builders**, factories like `createDaemonControlRouteHandlers` that build a set of handlers from your service adapters;
- **route dispatchers**, functions like `dispatchDaemonApiRoutes` that route a request to the right handler for you;
- **shared auth/scope helpers**, for resolving the authenticated principal and checking required scopes;
- **structured daemon error helpers**, for building and summarizing `GoodVibesSdkError`-shaped responses.

## Control and telemetry routes

```ts
import {
  createDaemonControlRouteHandlers,
  createDaemonTelemetryRouteHandlers,
} from '@pellux/goodvibes-sdk/daemon';
```

## Operator/automation/session/task dispatch

```ts
import { dispatchDaemonApiRoutes } from '@pellux/goodvibes-sdk/daemon';
```

## Other exported dispatchers

The daemon package (`@pellux/goodvibes-sdk/daemon`) also exports:

```ts
import {
  dispatchAutomationRoutes,
  dispatchSessionRoutes,
  dispatchTaskRoutes,
  dispatchOperatorRoutes,
  dispatchRemoteRoutes,
} from '@pellux/goodvibes-sdk/daemon';
```

Other route categories (channel, integration, system, knowledge, media) are host-owned
composition points. Import the exported subsystem routes and services from their
explicit public subpaths rather than through a catch-all platform barrel.

## Host responsibility

The SDK does not replace your server framework. You still own:
- **request routing**: matching incoming requests to the handlers this package builds.
- **concrete service implementations**: the objects (session stores, provider clients, and so on) the route-handler factories are built from.
- **auth/session storage**: where tokens and sessions actually live; the SDK gives you the auth/scope helpers, not the storage.
- **host-specific surface/storage root decisions**: where on disk or in which bucket your host keeps its state.
- **runtime bootstrapping**: starting your process and wiring these pieces together.
- **concrete host policies** like CORS, TLS termination, and deployment-specific auth envelopes.

## Adopt-or-spawn daemon startup

Full-surface hosts such as the TUI call `startHostServices` to start the
services a client surface owns. The daemon itself is never one of them:
`startHostServices` never constructs a `DaemonServer` in the calling process.
The daemon is a separate product (`goodvibes-daemon`) with its own
composition root; a host either adopts an already-running compatible daemon
or spawns the standalone `goodvibes-daemon` binary as a detached child
process and then adopts that. `daemonServer` on the returned handle is always
`null`, there is no in-process daemon instance to hold or stop.

When `daemon.enabled` is true (the default; resolved via
`resolveDaemonEnabled`), the shared pure decision in
`decideDaemonAdoption` (`platform/runtime/daemon-adoption-policy.ts`) maps
a port probe and an identity probe onto one of these outcomes, reported as
`daemonStatus.mode`:

- **`external`** (adopt): a compatible GoodVibes daemon already answers on the
  configured host/port, or a freshly spawned detached daemon became reachable.
  The host runs without owning the daemon process itself.
- **`incompatible`**: a GoodVibes daemon answers, but on a version band this
  host cannot adopt. The host never starts a second, competing daemon; it
  reports the mismatch and runs without one.
- **`blocked`**: the configured port is occupied by a process that does not
  verify as a GoodVibes daemon. The host runs without a daemon rather than
  guessing.
- **`unavailable`**: the port is free but no daemon exists to adopt and this
  call is not allowed to spawn one (`adoptOnly: true`, what both `goodvibes-tui`
  and `goodvibes-agent` pass), or a spawn attempt did not become reachable in
  time.
- **`disabled`**: `daemon.enabled` (or the caller's own gate) is false.

A caller that does not pass `adoptOnly: true` and finds the port free spawns
the detached `goodvibes-daemon` binary (Owner ruling D7a: the daemon is a
system service, so a surface starting must not couple the daemon's lifetime to
that surface's process) and then adopts it the same way as an already-running
one, still reported as `external`.

Hosts should read `daemonStatus` rather than treat every `daemonServer: null`
as the same outcome, since `daemonServer` is unconditionally `null` regardless
of which of the outcomes above occurred.

`httpListenerStatus` reports on a different, separate service: the optional
HTTP listener gated by `danger.httpListener` (default off). Unlike the daemon,
the listener genuinely can be constructed in-process, so its modes include a
real `"embedded"` state (`embeddedHttpListener` on the handle is non-null in
that case) alongside `"disabled"`, `"blocked"`, and `"unavailable"`.

## Recommended embedding pattern

1. Build concrete service/context adapters in your host app.
2. Create the daemon route handlers from those adapters.
3. Route incoming requests into the appropriate handler or dispatcher.
4. Keep platform semantics inside this repo and adapt them through your host-specific wiring.

The example at [daemon-fetch-handler-quickstart.ts](../examples/daemon-fetch-handler-quickstart.ts) shows the intended shape.

## Error handling

All SDK errors extend `GoodVibesSdkError`. The daemon surface emits typed errors across the full `SDKErrorKind` union (`'auth'`, `'config'`, `'contract'`, `'network'`, `'not-found'`, `'protocol'`, `'rate-limit'`, `'service'`, `'internal'`, `'tool'`, `'validation'`, `'unknown'`). Tool-execution, upstream-service, protocol, and daemon-internal failures surface through their matching kind so callers do not need to infer them from English messages. See [Error Kinds](./error-kinds.md) for details.

```ts
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk/errors';

try {
  await handler(req);
} catch (err) {
  if (err instanceof GoodVibesSdkError) {
    switch (err.kind) {
      case 'auth':
        // scope or token problem, return 401/403
        break;
      case 'validation':
        // bad request shape, return 400
        break;
      case 'service':
      case 'protocol':
      case 'tool':
      case 'internal':
        // Upstream service, wire-protocol, tool, or daemon-internal failure.
        break;
      case 'unknown':
        // unexpected failure, log with full err context
        break;
      default:
        throw err;
    }
  }
}
```

## Observability

`SDKObserver` is not part of the daemon route-handler surface itself: `bootDaemon`
and `DaemonServer` take no observer option. It belongs to the client SDK
(`createGoodVibesSdk`), the HTTP client other code uses to call a running
daemon's API, so it is the right tool when your host both embeds daemon routes
and also talks to a daemon (its own or another one) as a client. Use
`createConsoleObserver` during development or wire a custom observer for
production telemetry pipelines. See [Observability](./observability.md) for the
full observer API.

```ts
import { createGoodVibesSdk, createConsoleObserver } from '@pellux/goodvibes-sdk';

const sdk = createGoodVibesSdk({
  baseUrl: 'https://daemon.example.com',
  authToken: process.env.GV_TOKEN,
  observer: createConsoleObserver(),
});
```

## Related

- [Daemon batch processing](./daemon-batch-processing.md): opt-in provider Batch API queuing through the daemon.
- [Provider and model API reference](./provider-model-api.md): model-catalog discovery, live model selection, and `providers`-domain SSE events.
- [Runtime Surfaces](./surfaces.md), [Error Kinds](./error-kinds.md), and [Observability](./observability.md).
