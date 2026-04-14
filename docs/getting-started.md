# Getting Started

## Install

```bash
npm install @goodvibes/sdk
```

Or install only the surfaces you need:

```bash
npm install @goodvibes/operator-sdk @goodvibes/transport-realtime
```

## Choose the right package

- `@goodvibes/sdk`
  Use this unless you already know you only want a lower-level package.
- `@goodvibes/operator-sdk`
  Use this when you only need operator/control-plane APIs.
- `@goodvibes/peer-sdk`
  Use this when you only need peer/distributed-runtime APIs.
- `@goodvibes/daemon-sdk`
  Use this when you are hosting reusable GoodVibes daemon routes inside another server.
- `@goodvibes/transport-*`
  Use these only when you need low-level transport composition.

## First client

```ts
import { createNodeGoodVibesSdk } from '@goodvibes/sdk/node';

const sdk = createNodeGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3210',
  authToken: process.env.GOODVIBES_TOKEN,
});

const status = await sdk.operator.control.status();
```

## Login flow with token persistence

```ts
import { createGoodVibesSdk } from '@goodvibes/sdk';
import { createMemoryTokenStore } from '@goodvibes/sdk';

const sdk = createGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3210',
  tokenStore: createMemoryTokenStore(),
});

await sdk.auth.login({
  username: 'alice',
  password: 'secret',
});

const current = await sdk.auth.current();
console.log(current.principalId);
```

## Realtime

```ts
const stop = sdk.realtime.viaSse().agents.on('AGENT_COMPLETED', (event) => {
  console.log('agent completed', event);
});
```

Use:
- SSE for Node/Bun services and browser dashboards
- WebSocket for React Native / Expo companion apps

## Runtime-specific entrypoints

- `@goodvibes/sdk/node`
- `@goodvibes/sdk/browser`
- `@goodvibes/sdk/web`
- `@goodvibes/sdk/react-native`
- `@goodvibes/sdk/expo`

These wrap the same underlying SDK surface but set runtime-appropriate defaults for retry, reconnect, and runtime globals.

## Next reads

- [Authentication](./authentication.md)
- [Realtime and telemetry](./realtime-and-telemetry.md)
- [Retries and reconnect](./retries-and-reconnect.md)
- [Companion app patterns](./companion-app-patterns.md)
- [Daemon embedding](./daemon-embedding.md)
