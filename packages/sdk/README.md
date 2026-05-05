# @pellux/goodvibes-sdk

TypeScript SDK for building GoodVibes operator, peer, web, mobile, and daemon-connected apps with typed contracts, auth, realtime events, and transport layers.

> **What this SDK is:** a client for the GoodVibes daemon. Not a direct provider SDK.
> See [Getting Started](../../docs/getting-started.md) for the full walkthrough.

Install:

```bash
npm install @pellux/goodvibes-sdk
```

Quick example (Bun):

```ts
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';
import { createMemoryTokenStore } from '@pellux/goodvibes-sdk/auth';

const sdk = createGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3421',
  tokenStore: createMemoryTokenStore(process.env.GOODVIBES_TOKEN ?? null),
});

console.log(await sdk.operator.control.snapshot());
```

Entry points:
- `@pellux/goodvibes-sdk`
- `@pellux/goodvibes-sdk/auth`
- `@pellux/goodvibes-sdk/operator`
- `@pellux/goodvibes-sdk/peer`
- `@pellux/goodvibes-sdk/contracts`
- `@pellux/goodvibes-sdk/browser`
- `@pellux/goodvibes-sdk/web`
- `@pellux/goodvibes-sdk/workers`
- `@pellux/goodvibes-sdk/react-native`
- `@pellux/goodvibes-sdk/expo`
- `@pellux/goodvibes-sdk/daemon`

Cloudflare batch provisioning is exposed through daemon `/api/cloudflare/*`
routes. The `/workers` entry is for manual Worker deployments.

Advanced server/runtime consumers can use explicit `platform/...` subpaths such
as `@pellux/goodvibes-sdk/platform/node`,
`@pellux/goodvibes-sdk/platform/runtime`, and
`@pellux/goodvibes-sdk/platform/knowledge`. The package does not expose a
`platform/*` wildcard contract; only listed subpaths are supported.

The root SDK package is a facade over the monorepo packages for contracts,
errors, transports, daemon, operator, and peer clients. Those packages remain
the source of truth; this npm package provides the consumer-facing entrypoint
map.

Use this package when you want the main consumer-facing GoodVibes TypeScript SDK rather than lower-level pieces.
