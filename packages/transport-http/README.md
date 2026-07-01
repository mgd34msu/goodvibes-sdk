# @pellux/goodvibes-transport-http

Public GoodVibes HTTP transport package for JSON requests, auth headers, retry/backoff, SSE streams, and contract route invocation.

Most applications should install `@pellux/goodvibes-sdk` and import `@pellux/goodvibes-sdk/transport-http`. Install this package directly when you only need the HTTP transport subset.

Key exports:
- Contract routes: `invokeContractRoute`, `openContractRouteStream`, `requireContractRoute`.
- HTTP transport: `createHttpTransport`, `createFetch`, `requestJsonRaw`, `createJsonRequestInit`.
- Idempotency: `generateIdempotencyKey`.
- Retry / backoff: `DEFAULT_HTTP_RETRY_POLICY`, `resolveHttpRetryPolicy`, `computeBackoffDelay`, `normalizeBackoffPolicy`, `sleepWithSignal`.
- SSE streaming: `openServerSentEventStream`, `openRawServerSentEventStream`.
- Auth / headers: `normalizeAuthToken`, `resolveAuthToken`, `mergeHeaders`.
- Paths: `buildUrl`, `normalizeBaseUrl`, `createTransportPaths`.
- Middleware: `TransportMiddleware` / `TransportContext` types (compose chains with `composeMiddleware` from `transport-core`).

Use this surface when you need lower-level HTTP/SSE control or when you are building a custom GoodVibes client on top of the synced contracts.

```ts
import { createJsonRequestInit, requestJsonRaw } from '@pellux/goodvibes-sdk/transport-http';

const body = await requestJsonRaw(
  fetch,
  'http://127.0.0.1:3421/api/control-plane/auth',
  createJsonRequestInit(process.env.GOODVIBES_TOKEN ?? null),
);
```
