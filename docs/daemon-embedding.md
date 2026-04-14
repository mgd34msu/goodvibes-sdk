# Daemon Embedding

Use `@goodvibes/daemon-sdk` when you want to host GoodVibes daemon routes in another server process.

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
} from '@goodvibes/daemon-sdk';
```

## Operator/automation/session/task dispatch

```ts
import { dispatchDaemonApiRoutes } from '@goodvibes/daemon-sdk';
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
- runtime bootstrapping
- concrete host policies like CORS, TLS, and deployment-specific auth envelopes

## Recommended embedding pattern

1. Build concrete service/context adapters in your host app.
2. Create the daemon route handlers from those adapters.
3. Route incoming requests into the appropriate handler or dispatcher.
4. Keep platform semantics in sync by updating from `goodvibes-tui` first, then syncing this repo.

The example at [daemon-fetch-handler-quickstart.ts](../examples/daemon-fetch-handler-quickstart.ts) shows the intended shape.
