# Entry Point Guide

This SDK publishes one npm package: `@pellux/goodvibes-sdk`.

Everything in this document is a subpath export from that one package, not a separate install.

See [Runtime Surfaces](./surfaces.md) for the two-tier model: full surface (Bun) vs. companion surface (Hermes / browser / Workers).

## Consumer Decision Matrix

| Consumer | Entry point | Install | Read |
|---|---|---|---|
| Bun service (TUI, daemon) | `@pellux/goodvibes-sdk` | `bun add @pellux/goodvibes-sdk` | [Getting started](./getting-started.md) |
| Bun CLI app | `@pellux/goodvibes-sdk` | `bun add @pellux/goodvibes-sdk` | [Getting started](./getting-started.md) |
| Bun server host (daemon routes) | `@pellux/goodvibes-sdk/daemon` | `bun add @pellux/goodvibes-sdk` | [Daemon embedding](./daemon-embedding.md) |
| React Native app (Hermes) | `@pellux/goodvibes-sdk/react-native` | `npm install @pellux/goodvibes-sdk` | [React Native integration](./react-native-integration.md) |
| Expo app | `@pellux/goodvibes-sdk/expo` | `npm install @pellux/goodvibes-sdk` | [Expo integration](./expo-integration.md) |
| Browser SPA | `@pellux/goodvibes-sdk/browser` | `npm install @pellux/goodvibes-sdk` | [Browser integration](./browser-integration.md) |
| Web app / web UI | `@pellux/goodvibes-sdk/web` | `npm install @pellux/goodvibes-sdk` | [Web UI integration](./web-ui-integration.md) |
| Cloudflare Worker batch bridge and provisioning routes | `@pellux/goodvibes-sdk/workers` plus daemon `/api/cloudflare/*` | `npm install @pellux/goodvibes-sdk` | [Daemon batch processing](./daemon-batch-processing.md) |
| iOS native | JSON contracts via `/contracts` | N/A | [iOS integration](./ios-integration.md) |
| Android native | JSON contracts via `/contracts` | N/A | [Android integration](./android-integration.md) |

> `/browser` and `/web` are aliases — same bundle, two names for different mental models.

## Advanced Bun Entry Points

| Entry point | Use it when |
|---|---|
| `@pellux/goodvibes-sdk/platform/pairing/index` | QR code generation, companion token management, and connection info formatting |
| `@pellux/goodvibes-sdk/platform/daemon/port-check` | Port-in-use checking before binding a daemon HTTP server |

All `/platform/*` barrels require a Bun runtime.

## Companion-Safe Entry Points

These entry points contain no Bun globals and bundle cleanly with Metro, Vite, webpack, and esbuild:

| Entry point | Purpose |
|---|---|
| `@pellux/goodvibes-sdk/react-native` | React Native (Hermes) defaults |
| `@pellux/goodvibes-sdk/expo` | Expo alias of `/react-native` |
| `@pellux/goodvibes-sdk/browser` | Browser defaults |
| `@pellux/goodvibes-sdk/web` | Web app alias of `/browser` |
| `@pellux/goodvibes-sdk/workers` | Manual Cloudflare Worker bridge for optional daemon batch queue/tick integration; SDK-owned provisioning is done through daemon `/api/cloudflare/*` routes |
| `@pellux/goodvibes-sdk/auth` | Token storage and auth flows |
| `@pellux/goodvibes-sdk/errors` | Typed error classes |
| `@pellux/goodvibes-sdk/contracts` | Runtime-neutral contract types and method IDs |
| `@pellux/goodvibes-sdk/operator` | Operator/control-plane client |
| `@pellux/goodvibes-sdk/peer` | Peer/distributed-runtime client |
| `@pellux/goodvibes-sdk/transport-core` | Transport/event-feed primitives |
| `@pellux/goodvibes-sdk/transport-http` | HTTP/SSE/auth/retry primitives |
| `@pellux/goodvibes-sdk/transport-realtime` | Runtime-event connectors over SSE and WebSocket |
| `@pellux/goodvibes-sdk/transport-direct` | In-process direct transport |

CI job `platform-matrix` (`rn-bundle` dimension) enforces that companion dist bundles contain no `Bun.*` identifiers and no `node:*` imports. See [Compatibility](./compatibility.md).


## Transport Middleware

The SDK supports Koa-style transport middleware via `sdk.use()`. Middleware wraps every HTTP request/response cycle through the operator and peer transports.

```ts
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';
import type { TransportMiddleware } from '@pellux/goodvibes-sdk/transport-core';

const sdk = createGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3210',
  authToken: process.env.GOODVIBES_TOKEN,
});

// Append middleware at construction time via options.middleware:
// const sdk = createGoodVibesSdk({ ..., middleware: [myMiddleware] });

// Or append after construction:
sdk.use(async (ctx, next) => {
  const start = Date.now();
  console.log('->', ctx.method, ctx.url);
  await next();
  console.log('<-', ctx.response?.status, Date.now() - start, 'ms');
  if (ctx.error) {
    console.error('transport error', ctx.error);
  }
});
```

Middleware runs in order. Each middleware receives a mutable `TransportContext` and a `next()` function. Calling `next()` executes the remainder of the chain (including the real fetch). After `await next()` returns:
- `ctx.response` — the `Response` object (on success)
- `ctx.durationMs` — round-trip time in milliseconds
- `ctx.error` — the thrown error (on failure)

Middleware can:
- inspect or mutate request headers (`ctx.headers`) before the fetch
- inspect the response after `next()` resolves
- short-circuit by not calling `next()` (returns without a response)
- access `ctx.signal`, `ctx.body`, `ctx.options` for per-request data

`TransportMiddleware` and `TransportContext` are exported from `@pellux/goodvibes-sdk/transport-core`.

`composeMiddleware` is also exported for building standalone composed chains outside the SDK:

```ts
import { composeMiddleware } from '@pellux/goodvibes-sdk/transport-core';

const executor = composeMiddleware([loggingMiddleware, retryMiddleware], innerFetch);
```

## Contracts

The `@pellux/goodvibes-sdk/contracts` entry is runtime-neutral. Raw JSON artifacts are available at:
- `@pellux/goodvibes-sdk/contracts/operator-contract.json`
- `@pellux/goodvibes-sdk/contracts/peer-contract.json`

`@pellux/goodvibes-sdk/contracts/node` exports filesystem path helpers for locating JSON contract artifacts on disk. It is a build/tooling convenience, not a runtime surface.

## Entry Point Relationships

- `@pellux/goodvibes-sdk/auth` adds token storage and login/current-auth helpers.
- `@pellux/goodvibes-sdk/contracts` is the typed vocabulary layer (method IDs, endpoint IDs, event maps).
- `@pellux/goodvibes-sdk/errors` defines the shared error model (`GoodVibesSdkError`, `SDKErrorKind`).
- `@pellux/goodvibes-sdk/transport-*` subpaths carry low-level transport behavior.
- `@pellux/goodvibes-sdk/operator` and `/peer` build contract-driven clients on top of transport.
- `@pellux/goodvibes-sdk` (root) composes those pieces into a Bun-optimized full-surface SDK.
- `@pellux/goodvibes-sdk/daemon` is the reusable server/daemon route layer for Bun hosts.
