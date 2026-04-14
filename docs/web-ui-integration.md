# Web UI Integration

Use `@goodvibes/sdk/web` for web UI applications.

```ts
import { createWebGoodVibesSdk } from '@goodvibes/sdk/web';

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

`@goodvibes/sdk/browser` and `@goodvibes/sdk/web` are equivalent surfaces. Use:
- `@goodvibes/sdk/web` when your mental model is “web UI”
- `@goodvibes/sdk/browser` when you want the generic browser label

## Typical web UI pattern

1. Load an initial snapshot with operator APIs.
2. Subscribe to runtime events or telemetry streams.
3. Refresh affected read models when key events arrive.
4. Keep mutation calls on HTTP even when realtime is enabled.
