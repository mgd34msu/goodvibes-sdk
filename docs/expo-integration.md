# Expo Integration

This is the **companion surface** for Expo (Hermes runtime). See [Published Surface Matrix](./surfaces.md).

Expo apps cannot run the full agentic surface (tool execution, LSP, MCP, workflows, daemon HTTP) — those require Bun. This guide covers auth, transport, realtime events, and error handling for the companion surface.

Use `@pellux/goodvibes-sdk/expo` for Expo-managed React Native apps.

```ts
import { createExpoGoodVibesSdk } from '@pellux/goodvibes-sdk/expo';

const sdk = createExpoGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  authToken: token,
});
```

## Installation

```bash
npm install @pellux/goodvibes-sdk
```

See [Getting started](./getting-started.md#install) for the canonical install command and version. Token persistence uses the optional peer dependency [`expo-secure-store`](https://docs.expo.dev/versions/latest/sdk/securestore/) (`>=13.0.0`); install it only when you use `createExpoSecureTokenStore`.

## Guidance

- prefer bearer tokens for Expo apps
- persist tokens with a secure `tokenStore` (see [Token storage](#token-storage)) rather than rolling a custom adapter
- use `sdk.realtime.viaWebSocket()` for realtime — the Expo surface is WebSocket-only (no `viaSse()`), so the inherited `sseReconnect` option is a no-op
- reconnect on foreground/resume transitions
- wrap token access in a `tokenStore` or `getAuthToken` so reconnects do not keep stale tokens

## Realtime

The Expo entrypoint wraps the React Native factory, so realtime is WebSocket-only: `sdk.realtime` exposes `runtime()` and `viaWebSocket()` (there is no `viaSse()`). The factory applies the same defaults, which you can override through `GoodVibesSdkOptions`:

- `realtime.webSocketReconnect` — `{ enabled: true, baseDelayMs: 500, maxDelayMs: 5000 }`
- `retry` (HTTP) — `{ maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 2000 }`
- `realtime.onError` — called when the realtime transport hits an unrecoverable error

Scope a feed to a single session with `forSession` (re-exported from `@pellux/goodvibes-sdk/expo`):

```ts
import { createExpoGoodVibesSdk, forSession } from '@pellux/goodvibes-sdk/expo';

const sessionEvents = forSession(sdk.realtime.viaWebSocket(), sessionId);
sessionEvents.agents.on('AGENT_COMPLETED', (event) => console.log(event));
```

## Token storage

Pass a `tokenStore` to persist and rotate the bearer token. `tokenStore` is the highest-precedence auth option — it overrides both `getAuthToken` and the static `authToken`. Use `createExpoSecureTokenStore` (backed by `expo-secure-store`), exported from `@pellux/goodvibes-sdk/expo`:

```ts
import {
  createExpoGoodVibesSdk,
  createExpoSecureTokenStore,
} from '@pellux/goodvibes-sdk/expo';

const sdk = createExpoGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  tokenStore: createExpoSecureTokenStore(),
});
```

## Typical Expo shape

- login or bootstrap the token once
- hydrate the SDK from secure storage on app start
- load initial operator snapshots over HTTP
- subscribe to WebSocket runtime events for companion-app updates
- refresh read models after important events or foreground resumes

## Error handling and observability

Error handling (the `GoodVibesSdkError` taxonomy) and observability (`SDKObserver` / `createConsoleObserver`) are identical to the React Native surface — the Expo factory wraps `createReactNativeGoodVibesSdk`. See [Error handling](./react-native-integration.md#error-handling) and [Observability](./react-native-integration.md#observability) in the React Native guide.

## Example

See [expo-quickstart.tsx](../examples/expo-quickstart.tsx).
