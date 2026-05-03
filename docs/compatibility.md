# Compatibility

## Supported Runtimes

See [Runtime Surfaces](./surfaces.md) for the full two-tier model.

| Runtime | Surface | Notes |
|---|---|---|
| **Bun ≥1.0** | Full + Companion | TUI, daemons, CLI apps, and all companion entry points |
| **Hermes (React Native / Expo)** | Companion only | iOS and Android companion apps via `/react-native` and `/expo` |
| **Modern browsers** | Companion only | Browser and web UI apps via `/browser` and `/web` |
| **Cloudflare Workers / workerd / Miniflare 4** | Companion only | Use `/web` for normal operator HTTP clients. Use `/workers` only for manual GoodVibes Worker bridge deployments that proxy daemon batch routes and handle queue/scheduled ticks. SDK-owned Cloudflare provisioning is exposed by daemon `/api/cloudflare/*` routes and uses the official Cloudflare API from the Bun daemon side. |

## Node.js is NOT Supported

Node.js is not in the supported consumer list. The published surface does not advertise a Node runtime target. If you need Node support, open an issue.

Use `createGoodVibesSdk` from the root entry (`@pellux/goodvibes-sdk`) on Bun for full-surface hosts.

## Runtime Requirements

All surfaces:
- ESM package consumers
- `fetch` support for HTTP clients
- `WebSocket` support for WebSocket realtime clients

Full surface (Bun only) additionally requires:
- `Bun.spawn`, `Bun.file`, `Bun.Glob`, `Bun.which`, `Bun.CryptoHasher`, `Bun.Transpiler`, `Bun.serve`

Attempting to import the full surface in Hermes, a browser, or any non-Bun runtime will fail at runtime.

## Engine Policy

Published packages declare `node >=20` because the runtime-neutral packages and
package-manager/tooling metadata should install on current LTS Node releases.
That declaration does not make Node a supported full-surface runtime; the full
surface remains Bun-only.

The private workspace root requires Node 22 for CI and release tooling. GitHub
Actions jobs use Node 22 deliberately while the published package floor remains
lower for consumers of runtime-neutral entry points.

## Companion Bundle Guard

CI job `platform-matrix` (`rn-bundle` dimension, implemented in `test/rn-bundle-node-imports.test.ts`) verifies that the companion entry point dist bundles — `react-native.js`, `expo.js`, `browser.js`, `web.js`, `workers.js`, `auth.js` — contain no `Bun.*` identifiers and no `node:*` imports. Any match fails CI and blocks release.

This is the enforcement mechanism for the companion surface guarantee.

## Runtime-Neutral Entry Points

These companion-safe entry points contain no Bun-only imports and bundle cleanly with Metro, Vite, webpack, and esbuild. Use the runtime-specific entries only in the runtimes named by their docs:

- `@pellux/goodvibes-sdk/contracts`
- `@pellux/goodvibes-sdk/errors`
- `@pellux/goodvibes-sdk/operator`
- `@pellux/goodvibes-sdk/peer`
- `@pellux/goodvibes-sdk/auth`
- `@pellux/goodvibes-sdk/transport-core`
- `@pellux/goodvibes-sdk/transport-http`
- `@pellux/goodvibes-sdk/transport-realtime`
- `@pellux/goodvibes-sdk/browser`
- `@pellux/goodvibes-sdk/web`
- `@pellux/goodvibes-sdk/workers`
- `@pellux/goodvibes-sdk/react-native`
- `@pellux/goodvibes-sdk/expo`

Note: `@pellux/goodvibes-sdk/contracts/node` exports filesystem path helpers for locating JSON contract artifacts on disk. It is a build/tooling convenience only, not a runtime surface, and is not safe for mobile or browser bundlers.

## Version Alignment

The workspace tracks the SDK release line directly. See [CHANGELOG.md](../CHANGELOG.md) for release history.

## Compatibility Maintenance

When shared behavior changes inside this repo:
1. Update the SDK source.
2. Refresh the umbrella package internals if needed (see [Testing and Validation](./testing-and-validation.md)).
3. Rerun validation: `bun run validate`.
