# @pellux/goodvibes-peer-sdk

Internal workspace package backing `@pellux/goodvibes-sdk/peer`.

Consumers should install `@pellux/goodvibes-sdk` and import this surface from the umbrella package.

```ts
import { createPeerSdk } from '@pellux/goodvibes-sdk/peer';

const peer = createPeerSdk({
  baseUrl: 'http://127.0.0.1:3421',
  authToken: process.env.GOODVIBES_TOKEN,
});

const work = await peer.work.pull();
```

Use this surface for pairing, heartbeat, work pull, and work completion flows without pulling in the broader umbrella SDK.

Advanced consumers can also build directly from a preconfigured transport and contract:

```ts
import { getPeerContract } from '@pellux/goodvibes-sdk/contracts';
import { createPeerRemoteClient } from '@pellux/goodvibes-sdk/peer';
import { createHttpTransport } from '@pellux/goodvibes-sdk/transport-http';

const transport = createHttpTransport({
  baseUrl: 'http://127.0.0.1:3421',
  authToken: process.env.GOODVIBES_TOKEN,
});

const peer = createPeerRemoteClient(transport, getPeerContract());
const heartbeat = await peer.peer.heartbeat({ peerId: 'peer-1' });
```
