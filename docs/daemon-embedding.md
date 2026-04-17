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

## Other route groups

The daemon package also exports reusable route builders for:
- channel routes
- integration routes
- system routes
- knowledge routes
- media routes
- runtime automation routes
- runtime session routes
- remote/peer routes

## Host responsibility

The SDK does not replace your server framework. You still own:
- request routing
- concrete service implementations
- auth/session storage
- host-specific surface/storage root decisions
- runtime bootstrapping
- concrete host policies like CORS, TLS, and deployment-specific auth envelopes

## Recommended embedding pattern

1. Build concrete service/context adapters in your host app.
2. Create the daemon route handlers from those adapters.
3. Route incoming requests into the appropriate handler or dispatcher.
4. Keep platform semantics inside this repo and adapt them through your host-specific wiring.

The example at [daemon-fetch-handler-quickstart.ts](../examples/daemon-fetch-handler-quickstart.ts) shows the intended shape.

## Error handling

All SDK errors extend `GoodVibesSdkError`. The daemon surface emits typed errors across the full `SDKErrorKind` union (`'auth'`, `'config'`, `'contract'`, `'network'`, `'not-found'`, `'rate-limit'`, `'server'`, `'validation'`, `'unknown'`). Tool-execution and agent-execution failures surface as `'server'`, `'validation'`, or `'unknown'` depending on the failure mode — check `err.category` (values like `'tool'`, `'service'`, `'protocol'`) for finer-grained classification. See [Error Kinds](./error-kinds.md) for details.

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
      case 'server':
        // tool/agent execution failure, 5xx from daemon — log and degrade
        // narrow further: err.category === 'tool' | 'service' | 'protocol'
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
