# @pellux/goodvibes-transport-direct

Internal workspace package backing `@pellux/goodvibes-sdk/transport-direct`.

Consumers should install `@pellux/goodvibes-sdk` and import this surface from the umbrella package.

Consumer import:

```ts
import { createDirectClientTransport } from '@pellux/goodvibes-sdk/transport-direct';

const transport = createDirectClientTransport(localOperator, localPeer);
```

Use this surface when operator and peer surfaces are already available in-process and you want a typed direct transport wrapper instead of HTTP.
