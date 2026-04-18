# Getting Started

> **What this SDK is:** `@pellux/goodvibes-sdk` is a client SDK for the GoodVibes daemon.
> It does **not** call Anthropic, OpenAI, Gemini, or any other AI provider directly — the daemon
> orchestrates those on your behalf. If you need to call a provider directly, use their official
> SDK instead. If you don't have a daemon yet, see [Daemon embedding](./daemon-embedding.md).

This SDK has two surfaces. Read [Runtime Surfaces](./surfaces.md) to understand which applies to you:
- **Full surface** — Bun consumers (TUI, daemon, CLI).
- **Companion surface** — Hermes (React Native / Expo) or browser consumers.

## Install

```bash
bun add @pellux/goodvibes-sdk
# or
npm install @pellux/goodvibes-sdk
```

This installs one package. Import only the entry points you need.

## Bun quickstart (full surface)

For Bun services, TUI apps, and CLI tools, use the root entry point:

```ts
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';
import { createMemoryTokenStore } from '@pellux/goodvibes-sdk/auth';

const sdk = createGoodVibesSdk({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3210',
  tokenStore: createMemoryTokenStore(process.env.GOODVIBES_TOKEN ?? null),
});

const snapshot = await sdk.operator.control.snapshot();
console.log(snapshot);
```

If you have a static token and don't need login/logout flows, `authToken` is sufficient:

```ts
const sdk = createGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3210',
  authToken: process.env.GOODVIBES_TOKEN,
});
```

For daemon embedding in a Bun server host:

```ts
import { dispatchDaemonApiRoutes } from '@pellux/goodvibes-sdk/daemon';
```

## Companion quickstart (React Native / Expo / browser)

For companion apps and web UIs, use the runtime-specific entry point. These entry points contain no Bun globals and bundle cleanly with Metro, Vite, webpack, and esbuild.

For a React Native or Expo deep-dive, see [React Native integration](./react-native-integration.md) and [Expo integration](./expo-integration.md). For browser and web UI, see [Browser integration](./browser-integration.md) and [Web UI integration](./web-ui-integration.md).

### React Native

```ts
import { createReactNativeGoodVibesSdk } from '@pellux/goodvibes-sdk/react-native';

const sdk = createReactNativeGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  authToken: await SecureStore.getItemAsync('gv-token'),
});

const stop = sdk.realtime.viaWebSocket().agents.on('AGENT_COMPLETED', (event) => {
  console.log(event);
});
```

### Expo

```ts
import { createExpoGoodVibesSdk } from '@pellux/goodvibes-sdk/expo';

const sdk = createExpoGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  authToken: await SecureStore.getItemAsync('gv-token'),
});
```

### Browser / web app

```ts
import { createWebGoodVibesSdk } from '@pellux/goodvibes-sdk/web';
import { createBrowserTokenStore } from '@pellux/goodvibes-sdk/auth';

const sdk = createWebGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  tokenStore: createBrowserTokenStore(),
});

// SSE for live dashboards:
const stop = sdk.realtime.viaSse().agents.on('AGENT_COMPLETED', (event) => {
  console.log('agent completed', event);
});
```

## Auth options: `tokenStore` vs `authToken`

The SDK accepts two auth options, with the following precedence (highest first):

1. **`tokenStore`** — a `GoodVibesTokenStore` object with `getToken` / `setToken` / `clearToken`.
   Recommended for any interactive or long-lived client.

2. **`getAuthToken`** — an async resolver `() => Promise<string | null>`.
   Use for dynamic token resolution without the full store interface.

3. **`authToken`** — a static `string | null`.
   Lowest precedence. Use only for short-lived scripts or when the token is static.

When `tokenStore` is present, `auth.login()` and `auth.clearToken()` automatically persist changes through the store.

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

## Realtime transports

```ts
// SSE (Bun, browser dashboards)
const stop = sdk.realtime.viaSse().agents.on('AGENT_COMPLETED', (event) => { ... });

// WebSocket (React Native, Expo, persistent duplex)
const stop = sdk.realtime.viaWebSocket().agents.on('AGENT_COMPLETED', (event) => { ... });
```

Recommended defaults:
- Bun (TUI / daemon): SSE
- Browser web UI: SSE for same-origin operator sessions
- React Native / Expo: WebSocket

## Error handling

All SDK errors are instances of `GoodVibesSdkError` with a typed `kind` discriminant. Import from `@pellux/goodvibes-sdk/errors`:

```ts
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk/errors';

try {
  await sdk.operator.control.snapshot();
} catch (err) {
  if (err instanceof GoodVibesSdkError) {
    switch (err.kind) {
      case 'auth':
        // re-authenticate
        break;
      case 'network':
        // check connectivity
        break;
      default:
        throw err;
    }
  }
  throw err;
}
```

See [Error kinds reference](./error-kinds.md) for all `SDKErrorKind` values.

## Observability

The SDK ships an `SDKObserver` interface and a built-in `createConsoleObserver` adapter:

```ts
import { createGoodVibesSdk, createConsoleObserver } from '@pellux/goodvibes-sdk';

const sdk = createGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3210',
  observer: createConsoleObserver(),
});
```

See [Observability](./observability.md) for the `SDKObserver` interface and available adapters.

## Choosing an entry point

- `@pellux/goodvibes-sdk` — Bun full surface. Use this for TUI, daemon, and CLI apps.
- `@pellux/goodvibes-sdk/daemon` — Bun server hosts embedding daemon routes.
- `@pellux/goodvibes-sdk/react-native` — React Native (Hermes) companion apps.
- `@pellux/goodvibes-sdk/expo` — Expo alias of `/react-native`.
- `@pellux/goodvibes-sdk/browser` or `/web` — browser and web apps.
- `@pellux/goodvibes-sdk/operator` — operator/control-plane client only.
- `@pellux/goodvibes-sdk/peer` — peer/distributed-runtime client only.
- `@pellux/goodvibes-sdk/auth` — token storage helpers and auth flows.
- `@pellux/goodvibes-sdk/errors` — typed error classes.
- `@pellux/goodvibes-sdk/transport-*` — low-level transport primitives.

See [Package guide](./packages.md) for a full decision matrix.

## Next reads

- [Runtime surfaces](./surfaces.md)
- [Authentication](./authentication.md)
- [Error handling](./error-handling.md)
- [Error kinds reference](./error-kinds.md)
- [Observability](./observability.md)
- [Realtime and telemetry](./realtime-and-telemetry.md)
- [Retries and reconnect](./retries-and-reconnect.md)
- [Companion app patterns](./companion-app-patterns.md)
- [Daemon embedding](./daemon-embedding.md)
