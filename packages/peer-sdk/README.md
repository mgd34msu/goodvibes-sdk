# @pellux/goodvibes-peer-sdk

Public GoodVibes peer package for distributed-runtime peer APIs and work exchange flows.

Most applications should install `@pellux/goodvibes-sdk` and import `@pellux/goodvibes-sdk/peer`. Install this package directly when you only need the peer client subset.

```ts
import { createPeerSdk } from '@pellux/goodvibes-sdk/peer';

const peer = createPeerSdk({
  baseUrl: 'http://127.0.0.1:3421',
  authToken: process.env.GOODVIBES_TOKEN,
});

const work = await peer.work.pull();
```

Use this surface for pairing, heartbeat, work pull, and work completion flows without pulling in the broader main SDK.

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
