# Android Integration

This repo publishes TypeScript packages, but Android companion teams can still use the same GoodVibes platform contracts directly from Kotlin.

Use this guide when you are building:
- a native Kotlin Android app
- an Android service or worker
- an Android client that needs direct operator, peer, telemetry, or runtime-event access

The source of truth for Android companion integrations in this repo is:
- the synced contract artifacts
- the generated API reference docs
- the Kotlin example in [android-kotlin-quickstart.kt](../examples/android-kotlin-quickstart.kt)

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

## Android app guidance

- store tokens in Android Keystore-backed secure storage
- use WebSocket for live runtime events and status panes
- reconnect on foreground/resume and network transitions
- treat HTTP APIs as the source for snapshots and mutation calls
- treat WebSocket events as the source for live updates
- use the TypeScript SDK only when your Android app is actually React Native or Expo based

## Kotlin example

See [android-kotlin-quickstart.kt](../examples/android-kotlin-quickstart.kt) for a concrete OkHttp-based example.

## If you are using React Native on Android

Use [react-native-integration.md](./react-native-integration.md) or [expo-integration.md](./expo-integration.md) instead of writing the protocol layer yourself.
