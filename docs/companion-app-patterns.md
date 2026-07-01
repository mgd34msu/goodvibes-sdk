# Companion App Patterns

GoodVibes companion apps should talk to the platform, not try to host the platform.

That applies to:
- browser dashboards
- internal web UIs
- React Native mobile apps
- Expo apps
- native Android/iOS apps using the same protocol directly

## Recommended Architecture

Use the platform this way:
- HTTP for snapshots and mutations
- SSE or WebSocket for live updates
- secure token storage for mobile and service clients
- periodic snapshot refresh around major lifecycle changes like foreground/resume

## Companion Flow Example

The shape below is the same on every companion surface: bootstrap state over
HTTP, subscribe to a live event channel, and re-read the snapshot on resume.
This example uses the browser entrypoint; React Native is identical except it
uses `createReactNativeGoodVibesSdk` and prefers `sdk.realtime.viaWebSocket()`.

```ts
import { createBrowserGoodVibesSdk } from '@pellux/goodvibes-sdk/browser';

// `token` and `render()` are provided by your app; omit `authToken` for
// same-origin cookie-backed sessions.
const sdk = createBrowserGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  authToken: token,
});

async function refresh(): Promise<void> {
  // The snapshot is the authoritative copy of state.
  render(await sdk.operator.control.snapshot());
}

// 1. HTTP bootstrap — load the snapshot before opening any stream.
await refresh();

// 2. Subscribe — keep a live event channel open. Use viaSse() for operator
//    dashboards; use sdk.realtime.viaWebSocket() on mobile/React Native.
const events = sdk.realtime.viaSse();
const unsubscribe = events.agents.on('AGENT_COMPLETED', () => {
  // Treat realtime as a wake-up signal, then re-read authoritative state.
  void refresh();
});

// 3. Snapshot refresh on resume — events can be missed while backgrounded, so
//    re-read state on foreground/resume and after network transitions.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refresh();
});

// Tear down the subscription when the view is destroyed.
function dispose(): void {
  unsubscribe();
}
```

## Typical Companion Flows

### Operator dashboard

- load `control.snapshot`
- load focused read models like approvals/tasks/sessions
- subscribe to runtime events
- refresh affected read models when key events arrive

### Mobile companion app

- bootstrap from a persisted token
- load initial account/control/session state over HTTP
- keep a lightweight WebSocket event channel open while the app is active
- reload snapshots on foreground/resume
- for true remote chat sessions, store provider/model on the companion chat session (`POST /api/companion/chat/sessions` to create, or `PATCH /api/companion/chat/sessions/:id` to update) instead of calling the global `/api/models/current` route

### Provider/model selection

Companion clients have two different model-selection modes:

- **Shared TUI session** — call `PATCH /api/models/current`. This intentionally changes the daemon/TUI current model and emits `MODEL_CHANGED`. Use only when the companion is acting as a remote control for the operator's TUI session.
- **True remote chat session** — pass `provider` and `model` when creating the companion chat session (`POST /api/companion/chat/sessions`), or update them later with `PATCH /api/companion/chat/sessions/:id`. This keeps the selection local to that remote session; the daemon still hosts runtime context such as working directory and tools, but the global TUI model is not affected.

> **Disambiguation:** `PATCH /api/models/current` and `PATCH /api/companion/chat/sessions/:id` are different routes with different scopes. The first is global (TUI-wide); the second is session-local. Most companion apps should use the session-local route.

### Approvals/status pane

- poll `approvals.list()` on a sane cadence
- also refresh after meaningful completion/failure events
- treat realtime as “wake-up” signals, not the only copy of state

## What Not To Do

- do not model the app entirely as raw event streams with no snapshot APIs
- do not rely on string parsing for errors
- do not assume mobile streaming behavior matches desktop/browser behavior
- keep companion-app behavior implemented in the SDK itself, not in an external host repo

## Next Reads

- [Companion Message Routing](./companion-message-routing.md) — the `kind` taxonomy (`message` / `task` / `followup`) for companion-originated messages, including when to use each kind
- [Authentication](./authentication.md) — token storage and refresh patterns for companion clients
- [Runtime Surfaces](./surfaces.md) — surface-specific constructors and capabilities
