# Companion Message Routing

This document describes how TUI clients must handle `conversation.followup.companion` events
produced by Problem-2 message routing.

## Background

A companion process may inject a message into the operator's live session without spawning an
agent turn. This is called a "companion follow-up." The SDK routes these through
`POST /api/sessions/:sessionId/messages` with `kind: 'message'` in the request body.

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
- The `kind` field defaults to `'task'` when omitted, preserving existing behavior.
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

## TUI Client Integration (Option B)

The TUI client **must** subscribe to `conversation.followup.companion` events and handle them
as follows:

1. Filter events: only process events where `envelope.sessionId` matches the active session.
2. Append a system-tagged line to the local `ConversationManager`:
   ```
   [Companion] <envelope.body>
   ```
3. Do **not** auto-trigger an orchestrator turn. The operator sees the companion message and
   decides whether to respond.
4. Optionally surface a visual indicator (e.g. a distinct color/prefix) to distinguish companion
   follow-ups from operator messages.

## Envelope Consistency

The `ConversationMessageEnvelope` shape is shared between chat-mode events (`turn.started`,
`turn.completed`) and Problem-2 follow-up events. Chat-mode events use:
- `source: 'companion-chat-user'` for user messages
- `source: 'companion-chat-assistant'` for assistant replies

Problem-2 follow-ups use `source: 'companion-followup'`. The TUI client can discriminate on
the `source` field to render each type appropriately.

## Related session routes

Two other session routes cover adjacent use cases. Use the one that matches your intent:

| Route | Purpose | Triggers agent turn? |
|---|---|---|
| `POST /api/sessions/:id/messages` | Inject a companion follow-up message visible to the operator | No — see above |
| `POST /api/sessions/:id/inputs` | Dispatch a structured intent (tool call, steer, cancel-input, etc.) into the active turn | Depends on the intent kind |
| `GET  /api/sessions/:id/messages` | Fetch the full conversation history for the session | n/a |

`POST /api/sessions/:id/inputs` was restored as an intent-dispatching alias in 0.21.36 (F20) — callers should route structured intents through this endpoint rather than building ad-hoc bodies for `/messages`.

All companion-chat routes (`POST /api/companion/chat/sessions`, `POST /api/companion/chat/sessions/:id/messages`, `GET /api/companion/chat/sessions/:id/messages`, `GET /api/companion/chat/sessions/:id/events`, `GET /api/companion/chat/sessions/:id`, `DELETE /api/companion/chat/sessions/:id`) are registered in the live method catalog as of 0.21.36 (F21). Fetch the catalog at `GET /api/control-plane/methods` to confirm the current registration for your daemon build.
