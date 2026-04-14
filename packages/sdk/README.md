# @goodvibes/sdk

Umbrella GoodVibes SDK with Node, browser, web UI, React Native, and Expo integration helpers.

Install:

```bash
npm install @goodvibes/sdk
```

Entry points:
- `@goodvibes/sdk`
- `@goodvibes/sdk/node`
- `@goodvibes/sdk/browser`
- `@goodvibes/sdk/web`
- `@goodvibes/sdk/react-native`
- `@goodvibes/sdk/expo`

Example:

```ts
import { createNodeGoodVibesSdk } from '@goodvibes/sdk/node';

const sdk = createNodeGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3210',
  authToken: process.env.GOODVIBES_TOKEN ?? null,
});

console.log(await sdk.operator.control.snapshot());
```

Use this package when you want the main consumer-facing GoodVibes TypeScript SDK rather than lower-level pieces.
