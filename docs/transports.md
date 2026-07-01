# Transports

The transport packages are source-of-truth packages re-exported through the SDK
facade.

- `transport-core`: shared direct transport primitives, event/error helpers,
  UUID helpers, and common transport utilities.
- `transport-direct`: SDK facade name for in-process direct transport backed by
  `transport-core`. It is a package export subpath only; there is no separate
  `packages/transport-direct` workspace package.
- `transport-http`: HTTP JSON transport, retry policy, auth header resolution,
  idempotency keys, and JSON Schema response validation helpers.
- `transport-realtime`: WebSocket and realtime runtime event transport.

## Public subpaths

| Subpath | Primary exports |
|---|---|
| `@pellux/goodvibes-sdk/transport-core` | `ClientTransport`, direct in-process helpers, event envelopes, common transport errors |
| `@pellux/goodvibes-sdk/transport-direct` | Facade for direct/in-process transport helpers from `transport-core` |
| `@pellux/goodvibes-sdk/transport-http` | HTTP client construction, auth token normalization, retry/backoff helpers, SSE transport |
| `@pellux/goodvibes-sdk/transport-realtime` | Runtime event SSE/WebSocket connectors and domain event feeds |

## Retry and errors

HTTP retry behavior is centralized in `transport-http` and uses the canonical
`RETRYABLE_STATUS_CODES` from `@pellux/goodvibes-errors`. Transport errors are
`GoodVibesSdkError` instances with `source: "transport"` so callers can treat
network, protocol, timeout, and configuration failures without message parsing.

## Realtime events

The realtime package validates inbound runtime event envelopes before dispatch.
SSE and WebSocket connectors share reconnect policy shapes. The WebSocket
connector (`createWebSocketConnector`) adds connection-lifecycle hooks that the
SSE connector (`createEventSourceConnector`) does not fire:

- `onConnectionStateChange(state)` — `state` is one of `'connecting'`,
  `'connected'`, `'reconnecting'`, `'disconnected'`, `'failed'`.
- `onReconnectAttempt(info)` — `info` is `{ attempt, maxAttempts, delayMs, reason }`.
  The legacy `onReconnect(attempt, delayMs)` is `@deprecated` but still fired.
- `onOpen()` and `onBackpressure(info)` signal connect and outbound-queue saturation.

```ts
import {
  createRemoteRuntimeEvents,
  createWebSocketConnector,
} from '@pellux/goodvibes-sdk/transport-realtime';

const events = createRemoteRuntimeEvents(
  createWebSocketConnector('https://goodvibes.example.com', token, WebSocket, {
    onConnectionStateChange: (state) => updateBadge(state),
    onReconnectAttempt: (info) => log('reconnect attempt', info.attempt),
  }),
);
```

See [Realtime and telemetry](./realtime-and-telemetry.md) for the full connector
surface — domain events, outbound-queue backpressure caps, and the `ws://` auth guard.

Transport errors should preserve useful event fields and use typed SDK error
classes. Retryable HTTP status codes come from `@pellux/goodvibes-errors`.

## See also

- [Realtime and telemetry](./realtime-and-telemetry.md)
- [Retries and reconnect](./retries-and-reconnect.md)
- [Observability](./observability.md)
