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

### Approvals/status pane

- poll `approvals.list()` on a sane cadence
- also refresh after meaningful completion/failure events
- treat realtime as “wake-up” signals, not the only copy of state

## What Not To Do

- do not model the app entirely as raw event streams with no snapshot APIs
- do not rely on string parsing for errors
- do not assume mobile streaming behavior matches desktop/browser behavior
- do not carry SDK-only fixes that should actually live in `goodvibes-tui`
