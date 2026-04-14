# Realtime and Telemetry

Use realtime feeds for live UI updates and operator monitoring.

## Runtime events

```ts
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';

const sdk = createGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3210',
  authToken: process.env.GOODVIBES_TOKEN,
});

const unsubscribe = sdk.realtime.viaSse().agents.on('AGENT_COMPLETED', (event) => {
  console.log(event);
});
```

The realtime layer supports:
- SSE stream resume via `Last-Event-ID`
- SSE reconnect
- WebSocket reconnect
- dynamic auth token resolution during reconnects

## Telemetry APIs

Telemetry APIs live on the operator client:

```ts
const snapshot = await sdk.operator.telemetry.snapshot({ limit: 100 });
const errors = await sdk.operator.telemetry.errors({ severity: 'error' });
```

## OTLP exports

The operator SDK exposes the OTLP-shaped daemon endpoints:

```ts
await sdk.operator.telemetry.otlp.traces();
await sdk.operator.telemetry.otlp.logs();
await sdk.operator.telemetry.otlp.metrics();
```

## Recommended use

- use HTTP operator APIs to load initial snapshots
- use realtime events to keep the UI current
- use telemetry endpoints for historical views, diagnostics, and filtered error/event exploration
- use OTLP endpoints when you are exporting platform telemetry into another observability tool
