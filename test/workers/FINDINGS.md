# Workers Runtime Findings

**Wave 4 — Cloudflare Workers real-runtime harness**
**Date**: 2026-04-17
**SDK version**: 0.19.6
**Miniflare version**: 4.20260415.0 (latest)
**Entry tested**: `./web` (`dist/web.js`)

---

## Entry Point Decision

**`./web` entry is sufficient. No new `./workers` subpath required.**

`dist/web.js` analysis:
- Zero `node:` protocol imports (grep confirmed)
- Zero `Bun.*` API calls (grep confirmed)
- Zero client-side `new WebSocket()` calls in bundle (grep confirmed)
- Zero `EventSource` usage in bundle (grep confirmed)
- `setTimeout` usage in `backoff.ts` is request-scoped and safe (see Timer section)

---

## Workers-Specific Capability Gaps

### 1. SSE (`EventSource`) — UNAVAILABLE in production Workers

**Status**: Gap (production runtime)
**Impact**: `sdk.realtime.viaSse()` cannot be called from within a production Worker.

**Miniflare note**: Miniflare 4 injects `EventSource` as part of its local simulation environment. In the `globals` audit, `globals.EventSource === true` under Miniflare. This is a simulation artifact — the real Cloudflare Workers production runtime does NOT expose `EventSource`. Tests reflect Miniflare's behaviour; the production gap is documented here.

`EventSource` is absent in production Workers. Workers are request-response handlers — they can upgrade to WebSocket (server-side) or use `fetch()` for SSE reads via streaming `Response`, but they do not expose the browser's `EventSource` API.

**Consequence**: The `realtime.viaSse()` path in the SDK (which calls `EventSource` internally via the `forSession()` helper) will throw a `ReferenceError` if invoked inside a Worker.

**Workaround**: Do not call `sdk.realtime.viaSse()` from Worker code. SSE subscription belongs in the browser/RN client, not in a Worker. Workers can proxy SSE streams using `fetch()` + streaming `Response`, but that is outside the SDK's current transport surface.

**SDK action needed**: Document this limitation in public `./web` JSDoc when used in Workers context. No code change required.

---

### 2. Client WebSocket (`new WebSocket()`) — UNAVAILABLE for outbound connections

**Status**: Gap (documentation)
**Impact**: `realtime.viaWebSocket()` (browser/RN realtime) is not usable for outbound connections from within a Worker.

Cloudflare Workers can **accept** WebSocket connections via `Response` upgrade (`new WebSocketPair()`), but they cannot **initiate** outbound WebSocket connections using `new WebSocket(url)` in the standard browser sense without using `cloudflare:workers` wrappers.

**Consequence**: The `sdk.realtime.viaWebSocket()` path — which uses `new WebSocket(url)` internally — would fail in Workers.

**Workaround**: Workers that need to forward realtime events to a daemon should use `sdk.operator` (HTTP transport) rather than realtime WebSocket. Realtime subscription belongs in the browser/RN layer.

**SDK action needed**: Document this limitation. No code change required.

---

### 3. `location.origin` — UNAVAILABLE

**Status**: Known, handled
**Impact**: `createWebGoodVibesSdk()` with no `baseUrl` will throw `ConfigurationError`.

Browsers expose `globalThis.location.origin`. Workers do not have a `location` global.

The SDK's `browser.ts` `resolveBrowserBaseUrl()` already throws `ConfigurationError` when `location.origin` is unavailable and no explicit `baseUrl` is provided:

```ts
throw new ConfigurationError(
  'Browser baseUrl is required when location.origin is unavailable.',
);
```

**Consequence**: Workers callers **must** pass an explicit `baseUrl`. This is correct and expected behaviour — the error message is clear.

**SDK action needed**: None. The error is already typed and descriptive.

---

### 4. `setTimeout` / `setInterval` — AVAILABLE, request-scoped

**Status**: Available with caveats
**Impact**: Low

`setTimeout` and `setInterval` are present in Workers, but they are request-scoped. Timer callbacks that run after the request response is sent may be silently dropped by the Workers runtime.

**SDK usage**: The `backoff.ts` `sleepWithSignal()` function uses `setTimeout` for retry delays. This is used by `transport-http` retry logic.

**Analysis**: Retry delays run *within* a request handler (the `await sleepWithSignal(delay)` call blocks the handler's async chain). Since the SDK's `maxAttempts` defaults to 1–3 and delays are bounded by `maxDelayMs` (1.5–2s), these complete well within the Workers CPU time limit (30s default, 50ms CPU for free tier).

**Risk**: If a caller configures very high `maxAttempts` or `maxDelayMs`, retries may exhaust the Workers CPU time limit. The caller is responsible for tuning retry policy for their execution budget.

**Recommendation**: Document that Workers callers should set `retry: { maxAttempts: 1 }` or `retry: false` for latency-sensitive Worker handlers.

---

### 5. `process` and `Buffer` — ABSENT (expected)

**Status**: Absent — correct
**Impact**: None

`process` and `Buffer` are not available in the Workers runtime without `nodejs_compat` flag. Even with `nodejs_compat`, our SDK dist does not reference either. This is confirmed by the zero `node:` imports in `dist/web.js`.

---

### 6. `crypto.subtle` and `crypto.randomUUID` — AVAILABLE

**Status**: Available
**Impact**: Positive

Both are available in Workers without any polyfill. This means future token-crypto work (e.g. PKCE, HMAC request signing) will work without shims.

---

### 7. `fetch`, `Request`, `Response`, `Headers`, `URL` — AVAILABLE

**Status**: Available (native Workers APIs)
**Impact**: Positive

All fetch primitives are native in Workers. The SDK's `transport-http` path uses only these primitives. No polyfill or override needed.

---

## Summary Table

| Feature | Available | SDK Impact | Action |
|---------|-----------|------------|--------|
| `fetch` / `Request` / `Response` | Yes | Transport-http works | None |
| `crypto.subtle` | Yes | Future crypto paths | None |
| `crypto.randomUUID` | Yes | Future token IDs | None |
| `setTimeout` (request-scoped) | Yes* | Retry backoff works | Document CPU budget |
| `EventSource` | **No** | `viaSse()` unavailable | Document gap |
| `new WebSocket()` outbound | **No** | `viaWebSocket()` unavailable | Document gap |
| `location.origin` | **No** | Must pass `baseUrl` explicitly | Error already typed |
| `process` | No | Not used by `./web` | None |
| `Buffer` | No (compat only) | Not used by `./web` | None |

---

## Architecture Verdict

`./web` is the correct Workers entry. No `./workers` subpath is needed at this time. The two transport-realtime paths (`viaSse`, `viaWebSocket`) are not Workers-compatible by design — they belong in the browser/RN client layer. Worker-hosted code should use `sdk.operator` (HTTP transport) for all daemon interactions.

If a Workers-specific realtime transport adapter is added in a future wave (e.g. Durable Objects WebSocket proxy, Workers-native SSE proxy), a new `./workers` subpath with a dedicated `workers.ts` factory should be created following the `browser.ts` / `react-native.ts` pattern.
