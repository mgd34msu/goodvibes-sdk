# @pellux/goodvibes-sdk

Umbrella GoodVibes SDK with Node, browser, web UI, React Native, and Expo integration helpers.

Install:

```bash
npm install @pellux/goodvibes-sdk
```

Entry points:
- `@pellux/goodvibes-sdk`
- `@pellux/goodvibes-sdk/node`
- `@pellux/goodvibes-sdk/browser`
- `@pellux/goodvibes-sdk/web`
- `@pellux/goodvibes-sdk/react-native`
- `@pellux/goodvibes-sdk/expo`

Example:

```ts
import { createNodeGoodVibesSdk } from '@pellux/goodvibes-sdk/node';

const sdk = createNodeGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3210',
  authToken: process.env.GOODVIBES_TOKEN ?? null,
});

console.log(await sdk.operator.control.snapshot());
```

Use this package when you want the main consumer-facing GoodVibes TypeScript SDK rather than lower-level pieces.
