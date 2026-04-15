# Compatibility

## Runtime support

Current SDK assumptions:
- ESM package consumers
- `fetch` support for HTTP clients
- `WebSocket` support for WebSocket realtime clients

Recommended runtimes:
- Node 18+
- Bun 1.3+
- modern browsers with `fetch`, `ReadableStream`, and `WebSocket`
- React Native / Expo with runtime `fetch` and `WebSocket`
- native Android/iOS clients using the documented HTTP and WebSocket contracts

## SDK scope

This is a TypeScript SDK. The published packages target:
- Node/Bun
- browser/web UI
- React Native
- Expo

Android and iOS companion apps can still use the same platform contracts directly, but Kotlin/Swift package SDKs are outside this repository’s current scope.

## Runtime-neutral packages

These are intended to be safe for Node, browser, and mobile bundlers:
- `@pellux/goodvibes-sdk/contracts`
- `@pellux/goodvibes-sdk/errors`
- `@pellux/goodvibes-sdk/operator`
- `@pellux/goodvibes-sdk/peer`
- `@pellux/goodvibes-sdk`
- `@pellux/goodvibes-sdk/transport-core`
- `@pellux/goodvibes-sdk/transport-http`
- `@pellux/goodvibes-sdk/transport-realtime`

Node-only helper:
- `@pellux/goodvibes-sdk/contracts/node`

## Version alignment

Current SDK version: `0.18.13`

The workspace tracks the SDK release line directly.

## Compatibility maintenance

When shared behavior changes inside this repo:
1. update the SDK source
2. run `bun run sync` if umbrella internals need refresh
3. rerun validation here
