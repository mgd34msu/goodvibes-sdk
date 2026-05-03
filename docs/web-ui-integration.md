# Web UI Integration

This is the **companion surface** for web UI applications (browser runtime). See [Runtime Surfaces](./surfaces.md).

Web UI apps cannot run the full agentic surface (tool execution, LSP, MCP, workflows, daemon HTTP) — those require Bun. This guide covers auth, transport, realtime events, and error handling for the companion surface.

Use `@pellux/goodvibes-sdk/web` for web UI applications. It exposes the
companion-safe browser runtime surface with web UI defaults.

```ts
import { createWebGoodVibesSdk } from '@pellux/goodvibes-sdk/web';

const sdk = createWebGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
});
```

## Recommended model

For a browser-based web UI:
- use the web entrypoint
- prefer same-origin cookie-backed auth when hosting the UI with the daemon
- use `sdk.realtime.viaSse()` for dashboards and live status panes
- use `sdk.operator.telemetry.*` for history, filters, and OTLP export views
- use `sdk.operator.control.snapshot()` and specific list endpoints for initial page state
- treat realtime as live update flow, not as the only source of truth

## When to use the browser entrypoint directly

`@pellux/goodvibes-sdk/browser` and `@pellux/goodvibes-sdk/web` are equivalent surfaces. Use:
- `@pellux/goodvibes-sdk/web` when your mental model is "web UI"
- `@pellux/goodvibes-sdk/browser` when you want the generic browser label

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

`SDKObserver` and `createConsoleObserver` work from web UI contexts exactly like from the full surface. They are imported from `@pellux/goodvibes-sdk` root, which is companion-safe. See [Observability](./observability.md) for the full observer API.

```ts
import { createConsoleObserver } from '@pellux/goodvibes-sdk';

const sdk = createWebGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  observer: createConsoleObserver(),
});
```
