# iOS Integration

This repo publishes TypeScript packages, but iOS companion teams can still use the same GoodVibes platform contracts directly from Swift.

Use this guide when you are building:
- a native Swift iOS app
- an iOS background/service integration
- an iOS client that needs direct operator, peer, telemetry, or runtime-event access

The source of truth for iOS companion integrations in this repo is:
- the [companion wire protocol](./companion-wire-protocol.md), which documents the shared auth, WebSocket, and method-call contract for native clients
- the contract artifacts `packages/contracts/artifacts/operator-contract.json` and `peer-contract.json` (also published on the `@pellux/goodvibes-sdk/contracts/operator-contract.json` and `@pellux/goodvibes-sdk/contracts/peer-contract.json` subpaths)
- the surface references: [surfaces.md](./surfaces.md), [exports.md](./exports.md), [public-surface.md](./public-surface.md), [packages.md](./packages.md)
- the generated API reference docs ([operator](./reference-operator.md), [peer](./reference-peer.md), [runtime events](./reference-runtime-events.md))
- the Swift example in [ios-swift-quickstart.swift](../examples/ios-swift-quickstart.swift)

## Installation

Native iOS apps consume the JSON contracts rather than the npm package — see the [entry point guide](./packages.md) for the install matrix. If you bundle the contracts from npm, install `@pellux/goodvibes-sdk` (the canonical install command and version live in [Getting started](./getting-started.md#install)) and read them from the `@pellux/goodvibes-sdk/contracts/*.json` subpaths. Pin to the SDK release whose contracts you target.

## Connecting

- **Auth:** bearer token (`Authorization: Bearer <token>`); `POST /login` mints one and `GET /api/control-plane/auth` verifies the current principal.
- **Realtime transport:** WebSocket at `/api/control-plane/ws?domains=<comma-joined>&clientKind=web`, with a `{ "type": "auth", "token": "<token>", "domains": ["<domain>"] }` frame sent as the first message.
- **Method calls:** over HTTP — invoke with `POST /api/control-plane/methods/{method}/invoke`; list the catalog with `GET /api/control-plane/methods`.

See the [companion wire protocol](./companion-wire-protocol.md) for the full reference (URL upgrade rules, optional trace headers, method-catalog endpoints, and contract artifacts).

## iOS app guidance

- store tokens in the iOS Keychain
- use WebSocket for live runtime events and status panes
- reconnect on foreground/resume and reachability changes
- use HTTP APIs for snapshots and mutations
- use WebSocket events for live updates
- use the TypeScript SDK only when your iOS app is actually React Native or Expo based

## Swift example

See [ios-swift-quickstart.swift](../examples/ios-swift-quickstart.swift) for a concrete `URLSession` / `URLSessionWebSocketTask` example.

## If you are using React Native on iOS

Use [react-native-integration.md](./react-native-integration.md) or [expo-integration.md](./expo-integration.md) instead of writing the protocol layer yourself.
