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
  baseUrl: 'http://127.0.0.1:3210',
  tokenStore: createMemoryTokenStore(process.env.GOODVIBES_TOKEN ?? null),
});

console.log(await sdk.operator.control.snapshot());
```

Entry points:
- `@pellux/goodvibes-sdk`
- `@pellux/goodvibes-sdk/auth`
- `@pellux/goodvibes-sdk/browser`
- `@pellux/goodvibes-sdk/web`
- `@pellux/goodvibes-sdk/workers`
- `@pellux/goodvibes-sdk/react-native`
- `@pellux/goodvibes-sdk/expo`

Cloudflare batch provisioning is exposed through daemon `/api/cloudflare/*`
routes. The `/workers` entry is for manual Worker deployments.

Use this package when you want the main consumer-facing GoodVibes TypeScript SDK rather than lower-level pieces.
