# Web UI cross-origin deployment: same-origin bundle serving (primary) + an allowlisted CORS path (secondary)

- **Date:** 2026-07-07
- **Status:** Accepted and implemented in this change.
- **Scope:** SDK daemon HTTP layer only — two opt-in capabilities plus their config
  keys. No operator-method / verb-catalog changes. The loopback default posture and
  every route's auth/admin scoping are unchanged.

## Context (reality, verified)

The daemon is a custom Bun-fetch router (`platform/daemon/http/router.ts`, danger
listener `platform/daemon/http-listener.ts`, boot factory `platform/daemon/boot.ts`).
Before this change the daemon emitted no `Access-Control-Allow-Origin`, had no
`OPTIONS` handler, and served no static bundle: the only HTML surface was the inline
control-plane debug page (`control-plane/gateway-web-ui.ts`), not an SPA host. A
browser hosted at a different origin/machine than the daemon therefore could not
reach it — this blocked every cross-machine and mobile journey.

A separate `web.*` config block (a distinct browser surface on its own port) already
exists but is not the daemon; serving the app bundle from the daemon's own origin is
what makes the browser same-origin policy disappear.

## Decision

Resolve the cross-origin problem with BOTH mechanisms, same-origin serving as the
primary path:

1. **PRIMARY — same-origin bundle serving behind an opt-in capability.** The daemon
   serves a built web UI bundle at `/` when `controlPlane.webui.serve` is on and
   `controlPlane.webui.bundleDir` points at the build directory. Because the bundle
   and the API share an origin, the browser's same-origin policy is a non-issue. The
   loopback default is preserved: serving is an explicit opt-in, never auto-enabled by
   network host mode. Static assets serve with correct content types and caching
   (hashed `/assets/*` immutable, the `index.html` shell `no-cache`), with SPA
   fallback to `index.html` for unknown navigation routes. API routes keep precedence:
   any `/api/*` (and `/login`, `/webhook/*`, `/task`, the OpenAI-compatible prefix) is
   dispatched to the API and never served as a static file. The bundle is public
   (served without a token); the app itself token-authenticates its API calls, so no
   wire data leaks from serving static files.

2. **SECONDARY — OPTIONS preflight + `Access-Control-Allow-*` gated by an explicit
   allowlist.** When `controlPlane.cors.enabled` is on, the daemon answers OPTIONS
   preflight and emits `Access-Control-Allow-Origin` / `-Methods` / `-Headers` /
   `-Credentials` ONLY for origins listed in `controlPlane.cors.allowedOrigins`. There
   is no wildcard: the matched origin is echoed back, `Access-Control-Allow-Credentials`
   rides only with a specific origin, `Authorization` is included in the allowed
   headers so the bearer-token flow works cross-origin, and `Vary: Origin` is always
   set so caches never serve an allow-origin to the wrong origin. A non-allowlisted
   origin is refused honestly (403 on preflight with no allow-origin; an actual request
   is processed server-side but carries no allow-origin, so the browser blocks the
   read). This path is for the Vite dev server (`localhost:5173` → daemon) and any
   deliberately separate-origin / reverse-proxy topology.

Both are wire-compatible with `tailscale serve`: it fronts the single daemon origin
with HTTPS, so bundle + API arrive same-origin over an HTTPS hostname with zero CORS.
That is the supported cross-machine path; the CORS allowlist is the explicit opt-in
for dev and non-proxied cross-origin, not the primary remote path.

## Alternatives rejected

- **CORS-allowlist only** — leaves the daemon unable to self-serve the bundle, forces
  every deployment through a separate static host, and cross-origin browser auth over a
  preflighted request is fragile. Kept as the secondary path, not the whole answer.
- **Reverse-proxy only (no daemon serving)** — pushes deployment complexity onto the
  user and still needs a bundle host. `tailscale serve` as a proxy is supported but
  should not be the only way to reach the browser.

## Auth model note

Same-origin carries the operator bearer token normally. The cross-origin path does not
weaken per-verb admin scoping: CORS controls only which browser origin may read a
response; every route still enforces its own auth and admin gate. Credentials are
allowlist-gated and never wildcarded.

## Config surface added

| Key | Type | Default | Meaning |
|---|---|---|---|
| `controlPlane.webui.serve` | boolean | `false` | Serve the built bundle same-origin from the daemon. |
| `controlPlane.webui.bundleDir` | string | `''` | Directory holding `index.html` + assets. Empty disables serving. |
| `controlPlane.cors.enabled` | boolean | `false` | Answer OPTIONS preflight and emit `Access-Control-Allow-*` for allowlisted origins. |
| `controlPlane.cors.allowedOrigins` | string | `''` | Comma-separated explicit origin allowlist (e.g. `http://localhost:5173`). Empty refuses every cross-origin request. |

Serving and CORS logic live in `platform/daemon/http/webui-serving.ts`; the router
integrates them as a pre-auth step in `handleRequest`.
