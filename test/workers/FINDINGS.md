# Workers Runtime Findings

**Wave 4 — Cloudflare Workers real-runtime harness**
**Date**: 2026-04-17
**SDK version**: 0.19.6
**Miniflare version**: 4.20260415.0 (latest)
**Entry tested**: `./web` (`dist/web.js`)

---

## Entry Point Decision

**`./web` remains sufficient for normal Worker-hosted operator HTTP clients. A new `./workers` subpath now exists for the optional GoodVibes Worker bridge.**

`dist/web.js` analysis:
- Zero `node:` protocol imports (grep confirmed)
- Zero `Bun.*` API calls (grep confirmed)
- Zero client-side `new WebSocket()` calls in bundle (grep confirmed)
- Zero `EventSource` usage in bundle (grep confirmed)
- `setTimeout` usage in `backoff.ts` is request-scoped and safe (see Timer section)

`dist/workers.js` is intentionally separate from `./web`. It exports `createGoodVibesCloudflareWorker()` for daemon batch proxying, Cloudflare Queue consumers, and scheduled batch ticks. It should not be used as the normal companion HTTP client entry point.

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

`./web` is the correct Workers entry for Worker-hosted operator HTTP clients. The two transport-realtime paths (`viaSse`, `viaWebSocket`) are not Workers-compatible by design — they belong in the browser/RN client layer. Worker-hosted code should use `sdk.operator` (HTTP transport) for normal daemon interactions.

Use `./workers` only when deploying the GoodVibes Worker bridge for optional daemon batch route proxying, Cloudflare Queue tick/job-signal consumers, or scheduled `/api/batch/tick` calls.

---

## wrangler-CLI harness (shares Miniflare 4 runtime)

**Added**: 2026-04-17
**Harness location**: `test/workers-wrangler/wrangler.test.ts`
**wrangler version**: 4.83.0 (pinned)
**Script**: `bun run test:workers:wrangler`
**CI dimension**: `platform-matrix / workers-wrangler`

**Key finding (read first)**: `wrangler dev --local` uses **Miniflare 4 as its local runtime layer** — it is NOT the raw workerd binary. The shared Miniflare 4 package (`miniflare@4.20260415.0`) is used by both the standalone Miniflare harness and this wrangler-CLI harness. Both inject `EventSource` (`globals.EventSource === true` in both). The production EventSource-absence gap cannot be exercised locally; it requires a real CF deployment with `CF_API_TOKEN`.

The value of this harness is exercising wrangler's **esbuild bundling pipeline** and **CLI config surface** (`wrangler.toml`, entry resolution) — not a different runtime. The other 8 assertions exercise real SDK behaviour through the wrangler bundling path.

### What it covers

- Runs the built `./web` entry (`packages/sdk/dist/web.js`) through wrangler's esbuild pipeline and Miniflare 4 runtime (NOT the raw workerd binary)
- Exercises the same 9 assertions across the same 6 endpoints as the Miniflare harness
- Exercises wrangler's esbuild bundling pipeline, distinct from the manual `bunx esbuild` pre-bundle step used in the standalone Miniflare harness
- Subprocess management: spawns `wrangler dev --local --port <random>` in `beforeAll`, polls `/health` until ready (60s timeout), kills in `afterAll`
- No Cloudflare account or API token required — `--local` mode uses Miniflare 4, not the production CF network

### EventSource: same as standalone Miniflare harness (both true)

Both this harness and the standalone Miniflare harness assert `globals.EventSource === true`. This is expected: both use Miniflare 4 internally, which injects EventSource as a simulation artifact.

The `sdk.realtime.viaSse()` path is unavailable from within a production Worker (production workerd does not expose EventSource) — callers must use `sdk.operator` (HTTP transport) instead. This production gap cannot be verified locally.

### What it does NOT cover

- **Actual production deployment**: `wrangler dev --local` uses Miniflare 4 internally — it does NOT exercise the real workerd binary directly. Production Workers run in Cloudflare's edge network with additional trust boundaries, network ACLs, and resource limits. Testing against a real deployment requires `CF_API_TOKEN` and a Cloudflare account — out of scope for this harness.
- **Cold-start latency**: wrangler dev takes 5–15s to boot (first run downloads the workerd binary). CI timeout is 15 min for the job; harness startup timeout is 60s.
- **Workers-specific bindings** (KV, D1, R2, Durable Objects): the SDK does not use these; harness does not configure them.
- **CPU/wall-time limits**: Local workerd does not enforce the 50ms CPU / 30s wall-time limits of the free/paid tiers. High-retry SDK configurations that would be problematic in production are not caught here.

### CI flakiness risk

wrangler dev cold-start timing is non-deterministic. On first run in CI (no binary cache), Miniflare's workerd cache download can take 10–20s. The 60s startup poll timeout accommodates this. Port collisions are avoided by randomising in `[12000, 19999]`. If CI exhibits repeated startup timeouts, consider caching `~/.cache/wrangler` across runs.

### EventSource finding: wrangler dev --local also injects EventSource

**Discovered during harness implementation: 2026-04-17**

`wrangler dev --local` uses **Miniflare 4 as its local runtime layer** — it is not a raw workerd binary. The shared Miniflare 4 package (`miniflare@4.20260415.0`) is used by both the standalone Miniflare harness and the wrangler dev harness. Both inject `EventSource`.

**Implication**: The `EventSource === false` assertion cannot be verified locally. To confirm that production Cloudflare Workers truly lack `EventSource`, a deployed Worker test (requiring `CF_API_TOKEN`) would be needed.

**Corrected assertion in wrangler harness**: `globals.EventSource === true` (matching Miniflare) — with an explanatory comment documenting the reason and the production gap.

**The wrangler harness still provides value** for verifying that the SDK loads and functions correctly through wrangler's esbuild bundling pipeline, which differs from the manual `bunx esbuild` pre-bundle step used in the Miniflare standalone harness. The other 8 assertions exercise real SDK behaviour.
