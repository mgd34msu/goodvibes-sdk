# Realtime and Telemetry

> **Surface scope:** This document covers realtime transport and telemetry for both the **full surface (Bun runtime)** and the **companion surface** (React Native, Expo, browser). Full-surface consumers use `createGoodVibesSdk`; companion consumers use their surface-specific constructors. See [Published Surface Matrix](./surfaces.md) for the full breakdown.

> **Scope vs. [Observability](./observability.md):** This document is the consumer-facing quick reference for realtime feeds and basic telemetry consumption. For the complete event-domain catalog, observer-pipeline internals, redaction, correlation context, and metric-label allowlist, see [Observability](./observability.md). Content overlap is intentional but kept minimal here.

Use realtime feeds for live UI updates and operator monitoring.

## Runtime events

```ts
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';

const sdk = createGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3421',
  authToken: process.env.GOODVIBES_TOKEN,
});

const unsubscribe = sdk.realtime.viaSse().agents.on('AGENT_COMPLETED', (event) => {
  console.log(event);
});
```

The realtime layer supports:
- SSE stream resume via `Last-Event-ID`
- SSE reconnect
- WebSocket reconnect
- dynamic auth token resolution during reconnects

### Realtime connectors

The realtime transport (`@pellux/goodvibes-sdk/transport-realtime`) exposes two low-level connector factories plus a domain-event layer. Wrap either connector with `createRemoteRuntimeEvents(connector)` for the typed runtime-event feed.

- `createEventSourceConnector(baseUrl, token, fetch, options?)` — SSE connector. Supports `Last-Event-ID` stream resume, reconnect (via the stream reconnect policy), and dynamic auth-token resolution on reconnect.
- `createWebSocketConnector(baseUrl, token, WebSocket, options?)` — WebSocket connector. The connection-lifecycle hooks below are passed via the `options` object. Adds connection-lifecycle hooks that the SSE connector does **not** fire:
  - `onConnectionStateChange(state)` where `state` is `'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed'`.
  - `onReconnectAttempt(info)` with `{ attempt, maxAttempts, delayMs, reason }` (the legacy `onReconnect(attempt, delayMs)` is deprecated but still fired).
  - `onBackpressure(info)` when the bounded outbound queue saturates.

**Domain events.** The domain-event module scopes feeds by session and domain:
- `createRemoteDomainEvents(domains, connector, options?)` builds a multi-domain feed over any `DomainEventConnector`.
- `forSession(...)` / `forSessionRuntime(...)` scope a feed to a single session.
- `SerializedEventEnvelope` is the wire-envelope type delivered by connectors.

**Outbound-queue backpressure (WebSocket).** Messages queued while the socket is reconnecting are held in a bounded, drop-oldest queue: up to 1,024 messages / 16 MiB total, with a single message above 1 MiB rejected outright. On overflow `onBackpressure` fires with `{ droppedCount, queueLength, queueBytes, reason }`.

**Insecure-transport guard.** The WebSocket connector refuses to send authentication over a non-loopback `ws://` URL, throwing a `ConfigurationError` — use `wss://` (or `https://`, which is upgraded to `wss://`) for remote hosts.

## Telemetry APIs

Telemetry APIs live on the operator client:

```ts
// snapshot: returns recent telemetry entries. The filter input is an inline per-method
// shape (there is no exported TelemetrySnapshotOptions type):
// { limit?; since?; until?; domains?; types?; severity?; traceId?; sessionId?; turnId?; agentId?; taskId?; cursor?; view? }
const snapshot = await sdk.operator.telemetry.snapshot({ limit: 100 });
// errors: filter by severity ('debug' | 'error' | 'info' | 'warn'), domains, time range
// (since/until), and a cursor for pagination
const errors = await sdk.operator.telemetry.errors({ severity: 'error' });
```

## OTLP exports

The operator SDK exposes the OTLP-shaped daemon endpoints:

```ts
await sdk.operator.telemetry.otlp.traces();
await sdk.operator.telemetry.otlp.logs();
await sdk.operator.telemetry.otlp.metrics();
```

The OTLP endpoints return JSON-encoded OTLP responses (`application/json` with OTLP export response shape). Binary protobuf encoding is not used on these routes.

## Recommended use

- use HTTP operator APIs to load initial snapshots
- use realtime events to keep the UI current
- use telemetry endpoints for historical views, diagnostics, and filtered error/event exploration
- use OTLP endpoints when you are exporting platform telemetry into another observability tool
