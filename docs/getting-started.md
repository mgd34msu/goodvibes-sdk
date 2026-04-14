# Getting Started

## Install

```bash
npm install @pellux/goodvibes-sdk
```

This installs one package. Import only the entrypoints you need:

```ts
import { createOperatorSdk } from '@pellux/goodvibes-sdk/operator';
import { createRemoteRuntimeEvents } from '@pellux/goodvibes-sdk/transport-realtime';
```

## Choose the right entrypoint

- `@pellux/goodvibes-sdk`
  Use this unless you already know you only want a narrower entrypoint.
- `@pellux/goodvibes-sdk/auth`
  Use this when you only need token storage helpers or auth flows layered over an existing operator client.
- `@pellux/goodvibes-sdk/operator`
  Use this when you only need operator/control-plane APIs.
- `@pellux/goodvibes-sdk/peer`
  Use this when you only need peer/distributed-runtime APIs.
- `@pellux/goodvibes-sdk/daemon`
  Use this when you are hosting reusable GoodVibes daemon routes inside another server.
- `@pellux/goodvibes-sdk/transport-*`
  Use these only when you need low-level transport composition.

## First client

```ts
import { createNodeGoodVibesSdk } from '@pellux/goodvibes-sdk/node';

const sdk = createNodeGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3210',
  authToken: process.env.GOODVIBES_TOKEN,
});

const status = await sdk.operator.control.status();
```

## Login flow with token persistence

```ts
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';
import { createMemoryTokenStore } from '@pellux/goodvibes-sdk/auth';

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

- `@pellux/goodvibes-sdk/node`
- `@pellux/goodvibes-sdk/browser`
- `@pellux/goodvibes-sdk/web`
- `@pellux/goodvibes-sdk/react-native`
- `@pellux/goodvibes-sdk/expo`

These wrap the same underlying SDK surface but set runtime-appropriate defaults for retry, reconnect, and runtime globals.

## Next reads

- [Authentication](./authentication.md)
- [Realtime and telemetry](./realtime-and-telemetry.md)
- [Retries and reconnect](./retries-and-reconnect.md)
- [Companion app patterns](./companion-app-patterns.md)
- [Daemon embedding](./daemon-embedding.md)
