# Retries and Reconnect

This applies to both full-surface (Bun) and companion-surface (Hermes/browser) consumers unless otherwise noted.

The SDK exposes retry and reconnect as first-class configuration instead of leaving them to ad hoc wrapper code.

## HTTP Retry

All runtime-specific entrypoints can take a retry policy:

```ts
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';

const sdk = createGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3210',
  authToken: process.env.GOODVIBES_TOKEN ?? null,
  retry: {
    maxAttempts: 4,
    baseDelayMs: 250,
    maxDelayMs: 2_500,
  },
});
```

Use retry for:
- safe/idempotent reads
- transient network failures
- rate-limited or temporarily degraded platform calls

Avoid retrying unsafe mutations blindly unless your application has idempotency guarantees.

## SSE Reconnect

SSE reconnect is controlled through `realtime.sseReconnect`:

```ts
const sdk = createBrowserGoodVibesSdk({
  realtime: {
    sseReconnect: {
      enabled: true,
      baseDelayMs: 500,
      maxDelayMs: 5_000,
    },
  },
});
```

The SDK preserves `Last-Event-ID` and sends it on reconnect so the server can replay missed events when supported.

## WebSocket Reconnect

WebSocket reconnect is controlled through `realtime.webSocketReconnect`:

```ts
const sdk = createReactNativeGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  authToken: token,
  realtime: {
    webSocketReconnect: {
      enabled: true,
      baseDelayMs: 500,
      maxDelayMs: 5_000,
    },
  },
});
```

## Token Rotation

If a long-lived client can rotate tokens, prefer:
- `tokenStore`
- or `getAuthToken`

That lets reconnects use fresh credentials instead of a stale startup token.

## Recommended Defaults

- Bun full-surface service:
  retry reads, SSE reconnect enabled
- Browser web UI:
  retry reads, SSE reconnect enabled
- React Native / Expo:
  retry reads, WebSocket reconnect enabled
