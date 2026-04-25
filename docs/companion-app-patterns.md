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
- for true remote chat sessions, store provider/model on the companion chat session (`POST` or `PATCH /api/companion/chat/sessions/:id`) instead of calling the global `/api/providers/current` route

### Provider/model selection

Companion clients have two different model-selection modes:

- Shared TUI session: call `PATCH /api/providers/current`. This intentionally changes the daemon/TUI current model and emits `MODEL_CHANGED`.
- True remote chat session: pass `provider` and `model` when creating the companion chat session, or update them with `PATCH /api/companion/chat/sessions/:id`. This keeps the selection local to that remote session while the daemon still hosts runtime context such as working directory and tools.

### Approvals/status pane

- poll `approvals.list()` on a sane cadence
- also refresh after meaningful completion/failure events
- treat realtime as “wake-up” signals, not the only copy of state

## What Not To Do

- do not model the app entirely as raw event streams with no snapshot APIs
- do not rely on string parsing for errors
- do not assume mobile streaming behavior matches desktop/browser behavior
- keep companion-app behavior implemented in the SDK itself, not in an external host repo
