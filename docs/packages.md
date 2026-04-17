# Entry Point Guide

This SDK publishes one npm package: `@pellux/goodvibes-sdk`.

Everything in this document is a subpath export from that one package, not a separate install.

See [Runtime Surfaces](./surfaces.md) for the two-tier model: full surface (Bun) vs. companion surface (Hermes / browser).

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
