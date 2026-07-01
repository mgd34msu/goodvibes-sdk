# Companion Wire Protocol (Native Clients)

Native Kotlin (Android) and Swift (iOS) companion apps talk to the GoodVibes daemon directly over the same HTTP and WebSocket contract the TypeScript SDK uses. This page is the shared wire reference for both platforms; the platform guides ([Android](./android-integration.md), [iOS](./ios-integration.md)) cover only what differs (secure storage and HTTP client).

If your app is React Native or Expo based, do not implement this protocol yourself — use [`@pellux/goodvibes-sdk/react-native`](./react-native-integration.md) or [`@pellux/goodvibes-sdk/expo`](./expo-integration.md), which implement it for you.

## Source of truth

- Surface and export references: [Runtime surfaces](./surfaces.md), [Exports](./exports.md), [Public surface](./public-surface.md), [Entry point guide](./packages.md)
- Contract artifacts in this repo: `packages/contracts/artifacts/operator-contract.json` and `packages/contracts/artifacts/peer-contract.json`
- The same artifacts ship on the `@pellux/goodvibes-sdk/contracts/operator-contract.json` and `@pellux/goodvibes-sdk/contracts/peer-contract.json` subpaths.

## Auth

- `POST /login` — username/password login when you need to mint a token.
- `GET /api/control-plane/auth` — verify the current principal.
- Send the bearer token as `Authorization: Bearer <token>` on every HTTP request.

## Runtime events (WebSocket)

Connect to:

```
/api/control-plane/ws?domains=<comma-joined-domains>&clientKind=web
```

`http`/`https` base URLs are upgraded to `ws`/`wss`. `clientKind=web` is always set; `domains` is omitted when no domains are requested.

Send an auth frame as the first message, then receive runtime-event frames for the subscribed domains:

```json
{ "type": "auth", "token": "<bearer-token>", "domains": ["<domain>"] }
```

When W3C trace propagation is enabled, the SDK also adds optional `traceparent` and `tracestate` fields to this frame.

## Method calls (HTTP)

Method invocation uses the HTTP transport (the contract's `transports.http.methodsPath`); the WebSocket transport delivers runtime events. Make method calls over HTTP rather than the WebSocket.

- `GET /api/control-plane/methods` — list the method catalog (useful when debugging or building dynamic tooling).
- `GET /api/control-plane/methods/{method}` — inspect a single method.
- `POST /api/control-plane/methods/{method}/invoke` — invoke a method with a JSON body.
