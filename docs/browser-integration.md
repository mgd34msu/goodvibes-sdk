# Browser Integration

This is the **companion surface** for browser runtimes. See [Runtime Surfaces](./surfaces.md).

Browser apps cannot run the full agentic surface (tool execution, LSP, MCP, workflows, daemon HTTP) — those require Bun. This guide covers auth, transport, realtime events, and error handling for the companion surface.

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

## Error handling

All SDK errors extend `GoodVibesSdkError`. See [Error Kinds](./error-kinds.md) for the full taxonomy.

```ts
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk/errors';

try {
  await sdk.operator.control.snapshot();
} catch (err) {
  if (err instanceof GoodVibesSdkError) {
    switch (err.kind) {
      case 'auth':
        // session expired — redirect to login or refresh token
        break;
      case 'network':
        // transport failure — reconnect SSE/WS or retry
        break;
      case 'server':
        // daemon returned 5xx — log and degrade gracefully
        break;
      default:
        throw err;
    }
  }
}
```

## Observability

`SDKObserver` is the right mechanism for dev-time logging in browser consoles. `createConsoleObserver` outputs structured events to `console.debug`, making it easy to trace SDK activity during development. See [Observability](./observability.md) for the full observer API.

```ts
import { createConsoleObserver } from '@pellux/goodvibes-sdk';

const sdk = createBrowserGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  observer: createConsoleObserver(),
});
```
