# @pellux/goodvibes-transport-realtime

Realtime event-domain connectors for GoodVibes SSE and WebSocket integrations.

Install:

```bash
npm install @pellux/goodvibes-transport-realtime
```

Example:

```ts
import {
  createEventSourceConnector,
  createRemoteRuntimeEvents,
} from '@pellux/goodvibes-transport-realtime';

const events = createRemoteRuntimeEvents(
  createEventSourceConnector('https://goodvibes.example.com', 'token', fetch),
);
```

Use this package when you want runtime-event subscriptions without pulling in the full umbrella SDK.
