# @pellux/goodvibes-operator-sdk

Public GoodVibes operator package for the contract-driven operator and control-plane HTTP client.

Most applications should install `@pellux/goodvibes-sdk` and import `@pellux/goodvibes-sdk/operator`. Install this package directly when you only need the operator client subset.

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

Use this surface when you want only the operator/control-plane surface and do not need the main SDK composition layer.

## Typed methods

The `createOperatorSdk` client exposes the operator contract as typed,
namespaced methods:

```ts
const status = await operator.control.status();
const sessions = await operator.sessions.list();

// Open a server-sent event stream; resolves to an unsubscribe function.
const stop = await operator.stream('control.events.stream', {
  handlers: {
    onEvent: (eventName, payload) => console.log(eventName, payload),
  },
});
stop();
```

Response bodies are validated against their Zod contract schemas by default;
pass `validateResponses: false` to `createOperatorSdk` to opt out. Call
`dispose()` (or `await asyncDispose()`) to release resources when finished;
the client also implements `Symbol.dispose` / `Symbol.asyncDispose`.

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

## See also

- Main SDK: [`@pellux/goodvibes-sdk`](../sdk/README.md)
- [Getting Started](../../docs/getting-started.md)
