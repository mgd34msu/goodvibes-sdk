# @pellux/goodvibes-peer-sdk

Internal workspace package backing `@pellux/goodvibes-sdk/peer`.

Consumers should install `@pellux/goodvibes-sdk` and import this surface from the umbrella package.

```ts
import { createPeerSdk } from '@pellux/goodvibes-sdk/peer';

const peer = createPeerSdk({
  baseUrl: 'http://127.0.0.1:3210',
  authToken: process.env.GOODVIBES_PEER_TOKEN,
});

const work = await peer.work.pull();
```

Use this surface for pairing, heartbeat, work pull, and work completion flows without pulling in the broader umbrella SDK.
