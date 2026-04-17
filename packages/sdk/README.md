# @pellux/goodvibes-sdk

Umbrella GoodVibes SDK with Node, browser, web UI, React Native, and Expo integration helpers.

> **What this SDK is:** a client for the GoodVibes daemon. Not a direct provider SDK.
> See [Getting Started](../../docs/getting-started.md) for the full walkthrough.

Install:

```bash
npm install @pellux/goodvibes-sdk
```

Quick example (Node / Bun):

```ts
import { createNodeGoodVibesSdk } from '@pellux/goodvibes-sdk/node';
import { createMemoryTokenStore } from '@pellux/goodvibes-sdk/auth';

const sdk = createNodeGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3210',
  tokenStore: createMemoryTokenStore(process.env.GOODVIBES_TOKEN ?? null),
});

console.log(await sdk.operator.control.snapshot());
```

Entry points:
- `@pellux/goodvibes-sdk`
- `@pellux/goodvibes-sdk/auth`
- `@pellux/goodvibes-sdk/node`
- `@pellux/goodvibes-sdk/browser`
- `@pellux/goodvibes-sdk/web`
- `@pellux/goodvibes-sdk/react-native`
- `@pellux/goodvibes-sdk/expo`

Use this package when you want the main consumer-facing GoodVibes TypeScript SDK rather than lower-level pieces.
