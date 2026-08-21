# @pellux/goodvibes-daemon-sdk

Public GoodVibes daemon package for embeddable route contracts, dispatchers, handler builders, and daemon-side helpers.

Most applications should install `@pellux/goodvibes-sdk` and import `@pellux/goodvibes-sdk/daemon`. Install this package directly when you only need the daemon embedding subset.

Consumer import:

```ts
import {
  createDaemonControlRouteHandlers,
  createDaemonTelemetryRouteHandlers,
  dispatchDaemonApiRoutes,
} from '@pellux/goodvibes-sdk/daemon';
```

This surface is for:
- embed daemon routes in another host
- dispatch operator, automation, session, task, or remote API calls
- reuse shared daemon auth/error helpers

See [Daemon Embedding](../../docs/daemon-embedding.md) for the full daemon surface, dispatchers, and the recommended embedding pattern.

This package gives you reusable route modules, but your host still owns:
- **request routing**: matching an incoming request to the handler this package builds for it.
- **concrete services**: the session stores, provider clients, and other objects a route-handler factory is built from.
- **auth/session storage**: where tokens and sessions actually live.
- **runtime bootstrapping**: starting your process and wiring these pieces together.

Use this surface when you are embedding GoodVibes into another TypeScript server. Do not use it for normal client-side integrations.
