# Daemon Embedding

This is the **full surface** — Bun runtime required. See [Runtime Surfaces](./surfaces.md).

## What the daemon surface gives you

- Agent execution and lifecycle management
- Tool execution, LSP integration, and MCP protocol support
- Workflow triggers and runtime automation
- HTTP server via `Bun.serve` with typed daemon route contracts
- File-system state and process spawning
- Full operator control and telemetry surfaces
- Structured daemon error handling via error-kind taxonomy

Use `@pellux/goodvibes-sdk/daemon` when you want to host GoodVibes daemon routes in another server process.

The package gives you:
- typed route-handler contracts
- route-group builders
- route dispatchers
- shared auth/scope helpers
- structured daemon error helpers

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

Other route categories (channel, integration, system, knowledge, media) are available
internally via the full platform hub (`@pellux/goodvibes-sdk/platform`) but do not
have separate public dispatcher exports at this time.

## Host responsibility

The SDK does not replace your server framework. You still own:
- request routing
- concrete service implementations
- auth/session storage
- host-specific surface/storage root decisions
- runtime bootstrapping
- concrete host policies like CORS, TLS, and deployment-specific auth envelopes

## Connect-or-start daemon startup

Full-surface hosts such as the TUI call `startHostServices` to start SDK-owned
local services. When `danger.daemon` is
enabled, the SDK now treats daemon startup as a connect-or-start decision:

- If the configured `controlPlane.host` and `controlPlane.port` are free, the
  SDK starts an embedded daemon and returns `daemonStatus.mode: "embedded"`.
- If the port is occupied, the SDK probes `GET /status` with the configured
  shared daemon token. A matching GoodVibes status response returns
  `daemonStatus.mode: "external"` and includes the detected version.
- If the port is occupied but the process cannot be verified as GoodVibes, the
  SDK does not start another daemon and returns `daemonStatus.mode: "blocked"`
  with a reason.
- If daemon startup times out, the SDK returns
  `daemonStatus.mode: "unavailable"`.

The `daemonServer` property remains `null` for external, blocked,
disabled, and unavailable cases because there is no embedded server instance to
stop. Hosts should read `daemonStatus` to distinguish these cases instead of
treating every `daemonServer: null` as the same outcome. `httpListenerStatus`
provides the same disabled, embedded, blocked, and unavailable reporting for the
HTTP listener.

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
        // scope or token problem — return 401/403
        break;
      case 'validation':
        // bad request shape — return 400
        break;
      case 'service':
      case 'protocol':
      case 'tool':
      case 'internal':
        // Upstream service, wire-protocol, tool, or daemon-internal failure.
        break;
      case 'unknown':
        // unexpected failure — log with full err context
        break;
      default:
        throw err;
    }
  }
}
```

## Observability

`SDKObserver` integrates with the full daemon surface for structured event tracing. Use `createConsoleObserver` during development or wire a custom observer for production telemetry pipelines. See [Observability](./observability.md) for the full observer API.

```ts
import { createConsoleObserver } from '@pellux/goodvibes-sdk';

const sdk = createGoodVibesSdk({
  observer: createConsoleObserver(),
});
```
