# React Native Integration

This is the **companion surface** for React Native (Hermes). See [Published Surface Matrix](./surfaces.md).

React Native apps cannot run the full agentic surface (tool execution, LSP, MCP, workflows, daemon HTTP) — those require Bun. This guide covers auth, transport, realtime events, and error handling for the companion surface.

Use `@pellux/goodvibes-sdk/react-native` for Android and iOS apps.

```ts
import { createReactNativeGoodVibesSdk } from '@pellux/goodvibes-sdk/react-native';

const sdk = createReactNativeGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  authToken: token,
});
```

## Installation

```bash
npm install @pellux/goodvibes-sdk
```

See [Getting started](./getting-started.md#install) for the canonical install command and version. For persistent secure token storage on bare React Native, also install the optional peer dependency [`react-native-keychain`](https://github.com/oblador/react-native-keychain) (`>=8.0.0`); it is only needed when you use `createIOSKeychainTokenStore` / `createAndroidKeystoreTokenStore`.

## Realtime

The React Native realtime surface is WebSocket-only. `sdk.realtime` exposes `runtime()` and `viaWebSocket()` — there is no `viaSse()`. SSE is unavailable on this surface, so the inherited `realtime.sseReconnect` option is a no-op here; only `webSocketReconnect` applies.

```ts
const events = sdk.realtime.viaWebSocket();
const unsubscribe = events.agents.on('AGENT_COMPLETED', (event) => {
  console.log(event);
});
```

The factory applies React-Native-tuned defaults that you can override through `GoodVibesSdkOptions`:

- `realtime.webSocketReconnect` — `{ enabled: true, baseDelayMs: 500, maxDelayMs: 5000 }`
- `retry` (HTTP) — `{ maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 2000 }`
- `realtime.onError` — called when the realtime transport hits an unrecoverable error

To scope a feed to a single session, wrap it with `forSession` (re-exported from `@pellux/goodvibes-sdk/react-native`):

```ts
import { createReactNativeGoodVibesSdk, forSession } from '@pellux/goodvibes-sdk/react-native';

const sessionEvents = forSession(sdk.realtime.viaWebSocket(), sessionId);
sessionEvents.agents.on('AGENT_COMPLETED', (event) => console.log(event));
```

## Token storage

Pass a `tokenStore` to persist and rotate the bearer token. `tokenStore` is the highest-precedence auth option — it overrides both `getAuthToken` and the static `authToken`. Use `createIOSKeychainTokenStore` (iOS Keychain) or `createAndroidKeystoreTokenStore` (Android Keystore), both exported from `@pellux/goodvibes-sdk/react-native`, rather than rolling a custom `GoodVibesTokenStore`:

```ts
import {
  createReactNativeGoodVibesSdk,
  createIOSKeychainTokenStore,
} from '@pellux/goodvibes-sdk/react-native';

const sdk = createReactNativeGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  tokenStore: createIOSKeychainTokenStore(),
});
```

On Android, use `createAndroidKeystoreTokenStore()` in place of the Keychain store.

## Error handling

All SDK errors extend `GoodVibesSdkError`. See [Error Kinds](./error-kinds.md) for the full taxonomy.

```ts
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk/errors';

try {
  await sdk.operator.control.snapshot();
} catch (err) {
  if (err instanceof GoodVibesSdkError) {
    switch (err.kind) {
      case 'auth':
        // token expired — refresh and retry
        break;
      case 'network':
        // transport failure — reconnect or surface to user
        break;
      case 'service':
        // daemon or upstream service returned 5xx — log and degrade gracefully
        break;
      case 'protocol':
        // SDK/client and daemon disagreed about the wire contract
        break;
      default:
        throw err;
    }
  }
}
```

## Observability

`SDKObserver` and `createConsoleObserver` work from React Native exactly like from the full surface. They are imported from `@pellux/goodvibes-sdk` root, which is companion-safe. See [Observability](./observability.md) for the full observer API.

```ts
import { createConsoleObserver } from '@pellux/goodvibes-sdk';

const sdk = createReactNativeGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  authToken: token,
  observer: createConsoleObserver(),
});
```

## Example

See [react-native-quickstart.ts](../examples/react-native-quickstart.ts) for a runnable end-to-end example.

## Notes

- `fetch` can come from the React Native runtime or be injected explicitly.
- `WebSocket` can come from the runtime or be passed through `WebSocketImpl`.
- The React Native entrypoint is WebSocket-only; SSE (`viaSse`) is not exposed and `sseReconnect` is a no-op.
- Provide a token store or `getAuthToken` when token state can rotate during the app session — see [Token storage](#token-storage).
- Reconnect after foreground/resume and network transitions.
- Use HTTP for snapshots/mutations and WebSocket for live updates.
- For Expo-managed apps, use [expo-integration.md](./expo-integration.md).
- For native Kotlin or Swift apps, use [android-integration.md](./android-integration.md) and [ios-integration.md](./ios-integration.md).
