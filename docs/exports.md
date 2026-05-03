# Public Exports

GoodVibes SDK exposes deliberate entrypoints. Code under repository
source folders is implementation, not public API.

## Facade Package

`@pellux/goodvibes-sdk` is the consumer-facing facade. It composes the
source-of-truth workspace packages and SDK-owned platform/runtime modules.

Use the root package for normal daemon-connected client work:

```ts
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';
```

## Source-Of-Truth Package Facades

These subpaths re-export real workspace packages:

- `@pellux/goodvibes-sdk/contracts`
- `@pellux/goodvibes-sdk/errors`
- `@pellux/goodvibes-sdk/daemon`
- `@pellux/goodvibes-sdk/operator`
- `@pellux/goodvibes-sdk/peer`
- `@pellux/goodvibes-sdk/transport-core`
- `@pellux/goodvibes-sdk/transport-direct`
- `@pellux/goodvibes-sdk/transport-http`
- `@pellux/goodvibes-sdk/transport-realtime`

See [Transports](./transports.md) for the canonical `transport-direct` facade
description.

## Platform Surfaces

Platform subpaths are intentionally listed in `packages/sdk/package.json`.
There is no `./platform/*` wildcard contract. If a platform path is not listed
in package exports, it is private implementation.

Client-safe surfaces:

- `@pellux/goodvibes-sdk/browser`
- `@pellux/goodvibes-sdk/web`
- `@pellux/goodvibes-sdk/workers`
- `@pellux/goodvibes-sdk/react-native`
- `@pellux/goodvibes-sdk/expo`

Runtime-heavy surfaces:

- `@pellux/goodvibes-sdk/platform/node`
- `@pellux/goodvibes-sdk/platform/runtime`
- `@pellux/goodvibes-sdk/platform/knowledge`
- `@pellux/goodvibes-sdk/platform/knowledge/extensions`
- `@pellux/goodvibes-sdk/platform/knowledge/home-graph`
- `@pellux/goodvibes-sdk/platform/providers`
- `@pellux/goodvibes-sdk/platform/tools`
- `@pellux/goodvibes-sdk/platform/integrations`

Pick the narrowest entrypoint that matches the runtime. Do not import from
`packages/*/src`, `dist`, or unlisted deep paths in application code.
