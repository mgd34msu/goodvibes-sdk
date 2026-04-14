# @goodvibes/peer-sdk

HTTP client for the GoodVibes peer and distributed-runtime APIs.

Install:

```bash
npm install @goodvibes/peer-sdk
```

```ts
import { createPeerSdk } from '@goodvibes/peer-sdk';

const peer = createPeerSdk({
  baseUrl: 'http://127.0.0.1:3210',
  authToken: process.env.GOODVIBES_PEER_TOKEN,
});

const work = await peer.work.pull();
```

Use this package for pairing, heartbeat, work pull, and work completion flows without pulling in the broader umbrella SDK.
