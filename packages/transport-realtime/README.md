# @pellux/goodvibes-transport-realtime

Public GoodVibes realtime transport package for event-domain connectors over SSE and WebSocket.

Most applications should install `@pellux/goodvibes-sdk` and import `@pellux/goodvibes-sdk/transport-realtime`. Install this package directly when you only need realtime connectors.

Consumer import:

```ts
import {
  createEventSourceConnector,
  createRemoteRuntimeEvents,
} from '@pellux/goodvibes-sdk/transport-realtime';

const events = createRemoteRuntimeEvents(
  createEventSourceConnector('https://goodvibes.example.com', 'token', fetch),
);
```

Use this surface when you want runtime-event subscriptions without pulling in the full main SDK.

## WebSocket connector

`createWebSocketConnector(baseUrl, token, WebSocket, options?)` returns a connector with the same shape as the SSE connector but adds WebSocket-only lifecycle hooks (the SSE connector does not fire them):

- `onConnectionStateChange(state: ConnectionState)` — `'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed'`.
- `onReconnectAttempt(info: ReconnectAttemptInfo)` — `{ attempt, maxAttempts, delayMs, reason }`. The legacy `onReconnect(attempt, delayMs)` is deprecated but still fired.
- `onBackpressure(info: BackpressureInfo)` — `{ droppedCount, queueLength, queueBytes, reason }`, emitted when the bounded outbound queue saturates (1,024 messages / 16 MiB total; a single message above 1 MiB is rejected). It fires on the first overflow and every tenth thereafter.

`DEFAULT_WS_MAX_ATTEMPTS` (10) is the default reconnect ceiling, chosen to avoid infinite auth-failure loops. `WebSocketTransportError` and `createWebSocketRemoteError` carry typed WebSocket failure detail. An internal guard (`assertWebSocketAuthTransportIsSafe`) refuses to send authentication over a non-loopback `ws://` URL, throwing a `ConfigurationError`; use `wss://` or `https://` for remote hosts.

## Domain events

The domain-event layer provides session- and domain-scoped feeds:

- `createRemoteDomainEvents(domains, connector, options?)` — multi-domain feed over any `DomainEventConnector`.
- `forSession(...)` / `forSessionRuntime(...)` — scope a feed to a single session.
- Types: `DomainEventConnector`, `RemoteDomainEventsOptions`, `SerializedEventEnvelope`, `ConnectionState`, `ReconnectAttemptInfo`, `BackpressureInfo`.
