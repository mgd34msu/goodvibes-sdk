# Troubleshooting

## `ConfigurationError: GoodVibes baseUrl is required`

Pass `baseUrl` explicitly, or use the browser/web entrypoint in a runtime where `location.origin` exists.

## `Fetch implementation is required`

Your runtime does not provide `fetch`, and you did not pass `options.fetch`.

Use:
- Bun ≥1.0 (full surface), Hermes via React Native/Expo (companion), modern browsers (companion)
- or inject `fetch` manually

See [Runtime Surfaces](./surfaces.md) for the full surface breakdown.

## `WebSocket implementation is required`

This affects:
- `sdk.realtime.viaWebSocket()`
- React Native / Expo realtime

Inject `WebSocketImpl` when your runtime does not expose `globalThis.WebSocket`.

## 401 / 403 failures

Check:
- bearer token value
- session cookie presence
- required scopes
- auth mode expected by the endpoint

Structured errors expose:
- `status`
- `category`
- `source`
- `hint`

## SSE works poorly on mobile

That is expected on some mobile stacks. Prefer WebSocket for React Native, Expo, Android, and iOS clients.

## Browser CORS or cookie issues

If you are using session cookies:
- prefer same-origin hosting
- ensure the daemon is reachable on the same origin as the web UI

If you are cross-origin:
- prefer bearer-token auth

## Contract drift concerns

Run:

```bash
bun run refresh:contracts
bun run validate
```

The validation pipeline checks contract, transport, error, daemon, and docs sync.

## Realtime reconnect loops

Check:
- whether your token expired after the initial connection
- whether your reconnect policy is enabled
- whether your runtime supports streaming properly
- whether the server or proxy preserves SSE/WebSocket semantics

If the client is mobile, prefer WebSocket over SSE.

## Read-only token resolver surprises

If `sdk.auth.setToken(...)` throws a configuration error, you created the SDK with `getAuthToken` only.

Pass `tokenStore` if the SDK needs to mutate token state.
