# Web UI Integration

This is the **companion surface** for web UI applications (browser runtime). See [Runtime Surfaces](./surfaces.md).

Web UI apps cannot run the full agentic surface (tool execution, LSP, MCP, workflows, daemon HTTP) — those require Bun. This guide covers auth, transport, realtime events, and error handling for the companion surface.

Use the narrowest browser entrypoint that matches the app. A normal GoodVibes
WebUI that presents the base knowledge/wiki system should use
`@pellux/goodvibes-sdk/browser/knowledge`; it contains base knowledge routes,
shared session/auth/provider routes, and realtime domains without loading Home
Assistant Home Graph route metadata. Use `@pellux/goodvibes-sdk/browser` only
when the app intentionally needs the complete operator route contract.

```ts
import { createBrowserKnowledgeSdk } from '@pellux/goodvibes-sdk/browser/knowledge';

const sdk = createBrowserKnowledgeSdk({
  baseUrl: 'https://goodvibes.example.com',
});
```

## Recommended model

For a browser-based web UI:
- use the narrowest scoped browser entrypoint
- prefer same-origin cookie-backed auth when hosting the UI with the daemon
- use `sdk.realtime.viaSse()` for dashboards and live status panes
- use `sdk.knowledge.*` or `sdk.operator.invoke(...)` for the base knowledge/wiki methods exposed by the scoped entrypoint
- use `sdk.operator.invoke('control.snapshot', {})` for shared control-plane state
- treat realtime as live update flow, not as the only source of truth

## Choosing browser entrypoints

`@pellux/goodvibes-sdk/browser/knowledge` is the default for the base GoodVibes
WebUI. `@pellux/goodvibes-sdk/browser/homeassistant` is for Home Assistant
panels and includes Home Graph routes without pulling the base knowledge/wiki
route table. `@pellux/goodvibes-sdk/browser` and `@pellux/goodvibes-sdk/web`
remain full all-method browser clients for applications that need the entire
operator contract.

See [public-surface.md](./public-surface.md) for the full entry-point reference.

## Typical web UI pattern

1. Load an initial snapshot with operator APIs.
2. Subscribe to runtime events or telemetry streams.
3. Refresh affected read models when key events arrive.
4. Keep mutation calls on HTTP even when realtime is enabled.

## Error handling

All SDK errors extend `GoodVibesSdkError`. See [Error Kinds](./error-kinds.md) for the full taxonomy.

```ts
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk/errors';

try {
  await sdk.operator.invoke('control.snapshot', {});
} catch (err) {
  if (err instanceof GoodVibesSdkError) {
    switch (err.kind) {
      case 'auth':
        // session expired — redirect to login or refresh token
        break;
      case 'network':
        // transport failure — reconnect SSE/WS or retry
        break;
      case 'service':
        // daemon or upstream service returned 5xx — log and degrade gracefully
        break;
      case 'protocol':
        // SDK/client and daemon disagreed about the wire contract
        break;
      default:
        throw err;
    }
  }
}
```

## Observability

`SDKObserver` and `createConsoleObserver` work from web UI contexts exactly like
from the full surface. Import observer helpers from
`@pellux/goodvibes-sdk/observer` so scoped browser bundles stay narrow. See
[Observability](./observability.md) for the full observer API.

```ts
import { createConsoleObserver } from '@pellux/goodvibes-sdk/observer';

const sdk = createBrowserKnowledgeSdk({
  baseUrl: 'https://goodvibes.example.com',
  observer: createConsoleObserver(),
});
```
