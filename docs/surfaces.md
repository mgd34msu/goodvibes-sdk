# Runtime Surfaces

The `@pellux/goodvibes-sdk` package has two surfaces with different runtime requirements.

See also: [Public Surface reference](./public-surface.md) for the full exports map.

## Full surface (Bun-only)

The full surface provides the agentic harness: tool execution, LSP and tree-sitter intelligence, MCP client/registry, workflow trigger executor, daemon HTTP server, file-based artifact storage, file state and KV caching, git service integration, ACP connection management, and companion pairing.

Imported via the root entry (`@pellux/goodvibes-sdk`) and the following subpaths:
- `./daemon`
- `./operator`
- `./platform/*`

This surface makes direct use of Bun runtime APIs, including `Bun.spawn`, `Bun.file`, `Bun.Glob`, `Bun.which`, `Bun.CryptoHasher`, `Bun.Transpiler`, and `Bun.serve`. It cannot be imported or executed outside a Bun runtime. Attempting to use it in Hermes, a browser, or Node.js will fail at runtime.

**Requires a Bun runtime to import and execute.**

## Companion surface (multi-runtime)

The companion surface provides auth, transport (HTTP/SSE/WebSocket), runtime events, contracts, errors, and observer hooks. It is intentionally runtime-neutral: no Bun globals, no `node:*` imports.

Imported via:
- `./react-native` — React Native (Hermes)
- `./browser` — browser environments
- `./web` — web + service workers (alias of `./browser`)
- `./expo` — Expo (alias of `./react-native`)
- `./auth` — auth client, token stores
- `./errors` — typed error surface
- `./contracts` — ACP contract types and method IDs
- `./transport-core`, `./transport-direct`, `./transport-http`, `./transport-realtime` — transport primitives
- `./peer` — peer ACP client

This surface works on Hermes (React Native / Expo), browser, Cloudflare Workers, and Bun. Metro's bundler (React Native) and standard browser bundlers (Vite, webpack, esbuild) can trace and bundle these entry points without modification.

## Runtimes explicitly supported

| Runtime | Surface | Notes |
|---------|---------|-------|
| Bun | Full + Companion | Dev environment, TUI, daemons, CLI apps |
| Hermes (React Native / Expo) | Companion only | iOS and Android companion apps |
| Browser | Companion only | Web UI apps |
| Cloudflare Workers / workerd / Miniflare 4 | Companion only | Use the `/web` entry point |

## Runtimes NOT supported

- **Node.js** — Not in the consumer list. The published surface does not advertise Node support. The `engines.node` field and `./node` exports entry have been removed as of 0.19.6. If you need Node support, open an issue.

## Enforcement

CI job `platform-matrix` (`rn-bundle` dimension, implemented in `test/rn-bundle-node-imports.test.ts`) verifies that the companion entry point dist bundles — `react-native.js`, `expo.js`, `browser.js`, `web.js`, `auth.js` — contain no `Bun.*` identifiers and no `node:*` imports. Any match fails CI and blocks release.

Future: a per-source lint rule will prevent introduction of `Bun.*` in companion-reachable source files before they reach the bundle stage.
