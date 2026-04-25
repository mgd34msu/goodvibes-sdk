# Companion Message Routing

This document describes how TUI clients must handle companion main-chat
messages surfaced through `conversation.followup.companion` and the runtime
`COMPANION_MESSAGE_RECEIVED` event.

## Background

A companion process may inject a message into the operator's live session
without spawning WRFC or agent work. This is called a companion main-chat
message. The SDK routes these through `POST /api/sessions/:sessionId/messages`
with `kind: 'message'` in the request body.

The message is not an agent task. It is appended to the target session and
emitted as `COMPANION_MESSAGE_RECEIVED`; a TUI that wants live companion chat
delegates that event into `Orchestrator.handleUserInput()`, which starts a
normal LLM turn in the same path as terminal input.

## API

```http
POST /api/sessions/:sessionId/messages
Content-Type: application/json

{ "body": "Hello from companion", "kind": "message" }
```

Response:

```json
{ "messageId": "<uuid>", "routedTo": "conversation" }
```

- No agent is spawned.
- The live TUI should treat the event as operator chat and start a normal LLM
  turn.
- The `kind` field defaults to `'task'` when omitted, preserving existing behavior.
- `kind: 'followup'` explicitly queues a session follow-up through the broker.
- Unknown `kind` values return `400 INVALID_KIND`.

## Control-Plane Event

The daemon publishes a `conversation.followup.companion` event via the gateway. The event
payload is a `ConversationMessageEnvelope`:

```ts
{
  sessionId: string;        // target operator session
  messageId: string;        // stable UUID for this message
  body: string;             // message text
  source: 'companion-followup';
  timestamp: number;        // epoch ms
  metadata?: Record<string, unknown>;
}
```

The same payload is also emitted on the runtime bus as
`COMPANION_MESSAGE_RECEIVED`. The runtime event includes the envelope fields
above plus `metadata` when the surface supplied it.

## TUI Client Integration

The TUI client should subscribe to `COMPANION_MESSAGE_RECEIVED` on the runtime
bus and handle it as follows:

1. Filter events: only process events where `envelope.sessionId` matches the active session.
2. Delegate to the active orchestrator instead of spawning an agent or WRFC chain.

```ts
runtimeBus.on('COMPANION_MESSAGE_RECEIVED', ({ payload }) => {
  if (payload.sessionId !== activeSessionId) return;
  void orchestrator.handleUserInput(payload.body, undefined, {
    origin: {
      source: payload.source,
      messageId: payload.messageId,
      metadata: payload.metadata,
    },
  });
});
```

`handleUserInput()` appends the user message to the conversation view and emits
the resulting turn events. Clients should not separately append the message
before calling the orchestrator, or the message will render twice.

For clients that construct `Orchestrator` directly, pass the shared session id
in `OrchestratorOptions.sessionId` when the orchestrator should emit turn events
under that same session id. If omitted, the orchestrator generates a private
runtime session id.

## ntfy Chat Replies

The `goodvibes-chat` ntfy route uses this same companion message path. The SDK
queues a one-shot ntfy reply target before emitting `COMPANION_MESSAGE_RECEIVED`.
To make reply correlation durable, TUI clients should pass
`payload.messageId` into `handleUserInput()` as `origin.messageId`; the SDK then
matches `TURN_SUBMITTED` and `TURN_COMPLETED` by message id and publishes only
the matching model response back to the originating ntfy topic.

The SDK retains a prompt-text fallback for older clients that have not forwarded
origin metadata yet, but new clients should not rely on prompt text as the
primary correlation key.

The ntfy provider runtime subscribes to route topics as live ingress. It starts
from the current Unix timestamp rather than `since=latest`, because ntfy uses
`since=latest` to return a cached message. Reconnects resume from the last
successfully handled ntfy message id and suppress duplicate ids.

## Envelope Consistency

The `ConversationMessageEnvelope` shape is shared between chat-mode events (`turn.started`,
`turn.completed`) and Problem-2 follow-up events. Chat-mode events use:
- `source: 'companion-chat-user'` for user messages
- `source: 'companion-chat-assistant'` for assistant replies

Session-message follow-ups use `source: 'companion-followup'`. ntfy chat uses
`source: 'ntfy-chat'`. The TUI client can discriminate on the `source` field or
metadata to render surface-specific styling, but both paths should use the same
orchestrator turn entry point when the user-facing behavior is live chat.

## Related session routes

Two other session routes cover adjacent use cases. Use the one that matches your intent:

| Route | Purpose | Triggers agent turn? |
|---|---|---|
| `POST /api/sessions/:id/messages` | Inject a companion main-chat message visible to the operator | Yes, when the live TUI delegates `COMPANION_MESSAGE_RECEIVED` to `handleUserInput()` |
| `POST /api/sessions/:id/inputs` | Dispatch a structured intent (tool call, steer, cancel-input, etc.) into the active turn | Depends on the intent kind |
| `GET  /api/sessions/:id/messages` | Fetch the full conversation history for the session | n/a |

`POST /api/sessions/:id/inputs` was restored as an intent-dispatching alias in 0.21.36 (F20) — callers should route structured intents through this endpoint rather than building ad-hoc bodies for `/messages`.

All companion-chat routes (`POST /api/companion/chat/sessions`, `POST /api/companion/chat/sessions/:id/messages`, `GET /api/companion/chat/sessions/:id/messages`, `GET /api/companion/chat/sessions/:id/events`, `GET /api/companion/chat/sessions/:id`, `DELETE /api/companion/chat/sessions/:id`) are registered in the live method catalog as of 0.21.36 (F21). Fetch the catalog at `GET /api/control-plane/methods` to confirm the current registration for your daemon build.
