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
