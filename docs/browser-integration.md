# Browser Integration

Use `@pellux/goodvibes-sdk/browser` for browser and web UI work.

```ts
import { createBrowserGoodVibesSdk } from '@pellux/goodvibes-sdk/browser';

const sdk = createBrowserGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
});
```

## Auth

Preferred browser auth modes:
- same-origin cookie session
- bearer token when operating cross-origin or inside a custom shell

The HTTP transport always uses `credentials: 'include'`, so same-origin cookie-backed sessions work without additional wiring.

If you are using bearer tokens in the browser, pair the SDK with `createBrowserTokenStore()` or your own `tokenStore` implementation.

## Realtime

For browser UIs:
- use `sdk.realtime.viaSse()` for operator dashboards and status views
- use `sdk.realtime.viaWebSocket()` when you need a persistent duplex connection model

The browser entrypoint also enables conservative defaults for:
- HTTP retry on safe/idempotent requests
- SSE reconnect
- WebSocket reconnect

## Example

```ts
const events = sdk.realtime.viaSse();
const unsubscribe = events.agents.on('AGENT_COMPLETED', (event) => {
  console.log(event);
});
```

## Same-origin recommendation

If the web UI is hosted with the daemon:
- prefer same-origin routing
- prefer cookie-backed session auth
- use SSE for live operator dashboards

If the app is cross-origin:
- use bearer tokens
- validate CORS explicitly
- prefer WebSocket if the deployment path is hostile to SSE
