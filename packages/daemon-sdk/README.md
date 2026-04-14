# @goodvibes/daemon-sdk

Embeddable daemon and control-plane route contracts, dispatchers, and handler builders for GoodVibes.

Install:

```bash
npm install @goodvibes/daemon-sdk
```

Use this package to:
- embed daemon routes in another host
- dispatch operator, automation, session, task, or remote API calls
- reuse shared daemon auth/error helpers

Typical entrypoints:

```ts
import {
  createDaemonControlRouteHandlers,
  createDaemonTelemetryRouteHandlers,
  dispatchDaemonApiRoutes,
} from '@goodvibes/daemon-sdk';
```

This package gives you reusable route modules, but your host still owns:
- request routing
- concrete services
- auth/session storage
- runtime bootstrapping

Use this package when you are embedding GoodVibes into another TypeScript server. Do not use it for normal client-side integrations.
