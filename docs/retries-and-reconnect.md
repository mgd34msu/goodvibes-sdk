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


## Idempotency Keys

For non-GET mutations, the SDK automatically injects an `Idempotency-Key` header when the call is marked idempotent. This enables safe retry of state-changing operations without duplicate side effects.

**Precedence chain (highest → lowest):**

1. **`perMethodPolicy[methodId]`** — an explicit per-method retry policy set on the SDK options overrides everything else.
2. **`contract.idempotent`** — the operator contract marks certain POST/PUT/PATCH/DELETE routes as idempotent (`idempotent: true`). Those methods automatically get an `Idempotency-Key` on each call.
3. **HTTP-verb default** — safe methods (`GET`, `HEAD`, `OPTIONS`) are retried by default; unsafe methods are not retried unless explicitly marked idempotent.

When an idempotent call is retried, the same `Idempotency-Key` UUID is used on each attempt. This lets the daemon detect and deduplicate retried requests.

For application-level idempotency on mutations not covered by the contract, generate and manage your own key (any UUID v4 string) and pass it as a request option:

```ts
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';

// Generate a stable key for the operation (e.g. using the Web Crypto API or a UUID library).
const key = crypto.randomUUID();

// Pass the key in the per-call options accepted by the transport layer.
// On retry with the same key, the daemon returns the cached result.
const result = await sdk.operator.sessions.create({ body: payload }, { idempotencyKey: key });
```

Never retry unsafe mutations blindly. Only operations with application-level or contract-level idempotency guarantees are safe to retry.

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
