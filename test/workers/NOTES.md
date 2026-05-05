# Workers Runtime Notes

This file is the design record for the Workers runtime harnesses:

- `test/workers/workers.test.ts` exercises the SDK `./web` entry through
  Miniflare.
- `test/workers-wrangler/wrangler.test.ts` exercises the same runtime surface
  through `wrangler dev --local`.

The `./web` entry is the Workers-compatible entry for Worker-hosted operator
HTTP clients. It has no `node:` imports, no `Bun.*` usage, no client-side
WebSocket construction, and no `EventSource` dependency. The separate
`./workers` entry is only for the optional GoodVibes Worker bridge.

## Runtime Capabilities

| Runtime capability | Worker support | SDK behavior |
| --- | --- | --- |
| `fetch`, `Request`, `Response`, `Headers`, `URL` | Available | HTTP transport works directly |
| `crypto.subtle`, `crypto.randomUUID` | Available | Token and signing paths can use native crypto |
| `setTimeout`, `setInterval` | Available, request-scoped | Retry delays must fit the request budget |
| `location.origin` | Unavailable | Worker callers must pass `baseUrl` explicitly |
| `EventSource` | Unavailable in production Workers | Do not call `sdk.realtime.viaSse()` inside a Worker |
| Outbound browser-style `new WebSocket(url)` | Unavailable in production Workers | Do not call browser/RN realtime WebSocket inside a Worker |
| `process`, `Buffer` | Unavailable unless `nodejs_compat` is enabled | The `./web` entry does not require either |

## Local Harness Caveat

Miniflare 4 injects `EventSource` in its local simulation environment.
`wrangler dev --local` also runs through Miniflare 4, so both local harnesses
observe `globals.EventSource === true`. Production Cloudflare Workers do not
expose browser `EventSource`; verifying that production absence requires a real
Cloudflare deployment and account token, which is outside this local harness.

The harnesses therefore assert the local Miniflare value while comments and docs
state the production runtime boundary.

## Entry Point Decision

Use `./web` for normal Worker-hosted daemon clients.

Use `./workers` only for the GoodVibes Worker bridge: daemon batch route proxying,
Cloudflare Queue tick/job-signal consumers, or scheduled `/api/batch/tick` calls.
