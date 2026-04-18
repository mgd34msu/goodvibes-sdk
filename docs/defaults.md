# Network Defaults Reference

This document records every timeout, retry, and backoff default in the SDK.
All values are in milliseconds unless stated otherwise.

## HTTP Transport (`packages/transport-http`)

| Path | Default | Notes |
|------|---------|-------|
| `DEFAULT_HTTP_RETRY_POLICY.maxAttempts` | 1 | Single attempt (no retry) by default; callers opt-in via `retry.maxAttempts` |
| `DEFAULT_HTTP_RETRY_POLICY.baseDelayMs` | 250 | Base delay between retry attempts |
| `DEFAULT_HTTP_RETRY_POLICY.maxDelayMs` | 2 000 | Backoff cap per retry |
| `DEFAULT_HTTP_RETRY_POLICY.backoffFactor` | 2 | Exponential multiplier |
| `DEFAULT_HTTP_RETRY_POLICY.retryOnStatuses` | `[408, 429, 500, 502, 503, 504]` | HTTP statuses eligible for retry |
| `DEFAULT_HTTP_RETRY_POLICY.retryOnMethods` | `['GET', 'HEAD', 'OPTIONS']` | Safe methods only |
| `DEFAULT_HTTP_RETRY_POLICY.retryOnNetworkError` | `true` | Network-level failures are retried |
| Request timeout | None (platform fetch default) | Use `AbortSignal` with timeout on the call site |

**Rationale:** Single-attempt default keeps latency predictable for interactive workloads. Callers
increase `maxAttempts` for batch/background operations.

## SSE Stream Reconnect (`packages/transport-http` — `reconnect.ts`)

| Path | Default | Notes |
|------|---------|-------|
| `DEFAULT_STREAM_RECONNECT_POLICY.enabled` | `false` | Reconnect is opt-in |
| `DEFAULT_STREAM_RECONNECT_POLICY.maxAttempts` | 10 | Finite cap prevents infinite reconnect loops |
| `DEFAULT_STREAM_RECONNECT_POLICY.baseDelayMs` | 500 | Initial reconnect delay |
| `DEFAULT_STREAM_RECONNECT_POLICY.maxDelayMs` | 30 000 | Hard backoff cap (30 s) |
| `DEFAULT_STREAM_RECONNECT_POLICY.backoffFactor` | 2 | Exponential multiplier |

**Rationale:** `maxAttempts: 10` replaces a previous `Number.POSITIVE_INFINITY` default which was
a 1.0.0 blocker — an unbounded reconnect loop could hang a process indefinitely in the face of a
persistent auth failure or server outage. `maxDelayMs: 30 000` caps worst-case wait between
attempts to 30 seconds to avoid silent hangs.

## WebSocket Reconnect (`packages/transport-realtime`)

| Path | Default | Notes |
|------|---------|-------|
| `DEFAULT_WS_MAX_ATTEMPTS` | 10 | Shared constant; passed to `normalizeStreamReconnectPolicy` |
| `reconnect.baseDelayMs` | 500 (inherited from SSE policy) | |
| `reconnect.maxDelayMs` | 30 000 (inherited from SSE policy) | |
| `reconnect.backoffFactor` | 2 | |

**Rationale:** Matches SSE for a symmetric schedule. Finite cap prevents infinite auth-failure loops.

## Auth (`packages/sdk/src/auth.ts`)

| Path | Timeout | Max Retries | Notes |
|------|---------|-------------|-------|
| `SessionManager.login` / `current` | None explicit | Delegates to HTTP transport | HTTP retry policy applies |
| `TokenStore.getToken / setToken / clearToken` | None | N/A | Synchronous-ish; no network I/O |

**Rationale:** Auth calls go through the HTTP transport layer which applies `DEFAULT_HTTP_RETRY_POLICY`.
There is no separate auth-specific timeout; callers should pass an `AbortSignal` for bounded waits.

## Outbound Producer Queue (`packages/transport-realtime` — `runtime-events.ts`)

| Field | Value | Notes |
|-------|-------|-------|
| `MAX_OUTBOUND_QUEUE` | 1 024 | Max buffered outbound messages while socket is not open |
| Drop policy | Oldest dropped first | `droppedOutboundCount` incremented on each drop; `onError` is called |
