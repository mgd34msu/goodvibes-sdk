# Retries and Reconnect

This applies to both full-surface (Bun) and companion-surface (Hermes/browser) consumers unless otherwise noted.

The SDK exposes retry and reconnect as first-class configuration instead of leaving them to ad hoc wrapper code.

## HTTP Retry

All runtime-specific entrypoints can take a retry policy:

```ts
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';

const sdk = createGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3421',
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

There is no per-call `idempotencyKey` request option. The per-call options accepted by the transport layer (`ContractInvokeOptions`) are `signal`, `headers`, and `responseSchema` only. The `Idempotency-Key` is generated internally (`generateIdempotencyKey`) and is attached only when the resolved method is a mutation (POST/PUT/PATCH/DELETE) **and** either the contract marks the route `idempotent: true` or a `perMethodPolicy` entry exists for that method ID.

For application-level idempotency on a mutation the contract does not already mark idempotent, register a `perMethodPolicy` entry keyed by the method ID. That both enables retries for the method and causes the SDK to attach a stable `Idempotency-Key` on each attempt:

```ts
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';

const sdk = createGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3421',
  authToken: process.env.GOODVIBES_TOKEN ?? null,
  retry: {
    perMethodPolicy: {
      'sessions.create': { maxAttempts: 3 },
    },
  },
});

// The Idempotency-Key is generated and reused across retries automatically.
const result = await sdk.operator.sessions.create({ title: 'My session' });
```

Never retry unsafe mutations blindly. Only operations with application-level or contract-level idempotency guarantees are safe to retry.

## Token Rotation

If a long-lived client can rotate tokens, prefer:
- `tokenStore`
- or `getAuthToken`

That lets reconnects use fresh credentials instead of a stale startup token.

## Default Behavior

Out of the box the SDK is conservative — retries and reconnect are **off** by default and must be opted into:

- **HTTP retry is off.** `DEFAULT_HTTP_RETRY_POLICY.maxAttempts` is `1` (one attempt, no retries). When you enable retries, only safe methods are retried by default (`retryOnMethods: ['GET', 'HEAD', 'OPTIONS']`) and `retryOnNetworkError` is `true`; default delays are `baseDelayMs: 250`, `maxDelayMs: 2000`, `backoffFactor: 2`.
- **Stream / SSE reconnect is off.** `DEFAULT_STREAM_RECONNECT_POLICY.enabled` is `false`. When enabled, `maxAttempts` defaults to `10` (`DEFAULT_STREAM_MAX_ATTEMPTS`), with `baseDelayMs: 500` and `maxDelayMs: 30000`.
- **WebSocket reconnect** likewise defaults to a finite `maxAttempts` of `10` (`DEFAULT_WS_MAX_ATTEMPTS`) when enabled, to prevent infinite auth-failure loops.

## Recommended Defaults

- Bun full-surface service:
  retry reads, SSE reconnect enabled
- Browser web UI:
  retry reads, SSE reconnect enabled
- React Native / Expo:
  retry reads, WebSocket reconnect enabled

## Next Reads

- [Transports](./transports.md)
- [Performance and tuning](./performance.md)
- [Observability](./observability.md)
