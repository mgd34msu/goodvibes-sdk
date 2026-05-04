# React Native Integration

This is the **companion surface** for React Native (Hermes). See [Runtime Surfaces](./surfaces.md).

React Native apps cannot run the full agentic surface (tool execution, LSP, MCP, workflows, daemon HTTP) — those require Bun. This guide covers auth, transport, realtime events, and error handling for the companion surface.

Use `@pellux/goodvibes-sdk/react-native` for Android and iOS apps.

```ts
import { createReactNativeGoodVibesSdk } from '@pellux/goodvibes-sdk/react-native';

const sdk = createReactNativeGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  authToken: token,
});
```

## Realtime

React Native should use WebSocket for realtime:

```ts
const events = sdk.realtime.viaWebSocket();
const unsubscribe = events.agents.on('AGENT_COMPLETED', (event) => {
  console.log(event);
});
```

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

## Notes

- `fetch` can come from the React Native runtime or be injected explicitly.
- `WebSocket` can come from the runtime or be passed through `WebSocketImpl`.
- The default React Native entrypoint prefers WebSocket over SSE because fetch streaming support varies across mobile stacks.
- Provide a token store or `getAuthToken` when token state can rotate during the app session. Use `createIOSKeychainTokenStore` or `createAndroidKeystoreTokenStore` (both exported from `@pellux/goodvibes-sdk/react-native`) for persistent secure storage rather than rolling a custom `GoodVibesTokenStore` adapter.
- Reconnect after foreground/resume and network transitions.
- Use HTTP for snapshots/mutations and WebSocket for live updates.
- For Expo-managed apps, use [expo-integration.md](./expo-integration.md).
- For native Kotlin or Swift apps, use [android-integration.md](./android-integration.md) and [ios-integration.md](./ios-integration.md).
