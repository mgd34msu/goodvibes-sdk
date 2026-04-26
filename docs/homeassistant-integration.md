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

All daemon API calls require normal daemon authentication. The inbound webhook
below additionally requires the Home Assistant webhook secret because webhook
routes are evaluated before daemon bearer auth.

### Home Assistant to GoodVibes

Home Assistant-originated prompts should be sent to:

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
The adapter creates or updates a route binding with `surfaceKind:
"homeassistant"`, submits the prompt through the shared session broker, spawns
an agent when needed, and queues replies through the normal channel reply
pipeline.

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
  "routeId": "route-1",
  "surfaceId": "homeassistant",
  "externalId": "home",
  "metadata": {
    "threadId": "thread-1",
    "channelId": "area.kitchen",
    "attachments": []
  }
}
```

The Home Assistant integration should listen for this event type and update
entities, diagnostics, notifications, or repairs from the event data.

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
5. Event listener for `surfaces.homeassistant.eventType`, default
   `goodvibes_message`.
6. Entities for:
   - Daemon connectivity/status.
   - Last GoodVibes reply.
   - Active session/agent id.
   - Last error.
   - Optional tool catalog count/version.
7. Optional WebSocket or SSE client support:
   - Home Assistant can use its own WebSocket APIs internally.
   - For GoodVibes daemon events, the integration can subscribe to the daemon
     control-plane event stream when it needs live updates beyond event bus
     deliveries.

Do not reimplement GoodVibes routing, tool catalogs, or provider/model
resolution in the Home Assistant project. The HA integration should consume the
SDK/daemon endpoints above and keep Home Assistant-specific UI/entity/service
logic on the HA side.
