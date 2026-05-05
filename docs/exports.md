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

The package also exposes `@pellux/goodvibes-sdk/package.json` as metadata.

## Source-Of-Truth Package Facades

These subpaths expose source-of-truth workspace package outputs:

- `@pellux/goodvibes-sdk/contracts`
- `@pellux/goodvibes-sdk/contracts/node`
- `@pellux/goodvibes-sdk/contracts/operator-contract.json`
- `@pellux/goodvibes-sdk/contracts/peer-contract.json`
- `@pellux/goodvibes-sdk/errors`
- `@pellux/goodvibes-sdk/daemon`
- `@pellux/goodvibes-sdk/operator`
- `@pellux/goodvibes-sdk/peer`
- `@pellux/goodvibes-sdk/transport-core`
- `@pellux/goodvibes-sdk/transport-http`
- `@pellux/goodvibes-sdk/transport-realtime`

`@pellux/goodvibes-sdk/transport-direct` is an SDK-owned facade over direct
transport helpers from `transport-core`; it is not backed by a separate
transport-direct sibling package.

See [Transports](./transports.md) for the canonical `transport-direct` facade
description.

## Platform Surfaces

Platform subpaths are intentionally listed in `packages/sdk/package.json`.
There is no catch-all platform contract. If a platform path is not listed in
package exports, it is private implementation.

Client-safe surfaces:

- `@pellux/goodvibes-sdk/auth`
- `@pellux/goodvibes-sdk/browser`
- `@pellux/goodvibes-sdk/client-auth`
- `@pellux/goodvibes-sdk/events`
- `@pellux/goodvibes-sdk/events/<domain>` for the explicit public event domains documented in [Public Surface](./public-surface.md)
- `@pellux/goodvibes-sdk/observer`
- `@pellux/goodvibes-sdk/web`
- `@pellux/goodvibes-sdk/workers`
- `@pellux/goodvibes-sdk/react-native`
- `@pellux/goodvibes-sdk/expo`

Runtime-heavy surfaces:

- `@pellux/goodvibes-sdk/platform/acp`
- `@pellux/goodvibes-sdk/platform/adapters`
- `@pellux/goodvibes-sdk/platform/agents`
- `@pellux/goodvibes-sdk/platform/artifacts`
- `@pellux/goodvibes-sdk/platform/automation`
- `@pellux/goodvibes-sdk/platform/batch`
- `@pellux/goodvibes-sdk/platform/bookmarks`
- `@pellux/goodvibes-sdk/platform/channels`
- `@pellux/goodvibes-sdk/platform/cloudflare`
- `@pellux/goodvibes-sdk/platform/companion`
- `@pellux/goodvibes-sdk/platform/config`
- `@pellux/goodvibes-sdk/platform/control-plane`
- `@pellux/goodvibes-sdk/platform/core`
- `@pellux/goodvibes-sdk/platform/daemon`
- `@pellux/goodvibes-sdk/platform/discovery`
- `@pellux/goodvibes-sdk/platform/export`
- `@pellux/goodvibes-sdk/platform/git`
- `@pellux/goodvibes-sdk/platform/hooks`
- `@pellux/goodvibes-sdk/platform/integrations`
- `@pellux/goodvibes-sdk/platform/intelligence`
- `@pellux/goodvibes-sdk/platform/knowledge/extensions`
- `@pellux/goodvibes-sdk/platform/knowledge/home-graph`
- `@pellux/goodvibes-sdk/platform/knowledge`
- `@pellux/goodvibes-sdk/platform/media`
- `@pellux/goodvibes-sdk/platform/mcp`
- `@pellux/goodvibes-sdk/platform/multimodal`
- `@pellux/goodvibes-sdk/platform/node/runtime-boundary`
- `@pellux/goodvibes-sdk/platform/node`
- `@pellux/goodvibes-sdk/platform/pairing`
- `@pellux/goodvibes-sdk/platform/permissions`
- `@pellux/goodvibes-sdk/platform/plugins`
- `@pellux/goodvibes-sdk/platform/profiles`
- `@pellux/goodvibes-sdk/platform/providers`
- `@pellux/goodvibes-sdk/platform/runtime/observability`
- `@pellux/goodvibes-sdk/platform/runtime/sandbox`
- `@pellux/goodvibes-sdk/platform/runtime/settings`
- `@pellux/goodvibes-sdk/platform/runtime/state`
- `@pellux/goodvibes-sdk/platform/runtime/store`
- `@pellux/goodvibes-sdk/platform/runtime/ui`
- `@pellux/goodvibes-sdk/platform/runtime`
- `@pellux/goodvibes-sdk/platform/scheduler`
- `@pellux/goodvibes-sdk/platform/security`
- `@pellux/goodvibes-sdk/platform/sessions`
- `@pellux/goodvibes-sdk/platform/state`
- `@pellux/goodvibes-sdk/platform/templates`
- `@pellux/goodvibes-sdk/platform/tools`
- `@pellux/goodvibes-sdk/platform/types`
- `@pellux/goodvibes-sdk/platform/utils`
- `@pellux/goodvibes-sdk/platform/voice`
- `@pellux/goodvibes-sdk/platform/watchers`
- `@pellux/goodvibes-sdk/platform/web-search`
- `@pellux/goodvibes-sdk/platform/workflow`
- `@pellux/goodvibes-sdk/platform/workspace`

Pick the narrowest entrypoint that matches the runtime. Do not import from
workspace package source directories, `dist`, or unlisted deep paths in
application code.
