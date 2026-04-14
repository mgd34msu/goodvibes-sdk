# iOS Integration

This repo publishes TypeScript packages, but iOS companion teams can still use the same GoodVibes platform contracts directly from Swift.

Use this guide when you are building:
- a native Swift iOS app
- an iOS background/service integration
- an iOS client that needs direct operator, peer, telemetry, or runtime-event access

The source of truth for iOS companion integrations in this repo is:
- the synced contract artifacts
- the generated API reference docs
- the Swift example in [ios-swift-quickstart.swift](../examples/ios-swift-quickstart.swift)

## Recommended auth

- bearer token

## Recommended realtime transport

- WebSocket

## Native integration approach

Use:
- `POST /login` if you need username/password login
- `GET /api/control-plane/auth` to verify the current principal
- `/api/control-plane/ws` for runtime events and method calls
- `/api/control-plane/methods` to inspect the method catalog when debugging or building dynamic tooling

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
