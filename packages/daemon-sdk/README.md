# @pellux/goodvibes-daemon-sdk

Internal workspace package backing `@pellux/goodvibes-sdk/daemon`.

Consumers should install `@pellux/goodvibes-sdk` and import this surface from the umbrella package.

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

Typical entrypoints:

```ts
import {
  createDaemonControlRouteHandlers,
  createDaemonTelemetryRouteHandlers,
  dispatchDaemonApiRoutes,
} from '@pellux/goodvibes-sdk/daemon';
```

This package gives you reusable route modules, but your host still owns:
- request routing
- concrete services
- auth/session storage
- runtime bootstrapping

Use this surface when you are embedding GoodVibes into another TypeScript server. Do not use it for normal client-side integrations.
