# Entry Point Guide

This SDK publishes one npm package: `@pellux/goodvibes-sdk`.

Everything else in this document is a subpath export from that one package, not a separate install.

## Decision Matrix

| Package | Use it when | Avoid it when |
| --- | --- | --- |
| `@pellux/goodvibes-sdk` | You want the main TypeScript SDK with auth, operator, peer, and realtime in one place. | You only need one narrow surface. |
| `@pellux/goodvibes-sdk/auth` | You only need token storage or auth helper flows. | You want the full composed client already wired up. |
| `@pellux/goodvibes-sdk/operator` | You only need operator/control-plane APIs. | You also need peer/distributed-runtime APIs and don’t mind the umbrella package. |
| `@pellux/goodvibes-sdk/peer` | You only need pairing, heartbeat, work pull, and work completion flows. | You need the full operator surface too. |
| `@pellux/goodvibes-sdk/daemon` | You are embedding daemon routes into another TypeScript server host. | You are writing a normal client integration. |
| `@pellux/goodvibes-sdk/contracts` | You need typed ids, manifests, and generated request/response/event maps. | You only need high-level clients. |
| `@pellux/goodvibes-sdk/errors` | You want structured error classes or fields. | You only consume the umbrella SDK and don’t catch errors directly. |
| `@pellux/goodvibes-sdk/transport-http` | You need low-level HTTP/SSE/auth/retry primitives. | You want a ready-made operator or peer client. |
| `@pellux/goodvibes-sdk/transport-realtime` | You need low-level runtime-event connectors. | You can use `sdk.realtime` instead. |
| `@pellux/goodvibes-sdk/transport-direct` | You are composing local/in-process clients. | You are talking to a remote daemon over HTTP or WebSocket. |
| `@pellux/goodvibes-sdk/transport-core` | You need transport/event-feed building blocks. | You want ready-made clients. |

## Recommended Starting Points

- Web or browser UI:
  start with `@pellux/goodvibes-sdk/web` or `@pellux/goodvibes-sdk/browser`
- Node/Bun service:
  start with `@pellux/goodvibes-sdk/node`
- React Native / Expo companion app:
  start with `@pellux/goodvibes-sdk/react-native` or `@pellux/goodvibes-sdk/expo`
- Server embedding:
  start with `@pellux/goodvibes-sdk/daemon`
- Tooling or codegen against the protocol:
  start with `@pellux/goodvibes-sdk/contracts`

## Package Relationships

- `@pellux/goodvibes-sdk/auth` adds token storage and login/current-auth helpers.
- `@pellux/goodvibes-sdk/contracts` is the typed vocabulary layer.
- `@pellux/goodvibes-sdk/errors` defines the shared error model.
- `@pellux/goodvibes-sdk/transport-*` subpaths carry low-level transport behavior.
- `@pellux/goodvibes-sdk/operator` and `@pellux/goodvibes-sdk/peer` build contract-driven clients on top.
- `@pellux/goodvibes-sdk` composes those pieces into environment-specific entrypoints.
- `@pellux/goodvibes-sdk/daemon` is the reusable server/daemon route layer.
