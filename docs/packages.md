# Package Guide

# Package Guide

## Decision Matrix

| Package | Use it when | Avoid it when |
| --- | --- | --- |
| `@goodvibes/sdk` | You want the main TypeScript SDK with auth, operator, peer, and realtime in one place. | You only need one narrow surface. |
| `@goodvibes/operator-sdk` | You only need operator/control-plane APIs. | You also need peer/distributed-runtime APIs and don’t mind the umbrella package. |
| `@goodvibes/peer-sdk` | You only need pairing, heartbeat, work pull, and work completion flows. | You need the full operator surface too. |
| `@goodvibes/daemon-sdk` | You are embedding daemon routes into another TypeScript server host. | You are writing a normal client integration. |
| `@goodvibes/contracts` | You need typed ids, manifests, and generated request/response/event maps. | You only need high-level clients. |
| `@goodvibes/errors` | You want structured error classes or fields. | You only consume the umbrella SDK and don’t catch errors directly. |
| `@goodvibes/transport-http` | You need low-level HTTP/SSE/auth/retry primitives. | You want a ready-made operator or peer client. |
| `@goodvibes/transport-realtime` | You need low-level runtime-event connectors. | You can use `sdk.realtime` instead. |
| `@goodvibes/transport-direct` | You are composing local/in-process clients. | You are talking to a remote daemon over HTTP or WebSocket. |
| `@goodvibes/transport-core` | You need transport/event-feed building blocks. | You want ready-made clients. |

## Recommended Starting Points

- Web or browser UI:
  start with `@goodvibes/sdk/web` or `@goodvibes/sdk/browser`
- Node/Bun service:
  start with `@goodvibes/sdk/node`
- React Native / Expo companion app:
  start with `@goodvibes/sdk/react-native` or `@goodvibes/sdk/expo`
- Server embedding:
  start with `@goodvibes/daemon-sdk`
- Tooling or codegen against the protocol:
  start with `@goodvibes/contracts`

## Package Relationships

- `@goodvibes/contracts` is the typed vocabulary layer.
- `@goodvibes/errors` defines the shared error model.
- `@goodvibes/transport-*` packages carry low-level transport behavior.
- `@goodvibes/operator-sdk` and `@goodvibes/peer-sdk` build contract-driven clients on top.
- `@goodvibes/sdk` composes those pieces into environment-specific entrypoints.
- `@goodvibes/daemon-sdk` is the reusable server/daemon route layer.
