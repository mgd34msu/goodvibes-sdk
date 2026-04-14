# @pellux/goodvibes-transport-realtime

Internal workspace package backing `@pellux/goodvibes-sdk/transport-realtime`.

Consumers should install `@pellux/goodvibes-sdk` and import this surface from the umbrella package.

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

Use this surface when you want runtime-event subscriptions without pulling in the full umbrella SDK.
