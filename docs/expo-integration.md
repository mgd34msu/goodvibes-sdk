# Expo Integration

This is the **companion surface** for Expo (Hermes runtime). See [Runtime Surfaces](./surfaces.md).

Expo apps cannot run the full agentic surface (tool execution, LSP, MCP, workflows, daemon HTTP) — those require Bun. This guide covers auth, transport, realtime events, and error handling for the companion surface.

Use `@pellux/goodvibes-sdk/expo` for Expo-managed React Native apps.

```ts
import { createExpoGoodVibesSdk } from '@pellux/goodvibes-sdk/expo';

const sdk = createExpoGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  authToken: token,
});
```

## Guidance

- prefer bearer tokens for Expo apps
- store tokens using `createExpoSecureTokenStore` from `@pellux/goodvibes-sdk/expo` (backed by `expo-secure-store`) rather than rolling a custom adapter
- prefer `sdk.realtime.viaWebSocket()` over SSE
- reconnect on foreground/resume transitions
- wrap token access in a `tokenStore` or `getAuthToken` so reconnects do not keep stale tokens

## Typical Expo shape

- login or bootstrap the token once
- hydrate the SDK from secure storage on app start
- load initial operator snapshots over HTTP
- subscribe to WebSocket runtime events for companion-app updates
- refresh read models after important events or foreground resumes

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

`SDKObserver` and `createConsoleObserver` work from Expo exactly like from the full surface. They are imported from `@pellux/goodvibes-sdk` root, which is companion-safe. See [Observability](./observability.md) for the full observer API.

```ts
import { createConsoleObserver } from '@pellux/goodvibes-sdk';

const sdk = createExpoGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  authToken: token,
  observer: createConsoleObserver(),
});
```

## Example

See [expo-quickstart.tsx](../examples/expo-quickstart.tsx).
