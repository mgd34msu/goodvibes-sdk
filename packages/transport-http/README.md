# @pellux/goodvibes-transport-http

Internal workspace package backing `@pellux/goodvibes-sdk/transport-http`.

Consumers should install `@pellux/goodvibes-sdk` and import this surface from the umbrella package.

Exports include:
- contract route invocation helpers
- HTTP transport creation
- direct JSON request helpers
- header and auth token resolution helpers
- retry/backoff helpers
- SSE streaming helpers

Use this surface when you need lower-level HTTP/SSE control or when you are building a custom GoodVibes client on top of the synced contracts.

```ts
import { createJsonRequestInit, requestJsonRaw } from '@pellux/goodvibes-sdk/transport-http';

const body = await requestJsonRaw(
  fetch,
  'http://127.0.0.1:3210/api/control-plane/auth',
  createJsonRequestInit(process.env.GOODVIBES_TOKEN ?? null),
);
```
