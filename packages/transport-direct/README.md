# @goodvibes/transport-direct

In-process direct client transport shell for embedding GoodVibes operator and peer clients.

Install:

```bash
npm install @goodvibes/transport-direct
```

Example:

```ts
import { createDirectClientTransport } from '@goodvibes/transport-direct';

const transport = createDirectClientTransport(localOperator, localPeer);
```

Use this package when operator and peer surfaces are already available in-process and you want a typed direct transport wrapper instead of HTTP.
