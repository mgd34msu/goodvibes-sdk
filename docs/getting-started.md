# Getting Started

> **What this SDK is:** `@pellux/goodvibes-sdk` is a client SDK for the GoodVibes daemon.
> It does **not** call Anthropic, OpenAI, Gemini, or any other AI provider directly — the daemon
> orchestrates those on your behalf. If you need to call a provider directly, use their official
> SDK instead. If you don't have a daemon yet, see [Daemon embedding](./daemon-embedding.md).

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

## Auth options: `tokenStore` vs `authToken`

The SDK accepts two auth options, with the following precedence (highest first):

1. **`tokenStore`** — a `GoodVibesTokenStore` object with `getToken` / `setToken` / `clearToken`.
   Use this when you need token mutation or persistence (login flows, session refresh, secure storage).
   This is the **recommended** option for any interactive or long-lived client.

2. **`getAuthToken`** — an async resolver `() => Promise<string | null>`.
   Use this for dynamic token resolution without the full store interface.

3. **`authToken`** — a static `string | null`.
   Lowest precedence. Use only for short-lived scripts or when the token is already known and static.
   Ignored when `tokenStore` or `getAuthToken` is provided.

When `tokenStore` is present, `auth.login()` and `auth.clearToken()` automatically persist changes
through the store. When only `authToken` is provided, the auth client is read-only — calling
`auth.setToken()` or `auth.clearToken()` will throw.

## Node / Bun

```ts
import { createNodeGoodVibesSdk } from '@pellux/goodvibes-sdk/node';
import { createMemoryTokenStore } from '@pellux/goodvibes-sdk/auth';

const sdk = createNodeGoodVibesSdk({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3210',
  tokenStore: createMemoryTokenStore(process.env.GOODVIBES_TOKEN ?? null),
});

const snapshot = await sdk.operator.control.snapshot();
console.log(snapshot);
```

If you have a static token and don't need login/logout flows, `authToken` is sufficient:

```ts
const sdk = createNodeGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3210',
  authToken: process.env.GOODVIBES_TOKEN,
});
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

## Browser web UI

```ts
import { createWebGoodVibesSdk } from '@pellux/goodvibes-sdk/web';
import { createBrowserTokenStore } from '@pellux/goodvibes-sdk/auth';

const sdk = createWebGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  tokenStore: createBrowserTokenStore(),
});
```

For same-origin browser sessions, use SSE for live dashboards:

```ts
const stop = sdk.realtime.viaSse().agents.on('AGENT_COMPLETED', (event) => {
  console.log('agent completed', event);
});
```

## React Native / Expo

```ts
import { createReactNativeGoodVibesSdk } from '@pellux/goodvibes-sdk/react-native';
// or: import { createExpoGoodVibesSdk } from '@pellux/goodvibes-sdk/expo';

const sdk = createReactNativeGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  authToken: await SecureStore.getItemAsync('gv-token'),
});

const stop = sdk.realtime.runtime().agents.on('AGENT_COMPLETED', (event) => {
  console.log(event);
});
```

For React Native/Expo, WebSocket is the recommended realtime transport.

## Realtime transports

```ts
// SSE (Node/Bun, browser dashboards)
const stop = sdk.realtime.viaSse().agents.on('AGENT_COMPLETED', (event) => { ... });

// WebSocket (React Native, Expo, persistent duplex)
const stop = sdk.realtime.viaWebSocket().agents.on('AGENT_COMPLETED', (event) => { ... });
```

Recommended defaults:
- Node / Bun: SSE
- Browser web UI: SSE for same-origin operator sessions
- React Native / Expo: WebSocket

## Runtime-specific entrypoints

- `@pellux/goodvibes-sdk/node` — Node/Bun HTTP retry and SSE reconnect defaults
- `@pellux/goodvibes-sdk/browser` — generic browser defaults
- `@pellux/goodvibes-sdk/web` — browser/web UI alias
- `@pellux/goodvibes-sdk/react-native` — React Native WebSocket-first defaults
- `@pellux/goodvibes-sdk/expo` — Expo-flavored React Native alias

These wrap the same underlying SDK surface but set runtime-appropriate defaults for retry, reconnect, and runtime globals.

## Next reads

- [Authentication](./authentication.md)
- [Realtime and telemetry](./realtime-and-telemetry.md)
- [Retries and reconnect](./retries-and-reconnect.md)
- [Companion app patterns](./companion-app-patterns.md)
- [Daemon embedding](./daemon-embedding.md)
