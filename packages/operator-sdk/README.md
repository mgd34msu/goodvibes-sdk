# @pellux/goodvibes-operator-sdk

Internal workspace package backing `@pellux/goodvibes-sdk/operator`.

Consumers should install `@pellux/goodvibes-sdk` and import this surface from the umbrella package.

```ts
import { createOperatorSdk } from '@pellux/goodvibes-sdk/operator';

const operator = createOperatorSdk({
  baseUrl: 'http://127.0.0.1:3421',
  authToken: process.env.GOODVIBES_TOKEN,
});

const snapshot = await operator.control.snapshot();
const login = await operator.invoke('control.auth.login', {
  username: 'alice',
  password: 'secret',
});
```

Use this surface when you want only the operator/control-plane surface and do not need the umbrella SDK composition layer.

Advanced consumers can also build directly from a preconfigured transport and contract:

```ts
import { getOperatorContract } from '@pellux/goodvibes-sdk/contracts';
import { createOperatorRemoteClient } from '@pellux/goodvibes-sdk/operator';
import { createHttpTransport } from '@pellux/goodvibes-sdk/transport-http';

const transport = createHttpTransport({
  baseUrl: 'http://127.0.0.1:3421',
  authToken: process.env.GOODVIBES_TOKEN,
});

const operator = createOperatorRemoteClient(transport, getOperatorContract());
const status = await operator.control.status();
```
