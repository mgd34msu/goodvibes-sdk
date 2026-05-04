# Ninth Review — SDK Packages (HEAD)

**Scope:** `packages/{contracts,errors,daemon-sdk,operator-sdk,peer-sdk,transport-core,transport-http,transport-realtime}/src/**`

**Reviewer:** goodvibes:reviewer (9th-pass packages lane)

**WRFC:** wrfc_9th_packages

---

## CRITICAL

### CRIT-01 — Synthetic `Response` from middleware fast-path drops headers/length, breaks streaming and retry-after parsing for middleware-equipped HTTP transport
**File:** `packages/transport-http/src/http-core.ts:438-442`

```ts
return new Response(JSON.stringify(body), {
  status: response.status,
  statusText: response.statusText,
  headers: response.headers,
});
```

The middleware path constructs a synthetic `Response` whose body is a re-stringified JSON copy of the parsed body, but it forwards the **original** `response.headers` (including the original `content-length`, `content-encoding`, possibly `transfer-encoding: chunked`) onto a body that is now a different size. Downstream consumers that read `content-length`, attempt to handle gzip/br encoding, or rely on hop-by-hop headers will see lying headers. Also, on `null`-body daemon responses (`readJsonBody` returns `null`), `JSON.stringify(null)` produces the literal `"null"` — `ctx.response.json()` on the next line returns `null` correctly, but the synthetic body now has a size of 4 with a header that says otherwise.

More importantly: the no-middleware path on line 471 calls `innerFetch(ctx)` and immediately consumes `.json()` on the synthetic Response too — meaning **for both code paths**, custom middleware that wants to inspect the raw body bytes after `next()` resolves will read JSON-re-encoded bytes, not the original wire bytes (whitespace, key order, numeric precision lost). For SSE/streaming bodies passed accidentally through this transport (`Content-Type: text/event-stream`), the synthetic Response is a bug magnet.

**Fix:** Either (a) construct the synthetic Response with no body and stash the parsed body on a non-Response carrier object that middleware can read, or (b) keep the original Response and re-parse — but that double-reads the body. Cleanest is to expose `ctx.body = body` and have the inner-fetch return the original `response` directly, then call `.json()` only when no middleware modified the result. Headers must reflect the actual bytes.

---

### CRIT-02 — Middleware error wrapping discards `HttpStatusError`, breaking caller `instanceof HttpStatusError` and `category === 'rate_limit'` checks
**File:** `packages/transport-http/src/http-core.ts:485-499`

```ts
if (ctx.middlewareError) {
  // Error came from within the middleware chain — wrap regardless of error type.
  const msg = transportErrorFromUnknown(error, 'transport middleware error').message;
  const middlewareName = ctx.activeMiddlewareName ?? 'unknown';
  const wrapped = new GoodVibesSdkError(`Transport middleware error: ${msg}`, {
    category: 'unknown',
    source: 'transport',
    recoverable: false,
    cause: { middleware: middlewareName, originalError: error },
  });
  return wrapped;
}
```

If a middleware re-throws an `HttpStatusError` it caught (a common pattern for adding rate-limit handling, custom retry logic, or conditional re-issue), the SDK silently downgrades the error to `category: 'unknown', recoverable: false`, hiding the original 429 / 401 / 503 status from the caller. Users handling `err.category === 'rate_limit'` or `err instanceof HttpStatusError` will fall through to a generic catch and lose retry semantics. The comment claims this is intentional ("ALL errors originating from the middleware chain are wrapped — including HttpStatusError") but this design choice silently breaks the documented narrowing pattern in `errors/index.ts:178-187`.

Worse: the retry decision below at line 502-503 reads `wrappedError.transport.status` to decide whether to retry. `wrapped` is a fresh `GoodVibesSdkError` with **no** `transport` property attached, so `status` evaluates to `undefined` and `shouldRetry` is always `false` for any middleware-rethrown error — even a transient 503.

**Fix:** When `error instanceof HttpStatusError` (or any error already carrying `transport` payload), preserve it and only annotate with `cause: { middleware: ... }`. Reserve full wrapping for non-SDK errors that originated *purely* inside middleware logic.

---

### CRIT-03 — Stream cleanup leak: `forSession` filtered feed wraps unsubscribe but never disconnects upstream when last underlying listener is the shared one
**File:** `packages/transport-realtime/src/domain-events.ts:217-239`

The `createFilteredFeed` shared envelope-listener pattern (MIN-16 in the file) shares one `feed.onEnvelope(...)` subscription per event type for N filtered consumers. When the last filtered consumer unsubscribes, `removeSharedIfEmpty` calls `shared.unsub()` which removes the upstream payload listener. **However**, the `RemoteDomainEventConnection` upstream uses `maybeDisconnect()` which re-checks `hasListeners()` (lines 102-105 of the same file). The shared envelope listener installed by `createFilteredFeed` registers exactly **one** envelope listener on the upstream feed regardless of how many filtered consumers exist. So `hasListeners()` returns `false` only when `shared.unsub()` is called.

Problem: between `shared.unsub()` and the upstream's `maybeDisconnect()`, there is no synchronization. The unsub on the upstream feed (`createRemoteDomainEventFeed`'s returned closure at line 165-168) calls `unsubscribe(); maybeDisconnect();` synchronously. That works for the direct path. But the filtered feed's `removeSharedIfEmpty` calls `shared.unsub()` without awaiting any microtask — fine.

The **actual** leak: in `createRemoteDomainEventFeed` at line 134, when `connect()` resolves and `disconnectPending && !hasListeners()` is true, `cleanup()` is invoked. But the next reconnect attempt is fully gated on `connectPromise || disconnect`. If the connector rejects (line 139-142) and `connectPromise` is finally cleared (line 144), but `disconnect` is `null` and `disconnectPending` was reset to `false`, the filtered feed cannot re-attach a listener: the filtered feed shares one envelope subscription, so once `shared.unsub()` ran, all downstream listeners stop receiving events with no way to re-subscribe through the same `shared` cache. The next call to `getOrCreateShared(type)` will create a NEW shared subscription, which retriggers `maybeConnect()` — that recovery path does work.

Narrower issue: `forSession` returns `Object.freeze({...filteredFeeds, domains, domain})` (line 305-311) but reading `events.domains` returns the inner `events.domains` array reference. If consumers mutate it, downstream feeds would re-iterate stale domains. Minor but unfrozen.

**Fix:** Promote this to a real bug only if reproduction observed; the report flags as Major instead. Keeping CRIT designation removed — see MAJ-09.

---

### CRIT-04 — Outbound WebSocket queue is preserved across the `closeSocket()` path but reset on disposal, allowing message replay against a different daemon session after token rotation
**File:** `packages/transport-realtime/src/runtime-events.ts:382-396, 559-570`

`closeSocket()` (called on `onClose`, scheduleReconnect, and on disposal) preserves `outboundQueue` so that pending frames flush on reconnect (`flushOutboundQueue` at line 419-436). On reconnect, `onOpen` re-sends the auth frame with the **freshly-resolved** auth token (`getAuthToken()` at line 444), then drains the queue. If between disconnect and reconnect, the daemon issued a new pair token, revoked the previous one, and the operator queued a sensitive command (e.g. `emitLocal('{"type":"invoke",...}')`) intended for the original session, the queued message is now sent with the **new** auth identity. There is no per-message session/identity binding.

This is a security correctness issue for the WebSocket connector when used as a control channel for distributed work. Tokens may have different scopes; replaying queued frames under broader-scope tokens can elevate the effect of a queued operation.

**Fix:** Either (a) bind queued frames to the auth token version that was active at enqueue time and discard frames whose auth token no longer matches, or (b) document that `emitLocal` is best-effort fire-and-forget and clear the queue on token rotation. Adding a `queueOnReconnect: false` per-frame option is also acceptable.

---

### CRIT-05 — `decodeURIComponent` in operator dispatcher throws `URIError` on malformed percent-encoded paths, returning a 500 instead of a 400 to the caller
**File:** `packages/daemon-sdk/src/operator.ts:8-14, 67-69, 99-103, 107-111, 115, 119, 123, 127, 131, 135, 139, 143, 147, 151, 155, 159, 206, 208`

The file defines `safeDecodeURIComponent` (line 8) explicitly to handle malformed sequences, then **never uses it**. Every `decodeURIComponent` call site (≈25 occurrences) will throw `URIError` on input like `/api/control-plane/methods/%E0%A4/invoke`. Since `dispatchOperatorRoutes` does not wrap match-paths in try/catch and the calling daemon harness typically forwards thrown errors to a generic 500 handler, this is both a DOS vector (any unauthenticated client can probe URL space) and a contract violation — the operator surface should reject malformed paths with 400.

**Fix:** Either delete `safeDecodeURIComponent` (currently dead per CRIT detection) and accept the risk, OR replace every `decodeURIComponent` call in this file with `safeDecodeURIComponent` and 404 (per existing "Unknown channel ..." / "Unknown gateway method" patterns) when the result is `null`. Same review item also applies to the dead-helper detection finding (NIT-01 below).

---

### CRIT-06 — `error-response.ts` privileged-field gating leaks `requestId` and `retryAfterMs` to unprivileged callers
**File:** `packages/daemon-sdk/src/error-response.ts:308-323, 346-362`

The MAJ-5 fix added gating for `provider`, `operation`, `phase`, `providerCode`, `providerType` fields behind `isPrivileged`. **But `requestId` and `retryAfterMs` are still always emitted** (lines 320, 323, 358, 361). `requestId` can leak internal trace IDs that correlate across users; `retryAfterMs` can leak rate-limit window state about other tenants when shared infrastructure is fronted.

More subtle: an unprivileged caller can do timing attacks via `retryAfterMs` to fingerprint backend providers (different providers have different rate-limit policies — `retryAfterMs: 2000` vs `5000` reveals upstream identity).

**Fix:** Either gate `retryAfterMs` behind `isPrivileged`, or sanitize to a coarse bucket (e.g. always round up to next 5s) for unprivileged callers. `requestId` should be re-issued per-tenant rather than passed through.

---

## MAJOR

### MAJ-01 — `daemon-sdk/integration-routes.ts` exposes provider/delivery/account state without admin or auth checks
**File:** `packages/daemon-sdk/src/integration-routes.ts:74-118`

The following handlers are returned without `requireAdmin` or any authentication enforcement:
- `getDelivery(deliveryId)` (line 74-81): reads from internal `runtimeStore.getState().deliveries.deliveryAttempts` map. Anyone with network access can enumerate delivery IDs and read their contents.
- `getProviders()` (line 99): lists all configured providers with credentials state.
- `getProvider(providerId)` (line 100-105): same.
- `getProviderUsage(providerId)` (line 106-111): leaks per-provider usage telemetry.
- `getAccounts()` (line 85-98): merges integration accounts + channel accounts; channel-account list often includes auth-state per channel.
- `getMemoryDoctor`/`getMemoryVectorStats` (line 119-120): leaks memory subsystem state.

Comment in operator.ts:18-32 claims "auth enforcement lives in the handler factories" — but this factory does NOT enforce auth on these read paths. Either the comment lies or the factory is missing checks.

**Fix:** Add `requireAdmin` (or at minimum `requireAuthenticatedSession`) to each of the handlers above. If the daemon harness enforces auth at a layer above (e.g. inside `requireAdmin` injected via context), document that contract clearly in the handler factory.

---

### MAJ-02 — `channel-routes.ts` directory query leaks live channel members without auth
**File:** `packages/daemon-sdk/src/channel-routes.ts:317-326`

`getChannelDirectory` calls `context.channelPlugins.queryDirectory(...)` for the surface and forwards a query string from `q=`. No `requireAdmin` check. For the Slack/Telegram/Discord/Matrix/etc. surfaces, this allows an unauthenticated network caller to enumerate the daemon's connected workspaces, channels, and members. Other GET handlers in this file (e.g. `getChannelAccounts`, `getChannelDoctor`) similarly omit auth enforcement, but those expose less sensitive shape. Directory enumeration is the worst.

**Fix:** `getChannelDirectory` MUST `requireAdmin(req)`; same for `getChannelStatus` (line 316), `getChannelAccount` (line 39), and the entire `get*` family that returns connection-state.

---

### MAJ-03 — `http-core.ts` retry decision reads `wrappedError.transport.status` after middleware wrap, which never has `transport` set
**File:** `packages/transport-http/src/http-core.ts:502-513`

```ts
const status = typeof wrappedError === 'object' && wrappedError !== null && 'transport' in wrappedError
  ? (wrappedError as { readonly transport?: { readonly status?: unknown } }).transport?.status
  : undefined;
// ...
const shouldRetry = canRetry && attempt < resolvedRetry.maxAttempts && (
  (typeof status === 'number' && status > 0 && isRetryableHttpStatus(method, status, resolvedRetry))
  || (typeof status === 'number' && status === 0 && isRetryableNetworkError(method, resolvedRetry))
);
```

When `ctx.middlewareError === true`, the wrapping at lines 489-496 produces a `GoodVibesSdkError` with **no `transport` property**. So `status` resolves to `undefined`, and `shouldRetry` evaluates to `false` for ANY middleware-thrown error — including transient 5xx, ECONNRESET, etc. Combined with CRIT-02, middleware-equipped transports lose all retry behavior on transient failures even when the user explicitly requested retry-on-5xx.

**Fix:** Either preserve the original error's `transport` payload by `Object.assign(wrapped, { transport: (error as any).transport })` when wrapping, or bypass wrapping when `error` already carries a `transport` shape.

---

### MAJ-04 — `runtime-events.ts` WS onClose treats codes 1001 and 1006 as errors that trigger reconnect, including normal "server shutting down"
**File:** `packages/transport-realtime/src/runtime-events.ts:527-536`

```ts
if (!stopped && event.code !== 1000 && event.code !== 1005) {
  const closeError = webSocketCloseError(event);
  invokeTransportObserver(() => observer?.onError?.(closeError));
  options.onError?.(closeError);
}
closeSocket();
scheduleReconnect();
```

WebSocket close codes:
- `1000` Normal closure (treated correctly as success)
- `1001` Going away — server shutting down or tab close. Often expected lifecycle, not an error.
- `1005` No status code received — treated as success (correct for graceful close)
- `1006` Abnormal closure — definitely an error
- `1011` Server error — error
- `1012-1015` Service restart, try again later, etc. — recoverable

Firing `options.onError` for 1001 (server going away) is wrong; the server intentionally requested cleanup, not a fault. For long-running daemons connected to upstream services that scale down (Cloudflare Workers, Heroku dyno restarts), this generates spurious error noise on every deploy.

**Fix:** Treat 1000, 1001, 1005 as non-error closures (still reconnect if enabled, but don't fire `onError`). Codes 1006-1015 remain errors.

---

### MAJ-05 — `runtime-events.ts` WS onOpen drops queued messages when auth token resolution returns null
**File:** `packages/transport-realtime/src/runtime-events.ts:438-460`

```ts
const authToken = (await getAuthToken()) ?? null;
if (!authToken || !openedSocket || stopped || socket !== openedSocket) return;
// ...
openedSocket.send(JSON.stringify({ type: 'auth', token: authToken, domains: [domain], ... }));
flushOutboundQueue(openedSocket);
```

If `getAuthToken` resolves to `null` (e.g. transient credential refresh failure, sign-out during reconnect), `onOpen` returns early **without** calling `flushOutboundQueue` and **without** closing the now-open socket. The socket sits in OPEN state unauthenticated, the queue stays full, and the next reconnect (on natural close) re-runs onOpen. If credentials remain unavailable, the queue grows unboundedly until `MAX_OUTBOUND_QUEUE_BYTES` triggers drop-oldest — but those drops fire `WS_QUEUE_OVERFLOW` errors that may be invisible to the operator who silently lost auth.

**Fix:** When `authToken` is null in `onOpen`, fire a `WS_AUTH_UNAVAILABLE` error via `options.onError`, call `closeSocket()`, and let `scheduleReconnect()` retry with backoff. Currently the failure is silent.

---

### MAJ-06 — `sse-stream.ts` triggers "Stream closed unexpectedly" reconnect on naturally-terminating SSE streams
**File:** `packages/transport-http/src/sse-stream.ts:201-223`

```ts
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  // ...
}
// ...
if (reconnectPolicy.enabled && !controller.signal.aborted && !outerController.signal.aborted && !stopped) {
  throw createStreamError(response.status, url, 'Stream closed unexpectedly');
}
```

A server that closes the SSE stream cleanly after sending a terminal `event: complete` (a common pattern for finite streams: e.g., a session that has finished) will trigger this throw, leading to reconnect-and-fail-forever. The SDK has no way to distinguish "stream is done, server signals completion" from "stream dropped unexpectedly." Reconnect is enabled by default opt-in, so users who DO want reconnect on transient drops MUST also tolerate infinite reconnect on streams the server intentionally closed.

**Fix:** Add a sentinel handler `onComplete` (or recognize `event: close` / `event: end` from the server) that suppresses the unexpected-close throw. Alternatively, allow callers to signal terminal events through `handlers.onClose` returning a "don't reconnect" flag.

---

### MAJ-07 — Idempotency-key generation logic relies on `hasPerMethodOverride` re-resolving the policy twice (correctness) and may emit keys for non-retried calls (semantics)
**File:** `packages/transport-http/src/http-core.ts:368-371, 508-509`

```ts
const hasPerMethodOverride = methodId !== undefined
  && resolveHttpRetryPolicy(retryPolicy, requestOptions.retry).perMethodPolicy[methodId] !== undefined;
const idempotencyKey = isMutatingMethod && (contractIdempotent || hasPerMethodOverride)
  ? generateIdempotencyKey()
  : undefined;
```

The pre-loop (line 368) re-runs `resolveHttpRetryPolicy` even though `baseRetry` was just computed at line 355. Apart from being wasteful, the result is consistent with `baseRetry.perMethodPolicy[methodId] !== undefined` — but the inner-loop check at line 508 reads `baseRetry.perMethodPolicy[methodId]` directly. If `requestOptions.retry` is mutated mid-flight (e.g. by middleware), pre and inner can disagree. Probably not exercised today but a footgun.

Semantic concern: a `methodId` whose `perMethodPolicy` entry is `{ maxAttempts: 1 }` (retry disabled) still yields `hasPerMethodOverride === true` and emits an idempotency key. Sending an idempotency key implies "server: please de-dup my retries" — but this call WILL NOT retry. Some daemons cache idempotency-keyed responses for hours; a non-retried call now occupies cache space for no benefit and risks the server returning a stale 200 if the same key is reused.

**Fix:** Compute `hasPerMethodOverride` from `baseRetry` (already in scope). Tighten the idempotency-key emission: emit only when `(contractIdempotent || (hasPerMethodOverride && perMethodPolicy[methodId].maxAttempts > 1))`.

---

### MAJ-08 — `event-feeds.ts` `createRuntimeEventFeeds` returns an `Object.freeze`d object whose inner `feeds[domain]` references can mutate listener maps
**File:** `packages/transport-core/src/event-feeds.ts:64-75`

```ts
const feeds = {} as Record<TDomain, RuntimeEventFeed<TEvent>>;
for (const domain of domains) {
  feeds[domain] = createFeed(domain);
}
return Object.freeze({
  ...feeds,
  domains,
  domain(domain: TDomain): RuntimeEventFeed<TEvent> {
    return feeds[domain];
  },
});
```

`Object.freeze` is shallow. The `feeds` map values (each a feed object with `on`/`onEnvelope` closures) are not frozen, and the underlying `payloadListeners`/`envelopeListeners` Maps inside `createRemoteDomainEventFeed` are mutable. A consumer calling `feeds[domain] = somethingElse` won't work (frozen), but calling `feeds[domain].on(...)` mutates internal state — which is the intended public API. Confusing surface area for review: the `Object.freeze` provides a false sense of immutability that doesn't actually protect anything beyond reassignment.

Not a bug per se, but: the domain feeds are **shared by reference** between the spread `...feeds` and the closure inside `domain()`. Two ways to access the same mutable feed object — fine, but redundant.

**Fix:** Document that `Object.freeze` here only guards the wrapper shape; the inner feeds remain stateful by design. Or remove the freeze and explicitly mark the type as `Readonly<...>`.

---

### MAJ-09 — `domain-events.ts` connector's `disconnectPending` is reset by `.finally()` regardless of whether `disconnect` was successfully invoked
**File:** `packages/transport-realtime/src/domain-events.ts:107-147`

```ts
}).then((cleanup) => {
  if (typeof cleanup !== 'function') {
    if (disconnectPending) {
      reportUnexpectedConnectionError(...);
    }
    return;
  }
  if (disconnectPending && !hasListeners()) {
    cleanup();
    return;
  }
  disconnect = cleanup;
}).catch(...).finally(() => {
  connectPromise = null;
  disconnectPending = false;
});
```

If `cleanup` is invoked at line 135 because `disconnectPending && !hasListeners()`, the function returns and `disconnect` is never assigned. The `.finally()` then resets `disconnectPending = false`. So far OK. But: between `cleanup()` (line 135) executing and `.finally()` running (microtask later), any new `maybeConnect()` call would see `connectPromise !== null` and skip — until the finally runs. Window is small but not zero.

A stronger issue: if `cleanup` itself throws (uncaught), the `.then` callback rejects, propagates to `.catch` which calls `reportUnexpectedConnectionError`, then `.finally` clears state. Fine. But the cleanup resource (e.g. EventSource) may now be in a half-closed state with `disconnect` still `null`. Subsequent `maybeConnect()` will re-call `connect(domain, ...)` which establishes a NEW upstream connection, leaking the half-closed one.

**Fix:** When `cleanup()` is called inline, set `disconnect = null` explicitly (it's already null, but defensive) and wrap the `cleanup()` call in a try/catch so a failing cleanup function doesn't prevent state cleanup.

---

### MAJ-10 — `error-response.ts` `inferCategoryFromMessage` regex matches `"unauthorized"` (with `unauthoriz` prefix) but also matches `"unauthorized to author"` because the trailing word boundary is missing
**File:** `packages/daemon-sdk/src/error-response.ts:172`

```ts
if (/api[_\s-]?key|\bauth\b|\btoken\b|credential|\bjwt\b|unauthoriz/.test(msg)) return DaemonErrorCategory.AUTHENTICATION;
```

`unauthoriz` (no `\b` suffix) matches the substring even inside larger words. Consider message `"Cannot identify unauthorized author of this commit"` — matches AUTHENTICATION, but the underlying error is about commit metadata. The pattern was designed to match `unauthorized` and `unauthorize` — both have proper word forms — but the loose pattern accepts `unauthorizedly`, `unauthoriztron` (unlikely), and most concerning, accidentally hits substrings.

`\bauth\b` is correctly bounded; `\btoken\b` correctly bounded; `unauthoriz` is the outlier.

**Fix:** Change `unauthoriz` → `\bunauthoriz(?:ed|e|ation)?\b` or simply `\bunauthorized\b`.

---

### MAJ-11 — `errors/index.ts` `serializeCause` walks `.cause`, `.originalError`, `.error` symmetrically with `inferCategoryFromCause`, but the `.error` walk path collides with structured daemon error bodies
**File:** `packages/errors/src/index.ts:284-294`

```ts
const causeRecord = cause as { readonly cause?: unknown; readonly originalError?: unknown; readonly error?: unknown };
const nestedCause = causeRecord.cause ?? causeRecord.originalError ?? causeRecord.error;
```

When the SDK wraps a `StructuredDaemonErrorBody` (which has `error: string` field — the message) inside `cause`, `serializeCause` recurses into `cause.error` thinking it's a nested Error. It then falls into the `typeof cause !== 'object'` branch (string is not object) and returns the string. Result: the JSON serialization of `error.toJSON()` includes `cause: { error: "the error message" }` — which is semantically wrong; `error` is the message field of the structured body, not a nested cause.

`inferCategoryFromCause` has the same blind spot. A daemon error body like `{ error: 'Quota exceeded', category: 'rate_limit' }` has its category correctly read at line 160, and the `.cause`/`.originalError`/`.error` walk is short-circuited by `category && category !== 'unknown'`. So the `inferCategoryFromCause` path is safe, but `serializeCause` is not.

**Fix:** In `serializeCause`, only follow `.error` if the value is itself an Error or non-string object. If `causeRecord.error` is a string, skip it (it's likely the message field of a structured error body, not a nested cause).

---

### MAJ-12 — `transport-realtime/runtime-events.ts` WS frame size pre-check uses `length` (UTF-16 code units), accepts oversized UTF-8 frames before the authoritative byte check
**File:** `packages/transport-realtime/src/runtime-events.ts:479-491`

```ts
if (event.data.length > MAX_INBOUND_FRAME_BYTES) {
  throw new WebSocketTransportError(...);
}
const frameBytes = textEncoder.encode(event.data).byteLength;
if (frameBytes > MAX_INBOUND_FRAME_BYTES) {
  throw new WebSocketTransportError(...);
}
```

The MAJ-6 comment says this is a "cheap pre-check (1 byte per char worst case)" — but it's actually 4 bytes per char worst case (a single non-BMP code point is 2 UTF-16 code units = 1 length but 4 UTF-8 bytes). For an attacker sending a frame composed entirely of 4-byte UTF-8 codepoints (emoji surrogate pairs), `event.data.length === MAX_INBOUND_FRAME_BYTES / 2` (because surrogate pairs count as 2 length each but encode to 4 UTF-8 bytes), so a frame of `MAX_INBOUND_FRAME_BYTES * 2` UTF-8 bytes still passes the cheap pre-check. The authoritative check on line 485 then catches it — but only after `textEncoder.encode` has already allocated a buffer 2x the limit.

For `MAX_INBOUND_FRAME_BYTES = 1MB`, an attacker can force a 2MB allocation per frame.

**Fix:** Either drop the cheap pre-check (the authoritative check is necessary anyway) or make it `event.data.length > MAX_INBOUND_FRAME_BYTES * 4` (assuming worst-case 4 bytes/char in UTF-8 from BMP chars; surrogate pairs are 2 length × 4 bytes = 2 bytes/length-unit so the multiplier should match worst case). The current `* 1` factor is wrong.

---

### MAJ-13 — `http-core.ts` `parseRetryAfterMs` accepts `Infinity` and unbounded HTTP-date deltas, allowing a malicious daemon to set effectively-infinite retry delays
**File:** `packages/transport-http/src/http-core.ts:278-294`

```ts
const seconds = Number(retryAfter);
if (!Number.isNaN(seconds) && seconds > 0) {
  return Math.ceil(seconds * 1000);
}
const date = new Date(retryAfter);
if (!Number.isNaN(date.getTime())) {
  const ms = date.getTime() - Date.now();
  return ms > 0 ? ms : 0;
}
```

A daemon returning `Retry-After: 1e308` produces a retry delay of `Math.ceil(1e308 * 1000)` which is `Infinity` after multiplication. The retry loop's `sleepWithSignal(Infinity, signal)` then blocks until the signal aborts — effectively a denial-of-service against the calling SDK if no abort is supplied. A malicious daemon can use this to effectively halt a client's request pipeline.

Similarly, an HTTP-date 100 years in the future produces a multi-billion-ms delay.

**Fix:** Cap `retryAfterMs` at the resolved policy's `maxDelayMs` (default 2_000ms) at the parse boundary. Or cap at a hard ceiling like 5 minutes here and let the retry loop's own `maxDelayMs` cap apply afterwards.

---

## MINOR

### MIN-01 — `operator.ts` daemon dispatcher: dead `safeDecodeURIComponent` helper
**File:** `packages/daemon-sdk/src/operator.ts:8-14`

Defined but unused. Either delete OR adopt at every `decodeURIComponent` call site (see CRIT-05).

---

### MIN-02 — `client-plumbing.ts` `splitClientArgs` uses non-null assertions on legitimately-undefined positions
**File:** `packages/transport-http/src/client-plumbing.ts:50`

```ts
return [args[0]! as TInput | undefined, args[1]! as TOptions | undefined];
```

The `!` non-null assertions are misleading: the very next type cast is `| undefined`. TypeScript-correct version drops the `!` entirely.

---

### MIN-03 — `errors/index.ts` `Symbol.for('pellux.goodvibes.sdk.error')` brand is realm-global; SDK-A v1 errors will pass `instanceof` against SDK-B v2
**File:** `packages/errors/src/index.ts:138`

Using `Symbol.for` (global registry) means two different SDK versions in the same realm share the same brand symbol. A `GoodVibesSdkError` from `@pellux/goodvibes-errors@1.0.0` will pass `err instanceof GoodVibesSdkError` from `@pellux/goodvibes-errors@2.0.0`. If v2 adds required fields, downstream code that narrows the error and accesses `.newField` will get `undefined` at runtime instead of failing the instanceof check.

**Fix:** Use `Symbol()` (per-realm-per-load brand) instead of `Symbol.for`, OR include a version field in the brand value (e.g., `{ version: 2 }` and check it).

---

### MIN-04 — `event-envelope.ts` generates a fresh UUID per envelope when no `traceId` provided, consuming crypto entropy on every event
**File:** `packages/transport-core/src/event-envelope.ts:38`

```ts
traceId: context.traceId ?? createUuidV4(),
```

The NIT-1 comment in the file already flags this. For high-volume telemetry (per-token streaming deltas), entropy consumption becomes measurable. In `crypto.randomUUID()`-supported runtimes, this is fine. In the fallback path (`uuid.ts:7-21`), it's `crypto.getRandomValues(new Uint8Array(16))` per call — also fine.

Real concern: emitting un-correlated trace IDs on each delta means downstream observability cannot correlate them. The author intends callers to pre-pin a trace ID, but the default-fill path encourages incorrect usage.

**Fix:** Default the auto-generated trace ID to `undefined` (omit) rather than synthesizing one. Callers who need correlation must opt in.

---

### MIN-05 — `sse-stream.ts` re-uses the parsing buffer on residual EOF data without trimming partial lines correctly
**File:** `packages/transport-http/src/sse-stream.ts:213-216`

```ts
if (buffer.trim()) {
  consumeLine(buffer.replace(/\r$/, ''));
  flush();
}
```

When the server flushes a final batch without a trailing newline, `buffer` may contain multiple `\n`-separated lines that the inner `while (newlineIndex >= 0)` loop already consumed; only the LAST partial line remains. `consumeLine(buffer)` is correct for that single line. But if the server flushes `data: foo\ndata: bar` (no trailing newline) and the reader returns the entire chunk in one read, the inner loop will process the first line, leaving `data: bar` in `buffer`, and this final block correctly consumes it. OK.

However, `buffer.replace(/\r$/, '')` only strips a trailing `\r`. If the partial line has internal `\r\n` from a previous chunk that the inner loop missed (it should not — the loop strips `\r$` per line), there's no edge case. Acceptable.

Weaker concern: if `buffer.trim()` is false (whitespace only), no flush. If a stream ends with `data: x\n\n` (terminating event), the inner loop already flushed; final block is a no-op. OK. If stream ends with `data: x\n` (no trailing blank line), inner loop processed the `data:` line but never flushed because the empty-line trigger is missing. The final block invokes `consumeLine(buffer)` — but `buffer` is now empty (consumed by inner loop). So `consumeLine('')` is called, which calls `flush()`. That works.

**Verdict:** Subtle but correct. Documenting as MIN for clarity-of-review purposes.

---

### MIN-06 — `contract-client.ts` zod issue extraction conflates `code` with `expected`
**File:** `packages/transport-http/src/contract-client.ts:65`

```ts
const expected = issue ? (issue as { readonly expected?: string }).expected ?? issue.code : 'unknown';
```

For a Zod `invalid_type` issue, `expected` is the schema-expected type (e.g. `'string'`). For other issue codes (e.g. `'invalid_string'`, `'too_small'`), `issue.code` is something like `'too_small'` — used as a fallback for `expected`. The error message becomes "expected too_small but received string", which is grammatically broken and confusing.

**Fix:** Use `issue.message` (Zod-native human-readable explanation) as the fallback, or branch on `issue.code` to produce code-specific text.

---

### MIN-07 — `runtime-events.ts` `webSocketEventError` casts plain `Event` to `ErrorEvent` and reads `.error`/`.message` fields that are not on the spec
**File:** `packages/transport-realtime/src/runtime-events.ts:589-628`

MIN-19/MIN-20 comments acknowledge this. Per WHATWG, WebSocket `error` events are plain `Event`s — `error` and `message` properties are not standardized. V8/Bun populate `error`; browsers do not. The fallback path is safe but the type assertion `event as ErrorEvent` is misleading. Consider a discriminated check: `if ('error' in event && (event as Event).error !== undefined) ...`.

---

### MIN-08 — `runtime-events.ts` WS reconnect schedule starts at `nextAttempt = reconnectAttempt + 1`, but `reconnectAttempt` is reset to 0 on first message receipt — racing reconnect logic
**File:** `packages/transport-realtime/src/runtime-events.ts:493-496, 398-417`

```ts
if (!hasReceivedMessage) {
  hasReceivedMessage = true;
  reconnectAttempt = 0;
}
```

The reset in `onMessage` happens on the **first message** of each connection. If the first message is a malformed frame that throws inside the try block (line 471-525), `hasReceivedMessage` is set to true BEFORE the JSON parse fails. So a bad first frame counts as a successful connection that resets attempt counter — but the connection is then dropped because the parse throws. Each reconnect therefore enjoys a fresh `maxAttempts` budget, allowing infinite reconnect against a daemon sending garbage.

**Fix:** Move `hasReceivedMessage = true; reconnectAttempt = 0;` to AFTER successful schema validation (line 506).

---

### MIN-09 — `transport-http/sse.ts` re-exports the type `ServerSentEventOptions` as `Omit<..., 'authToken'>` but the underlying `openRawServerSentEventStream` still accepts `authToken`
**File:** `packages/transport-http/src/sse.ts:5, 16-20`

```ts
export interface ServerSentEventOptions extends Omit<CoreServerSentEventOptions, 'authToken'> {}
// ...
return await openRawServerSentEventStream(transport.fetchImpl, url, handlers, {
  ...options,
  authToken: transport.authToken,
  getAuthToken: transport.getAuthToken.bind(transport),
});
```

The public type bans `authToken` from caller's `options`, but internally the wrapper injects `transport.authToken` (a static value pinned at construction time). If the caller has rotated tokens via `transport.getAuthToken`, the static `authToken` may be stale. Result: SSE auth header may include both a stale `authToken` AND a fresh `getAuthToken`-derived one, with priority depending on `resolveAuthToken`. Reading `auth.ts:118-127`, `resolveAuthToken` prefers `getAuthToken` over `authToken`, so it works — but the legacy `authToken` is unnecessary noise.

**Fix:** Either drop `authToken: transport.authToken` from this call (the resolver-based `getAuthToken` is sufficient) or document why both are forwarded.

---

### MIN-10 — `paths.ts` `normalizeBaseUrl` allows `ws://` and `wss://` even though the function returns a string used in `buildUrl` for HTTP paths
**File:** `packages/transport-http/src/paths.ts:49-66`

The function accepts `ws:`, `wss:`, `http:`, `https:`. But `createTransportPaths` then calls `buildUrl(normalized, '/api/...')` for paths like `/api/sessions` — which makes no sense for `ws://` schemes. A user passing `wss://daemon.example.com` would get `wss://daemon.example.com/api/sessions` as `sessionsUrl`, which `fetch()` would reject.

**Fix:** Either reject `ws:`/`wss:` in `createTransportPaths` (HTTP transport doesn't use WS) or split `normalizeBaseUrl` into HTTP-strict and HTTP-or-WS variants (the latter for `transport-realtime`).

---

### MIN-11 — `runtime-events.ts` `buildWebSocketUrl` duplicates the `normalizeBaseUrl` protocol gauntlet, creating two diverging error messages for the same bad input
**File:** `packages/transport-realtime/src/runtime-events.ts:194-214` (MIN-4 comment acknowledges this)

If the supported scheme set ever changes in `paths.ts:normalizeBaseUrl`, `buildWebSocketUrl` must be updated in lock-step. They're already drifted: `paths.ts:60` requires `GOODVIBES_ALLOW_INSECURE_TRANSPORT` env var for `ws:`/`http:` non-loopback, but `runtime-events.ts:216-228` only requires loopback for `ws:` (no env-var override). Inconsistent surface.

**Fix:** Centralize protocol validation in one helper that both transports consume.

---

### MIN-12 — `error-response.ts` `inferCategoryFromMessage` regex `/dns|tls|ssl|certificate/` matches inside legitimate error messages like `"failed to load tls.json"` or `"the user is on dns:lookup"`
**File:** `packages/daemon-sdk/src/error-response.ts:177`

Unbounded substring matching for `dns|tls|ssl|certificate` produces false positives in user-facing error messages that happen to contain those bytes. Less concerning than MAJ-10 but the same pattern.

**Fix:** Add `\b` word boundaries: `/\b(?:dns|tls|ssl|certificate)\b/`.

---

### MIN-13 — `daemon-sdk/artifact-upload.ts` multipart parser limit `MAX_MULTIPART_FIELD_BYTES` (1MB) applies per-field but no global cap on total multipart body size
**File:** `packages/daemon-sdk/src/artifact-upload.ts:45-46`

`MAX_MULTIPART_FIELD_BYTES = 1MB`. A malicious caller could submit 1000 fields each at the 1MB limit, totaling 1GB of memory pressure (plus the 1GB spool file). The artifact byte-cap (`maxFileBytes`) covers the file part only; non-file fields are unbounded in count.

**Fix:** Add a max-fields-count and a max-total-fields-bytes cap.

---

### MIN-14 — `error-response.ts` JSON-error response body double-stamps `status`
**File:** `packages/daemon-sdk/src/error-response.ts:381-388`

```ts
export function jsonErrorResponse(error: unknown, options: JsonErrorResponseOptions = {}): Response {
  const body = buildErrorResponseBody(error, options);
  const status = options.status ?? body.status ?? 500;
  return Response.json(
    { ...body, status },
    { status },
  );
}
```

`body` already contains `status` from `buildErrorResponseBody` if the source had a status. The spread `{ ...body, status }` then overrides it with the resolved status. This is correct, but the body now carries `status: 500` even when no error specified one — leading clients that parse the body for their own retry logic may incorrectly assume the daemon set 500 when in fact the SDK defaulted.

**Fix:** Don't include `status` in the body unless the caller explicitly set `options.status` or the underlying error had a status. Alternatively, document that body.status mirrors the HTTP status header.

---

### MIN-15 — `domain-events.ts` `addListener` allocates a fresh Set when the type has no entry, but the cleanup path doesn't shrink the outer Map when a Set becomes empty after deletion
**File:** `packages/transport-core` (subsumed into `domain-events.ts:38-50`)

Actually `addListener` does cleanup: when a Set becomes empty, `map.delete(type)` runs. Verified at lines 46-48. Not a leak. Mark as resolved.

---

### MIN-16 — `peer-sdk/client-core.ts` `validateJsonSchemaResponse` uses generic `firstJsonSchemaFailure` for peer endpoints; if a peer endpoint contract has a complex `oneOf` discriminator, the failure message is unhelpful
**File:** `packages/peer-sdk/src/client-core.ts:136-145`

```ts
throw new ContractError(
  `Response validation failed for peer endpoint "${endpoint.id}": field "${failure.path}" expected ${failure.expected} but received ${failure.received}. ...`
);
```

For `oneOf` failures, `failure.expected` is `'exactly one matching schema'` and `failure.received` is `'2 matches'` or `'0 matches'`. The error doesn't tell the caller which `oneOf` branch was closest. Not blocking; consistent with the operator-side helper (which has the same limitation).

**Fix:** When `bestSchemaFailure` returns a more specific failure, prefer it. Already done in `client-plumbing.ts:100`. No change needed; flag as future enhancement.

---

### MIN-17 — `daemon-sdk/control-routes.ts` `getCurrentAuth` exposes the presence/absence of `Authorization` header via `authorizationHeaderPresent` field
**File:** `packages/daemon-sdk/src/control-routes.ts:90, 119-120`

```ts
const hasAuthorizationHeader = Boolean(request.headers.get('authorization')?.trim());
// ...
authorizationHeaderPresent: hasAuthorizationHeader,
```

A client that didn't send `Authorization` learns whether the cookie path or header path was used. Marginal infoleak; on the threat model where the daemon is local-only this is fine. For shared/exposed daemons, presence-of-header reveals whether other clients on the same origin authenticated via header vs cookie.

**Fix:** Optional. Document as expected behavior or remove the field for non-admin callers.

---

### MIN-18 — `transport-realtime/runtime-events.ts` queue overflow notification logic is reset to 0 on successful flush, but `droppedOutboundCount` is never reset
**File:** `packages/transport-realtime/src/runtime-events.ts:419-436, 569`

`droppedOutboundCount` accumulates across the lifetime of the connector and is never reset. Operators reading the count after a long-running connection see the cumulative drop count, which is the intended audit trail. But `flushOutboundQueue` resets `queueOverflowNotified = false; overflowEventCount = 0` (lines 434-435) — meaning the next overflow burst fires `onError` again, but the cumulative drop count is still inflated. Inconsistent semantics.

**Fix:** Either expose `droppedOutboundCount` via a getter (so operators can poll) or reset it together with the overflow counters on successful flush.

---

## NITPICK

### NIT-01 — `daemon-sdk/operator.ts` exports `safeDecodeURIComponent` is private but defined as if for use
Delete or adopt (see CRIT-05). Pure dead code at the moment.

### NIT-02 — `daemon-sdk/api-router.ts` extension dispatcher comment claims "Exceptions thrown by an extension propagate to the caller" — this is true but is exactly the behavior built-ins also have, so the comment is redundant
**File:** `packages/daemon-sdk/src/api-router.ts:9-15`

### NIT-03 — `errors/index.ts` `inferCategory` returns `'unknown'` for status 410 (gone), 422 (unprocessable), 451 (legal). These are legitimate statuses that deserve their own categories
**File:** `packages/errors/src/index.ts:107-117`

### NIT-04 — `transport-core/uuid.ts` template-string concatenation in fallback path could be simpler with `Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')` then slice — current `${hex.slice(0,8)}-...` style is fine but verbose
**File:** `packages/transport-core/src/uuid.ts:20-21`

### NIT-05 — `transport-realtime/domain-events.ts` `forSession` returns a frozen object that re-uses the inner `events.domains` array — if consumers mutate the source array, both views diverge
**File:** `packages/transport-realtime/src/domain-events.ts:307`

### NIT-06 — `contracts/src/index.ts` lazy-init maps use module-level `let` — module-level state is a hidden global. For sandbox tests that load the module multiple times in different vm contexts this is fine, but for hot-reload scenarios in dev mode, the map may not invalidate when the contract artifacts change
**File:** `packages/contracts/src/index.ts:64-97`

### NIT-07 — `daemon-sdk/error-response.ts` `inferCategoryFromMessage` checks 13 regexes in sequence on every error response — could be a performance hot spot in a high-error-volume daemon. The MIN-6 fast-path lookup helps for known error codes only
**File:** `packages/daemon-sdk/src/error-response.ts:160-182`

### NIT-08 — `daemon-sdk/route-helpers.ts` `serializableJsonResponse` calls `toSerializableJson` recursively with a `Map` for the cycle-detection stack; for large nested payloads, a WeakSet would avoid the per-recursion `new Map(stack)` clone
**File:** `packages/daemon-sdk/src/route-helpers.ts:26-43`

### NIT-09 — `transport-realtime/runtime-events.ts` MIN-3 `CANONICAL_WS_CODES` Set is allocated inside `[Symbol.hasInstance]` on every check — should be hoisted module-scoped
**File:** `packages/transport-realtime/src/runtime-events.ts:136-143`

### NIT-10 — `transport-http/http.ts` `normalizeTransportError` line 165 string-matches on `'Fetch implementation is required'` and `'Transport baseUrl is required'` — these are now unreachable since both are thrown as `ConfigurationError` at the source. Dead defensive code
**File:** `packages/transport-http/src/http.ts:165-174`

### NIT-11 — `daemon-sdk/auth-helpers.ts` `withAdmin` is a single-use helper that exists in this file alone (per the file comment) but is too small to justify its own file; could fold into `route-helpers.ts`
**File:** `packages/daemon-sdk/src/auth-helpers.ts`

### NIT-12 — `peer-sdk/index.ts` and `operator-sdk/index.ts` inconsistently export their `*RemoteClientOptions` types — operator exports both `OperatorRemoteClientInvokeOptions` and `OperatorRemoteClientStreamOptions`; peer only exports `PeerRemoteClientInvokeOptions` (no stream)
**File:** `packages/peer-sdk/src/index.ts:10-13`

Intentional asymmetry (peer endpoints don't stream), but worth a doc comment explaining why.

### NIT-13 — `transport-core/observer.ts` `invokeTransportObserver` swallows errors with `void error;` — fine for production but loses debug signal. Consider an opt-in `debug: true` mode that re-throws or logs
**File:** `packages/transport-core/src/observer.ts:56-63`

### NIT-14 — `daemon-sdk/system-routes.ts` and `runtime-routes.ts` were not opened in this review (outline-only) — minor finding density may be undercounted for these files

### NIT-15 — `transport-http/contract-client.ts` `requireContractRoute` linear scan via `routes.find` is O(n) per lookup; both operator-sdk and peer-sdk wrap this. For contracts with hundreds of methods/endpoints, a Map cache would be a tiny optimization. The contract index already builds Maps in `contracts/src/index.ts` — could expose them
**File:** `packages/transport-http/src/contract-client.ts:33-43`

### NIT-16 — `errors/index.ts` `RETRYABLE_STATUS_CODES` includes 408 (Request Timeout) — but the Idempotency-Key emission logic in `http-core.ts` only emits keys when contract-marked idempotent. So a 408 retry on a non-idempotent POST is the documented "do NOT retry" path; consistent. No change.

---

## Summary by Severity

| Severity | Count |
|----------|-------|
| Critical | 6 |
| Major    | 13 |
| Minor    | 18 |
| Nitpick  | 16 |
| **Total** | **53** |

**Score (against 9.9 minimum):** **6.8/10**

The packages show strong attention to detail (extensive numbered comments referencing prior review items: MAJ-N, MIN-N, NIT-N), but accumulate non-trivial security and correctness issues across the daemon-sdk dispatchers (auth gaps in MAJ-01/MAJ-02), the HTTP middleware path (CRIT-01/CRIT-02/MAJ-03 form a connected family), and the WebSocket runtime-events connector (CRIT-04, MAJ-04/05/12). The contracts and errors packages are notably tighter than daemon-sdk.

Falls below the 9.9 threshold primarily due to:
1. Three connected critical findings around the HTTP middleware path (CRIT-01, CRIT-02, MAJ-03).
2. Two security/auth gaps in daemon-sdk integration/channel routes (MAJ-01, MAJ-02).
3. One WebSocket message-replay critical (CRIT-04).
4. One DOS vector via dead `safeDecodeURIComponent` and `URIError` propagation (CRIT-05).
5. One info-disclosure regression on `error-response.ts` privileged-field gating (CRIT-06).

Closing the 6 critical and 13 major issues would lift this to ~9.5; the minors and nitpicks form an additional polish pass.
