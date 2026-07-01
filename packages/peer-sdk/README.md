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

## Pairing, work, and lifecycle

```ts
// Request a pairing challenge for operator approval. `peerKind` is 'node' or
// 'device'; `label` is required.
const pairing = await peer.pairing.request({ peerKind: 'node', label: 'my-runner' });

// Pull a work item, then report its outcome by work id. `status` is one of
// 'completed', 'failed', or 'cancelled'.
const job = await peer.work.pull();
await peer.work.complete('work-123', { status: 'completed' });

// Release resources when finished (also exposed via Symbol.dispose).
peer.dispose();
```

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

// Peer identity comes from the bearer peer token, not the request body. The
// heartbeat input carries liveness metadata only (capabilities, commands,
// version, clientMode, metadata).
const heartbeat = await peer.peer.heartbeat({ capabilities: ['work'], version: '0.35.0' });
```

## See also

- Main SDK: [`@pellux/goodvibes-sdk`](../sdk/README.md)
- [Getting Started](../../docs/getting-started.md)
