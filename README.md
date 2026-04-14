# GoodVibes SDK

TypeScript SDK workspace for GoodVibes operator, peer, transport, realtime, contract, and daemon integration surfaces.

Current foundation source:
- SDK version: `0.18.12`
- Product version: `0.18.2`
- Operator methods: `213`
- Operator events: `29`
- Peer endpoints: `6`

## Scope

This repo publishes the TypeScript client and daemon integration layers for the GoodVibes platform.

Use it when you need to:
- call operator or peer APIs from Node, Bun, browser, React Native, or Expo
- consume realtime runtime events over SSE or WebSocket
- embed reusable GoodVibes daemon route modules in another TypeScript host
- build companion apps and web UIs against the GoodVibes platform surface

This repo does **not** try to run the full GoodVibes platform on mobile devices. Companion apps talk to the platform remotely over the same contracts the SDK uses.

## Install

This is one npm package with subpath exports.

```bash
npm install @pellux/goodvibes-sdk
```

Alternate registry:
- npmjs primary package: `@pellux/goodvibes-sdk`
- GitHub Packages mirror: `@mgd34msu/goodvibes-sdk`

GitHub Packages install requires scoped registry mapping:

```ini
@mgd34msu:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

Then import only the subpath entrypoints you need:

```ts
import { createOperatorSdk } from '@pellux/goodvibes-sdk/operator';
import { createRemoteRuntimeEvents } from '@pellux/goodvibes-sdk/transport-realtime';
```

## Entry Points

- `@pellux/goodvibes-sdk/contracts`
  Runtime-neutral contract artifacts, ids, and generated typed method/endpoint/event maps.
- `@pellux/goodvibes-sdk/auth`
  Token storage helpers plus login/current-auth flows layered over the operator client.
- `@pellux/goodvibes-sdk/errors`
  Structured SDK, transport, and daemon error types.
- `@pellux/goodvibes-sdk/daemon`
  Embeddable daemon route contracts, handler builders, and dispatchers for server hosts.
- `@pellux/goodvibes-sdk/transport-core`
  Shared transport/event-feed primitives.
- `@pellux/goodvibes-sdk/transport-direct`
  In-process direct transport shell for embedded/local integration.
- `@pellux/goodvibes-sdk/transport-http`
  HTTP, JSON, path, auth, retry, and SSE primitives.
- `@pellux/goodvibes-sdk/transport-realtime`
  Runtime-event connectors over SSE and WebSocket.
- `@pellux/goodvibes-sdk/operator`
  Contract-driven operator/control-plane client.
- `@pellux/goodvibes-sdk/peer`
  Contract-driven peer/distributed-runtime client.
- `@pellux/goodvibes-sdk`
  Umbrella SDK plus runtime-specific helpers for Node, browser/web UI, React Native, and Expo.

## Runtime Entry Points

- `@pellux/goodvibes-sdk`
  Lowest-friction umbrella entrypoint when you want operator, peer, auth, and realtime together.
- `@pellux/goodvibes-sdk/node`
  Node/Bun defaults for HTTP retry and realtime reconnect.
- `@pellux/goodvibes-sdk/browser`
  Generic browser defaults.
- `@pellux/goodvibes-sdk/web`
  Browser/web UI alias when your mental model is “web app”.
- `@pellux/goodvibes-sdk/react-native`
  React Native defaults with WebSocket-first realtime.
- `@pellux/goodvibes-sdk/expo`
  Expo-flavored React Native alias.

## Quick Start

Prerequisite: you already have a reachable GoodVibes daemon/operator endpoint. The SDK is a client for the platform; it does not start the platform for you.

### Node / Bun

```ts
import { createNodeGoodVibesSdk } from '@pellux/goodvibes-sdk/node';
import { createMemoryTokenStore } from '@pellux/goodvibes-sdk/auth';

const sdk = createNodeGoodVibesSdk({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3210',
  tokenStore: createMemoryTokenStore(process.env.GOODVIBES_TOKEN ?? null),
});

const snapshot = await sdk.operator.control.snapshot();
console.log(snapshot);
```

Login and token persistence:

```ts
const login = await sdk.auth.login({
  username: 'alice',
  password: 'secret',
});

console.log(login.token);
console.log(await sdk.auth.current());
```

### Browser web UI

```ts
import { createWebGoodVibesSdk } from '@pellux/goodvibes-sdk/web';

const sdk = createWebGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
});

const unsubscribe = sdk.realtime.viaSse().agents.on('AGENT_COMPLETED', (event) => {
  console.log(event);
});
```

### React Native

```ts
import { createReactNativeGoodVibesSdk } from '@pellux/goodvibes-sdk/react-native';

const sdk = createReactNativeGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  authToken: token,
});

const unsubscribe = sdk.realtime.runtime().agents.on('AGENT_COMPLETED', (event) => {
  console.log(event);
});
```

### Expo

```ts
import { createExpoGoodVibesSdk } from '@pellux/goodvibes-sdk/expo';

const sdk = createExpoGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  authToken: token,
});
```

## Auth and Realtime Guidance

- Browser web UI on the same origin:
  prefer session auth or a token store-backed browser client, and use SSE for live dashboards.
- Server-side Node/Bun integrations:
  prefer bearer tokens and SSE.
- React Native / Expo companion apps:
  prefer bearer tokens in secure storage and WebSocket realtime.
- Native Kotlin / Swift companion apps:
  use the same HTTP and WebSocket contract reference documents; this repo itself publishes TypeScript packages.

## Realtime

The SDK supports both realtime transports:
- SSE via `sdk.realtime.viaSse()`
- WebSocket via `sdk.realtime.viaWebSocket()`

Recommended defaults:
- Node / Bun: SSE
- Browser web UI: SSE for same-origin operator sessions, WebSocket when you need a persistent duplex channel
- React Native: WebSocket
- Expo: WebSocket
- Native Android / iOS: WebSocket when using the protocol directly

The transport layers support:
- HTTP retry/backoff
- SSE replay via `Last-Event-ID`
- SSE reconnect
- WebSocket reconnect
- dynamic auth token resolution for long-lived clients

## Contracts

The default `@pellux/goodvibes-sdk/contracts` entry is runtime-neutral and safe for Node, browser, and mobile builds.

Raw JSON artifacts are still exported:
- `@pellux/goodvibes-sdk/contracts/operator-contract.json`
- `@pellux/goodvibes-sdk/contracts/peer-contract.json`

Node-only artifact-path helpers are available from:
- `@pellux/goodvibes-sdk/contracts/node`

Auth helpers are also available as a narrow subpath:
- `@pellux/goodvibes-sdk/auth`

## Docs

- [Docs index](./docs/README.md)
- [Getting started](./docs/getting-started.md)
- [Package guide](./docs/packages.md)
- [Authentication](./docs/authentication.md)
- [Browser integration](./docs/browser-integration.md)
- [Web UI integration](./docs/web-ui-integration.md)
- [React Native integration](./docs/react-native-integration.md)
- [Expo integration](./docs/expo-integration.md)
- [Android integration](./docs/android-integration.md)
- [iOS integration](./docs/ios-integration.md)
- [Daemon embedding](./docs/daemon-embedding.md)
- [Realtime and telemetry](./docs/realtime-and-telemetry.md)
- [Retries and reconnect](./docs/retries-and-reconnect.md)
- [Companion app patterns](./docs/companion-app-patterns.md)
- [Error handling](./docs/error-handling.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Compatibility](./docs/compatibility.md)
- [Release and publishing](./docs/release-and-publishing.md)
- [Testing and validation](./docs/testing-and-validation.md)
- [Operator API reference](./docs/reference-operator.md)
- [Peer API reference](./docs/reference-peer.md)
- [Runtime events reference](./docs/reference-runtime-events.md)

## Examples

- [Node operator quickstart](./examples/operator-http-quickstart.mjs)
- [Peer quickstart](./examples/peer-http-quickstart.mjs)
- [Realtime quickstart](./examples/realtime-events-quickstart.mjs)
- [Auth and token store quickstart](./examples/auth-login-and-token-store.ts)
- [Retry and reconnect quickstart](./examples/retry-and-reconnect.mjs)
- [Companion approvals feed](./examples/companion-approvals-feed.ts)
- [Browser web UI quickstart](./examples/browser-web-ui-quickstart.ts)
- [React Native quickstart](./examples/react-native-quickstart.ts)
- [Expo quickstart](./examples/expo-quickstart.tsx)
- [Android Kotlin quickstart](./examples/android-kotlin-quickstart.kt)
- [iOS Swift quickstart](./examples/ios-swift-quickstart.swift)
- [Daemon embedding quickstart](./examples/daemon-fetch-handler-quickstart.ts)
- [Direct transport quickstart](./examples/direct-transport-quickstart.ts)

## Maintainers

- Contributor workflow: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Security process: [SECURITY.md](./SECURITY.md)
