# @pellux/goodvibes-transport-core

Public GoodVibes transport-core package for shared transport, event-feed, observer, and middleware primitives.

Most applications should install `@pellux/goodvibes-sdk` and import `@pellux/goodvibes-sdk/transport-core`. Install this package directly when you only need the transport primitives.

Use this surface only when you are composing your own transport/client abstraction.

Key exports:
- Event envelopes: `createEventEnvelope` (with the `EventEnvelope` / `EventEnvelopeContext` types).
- Client transport: `createClientTransport`, `createDirectClientTransport`.
- Middleware: `composeMiddleware` (with the `TransportMiddleware` / `TransportContext` types).
- Transport error helpers: `transportErrorFromUnknown`, `isAbortError`, `describeUnknownTransportError`.
- Runtime event feeds: `createRuntimeEventFeed`, `createRuntimeEventFeeds`.
- Utilities: `createUuidV4`.

```ts
import {
  createEventEnvelope,
  createUuidV4,
} from '@pellux/goodvibes-sdk/transport-core';

const envelope = createEventEnvelope(
  'TURN_SUBMITTED',
  { turnId: createUuidV4(), prompt: 'Hello' },
  { sessionId: 'sess_abc', source: 'orchestrator' },
);
```

Most consumers should use `@pellux/goodvibes-sdk`, `@pellux/goodvibes-sdk/operator`, or `@pellux/goodvibes-sdk/peer` instead.
