# Home Assistant Integration

Home Assistant support is an SDK-owned daemon surface. The Home Assistant
custom integration lives in a separate project, but it should treat the daemon
as the source of truth for pairing, prompts, tool catalogs, agent tools, replies,
and Home Assistant REST-backed operations.

The SDK defaults this surface off. Hosts must enable both the feature flag and
the surface config before Home Assistant ingress or delivery is active:

```json
{
  "featureFlags": {
    "homeassistant-surface": "enabled"
  },
  "surfaces": {
    "homeassistant": {
      "enabled": true
    }
  }
}
```

The implementation follows Home Assistant's first-class integration patterns:
config flows create config entries, device registry entries represent services
or devices, integration service actions are registered at setup time, the REST
API uses bearer tokens and JSON payloads, and the WebSocket API is available for
event streaming when the Home Assistant integration needs a live connection.

References:

- [Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/)
- [Home Assistant WebSocket API](https://developers.home-assistant.io/docs/api/websocket/)
- [Home Assistant config flows](https://developers.home-assistant.io/docs/core/integration/config_flow/)
- [Home Assistant device registry](https://developers.home-assistant.io/docs/device_registry_index/)
- [Home Assistant service actions](https://developers.home-assistant.io/docs/dev_101_services/)

## SDK Contract

### Feature Flag

`homeassistant-surface` gates the Home Assistant surface. It is disabled by
default and is also enabled by the legacy `omnichannel-surface-adapters` alias.

### Config Keys

| Key | Default | Purpose |
|---|---:|---|
| `surfaces.homeassistant.enabled` | `false` | Enables Home Assistant ingress and delivery. |
| `surfaces.homeassistant.instanceUrl` | `""` | Home Assistant base URL, for example `http://homeassistant.local:8123`. |
| `surfaces.homeassistant.accessToken` | `""` | Home Assistant long-lived access token or `goodvibes://` secret URI for daemon-to-HA REST calls. |
| `surfaces.homeassistant.webhookSecret` | `""` | Shared secret required on HA-to-daemon webhook calls. |
| `surfaces.homeassistant.defaultConversationId` | `"goodvibes"` | Default conversation/route id for Home Assistant-originated prompts. |
| `surfaces.homeassistant.deviceId` | `"goodvibes-daemon"` | Stable daemon device identifier presented to Home Assistant setup flows. |
| `surfaces.homeassistant.deviceName` | `"GoodVibes Daemon"` | Display name for the daemon device. |
| `surfaces.homeassistant.eventType` | `"goodvibes_message"` | Home Assistant event type used for daemon-to-HA deliveries. |
| `surfaces.homeassistant.remoteSessionTtlMs` | `1200000` | Idle TTL for daemon-owned Home Assistant remote sessions. Default is 20 minutes. |

Supported environment fallbacks:

- `HOMEASSISTANT_URL`, `HOME_ASSISTANT_URL`, `HA_URL`
- `HOMEASSISTANT_ACCESS_TOKEN`, `HOME_ASSISTANT_ACCESS_TOKEN`, `HA_ACCESS_TOKEN`
- `HOMEASSISTANT_WEBHOOK_SECRET`, `HOME_ASSISTANT_WEBHOOK_SECRET`,
  `HA_GOODVIBES_WEBHOOK_SECRET`

### Manifest and Setup Discovery

The Home Assistant integration should call daemon channel endpoints during
config flow setup. The most useful endpoints are:

| Endpoint | Purpose |
|---|---|
| `GET /api/channels/setup/homeassistant` | Setup schema, secret targets, and external setup steps. |
| `GET /api/channels/accounts/homeassistant` | Account/config posture and safe secret-source summaries. |
| `GET /api/channels/capabilities/homeassistant` | Surface capabilities. |
| `GET /api/channels/tools/homeassistant` | Home Assistant surface tools. |
| `GET /api/channels/agent-tools/homeassistant` | Tool definitions safe to expose into GoodVibes agent runtimes. |
| `GET /api/channels/actions/homeassistant` | Operator actions. |
| `POST /api/channels/actions/homeassistant/homeassistant-manifest` | Daemon/device manifest consumed by the HA integration. |
| `POST /api/channels/actions/homeassistant/homeassistant-status` | Checks HA API reachability and token posture. |
| `GET /api/homeassistant/health` | Authenticated surface health, capabilities, endpoints, and default remote-session TTL. |
| `POST /api/homeassistant/conversation` | Submit an Assist-style conversation turn and wait for the final assistant reply. |
| `POST /api/homeassistant/conversation/stream` | Submit a conversation turn and receive SSE `ack`, `progress`, `final`, or `error` events. |
| `POST /api/homeassistant/conversation/cancel` | Cancel a running Home Assistant conversation by `agentId` or known `messageId`. |

All daemon API calls require normal daemon authentication. The inbound webhook
below additionally requires the Home Assistant webhook secret because webhook
routes are evaluated before daemon bearer auth. The `/api/homeassistant/*`
conversation routes use normal daemon bearer auth and are the preferred path
for Home Assistant Assist conversation agents.

No Home Assistant ingress path starts WRFC review/fix chains. The SDK forces
Home Assistant work to use direct responders with `reviewMode: "none"`,
`executionProtocol: "direct"`, and `dangerously_disable_wrfc: true`.

### Home Assistant Assist Conversations

Home Assistant conversation agents should use:

```text
POST /api/homeassistant/conversation
Authorization: Bearer <daemon operator token>
```

Canonical body:

```json
{
  "message": "is the garage door open?",
  "conversationId": "assist-home",
  "messageId": "ha-assist-msg-123",
  "userId": "ha-user-id",
  "displayName": "Home Assistant",
  "context": {
    "language": "en",
    "deviceId": "voice-pe-1",
    "areaId": "garage"
  },
  "timeoutMs": 120000
}
```

The response resolves only when the agent finishes, fails, is cancelled, or the
wait timeout is reached:

```json
{
  "ok": true,
  "acknowledged": true,
  "messageId": "ha-assist-msg-123",
  "conversationId": "assist-home",
  "sessionId": "sess-1234",
  "routeId": "route-1234",
  "agentId": "agent-1234",
  "mode": "direct",
  "newSession": false,
  "sessionExpired": false,
  "status": "completed",
  "assistant": {
    "text": "The garage door is closed.",
    "speechText": "The garage door is closed.",
    "status": "completed",
    "toolCallsMade": 1
  }
}
```

`message`, `prompt`, `text`, `body`, or `task` can carry the prompt text.
`providerId`, `modelId`, and `tools` are optional; if omitted, daemon/session
defaults apply. This is intentionally different from companion-app remote chat:
Home Assistant does not expose provider/model selection, so the daemon resolves
the active/default routing.

`POST /api/homeassistant/conversation` returns the final response directly and
does not also publish a `goodvibes_message` event by default. Set
`"publishEvent": true` only when the Home Assistant integration also wants the
normal event-bus delivery for that same turn.

The daemon creates Home Assistant sessions as remote sessions, not shared TUI
sessions. It reuses the session for the same Home Assistant conversation until
`surfaces.homeassistant.remoteSessionTtlMs` elapses with no activity. The default
is 20 minutes. After TTL expiry the daemon closes the old session and starts a
fresh one, preventing stale Home Assistant turns from inheriting an old, long
transcript.

For live progress, use:

```text
POST /api/homeassistant/conversation/stream
```

The response is `text/event-stream` with `ack`, `progress`, `final`, and `error`
events. `final.data.assistant.text` and `final.data.assistant.speechText` carry
the text Home Assistant should return from a `ConversationEntity`.

To cancel a running turn:

```json
POST /api/homeassistant/conversation/cancel
{
  "agentId": "agent-1234"
}
```

The cancel endpoint also accepts a `messageId` while the daemon still has the
message-to-agent correlation in memory.

### Home Assistant to GoodVibes Webhook

The webhook route remains available for Home Assistant service actions and
automations that cannot call authenticated daemon API routes directly:

```text
POST /webhook/homeassistant
```

Required auth header, one of:

```text
x-goodvibes-homeassistant-secret: <webhookSecret>
x-goodvibes-webhook-secret: <webhookSecret>
Authorization: Bearer <webhookSecret>
```

Canonical prompt body:

```json
{
  "type": "prompt",
  "message": "turn on the kitchen lights and explain what changed",
  "conversationId": "home",
  "deviceId": "goodvibes-daemon",
  "entityId": "sensor.goodvibes_last_message",
  "areaId": "kitchen",
  "userId": "ha-user-id",
  "displayName": "Home Assistant",
  "messageId": "ha-msg-123",
  "providerId": "openai",
  "modelId": "gpt-5.5",
  "tools": ["homeassistant_state", "homeassistant_call_service"]
}
```

`message`, `prompt`, `text`, or `task` can carry the prompt text. `providerId`,
`modelId`, and `tools` are optional; if omitted, daemon/session defaults apply.
The adapter creates or updates a route binding with
`surfaceKind: "homeassistant"`, submits the prompt through the shared session
broker, starts a direct non-WRFC responder when work is needed, and queues the
final reply through the normal Home Assistant event pipeline.

For Assist conversation agents, use `/api/homeassistant/conversation` so Home
Assistant can return the assistant reply directly in the conversation call. The
webhook returns an acknowledgement and delivers the final response through the
configured `goodvibes_message` event.

Control commands are supported through the same webhook:

```text
status <run-or-agent-or-session-id>
cancel <run-or-agent-id>
retry <run-or-agent-id>
```

### GoodVibes to Home Assistant

Daemon replies and automation output are delivered to Home Assistant by firing
the configured event type through the Home Assistant REST API:

```text
POST /api/events/<surfaces.homeassistant.eventType>
Authorization: Bearer <Home Assistant long-lived access token>
```

The event payload is JSON and includes:

```json
{
  "source": "goodvibes",
  "emittedAt": "2026-04-26T00:00:00.000Z",
  "type": "message",
  "title": "GoodVibes",
  "body": "Assistant reply or agent status",
  "status": "completed",
  "jobId": "job-1",
  "runId": "run-1",
  "agentId": "agent-1",
  "sessionId": "sess-1",
  "routeId": "route-1",
  "surfaceId": "homeassistant",
  "externalId": "home",
  "messageId": "gv:agent-1",
  "replyToMessageId": "ha-msg-123",
  "conversationId": "home",
  "speechText": "Assistant reply or agent status",
  "metadata": {
    "threadId": "thread-1",
    "channelId": "area.kitchen",
    "inboundMessageId": "ha-msg-123",
    "conversationId": "home",
    "attachments": []
  }
}
```

The Home Assistant integration should listen for this event type and update
entities, diagnostics, notifications, or repairs from the event data. The
`replyToMessageId`, `conversationId`, `sessionId`, `routeId`, and `agentId`
fields are stable SDK-owned correlation fields for matching a Home Assistant
service call or webhook prompt to the final GoodVibes event.

## SDK Home Assistant Tools

The SDK exposes Home Assistant tools to operators and agents. Side-effecting
tools are intentionally explicit.

| Tool | Action | Side effects | Purpose |
|---|---|---:|---|
| `homeassistant_manifest` | `homeassistant-manifest` | no | Returns daemon/device setup contract. |
| `homeassistant_status` | `homeassistant-status` | no | Checks configured HA API reachability and token posture. |
| `homeassistant_states` | `homeassistant-list-states` | no | Lists entity states with optional `domain`, `query`, and `limit`. |
| `homeassistant_state` | `homeassistant-get-state` | no | Reads one entity state. |
| `homeassistant_services` | `homeassistant-list-services` | no | Lists callable Home Assistant services. |
| `homeassistant_call_service` | `homeassistant-call-service` | yes | Calls a service such as `light.turn_on`. |
| `homeassistant_fire_event` | `homeassistant-fire-event` | yes | Fires an event on the Home Assistant event bus. |
| `homeassistant_render_template` | `homeassistant-render-template` | no | Renders a Home Assistant template. |

Operator-only Home Assistant actions also include
`homeassistant-publish-goodvibes-event`, which publishes a GoodVibes-shaped
message event to the configured Home Assistant event type. It is not exposed as
an agent tool because normal daemon replies already use the channel reply
pipeline.

## Home Assistant Project Handoff

The Home Assistant integration should implement:

1. A `manifest.json` with `config_flow: true`.
2. A config flow that collects:
   - Daemon base URL.
   - Daemon bearer token.
   - Webhook secret.
   - Optional Home Assistant long-lived token setup guidance for enabling
     daemon-to-HA tools and event delivery.
3. A config entry and device registry entry representing the GoodVibes daemon
   as a service device.
4. Services/actions registered at integration setup time:
   - `goodvibes.prompt`
   - `goodvibes.run_agent`
   - `goodvibes.status`
   - `goodvibes.cancel`
   - `goodvibes.call_tool`
5. A Home Assistant Assist conversation platform using `ConversationEntity`.
   Submit prompts to `POST /api/homeassistant/conversation`, pass
   `conversation_id` as `conversationId`, wait for the response, and return
   `assistant.speechText`/`assistant.text` from the entity handler.
6. Event listener for `surfaces.homeassistant.eventType`, default
   `goodvibes_message`.
7. Entities for:
   - Daemon connectivity/status.
   - Last GoodVibes reply.
   - Active session/agent id.
   - Last error.
   - Optional tool catalog count/version.
8. Optional WebSocket or SSE client support:
   - Home Assistant can use its own WebSocket APIs internally.
   - For GoodVibes daemon progress, the integration can call
     `/api/homeassistant/conversation/stream` and consume SSE events.
   - For broader daemon events, the integration can subscribe to the daemon
     control-plane event stream when it needs live updates beyond event bus
     deliveries.

Do not reimplement GoodVibes routing, tool catalogs, or provider/model
resolution in the Home Assistant project. The HA integration should consume the
SDK/daemon endpoints above and keep Home Assistant-specific UI/entity/service
logic on the HA side.
